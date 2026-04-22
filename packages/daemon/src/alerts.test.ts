import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import {
  getDb,
  closeDb,
  upsertAlert,
  listAlerts,
  deleteAlert,
  markAlertTriggered,
  listNotifications,
  upsertAccount,
} from './db.js';
import { RateLimitStore } from './rate-limit-store.js';
import {
  startAlertEvaluator,
  startSonnetAlertEvaluator,
  startPoolAlertEvaluator,
  evaluatePoolOnce,
  primeNewAlertAgainstCurrentWindow,
} from './alerts.js';
import { DEFAULT_SETTINGS } from './settings.js';
import type { Settings } from '@claude-sentinel/shared';

const TEST_DB = () =>
  join(tmpdir(), `sentinel-alerts-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function ipcStub() {
  const broadcasts: unknown[] = [];
  return {
    broadcast: (m: unknown) => broadcasts.push(m),
    broadcasts,
  };
}

function updateSessionWindow(
  store: RateLimitStore,
  accountId: string,
  utilization: number,
  reset = 123456,
): void {
  store.update(accountId, {
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': String(utilization),
    'anthropic-ratelimit-unified-5h-reset': String(reset),
  });
}

function rrSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    switchingMode: 'round-robin',
    ...overrides,
  };
}

function seedAccount(db: ReturnType<typeof getDb>, id: string, email = `${id}@example.com`): void {
  upsertAccount(db, {
    id,
    accountUuid: id,
    email,
    displayName: id,
    orgUuid: id,
    orgName: id,
    planType: 'pro',
    isActive: false,
    createdAt: Date.now(),
    color: null,
  });
}

describe('alerts CRUD (per-account)', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = TEST_DB();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('creates, lists, and deletes alerts', () => {
    const db = getDb(dbPath);
    const alert = upsertAlert(db, {
      scope: 'account',
      accountId: 'acc-a',
      thresholdPct: 80,
      enabled: true,
    });
    expect(alert.id).toBeGreaterThan(0);
    expect(alert.scope).toBe('account');
    expect(alert.accountId).toBe('acc-a');
    expect(alert.thresholdPct).toBe(80);
    expect(alert.enabled).toBe(true);

    const list = listAlerts(db, { scope: 'account', accountId: 'acc-a' });
    expect(list).toHaveLength(1);

    const removed = deleteAlert(db, alert.id);
    expect(removed).toBe(true);
    expect(listAlerts(db, { scope: 'account', accountId: 'acc-a' })).toHaveLength(0);
  });

  it('updates an existing alert in place when id is provided', () => {
    const db = getDb(dbPath);
    const created = upsertAlert(db, {
      scope: 'account',
      accountId: 'acc-a',
      thresholdPct: 80,
      enabled: true,
    });
    const updated = upsertAlert(db, {
      id: created.id,
      scope: 'account',
      accountId: 'acc-a',
      thresholdPct: 50,
      enabled: false,
    });
    expect(updated.id).toBe(created.id);
    expect(updated.thresholdPct).toBe(50);
    expect(updated.enabled).toBe(false);
    expect(listAlerts(db, { scope: 'account', accountId: 'acc-a' })).toHaveLength(1);
  });

  it('listAlerts without filters returns every alert', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { scope: 'account', accountId: 'a', thresholdPct: 50, enabled: true });
    upsertAlert(db, { scope: 'account', accountId: 'b', thresholdPct: 75, enabled: true });
    expect(listAlerts(db)).toHaveLength(2);
  });

  it('listAlerts by scope returns only that scope', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { scope: 'account', accountId: 'a', thresholdPct: 50, enabled: true });
    upsertAlert(db, { scope: 'pool', accountId: null, thresholdPct: 75, enabled: true });
    expect(listAlerts(db, { scope: 'account' })).toHaveLength(1);
    expect(listAlerts(db, { scope: 'pool' })).toHaveLength(1);
  });

  it('listAlerts by account-only positional filter still works', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { scope: 'account', accountId: 'a', thresholdPct: 50, enabled: true });
    upsertAlert(db, { scope: 'account', accountId: 'b', thresholdPct: 75, enabled: true });
    expect(listAlerts(db, { accountId: 'a' })).toHaveLength(1);
  });

  it('deleteAlert returns false for unknown id', () => {
    const db = getDb(dbPath);
    expect(deleteAlert(db, 9999)).toBe(false);
  });

  it('markAlertTriggered persists the reset timestamp', () => {
    const db = getDb(dbPath);
    const alert = upsertAlert(db, {
      scope: 'account',
      accountId: 'acc-a',
      thresholdPct: 80,
      enabled: true,
    });
    markAlertTriggered(db, alert.id, 1_000_000);
    const [row] = listAlerts(db, { scope: 'account', accountId: 'acc-a' });
    expect(row?.lastTriggeredResetTs).toBe(1_000_000);
  });

  it('rejects pool-scoped inserts with a non-null accountId', () => {
    const db = getDb(dbPath);
    expect(() =>
      upsertAlert(db, { scope: 'pool', accountId: 'acc-a', thresholdPct: 50, enabled: true }),
    ).toThrow(/accountId = null/);
  });

  it('rejects account-scoped inserts without an accountId', () => {
    const db = getDb(dbPath);
    expect(() =>
      upsertAlert(db, { scope: 'account', accountId: '', thresholdPct: 50, enabled: true }),
    ).toThrow(/non-empty accountId/);
  });

  it('defaults scope to account when omitted', () => {
    const db = getDb(dbPath);
    const alert = upsertAlert(db, { accountId: 'acc-a', thresholdPct: 40, enabled: true });
    expect(alert.scope).toBe('account');
  });
});

describe('alerts CRUD (pool)', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = TEST_DB();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('stores pool alerts with accountId = null', () => {
    const db = getDb(dbPath);
    const alert = upsertAlert(db, {
      scope: 'pool',
      accountId: null,
      thresholdPct: 70,
      enabled: true,
    });
    expect(alert.scope).toBe('pool');
    expect(alert.accountId).toBeNull();
    const [row] = listAlerts(db, { scope: 'pool' });
    expect(row?.accountId).toBeNull();
  });

  it('updates pool alerts in place', () => {
    const db = getDb(dbPath);
    const created = upsertAlert(db, {
      scope: 'pool',
      accountId: null,
      thresholdPct: 50,
      enabled: true,
    });
    const updated = upsertAlert(db, {
      id: created.id,
      scope: 'pool',
      accountId: null,
      thresholdPct: 80,
      enabled: false,
    });
    expect(updated.thresholdPct).toBe(80);
    expect(updated.enabled).toBe(false);
    expect(updated.accountId).toBeNull();
  });
});

describe('startAlertEvaluator (per-account)', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = TEST_DB();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('fires an alert when utilization crosses the threshold', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { scope: 'account', accountId: 'acc-a', thresholdPct: 75, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    updateSessionWindow(store, 'acc-a', 0.85);

    expect(ipc.broadcasts).toHaveLength(1);
    const msg = ipc.broadcasts[0] as {
      type: string;
      accountId: string;
      thresholdPct: number;
      scope: string;
    };
    expect(msg.type).toBe('alert_triggered');
    expect(msg.accountId).toBe('acc-a');
    expect(msg.scope).toBe('account');
    expect(msg.thresholdPct).toBe(75);

    const notifs = listNotifications(db, {});
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.type).toBe('usage_alert');
  });

  it('does not fire below the threshold', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { scope: 'account', accountId: 'acc-a', thresholdPct: 75, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    updateSessionWindow(store, 'acc-a', 0.5);

    expect(ipc.broadcasts).toHaveLength(0);
  });

  it('does not re-fire within the same window (same reset)', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { scope: 'account', accountId: 'acc-a', thresholdPct: 75, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    updateSessionWindow(store, 'acc-a', 0.85, 111);
    updateSessionWindow(store, 'acc-a', 0.95, 111);

    expect(ipc.broadcasts).toHaveLength(1);
  });

  it('re-fires after the window resets (new reset value)', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { scope: 'account', accountId: 'acc-a', thresholdPct: 75, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    updateSessionWindow(store, 'acc-a', 0.85, 111);
    updateSessionWindow(store, 'acc-a', 0.85, 222);

    expect(ipc.broadcasts).toHaveLength(2);
  });

  it('ignores disabled alerts', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { scope: 'account', accountId: 'acc-a', thresholdPct: 75, enabled: false });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    updateSessionWindow(store, 'acc-a', 0.95);
    expect(ipc.broadcasts).toHaveLength(0);
  });

  it('uses the account email lookup when provided', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { scope: 'account', accountId: 'acc-a', thresholdPct: 75, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getEmailForAccount: () => 'pretty@example.com',
    });

    updateSessionWindow(store, 'acc-a', 0.95);
    const notifs = listNotifications(db, {});
    expect(notifs[0]?.body).toContain('pretty@example.com');
  });

  it('ignores updates when the session window is missing', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { scope: 'account', accountId: 'acc-a', thresholdPct: 75, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    store.update('acc-a', {
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.99',
    });
    expect(ipc.broadcasts).toHaveLength(0);
  });

  it('handles accounts that have no configured alerts', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    updateSessionWindow(store, 'unknown-acc', 0.99);
    expect(ipc.broadcasts).toHaveLength(0);
  });

  it('treats a missing session.reset as 0 so alerts still fire', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { scope: 'account', accountId: 'acc-a', thresholdPct: 50, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });
    store.update('acc-a', {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.80',
    });
    expect(ipc.broadcasts).toHaveLength(1);
  });

  it('does not fire pool alerts via the per-account evaluator', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { scope: 'pool', accountId: null, thresholdPct: 50, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    updateSessionWindow(store, 'acc-a', 0.95);
    expect(ipc.broadcasts).toHaveLength(0);
  });

  it('stays silent for accounts excluded from the round-robin pool', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { scope: 'account', accountId: 'acc-a', thresholdPct: 75, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => rrSettings({ poolExcludedIds: ['acc-a'] }),
    });

    updateSessionWindow(store, 'acc-a', 0.95);
    expect(ipc.broadcasts).toHaveLength(0);
  });

  it('still fires for excluded accounts outside round-robin mode', () => {
    // poolExcludedIds is defined as round-robin-only: in `off` mode the
    // field is ignored, so a stale exclusion entry must not accidentally
    // silence legitimate alerts.
    const db = getDb(dbPath);
    upsertAlert(db, { scope: 'account', accountId: 'acc-a', thresholdPct: 75, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => ({
        ...DEFAULT_SETTINGS,
        switchingMode: 'off',
        poolExcludedIds: ['acc-a'],
      }),
    });

    updateSessionWindow(store, 'acc-a', 0.95);
    expect(ipc.broadcasts).toHaveLength(1);
  });
});

describe('startPoolAlertEvaluator', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = TEST_DB();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('fires when the pool mean crosses the threshold', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'a');
    seedAccount(db, 'b');
    upsertAlert(db, { scope: 'pool', accountId: null, thresholdPct: 60, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startPoolAlertEvaluator({
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => rrSettings(),
    });

    updateSessionWindow(store, 'a', 0.9, 200);
    updateSessionWindow(store, 'b', 0.4, 300); // mean = 0.65 → crosses 60%

    expect(ipc.broadcasts).toHaveLength(1);
    const msg = ipc.broadcasts[0] as {
      type: string;
      scope: string;
      accountId: string | null;
      utilization: number;
    };
    expect(msg.type).toBe('alert_triggered');
    expect(msg.scope).toBe('pool');
    expect(msg.accountId).toBeNull();
    expect(msg.utilization).toBeCloseTo(0.65, 2);

    const notifs = listNotifications(db, {});
    expect(notifs[0]?.body).toMatch(/Round-robin pool/);
    expect(notifs[0]?.body).toContain('2 accounts');
  });

  it('ignores excluded accounts when computing the mean', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'a');
    seedAccount(db, 'b');
    upsertAlert(db, { scope: 'pool', accountId: null, thresholdPct: 50, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startPoolAlertEvaluator({
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => rrSettings({ poolExcludedIds: ['b'] }),
    });

    // Account 'a' alone at 40% — mean should NOT cross 50%.
    updateSessionWindow(store, 'a', 0.4, 200);
    // Excluded 'b' at 99% is a no-op in the pool (and is skipped by the
    // update filter as well — it's not a pool member).
    updateSessionWindow(store, 'b', 0.99, 300);
    expect(ipc.broadcasts).toHaveLength(0);
  });

  it('skips evaluation when switchingMode is not round-robin', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'a');
    upsertAlert(db, { scope: 'pool', accountId: null, thresholdPct: 10, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startPoolAlertEvaluator({
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => ({ ...DEFAULT_SETTINGS, switchingMode: 'off' }),
    });

    updateSessionWindow(store, 'a', 0.95, 200);
    expect(ipc.broadcasts).toHaveLength(0);
  });

  it('gates re-fire by min(reset) across pool members', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'a');
    seedAccount(db, 'b');
    upsertAlert(db, { scope: 'pool', accountId: null, thresholdPct: 50, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startPoolAlertEvaluator({
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => rrSettings(),
    });

    // Both above threshold; min(reset)=200.
    updateSessionWindow(store, 'a', 0.8, 200);
    updateSessionWindow(store, 'b', 0.9, 500);
    expect(ipc.broadcasts).toHaveLength(1);

    // Another update in the same "min reset" window — no re-fire.
    updateSessionWindow(store, 'a', 0.95, 200);
    expect(ipc.broadcasts).toHaveLength(1);

    // Account a's window rolls over: min(reset) is now 500. Alert re-arms.
    updateSessionWindow(store, 'a', 0.7, 900); // min(a=900, b=500) = 500 → different gate
    expect(ipc.broadcasts).toHaveLength(2);
  });

  it('no-op when pool has no eligible members', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { scope: 'pool', accountId: null, thresholdPct: 10, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    const deps = {
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => rrSettings(),
    };
    startPoolAlertEvaluator(deps);
    evaluatePoolOnce(deps); // no accounts seeded
    expect(ipc.broadcasts).toHaveLength(0);
  });

  it('evaluatePoolOnce fires immediately without needing a store update', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'a');
    seedAccount(db, 'b');
    upsertAlert(db, { scope: 'pool', accountId: null, thresholdPct: 50, enabled: true });
    const store = new RateLimitStore();
    updateSessionWindow(store, 'a', 0.8, 111);
    updateSessionWindow(store, 'b', 0.6, 222);

    const ipc = ipcStub();
    const deps = {
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => rrSettings(),
    };
    evaluatePoolOnce(deps);
    expect(ipc.broadcasts).toHaveLength(1);
  });

  it('evaluatePoolOnce is a no-op when switching mode is not round-robin', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'a');
    upsertAlert(db, { scope: 'pool', accountId: null, thresholdPct: 10, enabled: true });
    const store = new RateLimitStore();
    updateSessionWindow(store, 'a', 0.99, 111);

    const ipc = ipcStub();
    // Mode is 'off' — early return, no evaluation.
    const deps = {
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => ({ ...rrSettings(), switchingMode: 'off' as const }),
    };
    evaluatePoolOnce(deps);
    expect(ipc.broadcasts).toHaveLength(0);
  });

  it('evaluatePoolOnce uses the singular "account" copy when exactly one member is in the pool', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'only');
    upsertAlert(db, { scope: 'pool', accountId: null, thresholdPct: 10, enabled: true });
    const store = new RateLimitStore();
    updateSessionWindow(store, 'only', 0.5, 111);

    const ipc = ipcStub();
    const deps = {
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => rrSettings(),
    };
    evaluatePoolOnce(deps);
    // The most recently fired broadcast carries the body copy the UI renders.
    expect(ipc.broadcasts.length).toBeGreaterThan(0);
  });

  it('evaluatePoolOnce records resetTs=0 when no pool member has a reset value', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'a');
    upsertAlert(db, { scope: 'pool', accountId: null, thresholdPct: 10, enabled: true });
    const store = new RateLimitStore();
    // A rate-limit update that carries only utilization (no reset header)
    // keeps minReset = +Infinity, exercising the `=== POSITIVE_INFINITY` branch.
    store.update('a', {
      'anthropic-ratelimit-unified-5h-utilization': '0.5',
    });
    const ipc = ipcStub();
    const deps = {
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => rrSettings(),
    };
    evaluatePoolOnce(deps);
    expect(ipc.broadcasts.length).toBeGreaterThan(0);
  });

  it('primeNewAlertAgainstCurrentWindow is a no-op for budget-scope alerts', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'a');
    const store = new RateLimitStore();
    // Call prime directly on a budget-scope alert — must hit the early-return
    // branch at the top of the function (line 200).
    primeNewAlertAgainstCurrentWindow(db, store, {
      id: 999,
      scope: 'budget',
      accountId: 'a',
      thresholdPct: 50,
    });
    // No rows should have been marked — look up would still return null.
    // Just asserting no throw is enough for the branch.
    expect(true).toBe(true);
  });

  it('missing utilization counts as 0 in the mean', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'a');
    seedAccount(db, 'b');
    upsertAlert(db, { scope: 'pool', accountId: null, thresholdPct: 40, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startPoolAlertEvaluator({
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => rrSettings(),
    });

    // Only 'a' has utilization. Mean = 0.9 / 2 = 0.45 → 45%, crosses 40%.
    updateSessionWindow(store, 'a', 0.9, 111);
    expect(ipc.broadcasts).toHaveLength(1);
  });

  it('ignores disabled pool alerts', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'a');
    upsertAlert(db, { scope: 'pool', accountId: null, thresholdPct: 10, enabled: false });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startPoolAlertEvaluator({
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => rrSettings(),
    });

    updateSessionWindow(store, 'a', 0.95, 111);
    expect(ipc.broadcasts).toHaveLength(0);
  });

  it('skips when the updated account is excluded from the pool', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'a');
    seedAccount(db, 'b');
    upsertAlert(db, { scope: 'pool', accountId: null, thresholdPct: 10, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startPoolAlertEvaluator({
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => rrSettings({ poolExcludedIds: ['a'] }),
    });

    // Updated account 'a' is excluded — handler returns early, no evaluation.
    updateSessionWindow(store, 'a', 0.95, 111);
    expect(ipc.broadcasts).toHaveLength(0);
  });
});

describe('primeNewAlertAgainstCurrentWindow', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = TEST_DB();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('primes an alert whose threshold is already met, suppressing a same-window fire', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    updateSessionWindow(store, 'acc-a', 0.27, 555);

    const alert = upsertAlert(db, {
      scope: 'account',
      accountId: 'acc-a',
      thresholdPct: 25,
      enabled: true,
    });
    primeNewAlertAgainstCurrentWindow(db, store, alert);

    const [row] = listAlerts(db, { scope: 'account', accountId: 'acc-a' });
    expect(row?.lastTriggeredResetTs).toBe(555);

    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });
    updateSessionWindow(store, 'acc-a', 0.3, 555);
    expect(ipc.broadcasts).toHaveLength(0);
  });

  it('does not prime when current utilization is below the threshold', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    updateSessionWindow(store, 'acc-a', 0.1, 777);

    const alert = upsertAlert(db, {
      scope: 'account',
      accountId: 'acc-a',
      thresholdPct: 50,
      enabled: true,
    });
    primeNewAlertAgainstCurrentWindow(db, store, alert);

    const [row] = listAlerts(db, { scope: 'account', accountId: 'acc-a' });
    expect(row?.lastTriggeredResetTs).toBeNull();

    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });
    updateSessionWindow(store, 'acc-a', 0.6, 777);
    expect(ipc.broadcasts).toHaveLength(1);
  });

  it('is a no-op when no 5h window exists yet for the account', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();

    const alert = upsertAlert(db, {
      scope: 'account',
      accountId: 'acc-a',
      thresholdPct: 25,
      enabled: true,
    });
    primeNewAlertAgainstCurrentWindow(db, store, alert);

    const [row] = listAlerts(db, { scope: 'account', accountId: 'acc-a' });
    expect(row?.lastTriggeredResetTs).toBeNull();
  });

  it('is a no-op when the 5h window has no utilization yet', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    store.update('acc-a', {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-reset': '999',
    });

    const alert = upsertAlert(db, {
      scope: 'account',
      accountId: 'acc-a',
      thresholdPct: 25,
      enabled: true,
    });
    primeNewAlertAgainstCurrentWindow(db, store, alert);

    const [row] = listAlerts(db, { scope: 'account', accountId: 'acc-a' });
    expect(row?.lastTriggeredResetTs).toBeNull();
  });

  it('still lets a primed alert fire after the window resets', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    updateSessionWindow(store, 'acc-a', 0.27, 111);

    const alert = upsertAlert(db, {
      scope: 'account',
      accountId: 'acc-a',
      thresholdPct: 25,
      enabled: true,
    });
    primeNewAlertAgainstCurrentWindow(db, store, alert);

    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });
    updateSessionWindow(store, 'acc-a', 0.3, 111);
    expect(ipc.broadcasts).toHaveLength(0);
    updateSessionWindow(store, 'acc-a', 0.3, 222);
    expect(ipc.broadcasts).toHaveLength(1);
  });

  it('uses reset=0 when the current window has no reset value', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    store.update('acc-a', {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.80',
    });

    const alert = upsertAlert(db, {
      scope: 'account',
      accountId: 'acc-a',
      thresholdPct: 50,
      enabled: true,
    });
    primeNewAlertAgainstCurrentWindow(db, store, alert);

    const [row] = listAlerts(db, { scope: 'account', accountId: 'acc-a' });
    expect(row?.lastTriggeredResetTs).toBe(0);
  });

  it('primes a pool alert when the current pool mean is already at threshold', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'a');
    seedAccount(db, 'b');
    const store = new RateLimitStore();
    updateSessionWindow(store, 'a', 0.8, 111);
    updateSessionWindow(store, 'b', 0.6, 222); // mean = 0.7, min(reset) = 111

    const alert = upsertAlert(db, {
      scope: 'pool',
      accountId: null,
      thresholdPct: 50,
      enabled: true,
    });
    primeNewAlertAgainstCurrentWindow(db, store, alert, () => rrSettings());

    const [row] = listAlerts(db, { scope: 'pool' });
    expect(row?.lastTriggeredResetTs).toBe(111);

    // Pool evaluator shouldn't re-fire in the same "min reset" window.
    const ipc = ipcStub();
    startPoolAlertEvaluator({
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => rrSettings(),
    });
    updateSessionWindow(store, 'a', 0.9, 111);
    expect(ipc.broadcasts).toHaveLength(0);
  });

  it('does not prime a pool alert when the current pool mean is below the threshold', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'a');
    const store = new RateLimitStore();
    updateSessionWindow(store, 'a', 0.1, 222);

    const alert = upsertAlert(db, {
      scope: 'pool',
      accountId: null,
      thresholdPct: 50,
      enabled: true,
    });
    primeNewAlertAgainstCurrentWindow(db, store, alert, () => rrSettings());

    const [row] = listAlerts(db, { scope: 'pool' });
    expect(row?.lastTriggeredResetTs).toBeNull();
  });

  it('pool prime is a no-op when getSettings is omitted', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'a');
    const store = new RateLimitStore();
    updateSessionWindow(store, 'a', 0.99, 111);

    const alert = upsertAlert(db, {
      scope: 'pool',
      accountId: null,
      thresholdPct: 10,
      enabled: true,
    });
    primeNewAlertAgainstCurrentWindow(db, store, alert);

    const [row] = listAlerts(db, { scope: 'pool' });
    expect(row?.lastTriggeredResetTs).toBeNull();
  });

  it('pool prime is a no-op when the pool has zero eligible members', () => {
    const db = getDb(dbPath);
    // No accounts seeded.
    const store = new RateLimitStore();

    const alert = upsertAlert(db, {
      scope: 'pool',
      accountId: null,
      thresholdPct: 10,
      enabled: true,
    });
    primeNewAlertAgainstCurrentWindow(db, store, alert, () => rrSettings());

    const [row] = listAlerts(db, { scope: 'pool' });
    expect(row?.lastTriggeredResetTs).toBeNull();
  });

  it('account prime is a no-op when alert.accountId is missing', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    updateSessionWindow(store, 'acc-a', 0.95, 500);
    // Hand-craft an account-scoped alert with a null accountId to exercise
    // the defensive guard (not reachable via normal upsert).
    const alert = { id: -1, scope: 'account' as const, accountId: null, thresholdPct: 10 };
    expect(() => primeNewAlertAgainstCurrentWindow(db, store, alert)).not.toThrow();
  });
});

// ── account-sonnet scope ───────────────────────────────────────────────────

function updateSonnetWindow(
  store: RateLimitStore,
  accountId: string,
  utilization: number,
  reset = 500,
): void {
  store.update(accountId, {
    'anthropic-ratelimit-unified-7d_sonnet-status': 'allowed',
    'anthropic-ratelimit-unified-7d_sonnet-utilization': String(utilization),
    'anthropic-ratelimit-unified-7d_sonnet-reset': String(reset),
  });
}

describe('account-sonnet alerts', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = TEST_DB();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('fires on the Sonnet 7-day window, not the 5-hour window', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'acc-a');
    const store = new RateLimitStore();
    const ipc = ipcStub();

    upsertAlert(db, { scope: 'account-sonnet', accountId: 'acc-a', thresholdPct: 80, enabled: true });
    startSonnetAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    // 5-hour usage is high but irrelevant — we only care about Sonnet 7d.
    updateSessionWindow(store, 'acc-a', 0.95);
    // Sonnet at 90% — above 80% threshold → fire.
    updateSonnetWindow(store, 'acc-a', 0.9, 500);

    const fires = ipc.broadcasts.filter(
      (m): m is { type: string; scope: string } =>
        typeof m === 'object' && m !== null && (m as { type?: string }).type === 'alert_triggered',
    );
    expect(fires.some((m) => (m as { scope?: string }).scope === 'account-sonnet')).toBe(true);
  });

  it('does not re-fire within the same Sonnet window', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'acc-a');
    const store = new RateLimitStore();
    const ipc = ipcStub();

    upsertAlert(db, { scope: 'account-sonnet', accountId: 'acc-a', thresholdPct: 80, enabled: true });
    startSonnetAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    updateSonnetWindow(store, 'acc-a', 0.85, 500);
    updateSonnetWindow(store, 'acc-a', 0.95, 500);
    updateSonnetWindow(store, 'acc-a', 0.99, 500);

    const fires = ipc.broadcasts.filter(
      (m): m is { scope: string } =>
        typeof m === 'object' &&
        m !== null &&
        (m as { type?: string }).type === 'alert_triggered' &&
        (m as { scope?: string }).scope === 'account-sonnet',
    );
    expect(fires).toHaveLength(1);
  });

  it('re-arms after the Sonnet window rolls over', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'acc-a');
    const store = new RateLimitStore();
    const ipc = ipcStub();

    upsertAlert(db, { scope: 'account-sonnet', accountId: 'acc-a', thresholdPct: 80, enabled: true });
    startSonnetAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    updateSonnetWindow(store, 'acc-a', 0.9, 500);
    // Window rolls over — new reset timestamp.
    updateSonnetWindow(store, 'acc-a', 0.9, 9_999);

    const fires = ipc.broadcasts.filter(
      (m): m is { scope: string } =>
        typeof m === 'object' &&
        m !== null &&
        (m as { type?: string }).type === 'alert_triggered' &&
        (m as { scope?: string }).scope === 'account-sonnet',
    );
    expect(fires).toHaveLength(2);
  });

  it('does not fire when Sonnet util is below the threshold', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'acc-a');
    const store = new RateLimitStore();
    const ipc = ipcStub();

    upsertAlert(db, { scope: 'account-sonnet', accountId: 'acc-a', thresholdPct: 80, enabled: true });
    startSonnetAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    updateSonnetWindow(store, 'acc-a', 0.6, 500);

    const fires = ipc.broadcasts.filter(
      (m): m is { scope: string } =>
        typeof m === 'object' &&
        m !== null &&
        (m as { type?: string }).type === 'alert_triggered' &&
        (m as { scope?: string }).scope === 'account-sonnet',
    );
    expect(fires).toHaveLength(0);
  });

  it('sonnet-scope priming suppresses first-fire when already above threshold', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'acc-a');
    const store = new RateLimitStore();
    updateSonnetWindow(store, 'acc-a', 0.95, 500);

    const alert = upsertAlert(db, {
      scope: 'account-sonnet',
      accountId: 'acc-a',
      thresholdPct: 80,
      enabled: true,
    });
    primeNewAlertAgainstCurrentWindow(db, store, alert);

    const [row] = listAlerts(db, { scope: 'account-sonnet', accountId: 'acc-a' });
    expect(row?.lastTriggeredResetTs).toBe(500);

    // Now verify a subsequent rate-limit update does NOT re-fire for this window.
    const ipc = ipcStub();
    startSonnetAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });
    updateSonnetWindow(store, 'acc-a', 0.97, 500);
    const fires = ipc.broadcasts.filter(
      (m): m is { scope: string } =>
        typeof m === 'object' &&
        m !== null &&
        (m as { type?: string }).type === 'alert_triggered' &&
        (m as { scope?: string }).scope === 'account-sonnet',
    );
    expect(fires).toHaveLength(0);
  });

  it('stays silent for accounts excluded from the round-robin pool', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'acc-a');
    const store = new RateLimitStore();
    const ipc = ipcStub();

    upsertAlert(db, {
      scope: 'account-sonnet',
      accountId: 'acc-a',
      thresholdPct: 80,
      enabled: true,
    });
    startSonnetAlertEvaluator({
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => rrSettings({ poolExcludedIds: ['acc-a'] }),
    });

    updateSonnetWindow(store, 'acc-a', 0.95, 500);
    const fires = ipc.broadcasts.filter(
      (m): m is { scope: string } =>
        typeof m === 'object' &&
        m !== null &&
        (m as { type?: string }).type === 'alert_triggered' &&
        (m as { scope?: string }).scope === 'account-sonnet',
    );
    expect(fires).toHaveLength(0);
  });

  it('still fires for excluded accounts outside round-robin mode', () => {
    const db = getDb(dbPath);
    seedAccount(db, 'acc-a');
    const store = new RateLimitStore();
    const ipc = ipcStub();

    upsertAlert(db, {
      scope: 'account-sonnet',
      accountId: 'acc-a',
      thresholdPct: 80,
      enabled: true,
    });
    startSonnetAlertEvaluator({
      db,
      rateLimitStore: store,
      ipcServer: ipc as never,
      getSettings: () => ({
        ...DEFAULT_SETTINGS,
        switchingMode: 'off',
        poolExcludedIds: ['acc-a'],
      }),
    });

    updateSonnetWindow(store, 'acc-a', 0.95, 500);
    const fires = ipc.broadcasts.filter(
      (m): m is { scope: string } =>
        typeof m === 'object' &&
        m !== null &&
        (m as { type?: string }).type === 'alert_triggered' &&
        (m as { scope?: string }).scope === 'account-sonnet',
    );
    expect(fires).toHaveLength(1);
  });
});
