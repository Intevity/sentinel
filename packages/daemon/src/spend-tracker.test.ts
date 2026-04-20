import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import type { Settings } from '@claude-sentinel/shared';
import { getDb, closeDb, upsertAccount, upsertAlert } from './db.js';
import { RateLimitStore } from './rate-limit-store.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { SpendTracker, isoWeekStartMs } from './spend-tracker.js';

const TEST_DB = () => join(tmpdir(), `sentinel-spend-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function seed(db: ReturnType<typeof getDb>, id: string): void {
  upsertAccount(db, {
    id, accountUuid: id, email: `${id}@x`, displayName: id, orgUuid: id + '-org', orgName: '',
    planType: 'max', isActive: false, createdAt: Date.now(), color: null,
  });
}

function ipcStub() {
  const broadcasts: Array<{ type: string; [k: string]: unknown }> = [];
  return {
    broadcast: (m: { type: string; [k: string]: unknown }) => broadcasts.push(m),
    broadcasts,
  };
}

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

/** Helper for stubbing the Anthropic-spend getter in tests — a plain
 *  lookup table keyed by account id with a `.set()` mutator so tests can
 *  simulate the fetch landing / expiring / moving. */
function spendStub(initial: Record<string, number | null> = {}) {
  const map = new Map<string, number | null>(Object.entries(initial));
  return {
    get: (id: string): number | null => (map.has(id) ? map.get(id) ?? null : null),
    set: (id: string, v: number | null) => map.set(id, v),
  };
}

describe('isoWeekStartMs', () => {
  it('returns the previous Monday 00:00 local for a mid-week moment', () => {
    const fri = new Date(2026, 3, 17, 15, 30, 0).getTime();
    const d = new Date(isoWeekStartMs(fri));
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3);
    expect(d.getDate()).toBe(13);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it('rolls Sunday back to the prior Monday', () => {
    const sun = new Date(2026, 3, 19, 23, 59, 0).getTime();
    expect(new Date(isoWeekStartMs(sun)).getDate()).toBe(13);
  });
});

describe('SpendTracker', () => {
  let dbPath: string;
  beforeEach(() => { dbPath = TEST_DB(); });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('pauses an account when its per-account cap is exceeded by Anthropic-reported spend', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    seed(db, 'a');
    seed(db, 'b');
    const spend = spendStub({ a: 15.00, b: 2.00 });

    const tracker = new SpendTracker({
      db, rateLimitStore: store, ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
      getSettings: () => settings({ budgetWeeklyUsdByAccount: { a: 10 } }),
      getAnthropicSpend: spend.get,
      now: () => 1_700_000_000_000,
    });
    tracker.recompute();

    expect(tracker.getPausedIds().has('a')).toBe(true);
    expect(tracker.getPausedIds().has('b')).toBe(false);
  });

  it('does NOT pause when Anthropic spend is null (no session key / pre-fetch)', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    seed(db, 'a');
    const spend = spendStub({ a: null });

    const tracker = new SpendTracker({
      db, rateLimitStore: store, ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
      getSettings: () => settings({ budgetWeeklyUsdByAccount: { a: 10 } }),
      getAnthropicSpend: spend.get,
      now: () => 1_700_000_000_000,
    });
    tracker.recompute();

    expect(tracker.getPausedIds().size).toBe(0);
  });

  it('pauses every account when global cap is exceeded AND all spends are known', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    seed(db, 'a');
    seed(db, 'b');
    const spend = spendStub({ a: 6, b: 7 });

    const tracker = new SpendTracker({
      db, rateLimitStore: store, ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
      getSettings: () => settings({ budgetWeeklyUsdGlobal: 10 }),
      getAnthropicSpend: spend.get,
      now: () => 1_700_000_000_000,
    });
    tracker.recompute();
    expect(tracker.getPausedIds().size).toBe(2);
  });

  it('refuses to pause on global cap when any account spend is null', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    seed(db, 'a');
    seed(db, 'b');
    // `b` has no sessionKey yet — global total is a lower bound.
    const spend = spendStub({ a: 50, b: null });

    const tracker = new SpendTracker({
      db, rateLimitStore: store, ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
      getSettings: () => settings({ budgetWeeklyUsdGlobal: 10 }),
      getAnthropicSpend: spend.get,
      now: () => 1_700_000_000_000,
    });
    tracker.recompute();
    expect(tracker.getPausedIds().size).toBe(0);
  });

  it('unpauses when the cap is removed', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    seed(db, 'a');
    const spend = spendStub({ a: 12 });

    let cap: number | undefined = 10;
    const tracker = new SpendTracker({
      db, rateLimitStore: store, ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
      getSettings: () => settings({
        budgetWeeklyUsdByAccount: cap != null ? { a: cap } : {},
      }),
      getAnthropicSpend: spend.get,
      now: () => 1_700_000_000_000,
    });
    tracker.recompute();
    expect(tracker.getPausedIds().has('a')).toBe(true);

    cap = undefined;
    tracker.recompute();
    expect(tracker.getPausedIds().has('a')).toBe(false);
    expect(ipc.broadcasts.some((b) => b.type === 'account_unpaused' && b['accountId'] === 'a')).toBe(true);
  });

  it('unpauses when Anthropic spend drops below cap (next billing period)', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    seed(db, 'a');
    const spend = spendStub({ a: 15 });

    const tracker = new SpendTracker({
      db, rateLimitStore: store, ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
      getSettings: () => settings({ budgetWeeklyUsdByAccount: { a: 10 } }),
      getAnthropicSpend: spend.get,
      now: () => 1_700_000_000_000,
    });
    tracker.recompute();
    expect(tracker.getPausedIds().has('a')).toBe(true);

    // Simulate Anthropic resetting the period — `used_credits` goes back
    // to a small number.
    spend.set('a', 0.5);
    tracker.recompute();
    expect(tracker.getPausedIds().has('a')).toBe(false);
  });

  it('fires a budget:account alert once per ISO week', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    seed(db, 'a');
    upsertAlert(db, { scope: 'budget', budgetScope: 'account', accountId: 'a', thresholdPct: 80, enabled: true });
    const spend = spendStub({ a: 9 });

    const now = new Date(2026, 3, 17, 12, 0, 0).getTime();
    const tracker = new SpendTracker({
      db, rateLimitStore: store, ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
      getSettings: () => settings({ budgetWeeklyUsdByAccount: { a: 10 } }),
      getAnthropicSpend: spend.get,
      now: () => now,
    });
    tracker.recompute();
    const fires1 = ipc.broadcasts.filter((b) => b.type === 'alert_triggered');
    expect(fires1).toHaveLength(1);
    expect(fires1[0]?.['spendUsd']).toBe(9);

    // Second recompute in same week — no re-fire.
    tracker.recompute();
    expect(ipc.broadcasts.filter((b) => b.type === 'alert_triggered')).toHaveLength(1);
  });

  it('re-arms a budget alert after ISO-week rollover', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    seed(db, 'a');
    upsertAlert(db, { scope: 'budget', budgetScope: 'account', accountId: 'a', thresholdPct: 80, enabled: true });
    const spend = spendStub({ a: 9 });
    let clock = new Date(2026, 3, 17, 12, 0, 0).getTime();

    const tracker = new SpendTracker({
      db, rateLimitStore: store, ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
      getSettings: () => settings({ budgetWeeklyUsdByAccount: { a: 10 } }),
      getAnthropicSpend: spend.get,
      now: () => clock,
    });
    tracker.recompute();
    expect(ipc.broadcasts.filter((b) => b.type === 'alert_triggered')).toHaveLength(1);

    clock = new Date(2026, 3, 21, 12, 0, 0).getTime();
    tracker.recompute();
    expect(ipc.broadcasts.filter((b) => b.type === 'alert_triggered')).toHaveLength(2);
  });

  it('does NOT fire budget alert when spend is null', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    seed(db, 'a');
    upsertAlert(db, { scope: 'budget', budgetScope: 'account', accountId: 'a', thresholdPct: 50, enabled: true });
    const spend = spendStub({ a: null });

    const tracker = new SpendTracker({
      db, rateLimitStore: store, ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
      getSettings: () => settings({ budgetWeeklyUsdByAccount: { a: 10 } }),
      getAnthropicSpend: spend.get,
      now: () => Date.now(),
    });
    tracker.recompute();
    expect(ipc.broadcasts.some((b) => b.type === 'alert_triggered')).toBe(false);
  });

  it('emits spend_update with null entries preserved', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    seed(db, 'a');
    seed(db, 'b');
    const spend = spendStub({ a: 2, b: null });

    const tracker = new SpendTracker({
      db, rateLimitStore: store, ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
      getSettings: () => settings(),
      getAnthropicSpend: spend.get,
      now: () => Date.now(),
    });
    tracker.recompute();
    const update = ipc.broadcasts.find((b) => b.type === 'spend_update');
    expect(update).toBeDefined();
    expect((update as unknown as { perAccount: Record<string, number | null> }).perAccount).toEqual({ a: 2, b: null });
    // Global sum skips null contributors.
    expect((update as unknown as { global: number }).global).toBe(2);
  });
});
