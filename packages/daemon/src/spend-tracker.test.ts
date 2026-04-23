import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import type { Settings } from '@claude-sentinel/shared';
import { getDb, closeDb, upsertAccount, upsertAlert, listNotifications } from './db.js';
import { RateLimitStore } from './rate-limit-store.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { SpendTracker, isoWeekStartMs } from './spend-tracker.js';

const TEST_DB = () =>
  join(tmpdir(), `sentinel-spend-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function seed(db: ReturnType<typeof getDb>, id: string): void {
  upsertAccount(db, {
    id,
    accountUuid: id,
    email: `${id}@x`,
    displayName: id,
    orgUuid: id + '-org',
    orgName: '',
    planType: 'max',
    isActive: false,
    createdAt: Date.now(),
    color: null,
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
    get: (id: string): number | null => (map.has(id) ? (map.get(id) ?? null) : null),
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
  beforeEach(() => {
    dbPath = TEST_DB();
  });
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
    const spend = spendStub({ a: 15.0, b: 2.0 });

    const tracker = new SpendTracker({
      db,
      rateLimitStore: store,
      ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
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
      db,
      rateLimitStore: store,
      ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
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
      db,
      rateLimitStore: store,
      ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
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
      db,
      rateLimitStore: store,
      ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
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
      db,
      rateLimitStore: store,
      ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
      getSettings: () =>
        settings({
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
    expect(
      ipc.broadcasts.some((b) => b.type === 'account_unpaused' && b['accountId'] === 'a'),
    ).toBe(true);
  });

  it('unpauses when Anthropic spend drops below cap (next billing period)', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    seed(db, 'a');
    const spend = spendStub({ a: 15 });

    const tracker = new SpendTracker({
      db,
      rateLimitStore: store,
      ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
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
    upsertAlert(db, {
      scope: 'budget',
      budgetScope: 'account',
      accountId: 'a',
      thresholdPct: 80,
      enabled: true,
    });
    const spend = spendStub({ a: 9 });

    const now = new Date(2026, 3, 17, 12, 0, 0).getTime();
    const tracker = new SpendTracker({
      db,
      rateLimitStore: store,
      ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
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
    upsertAlert(db, {
      scope: 'budget',
      budgetScope: 'account',
      accountId: 'a',
      thresholdPct: 80,
      enabled: true,
    });
    const spend = spendStub({ a: 9 });
    let clock = new Date(2026, 3, 17, 12, 0, 0).getTime();

    const tracker = new SpendTracker({
      db,
      rateLimitStore: store,
      ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
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
    upsertAlert(db, {
      scope: 'budget',
      budgetScope: 'account',
      accountId: 'a',
      thresholdPct: 50,
      enabled: true,
    });
    const spend = spendStub({ a: null });

    const tracker = new SpendTracker({
      db,
      rateLimitStore: store,
      ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
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
      db,
      rateLimitStore: store,
      ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
      getSettings: () => settings(),
      getAnthropicSpend: spend.get,
      now: () => Date.now(),
    });
    tracker.recompute();
    const update = ipc.broadcasts.find((b) => b.type === 'spend_update');
    expect(update).toBeDefined();
    expect((update as unknown as { perAccount: Record<string, number | null> }).perAccount).toEqual(
      { a: 2, b: null },
    );
    // Global sum skips null contributors.
    expect((update as unknown as { global: number }).global).toBe(2);
  });

  it('getSpendSummary returns the live computed summary', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    seed(db, 'a');
    seed(db, 'b');
    const spend = spendStub({ a: 3.5, b: null });
    const tracker = new SpendTracker({
      db,
      rateLimitStore: store,
      ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
      getSettings: () => settings(),
      getAnthropicSpend: spend.get,
      now: () => Date.now(),
    });
    const summary = tracker.getSpendSummary();
    expect(summary.perAccount).toEqual({ a: 3.5, b: null });
    expect(summary.global).toBe(3.5);
  });

  describe('handleRateLimitUpdate', () => {
    it('no-ops when the rate-limit store has no unified-5h window for the account', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings(),
        getAnthropicSpend: () => null,
        now: () => Date.now(),
      });
      // No windows → early return, no broadcasts.
      tracker.handleRateLimitUpdate('a');
      expect(ipc.broadcasts).toHaveLength(0);
    });

    it('no-ops on the first observed reset (first-seen is not a rollover)', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      store.update('a', {
        'anthropic-ratelimit-unified-5h-utilization': '0.5',
        'anthropic-ratelimit-unified-5h-reset': '1700000000',
      });
      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings(),
        getAnthropicSpend: () => null,
        now: () => Date.now(),
      });
      tracker.handleRateLimitUpdate('a');
      // First-seen: store the reset but don't treat as rollover — no unpause
      // broadcast (account isn't paused anyway) and no recompute-driven
      // spend_update either because we short-circuit at "prev == null".
      expect(ipc.broadcasts.filter((b) => b.type === 'account_unpaused')).toHaveLength(0);
    });

    it('no-ops when the reset timestamp went backward or stayed equal', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      store.update('a', {
        'anthropic-ratelimit-unified-5h-utilization': '0.5',
        'anthropic-ratelimit-unified-5h-reset': '1700000000',
      });
      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings(),
        getAnthropicSpend: () => null,
        now: () => Date.now(),
      });
      tracker.handleRateLimitUpdate('a'); // Prime lastSessionReset
      const before = ipc.broadcasts.length;
      // Same timestamp again → not a rollover.
      tracker.handleRateLimitUpdate('a');
      expect(ipc.broadcasts.length).toBe(before);
    });

    it('clears a paused account and re-evaluates when the reset advances', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      const spend = spendStub({ a: 15 });
      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings({ budgetWeeklyUsdByAccount: { a: 10 } }),
        getAnthropicSpend: spend.get,
        now: () => 1_700_000_000_000,
      });
      tracker.recompute();
      expect(tracker.getPausedIds().has('a')).toBe(true);

      // Prime lastSessionReset with an initial reset.
      store.update('a', {
        'anthropic-ratelimit-unified-5h-utilization': '0.5',
        'anthropic-ratelimit-unified-5h-reset': '1700000000',
      });
      tracker.handleRateLimitUpdate('a');

      // Advance the reset + drop the spend so re-evaluation should unpause.
      store.update('a', {
        'anthropic-ratelimit-unified-5h-utilization': '0.1',
        'anthropic-ratelimit-unified-5h-reset': '1700018000',
      });
      spend.set('a', 0);
      tracker.handleRateLimitUpdate('a');

      expect(tracker.getPausedIds().has('a')).toBe(false);
      expect(ipc.broadcasts.some((b) => b.type === 'account_unpaused')).toBe(true);
    });
  });

  it('uses the real wall clock when no `now` fn is injected', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    seed(db, 'a');
    // Omit `now` — triggers the Date.now() fallback branch in clock().
    const tracker = new SpendTracker({
      db,
      rateLimitStore: store,
      ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
      getSettings: () => settings(),
      getAnthropicSpend: () => 5,
    });
    tracker.recompute();
    // Just enough to exercise the branch — no assertions on ts needed.
    expect(ipc.broadcasts.some((b) => b.type === 'spend_update')).toBe(true);
  });

  it('pause-log formats without budgetWeeklyUsdByAccount or globalCap present (uses 0 fallback)', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    seed(db, 'a');
    // An account currently paused (carried over from a previous state) but
    // neither per-account nor global cap is configured now — the unpause
    // path in evaluatePauseSet fires and hits the `?? 0` fallback when it
    // logs the prior spend.
    const spend = spendStub({ a: 12 });
    let cap: number | undefined = 10;
    const tracker = new SpendTracker({
      db,
      rateLimitStore: store,
      ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
      getSettings: () =>
        settings({
          budgetWeeklyUsdByAccount: cap != null ? { a: cap } : {},
        }),
      getAnthropicSpend: spend.get,
      now: () => 1_700_000_000_000,
    });
    tracker.recompute();
    expect(tracker.getPausedIds().has('a')).toBe(true);
    // Remove cap AND simulate spend accessor returning null, so the logger's
    // `?? 0` fallback fires during the unpause log line.
    cap = undefined;
    spend.set('a', null);
    tracker.recompute();
    expect(tracker.getPausedIds().has('a')).toBe(false);
  });

  describe('budget alerts — branch shapes', () => {
    it('skips an alert when its cap is 0', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      upsertAlert(db, {
        scope: 'budget',
        budgetScope: 'account',
        accountId: 'a',
        thresholdPct: 50,
        enabled: true,
      });
      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        // cap is 0 — resolveAlertContext returns cap=0, evaluate() drops it.
        getSettings: () => settings({ budgetWeeklyUsdByAccount: { a: 0 } }),
        getAnthropicSpend: () => 100,
        now: () => Date.now(),
      });
      tracker.recompute();
      expect(ipc.broadcasts.some((b) => b.type === 'alert_triggered')).toBe(false);
    });

    it('skips an alert when the observed pct is below threshold', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      upsertAlert(db, {
        scope: 'budget',
        budgetScope: 'account',
        accountId: 'a',
        thresholdPct: 80,
        enabled: true,
      });
      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings({ budgetWeeklyUsdByAccount: { a: 10 } }),
        // $5 of $10 = 50% — below 80% threshold.
        getAnthropicSpend: () => 5,
        now: () => Date.now(),
      });
      tracker.recompute();
      expect(ipc.broadcasts.some((b) => b.type === 'alert_triggered')).toBe(false);
    });

    it('resolveAlertContext returns a null-cap entry when account alert targets a budget that is not set', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      upsertAlert(db, {
        scope: 'budget',
        budgetScope: 'account',
        accountId: 'a',
        thresholdPct: 50,
        enabled: true,
      });
      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        // Per-account cap is not defined for 'a'; resolveAlertContext returns cap=null.
        getSettings: () => settings({ budgetWeeklyUsdByAccount: {} }),
        getAnthropicSpend: () => 100,
        now: () => Date.now(),
      });
      tracker.recompute();
      expect(ipc.broadcasts.some((b) => b.type === 'alert_triggered')).toBe(false);
    });
  });

  describe('budget alerts — global scope', () => {
    it('fires a global-scope budget alert only when every account has a known spend', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      seed(db, 'b');
      upsertAlert(db, {
        scope: 'budget',
        budgetScope: 'global',
        accountId: null,
        thresholdPct: 50,
        enabled: true,
      });
      const spend = spendStub({ a: 6, b: null });

      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings({ budgetWeeklyUsdGlobal: 10 }),
        getAnthropicSpend: spend.get,
        now: () => Date.now(),
      });
      tracker.recompute();
      // b is null — global cap is unknown, alert must not fire.
      expect(ipc.broadcasts.some((b) => b.type === 'alert_triggered')).toBe(false);

      // Fill in b's spend — now all accounts are known and alert should fire.
      spend.set('b', 1);
      tracker.recompute();
      expect(ipc.broadcasts.some((b) => b.type === 'alert_triggered')).toBe(true);
    });
  });

  describe('weekly rate-limit pauses', () => {
    const blockWeekly = (store: RateLimitStore, id: string, reset = 1_800_000): void => {
      store.update(id, {
        'anthropic-ratelimit-unified-7d-status': 'blocked',
        'anthropic-ratelimit-unified-7d-utilization': '1.0',
        'anthropic-ratelimit-unified-7d-reset': String(reset),
      });
    };

    it("pauses an account when unified-7d status is 'blocked', keying Retry-After on the 7d reset", () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      blockWeekly(store, 'a', 1_800_000);

      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings(),
        getAnthropicSpend: () => 0,
        now: () => 1_700_000_000_000,
      });
      tracker.recompute();

      expect(tracker.getPausedIds().has('a')).toBe(true);
      expect(tracker.getPauseReason('a')).toBe('sentinel_weekly_rate_limit');

      const paused = ipc.broadcasts.find(
        (b) => b.type === 'account_paused' && b.accountId === 'a',
      );
      expect(paused).toMatchObject({
        reason: 'sentinel_weekly_rate_limit',
        resetsAt: 1_800_000,
      });
    });

    it('coexists with a budget pause on a different account without cross-contamination', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      seed(db, 'b');
      const spend = spendStub({ a: 0, b: 20 });
      blockWeekly(store, 'a');

      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings({ budgetWeeklyUsdByAccount: { b: 10 } }),
        getAnthropicSpend: spend.get,
        now: () => 1_700_000_000_000,
      });
      tracker.recompute();

      expect(tracker.getPauseReason('a')).toBe('sentinel_weekly_rate_limit');
      expect(tracker.getPauseReason('b')).toBe('sentinel_budget');

      // Drop b's spend below the cap — the budget pause should clear without
      // disturbing a's weekly pause.
      spend.set('b', 1);
      tracker.recompute();

      expect(tracker.getPauseReason('a')).toBe('sentinel_weekly_rate_limit');
      expect(tracker.getPauseReason('b')).toBe(null);
    });

    it('weekly pause clears when the 7d reset advances via handleRateLimitUpdate', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      blockWeekly(store, 'a', 1_800_000);

      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings(),
        getAnthropicSpend: () => 0,
        now: () => 1_700_000_000_000,
      });
      tracker.recompute();
      expect(tracker.getPauseReason('a')).toBe('sentinel_weekly_rate_limit');

      // Prime handleRateLimitUpdate's last-seen map with the pre-rollover reset.
      tracker.handleRateLimitUpdate('a');

      // Now simulate the 7-day rollover: fresh window, status back to allowed.
      store.update('a', {
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '0.0',
        'anthropic-ratelimit-unified-7d-reset': '2404800',
      });
      tracker.handleRateLimitUpdate('a');

      expect(tracker.getPauseReason('a')).toBe(null);
      expect(ipc.broadcasts.some((b) => b.type === 'account_unpaused' && b.accountId === 'a')).toBe(
        true,
      );
    });

    it('5h rollover does not clear a weekly-rate-limit pause', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      blockWeekly(store, 'a', 1_800_000);

      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings(),
        getAnthropicSpend: () => 0,
        now: () => 1_700_000_000_000,
      });
      tracker.recompute();
      expect(tracker.getPauseReason('a')).toBe('sentinel_weekly_rate_limit');

      // Prime with initial 5h reset.
      store.update('a', {
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.5',
        'anthropic-ratelimit-unified-5h-reset': '1700000',
      });
      tracker.handleRateLimitUpdate('a');

      // Advance only the 5h — the 7d window is still blocked. Pause must stay.
      store.update('a', {
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.1',
        'anthropic-ratelimit-unified-5h-reset': '1718000',
      });
      tracker.handleRateLimitUpdate('a');

      expect(tracker.getPauseReason('a')).toBe('sentinel_weekly_rate_limit');
    });

    it('start() is safe to call, does not keep the event loop alive, and stop() tears down', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings(),
        getAnthropicSpend: () => 0,
        now: () => 1_700_000_000_000,
      });
      tracker.start();
      // Recompute should still work while the sweep timer is live.
      tracker.recompute();
      tracker.stop();
    });

    it('sweepWeeklyResets releases pauses whose 7d reset has passed', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      seed(db, 'b');
      blockWeekly(store, 'a', 100);
      blockWeekly(store, 'b', 10_000);

      let nowMs = 50_000;
      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings(),
        getAnthropicSpend: () => 0,
        now: () => nowMs,
      });
      tracker.recompute();
      expect(tracker.getPauseReason('a')).toBe('sentinel_weekly_rate_limit');
      expect(tracker.getPauseReason('b')).toBe('sentinel_weekly_rate_limit');

      // Advance past a's reset. recompute() alone wouldn't release a
      // because the evaluator re-pauses on status='blocked' regardless of
      // reset — the sweep is the only path that releases when the window
      // hasn't been refreshed yet. Flip a's status to allowed first so
      // the weekly evaluator in the subsequent recompute doesn't
      // immediately re-pause during sweep's own recompute() tail-call.
      store.update('a', {
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '1.0',
        'anthropic-ratelimit-unified-7d-reset': '100',
      });
      nowMs = 150_000; // past a's reset, still well before b's
      (tracker as unknown as { sweepWeeklyResets: () => void }).sweepWeeklyResets();

      expect(tracker.getPauseReason('a')).toBe(null);
      expect(tracker.getPauseReason('b')).toBe('sentinel_weekly_rate_limit');
      expect(
        ipc.broadcasts.some((m) => m.type === 'account_unpaused' && m.accountId === 'a'),
      ).toBe(true);
    });

    it('sweepWeeklyResets ignores non-weekly pauses and missing-reset windows', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      seed(db, 'b');
      const spend = spendStub({ a: 100 });

      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings({ budgetWeeklyUsdByAccount: { a: 10 } }),
        getAnthropicSpend: spend.get,
        now: () => 1_700_000_000_000,
      });
      tracker.recompute();
      expect(tracker.getPauseReason('a')).toBe('sentinel_budget');

      // b is "paused" by injecting a weekly reason directly and setting up a
      // 7d window with NO reset — the null-reset continue branch fires.
      store.update('b', {
        'anthropic-ratelimit-unified-7d-status': 'blocked',
        'anthropic-ratelimit-unified-7d-utilization': '1.0',
      });
      tracker.recompute();
      expect(tracker.getPauseReason('b')).toBe('sentinel_weekly_rate_limit');

      (
        tracker as unknown as { sweepWeeklyResets: () => void }
      ).sweepWeeklyResets();

      // Budget pause untouched; weekly pause retained (no reset → skip).
      expect(tracker.getPauseReason('a')).toBe('sentinel_budget');
      expect(tracker.getPauseReason('b')).toBe('sentinel_weekly_rate_limit');
    });

    it('start/stop lifecycle is idempotent', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings(),
        getAnthropicSpend: () => 0,
        now: () => Date.now(),
      });
      tracker.start();
      tracker.start(); // second start must be a no-op
      tracker.stop();
      tracker.stop(); // stopping twice is safe
    });

    it('weekly evaluator does not overwrite an existing budget pause', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      // Start with a budget pause in place.
      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings({ budgetWeeklyUsdByAccount: { a: 5 } }),
        getAnthropicSpend: () => 10,
        now: () => 1_700_000_000_000,
      });
      tracker.recompute();
      expect(tracker.getPauseReason('a')).toBe('sentinel_budget');

      // Now 7d goes blocked as well — budget pause must NOT be relabeled.
      blockWeekly(store, 'a');
      tracker.recompute();
      expect(tracker.getPauseReason('a')).toBe('sentinel_budget');
    });

    it('budget evaluator does not overwrite an existing weekly-rate-limit pause', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      blockWeekly(store, 'a');
      // Also simulate budget cap tripped; the weekly evaluator runs AFTER
      // the budget evaluator, so on the first recompute the budget
      // evaluator would normally add the pause first.  We test that a
      // pre-existing weekly pause survives a subsequent budget pass.
      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings({ budgetWeeklyUsdByAccount: { a: 5 } }),
        getAnthropicSpend: () => 0, // NOT over budget
        now: () => 1_700_000_000_000,
      });
      tracker.recompute();
      expect(tracker.getPauseReason('a')).toBe('sentinel_weekly_rate_limit');

      // Flip the spend above cap — budget cleanup must leave the weekly
      // pause alone.
      tracker.recompute();
      expect(tracker.getPauseReason('a')).toBe('sentinel_weekly_rate_limit');
    });

    it("weekly pause clears when the 7d window's status returns to 'allowed' (external recovery)", () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      blockWeekly(store, 'a');

      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings(),
        getAnthropicSpend: () => 0,
        now: () => 1_700_000_000_000,
      });
      tracker.recompute();
      expect(tracker.getPauseReason('a')).toBe('sentinel_weekly_rate_limit');

      // Without advancing reset, Anthropic could still flip status back to
      // allowed in some edge cases (e.g., grant landed, limit increased).
      // The evaluator's cleanup branch drops the weekly pause.
      store.update('a', {
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '0.8',
        'anthropic-ratelimit-unified-7d-reset': '1800000',
      });
      tracker.recompute();
      expect(tracker.getPauseReason('a')).toBe(null);
    });

    it('getPauseReason returns null for accounts that are not paused', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings(),
        getAnthropicSpend: () => 0,
        now: () => Date.now(),
      });
      tracker.recompute();
      expect(tracker.getPauseReason('a')).toBe(null);
      expect(tracker.getPauseReason('nonexistent')).toBe(null);
    });

    it('notification body mentions weekly 7-day on weekly-pause entry', () => {
      const db = getDb(dbPath);
      const store = new RateLimitStore();
      const ipc = ipcStub();
      seed(db, 'a');
      blockWeekly(store, 'a');

      const tracker = new SpendTracker({
        db,
        rateLimitStore: store,
        ipcServer: ipc as unknown as import('./ipc.js').IpcServer,
        getSettings: () => settings(),
        getAnthropicSpend: () => 0,
        now: () => 1_700_000_000_000,
      });
      tracker.recompute();

      const rows = listNotifications(db, { limit: 10 });
      const weeklyNotif = rows.find((n) => n.body.includes('7-day'));
      expect(weeklyNotif).toBeTruthy();
    });
  });
});
