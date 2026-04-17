import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import { getDb, closeDb, upsertAccount, listNotifications } from './db.js';
import { RateLimitStore } from './rate-limit-store.js';
import { startAutoSwitch } from './auto-switch.js';
import type { OAuthAccount, Settings } from '@claude-sentinel/shared';

const TEST_DB = () => join(tmpdir(), `sentinel-auto-switch-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function seed(db: ReturnType<typeof getDb>, id: string, email: string): void {
  upsertAccount(db, {
    id, accountUuid: id, email, displayName: email, orgUuid: '', orgName: '',
    planType: 'max', isActive: false, createdAt: Date.now(),
  });
}

function makeActive(id: string, email: string): OAuthAccount {
  return {
    accountUuid: id,
    emailAddress: email,
    organizationUuid: '',
    hasExtraUsageEnabled: true,
    billingType: 'max',
    accountCreatedAt: new Date().toISOString(),
    subscriptionCreatedAt: new Date().toISOString(),
    displayName: email,
    organizationRole: 'user',
    workspaceRole: null,
    organizationName: '',
  };
}

function updateSessionWindow(store: RateLimitStore, accountId: string, utilization: number, reset = 100_000): void {
  store.update(accountId, {
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': String(utilization),
    'anthropic-ratelimit-unified-5h-reset': String(reset),
  });
}

function ipcStub() {
  const broadcasts: unknown[] = [];
  return { broadcast: (m: unknown) => broadcasts.push(m), broadcasts };
}

describe('startAutoSwitch', () => {
  let dbPath: string;

  beforeEach(() => { dbPath = TEST_DB(); });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  function settings(partial: Partial<Settings> = {}): Settings {
    return { launchAtLogin: true, switchingMode: 'auto-switch', autoSwitchThresholdPct: 80, alertSoundName: 'Glass', ...partial };
  }

  it('switches to the lowest-utilization candidate when threshold is crossed', () => {
    const db = getDb(dbPath);
    seed(db, 'active', 'active@x');
    seed(db, 'b', 'b@x');
    seed(db, 'c', 'c@x');

    const store = new RateLimitStore();
    const ipc = ipcStub();
    const performSwitch = vi.fn(() => ({ success: true as const }));

    startAutoSwitch({
      db, rateLimitStore: store, ipcServer: ipc as never,
      getSettings: () => settings(),
      getActiveAccount: () => makeActive('active', 'active@x'),
      sentinelKey: (orgUuid, accountUuid) => orgUuid || accountUuid,
      performSwitch,
    });

    // Populate candidate utilizations: b = 0.3, c = 0.1 → c wins.
    updateSessionWindow(store, 'b', 0.3);
    updateSessionWindow(store, 'c', 0.1);
    // Active account crosses threshold.
    updateSessionWindow(store, 'active', 0.9);

    expect(performSwitch).toHaveBeenCalledTimes(1);
    expect(performSwitch).toHaveBeenCalledWith('c', 'c@x');
  });

  it('does nothing when mode is not auto-switch', () => {
    const db = getDb(dbPath);
    seed(db, 'active', 'active@x');
    seed(db, 'b', 'b@x');

    const store = new RateLimitStore();
    const ipc = ipcStub();
    const performSwitch = vi.fn(() => ({ success: true as const }));

    startAutoSwitch({
      db, rateLimitStore: store, ipcServer: ipc as never,
      getSettings: () => settings({ switchingMode: 'off' }),
      getActiveAccount: () => makeActive('active', 'active@x'),
      sentinelKey: (o, a) => o || a,
      performSwitch,
    });

    updateSessionWindow(store, 'active', 0.99);
    expect(performSwitch).not.toHaveBeenCalled();
  });

  it('ignores updates for non-active accounts', () => {
    const db = getDb(dbPath);
    seed(db, 'active', 'active@x');
    seed(db, 'b', 'b@x');

    const store = new RateLimitStore();
    const ipc = ipcStub();
    const performSwitch = vi.fn(() => ({ success: true as const }));

    startAutoSwitch({
      db, rateLimitStore: store, ipcServer: ipc as never,
      getSettings: () => settings(),
      getActiveAccount: () => makeActive('active', 'active@x'),
      sentinelKey: (o, a) => o || a,
      performSwitch,
    });

    // Only non-active account updates — should never switch.
    updateSessionWindow(store, 'b', 0.99);
    expect(performSwitch).not.toHaveBeenCalled();
  });

  it('broadcasts all_accounts_exhausted when no candidate is below threshold', () => {
    const db = getDb(dbPath);
    seed(db, 'active', 'active@x');
    seed(db, 'b', 'b@x');

    const store = new RateLimitStore();
    const ipc = ipcStub();
    const performSwitch = vi.fn(() => ({ success: true as const }));

    startAutoSwitch({
      db, rateLimitStore: store, ipcServer: ipc as never,
      getSettings: () => settings(),
      getActiveAccount: () => makeActive('active', 'active@x'),
      sentinelKey: (o, a) => o || a,
      performSwitch,
    });

    updateSessionWindow(store, 'b', 0.95, 555);
    updateSessionWindow(store, 'active', 0.95, 555);

    expect(performSwitch).not.toHaveBeenCalled();
    const exhausted = ipc.broadcasts.find((b: unknown) => (b as { type: string }).type === 'all_accounts_exhausted');
    expect(exhausted).toBeDefined();
    // Also persisted to notifications.
    const notifs = listNotifications(db, {});
    expect(notifs.find((n) => n.type === 'all_accounts_exhausted')).toBeDefined();
  });

  it('dedupes exhaustion broadcasts within the same window', () => {
    const db = getDb(dbPath);
    seed(db, 'active', 'active@x');
    seed(db, 'b', 'b@x');

    const store = new RateLimitStore();
    const ipc = ipcStub();
    const performSwitch = vi.fn(() => ({ success: true as const }));

    startAutoSwitch({
      db, rateLimitStore: store, ipcServer: ipc as never,
      getSettings: () => settings(),
      getActiveAccount: () => makeActive('active', 'active@x'),
      sentinelKey: (o, a) => o || a,
      performSwitch,
    });

    updateSessionWindow(store, 'b', 0.95, 777);
    updateSessionWindow(store, 'active', 0.95, 777);
    updateSessionWindow(store, 'active', 0.97, 777);

    const exhausted = ipc.broadcasts.filter((b: unknown) => (b as { type: string }).type === 'all_accounts_exhausted');
    expect(exhausted).toHaveLength(1);
  });

  it('re-fires exhaustion notice after the window resets', () => {
    const db = getDb(dbPath);
    seed(db, 'active', 'active@x');
    seed(db, 'b', 'b@x');

    const store = new RateLimitStore();
    const ipc = ipcStub();
    const performSwitch = vi.fn(() => ({ success: true as const }));

    startAutoSwitch({
      db, rateLimitStore: store, ipcServer: ipc as never,
      getSettings: () => settings(),
      getActiveAccount: () => makeActive('active', 'active@x'),
      sentinelKey: (o, a) => o || a,
      performSwitch,
    });

    updateSessionWindow(store, 'b', 0.95, 111);
    updateSessionWindow(store, 'active', 0.95, 111);
    updateSessionWindow(store, 'b', 0.95, 222);
    updateSessionWindow(store, 'active', 0.95, 222);

    const exhausted = ipc.broadcasts.filter((b: unknown) => (b as { type: string }).type === 'all_accounts_exhausted');
    expect(exhausted).toHaveLength(2);
  });

  it('skips blocked candidates when picking a target', () => {
    const db = getDb(dbPath);
    seed(db, 'active', 'active@x');
    seed(db, 'b', 'b@x'); // low utilization but will be blocked
    seed(db, 'c', 'c@x'); // higher utilization but allowed

    const store = new RateLimitStore();
    const ipc = ipcStub();
    const performSwitch = vi.fn(() => ({ success: true as const }));

    startAutoSwitch({
      db, rateLimitStore: store, ipcServer: ipc as never,
      getSettings: () => settings(),
      getActiveAccount: () => makeActive('active', 'active@x'),
      sentinelKey: (o, a) => o || a,
      performSwitch,
    });

    store.update('b', {
      'anthropic-ratelimit-unified-5h-status': 'blocked',
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
    });
    updateSessionWindow(store, 'c', 0.4);
    updateSessionWindow(store, 'active', 0.95);

    expect(performSwitch).toHaveBeenCalledWith('c', 'c@x');
  });

  it('does nothing when no active account is present', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    const store = new RateLimitStore();
    const ipc = ipcStub();
    const performSwitch = vi.fn(() => ({ success: true as const }));
    startAutoSwitch({
      db, rateLimitStore: store, ipcServer: ipc as never,
      getSettings: () => settings(),
      getActiveAccount: () => null,
      sentinelKey: (o, a) => o || a,
      performSwitch,
    });
    updateSessionWindow(store, 'a', 0.99);
    expect(performSwitch).not.toHaveBeenCalled();
  });

  it('returns a callable disposer', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const ipc = ipcStub();
    const dispose = startAutoSwitch({
      db, rateLimitStore: store, ipcServer: ipc as never,
      getSettings: () => settings(),
      getActiveAccount: () => null,
      sentinelKey: (o, a) => o || a,
      performSwitch: () => ({ success: true as const }),
    });
    expect(typeof dispose).toBe('function');
    // Invoking it is a no-op and must not throw.
    dispose();
  });

  it('ignores updates when unified-5h is missing for active account', () => {
    const db = getDb(dbPath);
    seed(db, 'active', 'active@x');
    const store = new RateLimitStore();
    const ipc = ipcStub();
    const performSwitch = vi.fn(() => ({ success: true as const }));
    startAutoSwitch({
      db, rateLimitStore: store, ipcServer: ipc as never,
      getSettings: () => settings(),
      getActiveAccount: () => makeActive('active', 'active@x'),
      sentinelKey: (o, a) => o || a,
      performSwitch,
    });
    // Only a 7d window — no 5h window present.
    store.update('active', {
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.99',
    });
    expect(performSwitch).not.toHaveBeenCalled();
  });

  it('logs but does not throw when performSwitch reports failure', () => {
    const db = getDb(dbPath);
    seed(db, 'active', 'active@x');
    seed(db, 'b', 'b@x');
    const store = new RateLimitStore();
    const ipc = ipcStub();
    const performSwitch = vi.fn(() => ({ success: false as const, error: 'no creds' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    startAutoSwitch({
      db, rateLimitStore: store, ipcServer: ipc as never,
      getSettings: () => settings(),
      getActiveAccount: () => makeActive('active', 'active@x'),
      sentinelKey: (o, a) => o || a,
      performSwitch,
    });

    updateSessionWindow(store, 'b', 0.1);
    updateSessionWindow(store, 'active', 0.95);

    expect(performSwitch).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
