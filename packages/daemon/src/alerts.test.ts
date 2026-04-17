import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import { getDb, closeDb, upsertAlert, listAlerts, deleteAlert, markAlertTriggered, listNotifications } from './db.js';
import { RateLimitStore } from './rate-limit-store.js';
import { startAlertEvaluator } from './alerts.js';

const TEST_DB = () => join(tmpdir(), `sentinel-alerts-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function ipcStub() {
  const broadcasts: unknown[] = [];
  return {
    broadcast: (m: unknown) => broadcasts.push(m),
    broadcasts,
  };
}

function updateSessionWindow(store: RateLimitStore, accountId: string, utilization: number, reset = 123456): void {
  store.update(accountId, {
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': String(utilization),
    'anthropic-ratelimit-unified-5h-reset': String(reset),
  });
}

describe('alerts CRUD', () => {
  let dbPath: string;

  beforeEach(() => { dbPath = TEST_DB(); });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('creates, lists, and deletes alerts', () => {
    const db = getDb(dbPath);
    const alert = upsertAlert(db, { accountId: 'acc-a', thresholdPct: 80, enabled: true });
    expect(alert.id).toBeGreaterThan(0);
    expect(alert.thresholdPct).toBe(80);
    expect(alert.enabled).toBe(true);

    const list = listAlerts(db, 'acc-a');
    expect(list).toHaveLength(1);

    const removed = deleteAlert(db, alert.id);
    expect(removed).toBe(true);
    expect(listAlerts(db, 'acc-a')).toHaveLength(0);
  });

  it('updates an existing alert in place when id is provided', () => {
    const db = getDb(dbPath);
    const created = upsertAlert(db, { accountId: 'acc-a', thresholdPct: 80, enabled: true });
    const updated = upsertAlert(db, { id: created.id, accountId: 'acc-a', thresholdPct: 50, enabled: false });
    expect(updated.id).toBe(created.id);
    expect(updated.thresholdPct).toBe(50);
    expect(updated.enabled).toBe(false);
    expect(listAlerts(db, 'acc-a')).toHaveLength(1);
  });

  it('listAlerts without accountId returns every alert', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { accountId: 'a', thresholdPct: 50, enabled: true });
    upsertAlert(db, { accountId: 'b', thresholdPct: 75, enabled: true });
    expect(listAlerts(db)).toHaveLength(2);
  });

  it('deleteAlert returns false for unknown id', () => {
    const db = getDb(dbPath);
    expect(deleteAlert(db, 9999)).toBe(false);
  });

  it('markAlertTriggered persists the reset timestamp', () => {
    const db = getDb(dbPath);
    const alert = upsertAlert(db, { accountId: 'acc-a', thresholdPct: 80, enabled: true });
    markAlertTriggered(db, alert.id, 1_000_000);
    const [row] = listAlerts(db, 'acc-a');
    expect(row?.lastTriggeredResetTs).toBe(1_000_000);
  });
});

describe('startAlertEvaluator', () => {
  let dbPath: string;

  beforeEach(() => { dbPath = TEST_DB(); });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('fires an alert when utilization crosses the threshold', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { accountId: 'acc-a', thresholdPct: 75, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    updateSessionWindow(store, 'acc-a', 0.85);

    expect(ipc.broadcasts).toHaveLength(1);
    const msg = ipc.broadcasts[0] as { type: string; accountId: string; thresholdPct: number };
    expect(msg.type).toBe('alert_triggered');
    expect(msg.accountId).toBe('acc-a');
    expect(msg.thresholdPct).toBe(75);

    const notifs = listNotifications(db, {});
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.type).toBe('usage_alert');
  });

  it('does not fire below the threshold', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { accountId: 'acc-a', thresholdPct: 75, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    updateSessionWindow(store, 'acc-a', 0.50);

    expect(ipc.broadcasts).toHaveLength(0);
  });

  it('does not re-fire within the same window (same reset)', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { accountId: 'acc-a', thresholdPct: 75, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    updateSessionWindow(store, 'acc-a', 0.85, 111);
    updateSessionWindow(store, 'acc-a', 0.95, 111);

    expect(ipc.broadcasts).toHaveLength(1);
  });

  it('re-fires after the window resets (new reset value)', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { accountId: 'acc-a', thresholdPct: 75, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    updateSessionWindow(store, 'acc-a', 0.85, 111);
    updateSessionWindow(store, 'acc-a', 0.85, 222);

    expect(ipc.broadcasts).toHaveLength(2);
  });

  it('ignores disabled alerts', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { accountId: 'acc-a', thresholdPct: 75, enabled: false });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    updateSessionWindow(store, 'acc-a', 0.95);
    expect(ipc.broadcasts).toHaveLength(0);
  });

  it('uses the account email lookup when provided', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { accountId: 'acc-a', thresholdPct: 75, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({
      db, rateLimitStore: store, ipcServer: ipc as never,
      getEmailForAccount: () => 'pretty@example.com',
    });

    updateSessionWindow(store, 'acc-a', 0.95);
    const notifs = listNotifications(db, {});
    expect(notifs[0]?.body).toContain('pretty@example.com');
  });

  it('ignores updates when the session window is missing', () => {
    const db = getDb(dbPath);
    upsertAlert(db, { accountId: 'acc-a', thresholdPct: 75, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });

    // Only a 7d window arrives; no 5h window.
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
    upsertAlert(db, { accountId: 'acc-a', thresholdPct: 50, enabled: true });
    const store = new RateLimitStore();
    const ipc = ipcStub();
    startAlertEvaluator({ db, rateLimitStore: store, ipcServer: ipc as never });
    // Update with utilization but no reset header.
    store.update('acc-a', {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.80',
    });
    expect(ipc.broadcasts).toHaveLength(1);
  });
});
