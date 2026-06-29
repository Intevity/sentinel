import { describe, it, expect, vi, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import { startRateLimitSweeper } from './rate-limit-sweeper.js';
import { RateLimitStore } from './rate-limit-store.js';
import { SpendTracker } from './spend-tracker.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { getDb, closeDb, upsertAccount, upsertRateLimit, loadRateLimits } from './db.js';
import type { IpcServer } from './ipc.js';

function ipcStub() {
  const broadcasts: Array<{ type: string; [k: string]: unknown }> = [];
  return {
    broadcast: (m: { type: string; [k: string]: unknown }) => broadcasts.push(m),
    broadcasts,
  };
}

const NOW_MS = 2_000_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

/** Seed a window with the given reset (Unix seconds) for an account. */
function seedWindow(store: RateLimitStore, accountId: string, resetSec: number): void {
  store.update(accountId, {
    'anthropic-ratelimit-unified-5h-utilization': '0.5',
    'anthropic-ratelimit-unified-5h-reset': String(resetSec),
  });
}

describe('startRateLimitSweeper', () => {
  it('rolls over stale windows, broadcasts, and fires onWindowsExpired on the startup pass', () => {
    const store = new RateLimitStore();
    seedWindow(store, 'acc-1', NOW_SEC - 3600); // elapsed
    const ipc = ipcStub();
    const onWindowsExpired = vi.fn();

    const handle = startRateLimitSweeper({
      rateLimitStore: store,
      ipcServer: ipc as unknown as IpcServer,
      onWindowsExpired,
      now: () => NOW_MS,
      intervalMs: 60_000,
    });
    // The first tick runs synchronously inside start().
    handle.stop();

    expect(store.getAll('acc-1').find((w) => w.name === 'unified-5h')?.utilization).toBe(0);
    expect(store.getAll('acc-1').find((w) => w.name === 'unified-5h')?.reset).toBeNull();
    expect(ipc.broadcasts).toContainEqual({ type: 'rate_limits_updated', accountId: 'acc-1' });
    expect(onWindowsExpired).toHaveBeenCalledTimes(1);
  });

  it('does not broadcast or fire onWindowsExpired when no window is stale', () => {
    const store = new RateLimitStore();
    seedWindow(store, 'acc-1', NOW_SEC + 3600); // future
    const ipc = ipcStub();
    const onWindowsExpired = vi.fn();

    const handle = startRateLimitSweeper({
      rateLimitStore: store,
      ipcServer: ipc as unknown as IpcServer,
      onWindowsExpired,
      now: () => NOW_MS,
      intervalMs: 60_000,
    });
    handle.stop();

    expect(ipc.broadcasts).toEqual([]);
    expect(onWindowsExpired).not.toHaveBeenCalled();
  });

  it('broadcasts exactly once for the stale account when accounts are mixed', () => {
    const store = new RateLimitStore();
    seedWindow(store, 'stale', NOW_SEC - 10);
    seedWindow(store, 'fresh', NOW_SEC + 10_000);
    const ipc = ipcStub();

    const handle = startRateLimitSweeper({
      rateLimitStore: store,
      ipcServer: ipc as unknown as IpcServer,
      now: () => NOW_MS,
      intervalMs: 60_000,
    });
    handle.stop();

    expect(ipc.broadcasts).toEqual([{ type: 'rate_limits_updated', accountId: 'stale' }]);
  });

  it('sweeps again on the interval', () => {
    vi.useFakeTimers();
    try {
      const store = new RateLimitStore();
      // No stale windows yet at start.
      seedWindow(store, 'acc-1', NOW_SEC + 10_000);
      const ipc = ipcStub();
      let clock = NOW_MS;

      const handle = startRateLimitSweeper({
        rateLimitStore: store,
        ipcServer: ipc as unknown as IpcServer,
        now: () => clock,
        intervalMs: 1000,
      });
      expect(ipc.broadcasts).toEqual([]); // immediate pass found nothing

      // Advance the clock past the window's reset, then let the interval fire.
      clock = (NOW_SEC + 20_000) * 1000;
      vi.advanceTimersByTime(1000);
      handle.stop();

      expect(ipc.broadcasts).toEqual([{ type: 'rate_limits_updated', accountId: 'acc-1' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('start/stop is safe and uses real-clock + default interval when none injected', () => {
    const store = new RateLimitStore();
    // reset=1 (epoch) is unambiguously in the past for the real wall clock.
    seedWindow(store, 'acc-1', 1);
    const ipc = ipcStub();

    // Omit `now` and `intervalMs` to exercise the Date.now / default-interval
    // fallbacks. The immediate pass should still roll the stale window over.
    const handle = startRateLimitSweeper({
      rateLimitStore: store,
      ipcServer: ipc as unknown as IpcServer,
    });
    expect(() => handle.stop()).not.toThrow();

    expect(store.getAll('acc-1').find((w) => w.name === 'unified-5h')?.utilization).toBe(0);
    expect(ipc.broadcasts).toContainEqual({ type: 'rate_limits_updated', accountId: 'acc-1' });
  });
});

// End-to-end: a daemon that sat idle past a window's reset recovers on the
// sweep — through the REAL onUpdate persistence chain and a real SpendTracker —
// zeroing the window, persisting it, broadcasting, and releasing a stale weekly
// pause. This is the weekend-recovery scenario the feature exists for.
describe('rate-limit sweeper end-to-end recovery', () => {
  let dbPath: string;
  afterEach(() => {
    closeDb();
    if (dbPath && existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('rolls over a stale weekly window, persists it, and releases its pause', () => {
    dbPath = join(tmpdir(), `sentinel-sweeper-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = getDb(dbPath);
    upsertAccount(db, {
      id: 'acc-1',
      accountUuid: 'acc-1',
      email: 'acc-1@x',
      displayName: 'acc-1',
      orgUuid: 'acc-1-org',
      orgName: '',
      planType: 'max',
      isActive: false,
      createdAt: 1_700_000_000_000,
      color: null,
    });

    const store = new RateLimitStore();
    const ipc = ipcStub();
    const clock = { now: 1_700_000_000_000 };

    // Real persistence wiring (mirrors index.ts): every store change writes through.
    store.onUpdate((id, windows) => {
      for (const w of windows) upsertRateLimit(db, id, w);
    });

    const tracker = new SpendTracker({
      db,
      rateLimitStore: store,
      ipcServer: ipc as unknown as IpcServer,
      getSettings: () => ({ ...DEFAULT_SETTINGS }),
      getAnthropicSpend: () => null,
      now: () => clock.now,
    });
    // Real pause wiring (mirrors index.ts).
    store.onUpdate((id) => tracker.handleRateLimitUpdate(id));

    // Seed a blocked weekly window with a reset shortly in the future, then
    // pause the account on it.
    const seedResetSec = Math.floor(clock.now / 1000) + 1000;
    store.update('acc-1', {
      'anthropic-ratelimit-unified-7d-status': 'blocked',
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': String(seedResetSec),
    });
    tracker.recompute();
    expect(tracker.getPauseReason('acc-1')).toBe('sentinel_weekly_rate_limit');

    // The daemon sits idle past the reset.
    clock.now += 2000 * 1000;

    const handle = startRateLimitSweeper({
      rateLimitStore: store,
      ipcServer: ipc as unknown as IpcServer,
      onWindowsExpired: () => tracker.recompute(),
      now: () => clock.now,
    });
    handle.stop();

    const weekly = store.getAll('acc-1').find((w) => w.name === 'unified-7d');
    expect(weekly?.utilization).toBe(0);
    expect(weekly?.status).toBe('allowed');
    expect(weekly?.reset).toBeNull();
    // Persisted, so a restart won't resurrect the stale numbers.
    expect(loadRateLimits(db).get('acc-1')?.find((w) => w.name === 'unified-7d')?.reset).toBeNull();
    // The stale weekly pause is released, with both broadcasts fired.
    expect(tracker.getPauseReason('acc-1')).toBeNull();
    expect(ipc.broadcasts).toContainEqual({ type: 'rate_limits_updated', accountId: 'acc-1' });
    expect(ipc.broadcasts).toContainEqual({ type: 'account_unpaused', accountId: 'acc-1' });
  });
});
