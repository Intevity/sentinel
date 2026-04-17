import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync, rmdirSync } from 'fs';
import Database from 'better-sqlite3';
import {
  getDb,
  closeDb,
  upsertAccount,
  getAccount,
  listAccounts,
  deleteAccount,
  markAccountRemoved,
  purgeAccount,
  hasNonPurgedAccount,
  insertUsageEvent,
  getUsageEvents,
  getTodayUsageSummary,
  insertOverageEvent,
  getOverageEvents,
  insertNotification,
  acknowledgeNotification,
  listNotifications,
  upsertRateLimit,
  loadRateLimits,
  deleteRateLimitsForAccount,
} from './db.js';
import type { AccountInfo, RateLimitWindow } from '@claude-sentinel/shared';

const TEST_DB = join(tmpdir(), `sentinel-test-${Date.now()}.db`);

function makeTestDb(): Database.Database {
  return getDb(TEST_DB);
}

describe('Database initialization', () => {
  afterEach(() => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('creates directory if it does not exist', () => {
    // Use a nested path that doesn't exist
    const subDir = join(tmpdir(), `sentinel-nested-${Date.now()}`);
    const nestedDb = join(subDir, 'test.db');
    try {
      const db = getDb(nestedDb);
      expect(existsSync(nestedDb)).toBe(true);
      db.close();
      closeDb();
    } finally {
      if (existsSync(nestedDb)) unlinkSync(nestedDb);
      if (existsSync(subDir)) rmdirSync(subDir);
    }
  });

  it('reuses existing connection', () => {
    const db1 = getDb(TEST_DB);
    const db2 = getDb(TEST_DB);
    expect(db1).toBe(db2);
  });
});

describe('Database', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    closeDb();
    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
  });

  describe('accounts', () => {
    const account: AccountInfo = {
      id: 'uuid-1',
      accountUuid: 'uuid-1',
      email: 'test@example.com',
      displayName: 'Test User',
      orgUuid: 'org-1',
      orgName: 'Test Org',
      planType: 'pro',
      isActive: false,
      createdAt: 1700000000000,
    };

    it('inserts and retrieves an account', () => {
      upsertAccount(db, account);
      const found = getAccount(db, 'uuid-1');
      expect(found).not.toBeNull();
      expect(found?.email).toBe('test@example.com');
      expect(found?.displayName).toBe('Test User');
      expect(found?.planType).toBe('pro');
    });

    it('upserts (updates) an existing account', () => {
      upsertAccount(db, account);
      upsertAccount(db, { ...account, displayName: 'Updated Name' });
      const found = getAccount(db, 'uuid-1');
      expect(found?.displayName).toBe('Updated Name');
    });

    it('returns null for unknown account', () => {
      expect(getAccount(db, 'nonexistent')).toBeNull();
    });

    it('lists all accounts sorted by email', () => {
      upsertAccount(db, { ...account, id: 'uuid-2', accountUuid: 'uuid-2', email: 'b@example.com' });
      upsertAccount(db, { ...account, id: 'uuid-1', accountUuid: 'uuid-1', email: 'a@example.com' });
      const accounts = listAccounts(db);
      expect(accounts).toHaveLength(2);
      expect(accounts[0]?.email).toBe('a@example.com');
      expect(accounts[1]?.email).toBe('b@example.com');
    });

    it('returns empty array when no accounts', () => {
      expect(listAccounts(db)).toEqual([]);
    });

    it('stores accountUuid separately from id', () => {
      upsertAccount(db, account);
      const found = getAccount(db, 'uuid-1');
      expect(found?.id).toBe('uuid-1');
      expect(found?.accountUuid).toBe('uuid-1');
    });

    it('allows two entries with the same accountUuid but different ids (same user, different orgs)', () => {
      const teamAccount: AccountInfo = {
        ...account,
        id: 'team-org-uuid',
        accountUuid: 'shared-user-uuid',
        orgUuid: 'team-org-uuid',
        planType: 'team',
      };
      const maxAccount: AccountInfo = {
        ...account,
        id: 'max-org-uuid',
        accountUuid: 'shared-user-uuid',
        orgUuid: 'max-org-uuid',
        planType: 'max',
      };
      upsertAccount(db, teamAccount);
      upsertAccount(db, maxAccount);
      const accounts = listAccounts(db);
      expect(accounts).toHaveLength(2);
      expect(accounts.map((a) => a.planType).sort()).toEqual(['max', 'team']);
      expect(accounts.every((a) => a.accountUuid === 'shared-user-uuid')).toBe(true);
    });

    it('falls back to id for accountUuid when migrating legacy rows', () => {
      // Simulate a pre-migration row by inserting without account_uuid
      db.prepare('INSERT INTO accounts (id, email, display_name, org_uuid, org_name, plan_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('legacy-id', 'legacy@example.com', 'Legacy', '', '', 'pro', Date.now());
      const found = getAccount(db, 'legacy-id');
      expect(found?.accountUuid).toBe('legacy-id');
    });

    it('deletes an account by id', () => {
      upsertAccount(db, account);
      expect(getAccount(db, 'uuid-1')).not.toBeNull();
      const deleted = deleteAccount(db, 'uuid-1');
      expect(deleted).toBe(true);
      expect(getAccount(db, 'uuid-1')).toBeNull();
    });

    it('returns false when deleting a non-existent account', () => {
      expect(deleteAccount(db, 'no-such-id')).toBe(false);
    });

    describe('hasNonPurgedAccount', () => {
      it('returns false for a row that does not exist', () => {
        expect(hasNonPurgedAccount(db, 'no-such-id')).toBe(false);
      });

      it('returns true for an active account (removed=0)', () => {
        upsertAccount(db, account);
        expect(hasNonPurgedAccount(db, 'uuid-1')).toBe(true);
      });

      it('returns true for a soft-removed account (removed=1)', () => {
        upsertAccount(db, account);
        markAccountRemoved(db, 'uuid-1');
        expect(hasNonPurgedAccount(db, 'uuid-1')).toBe(true);
      });

      it('returns false for a hard-purged tombstone (removed=2)', () => {
        upsertAccount(db, account);
        purgeAccount(db, 'uuid-1');
        expect(hasNonPurgedAccount(db, 'uuid-1')).toBe(false);
      });
    });
  });

  describe('usage events', () => {
    it('inserts and retrieves usage events', () => {
      const id = insertUsageEvent(db, {
        ts: 1700000000000,
        accountId: 'acc-1',
        sessionId: 'sess-1',
        model: 'claude-opus-4',
        costUsd: 0.05,
        inputTokens: 1000,
        outputTokens: 500,
        cacheRead: null,
        cacheCreate: null,
        durationMs: 1200,
      });
      expect(id).toBeGreaterThan(0);

      const events = getUsageEvents(db, { accountId: 'acc-1' });
      expect(events).toHaveLength(1);
      expect(events[0]?.model).toBe('claude-opus-4');
      expect(events[0]?.costUsd).toBe(0.05);
      expect(events[0]?.inputTokens).toBe(1000);
    });

    it('filters by account', () => {
      insertUsageEvent(db, { ts: Date.now(), accountId: 'acc-1', sessionId: null, model: 'claude-sonnet-4-6', costUsd: 0.01, inputTokens: 100, outputTokens: 50, cacheRead: null, cacheCreate: null, durationMs: null });
      insertUsageEvent(db, { ts: Date.now(), accountId: 'acc-2', sessionId: null, model: 'claude-haiku-4', costUsd: 0.001, inputTokens: 100, outputTokens: 50, cacheRead: null, cacheCreate: null, durationMs: null });

      const acc1Events = getUsageEvents(db, { accountId: 'acc-1' });
      expect(acc1Events).toHaveLength(1);
      expect(acc1Events[0]?.accountId).toBe('acc-1');
    });

    it('filters by sinceTs', () => {
      const past = Date.now() - 10000;
      const now = Date.now();
      insertUsageEvent(db, { ts: past - 1000, accountId: 'acc-1', sessionId: null, model: 'm', costUsd: null, inputTokens: null, outputTokens: null, cacheRead: null, cacheCreate: null, durationMs: null });
      insertUsageEvent(db, { ts: now, accountId: 'acc-1', sessionId: null, model: 'm', costUsd: null, inputTokens: null, outputTokens: null, cacheRead: null, cacheCreate: null, durationMs: null });

      const events = getUsageEvents(db, { sinceTs: past });
      expect(events).toHaveLength(1);
      expect(events[0]?.ts).toBe(now);
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        insertUsageEvent(db, { ts: Date.now() + i, accountId: 'acc-1', sessionId: null, model: 'm', costUsd: null, inputTokens: null, outputTokens: null, cacheRead: null, cacheCreate: null, durationMs: null });
      }
      const events = getUsageEvents(db, { limit: 3 });
      expect(events).toHaveLength(3);
    });
  });

  describe('getTodayUsageSummary', () => {
    it('returns zeros for account with no usage', () => {
      const summary = getTodayUsageSummary(db, 'acc-1');
      expect(summary.costUsd).toBe(0);
      expect(summary.tokens).toBe(0);
      expect(summary.sessionCount).toBe(0);
    });

    it('sums today usage correctly', () => {
      const now = Date.now();
      insertUsageEvent(db, { ts: now, accountId: 'acc-1', sessionId: 'sess-1', model: 'm', costUsd: 0.05, inputTokens: 1000, outputTokens: 500, cacheRead: null, cacheCreate: null, durationMs: null });
      insertUsageEvent(db, { ts: now, accountId: 'acc-1', sessionId: 'sess-1', model: 'm', costUsd: 0.03, inputTokens: 500, outputTokens: 200, cacheRead: null, cacheCreate: null, durationMs: null });

      const summary = getTodayUsageSummary(db, 'acc-1');
      expect(summary.costUsd).toBeCloseTo(0.08);
      expect(summary.tokens).toBe(2200);
      expect(summary.sessionCount).toBe(1); // same session_id
    });

    it('counts distinct sessions', () => {
      const now = Date.now();
      insertUsageEvent(db, { ts: now, accountId: 'acc-1', sessionId: 'sess-1', model: 'm', costUsd: 0.01, inputTokens: 100, outputTokens: 50, cacheRead: null, cacheCreate: null, durationMs: null });
      insertUsageEvent(db, { ts: now, accountId: 'acc-1', sessionId: 'sess-2', model: 'm', costUsd: 0.01, inputTokens: 100, outputTokens: 50, cacheRead: null, cacheCreate: null, durationMs: null });

      const summary = getTodayUsageSummary(db, 'acc-1');
      expect(summary.sessionCount).toBe(2);
    });

  it('handles null cost_usd in usage events gracefully', () => {
    const now = Date.now();
    insertUsageEvent(db, { ts: now, accountId: 'acc-null', sessionId: null, model: 'm', costUsd: null, inputTokens: null, outputTokens: null, cacheRead: null, cacheCreate: null, durationMs: null });

    const summary = getTodayUsageSummary(db, 'acc-null');
    expect(summary.costUsd).toBe(0);
    expect(summary.tokens).toBe(0);
    // COUNT(DISTINCT session_id) ignores NULLs in SQLite, so null sessionId → 0
    expect(summary.sessionCount).toBe(0);
  });
  });

  describe('overage events', () => {
    it('inserts and retrieves overage events', () => {
      const id = insertOverageEvent(db, {
        ts: Date.now(),
        accountId: 'acc-1',
        transition: 'entered',
        status: 'active',
        resetsAt: 1776700800,
        disabledReason: null,
      });
      expect(id).toBeGreaterThan(0);

      const events = getOverageEvents(db, { accountId: 'acc-1' });
      expect(events).toHaveLength(1);
      expect(events[0]?.transition).toBe('entered');
      expect(events[0]?.resetsAt).toBe(1776700800);
    });

    it('filters by account', () => {
      insertOverageEvent(db, { ts: Date.now(), accountId: 'acc-1', transition: 'entered', status: 'active', resetsAt: null, disabledReason: null });
      insertOverageEvent(db, { ts: Date.now(), accountId: 'acc-2', transition: 'entered', status: 'active', resetsAt: null, disabledReason: null });

      const events = getOverageEvents(db, { accountId: 'acc-1' });
      expect(events).toHaveLength(1);
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        insertOverageEvent(db, { ts: Date.now(), accountId: 'acc-1', transition: 'entered', status: 'active', resetsAt: null, disabledReason: null });
      }
      const events = getOverageEvents(db, { limit: 2 });
      expect(events).toHaveLength(2);
    });
  });

  describe('notifications', () => {
    it('inserts and lists notifications', () => {
      const id = insertNotification(db, {
        ts: Date.now(),
        accountId: 'acc-1',
        type: 'overage_entered',
        title: 'Overage started',
        body: 'You are now using overage',
      });
      expect(id).toBeGreaterThan(0);

      const notifs = listNotifications(db, {});
      expect(notifs).toHaveLength(1);
      expect(notifs[0]?.title).toBe('Overage started');
      expect(notifs[0]?.acknowledged).toBe(false);
    });

    it('acknowledges a notification', () => {
      const id = insertNotification(db, {
        ts: Date.now(),
        accountId: null,
        type: 'account_switched',
        title: 'Switched',
        body: 'Account switched',
      });

      const ok = acknowledgeNotification(db, id);
      expect(ok).toBe(true);

      const notifs = listNotifications(db, { unacknowledgedOnly: true });
      expect(notifs).toHaveLength(0);
    });

    it('returns false when acknowledging nonexistent notification', () => {
      expect(acknowledgeNotification(db, 9999)).toBe(false);
    });

    it('filters unacknowledged only', () => {
      const id1 = insertNotification(db, { ts: Date.now(), accountId: null, type: 'overage_entered', title: 'T1', body: 'B1' });
      insertNotification(db, { ts: Date.now(), accountId: null, type: 'overage_entered', title: 'T2', body: 'B2' });
      acknowledgeNotification(db, id1);

      const unacked = listNotifications(db, { unacknowledgedOnly: true });
      expect(unacked).toHaveLength(1);
      expect(unacked[0]?.title).toBe('T2');
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        insertNotification(db, { ts: Date.now(), accountId: null, type: 'account_switched', title: `T${i}`, body: 'B' });
      }
      const limited = listNotifications(db, { limit: 3 });
      expect(limited).toHaveLength(3);
    });
  });

  // ── Rate limit queries ────────────────────────────────────────────────────────

  describe('upsertRateLimit / loadRateLimits', () => {
    it('persists and reloads a subscription window', () => {
      const win: RateLimitWindow = {
        name: 'unified-5h',
        status: 'allowed',
        utilization: 0.42,
        limit: null,
        remaining: null,
        reset: 1776362400,
        lastUpdated: Date.now(),
      };
      upsertRateLimit(db, 'acc-1', win);

      const result = loadRateLimits(db);
      const windows = result.get('acc-1');
      expect(windows).toHaveLength(1);
      expect(windows?.[0]?.name).toBe('unified-5h');
      expect(windows?.[0]?.utilization).toBeCloseTo(0.42);
      expect(windows?.[0]?.reset).toBe(1776362400);
      expect(windows?.[0]?.status).toBe('allowed');
    });

    it('persists and reloads an API-key window', () => {
      const win: RateLimitWindow = {
        name: 'tokens',
        status: null,
        utilization: null,
        limit: 40000,
        remaining: 39500,
        reset: 1776362400,
        lastUpdated: Date.now(),
      };
      upsertRateLimit(db, 'acc-1', win);

      const result = loadRateLimits(db);
      const windows = result.get('acc-1');
      expect(windows?.[0]?.limit).toBe(40000);
      expect(windows?.[0]?.remaining).toBe(39500);
    });

    it('updates existing row on upsert', () => {
      const win: RateLimitWindow = { name: 'unified-5h', status: 'allowed', utilization: 0.10, limit: null, remaining: null, reset: 100, lastUpdated: 1 };
      upsertRateLimit(db, 'acc-1', win);
      upsertRateLimit(db, 'acc-1', { ...win, utilization: 0.90, reset: 200 });

      const result = loadRateLimits(db);
      const windows = result.get('acc-1');
      expect(windows).toHaveLength(1);
      expect(windows?.[0]?.utilization).toBeCloseTo(0.90);
      expect(windows?.[0]?.reset).toBe(200);
    });

    it('keeps accounts isolated', () => {
      upsertRateLimit(db, 'acc-1', { name: 'unified-5h', status: null, utilization: 0.1, limit: null, remaining: null, reset: 1, lastUpdated: 1 });
      upsertRateLimit(db, 'acc-2', { name: 'unified-5h', status: null, utilization: 0.9, limit: null, remaining: null, reset: 2, lastUpdated: 1 });

      const result = loadRateLimits(db);
      expect(result.get('acc-1')?.[0]?.utilization).toBeCloseTo(0.1);
      expect(result.get('acc-2')?.[0]?.utilization).toBeCloseTo(0.9);
    });

    it('deleteRateLimitsForAccount removes only the given account', () => {
      upsertRateLimit(db, 'acc-1', { name: 'unified-5h', status: null, utilization: 0.1, limit: null, remaining: null, reset: 1, lastUpdated: 1 });
      upsertRateLimit(db, 'acc-1', { name: 'unified-7d', status: null, utilization: 0.2, limit: null, remaining: null, reset: 2, lastUpdated: 1 });
      upsertRateLimit(db, 'acc-2', { name: 'unified-5h', status: null, utilization: 0.9, limit: null, remaining: null, reset: 2, lastUpdated: 1 });

      const removed = deleteRateLimitsForAccount(db, 'acc-1');
      expect(removed).toBe(2);

      const result = loadRateLimits(db);
      expect(result.get('acc-1')).toBeUndefined();
      expect(result.get('acc-2')?.[0]?.utilization).toBeCloseTo(0.9);
    });

    it('deleteRateLimitsForAccount returns 0 when nothing matches', () => {
      expect(deleteRateLimitsForAccount(db, 'never-stored')).toBe(0);
    });

    it('returns empty map when no rate limits stored', () => {
      const result = loadRateLimits(db);
      expect(result.size).toBe(0);
    });
  });
});

// ─── Metrics tab helpers ────────────────────────────────────────────────────

describe('Metrics tab DB helpers', () => {
  let db: Database.Database;
  const acct = 'acc-m';

  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('getTokensByDayModel groups by day + model with full token breakdown', async () => {
    const { getTokensByDayModel, insertUsageEvent } = await import('./db.js');
    insertUsageEvent(db, {
      ts: Date.now(),
      accountId: acct,
      sessionId: 's1',
      model: 'claude-opus-4',
      costUsd: 0.1,
      inputTokens: 100,
      outputTokens: 50,
      cacheRead: 20,
      cacheCreate: 5,
      durationMs: 1000,
    });
    insertUsageEvent(db, {
      ts: Date.now(),
      accountId: acct,
      sessionId: 's2',
      model: 'claude-opus-4',
      costUsd: 0.2,
      inputTokens: 200,
      outputTokens: 80,
      cacheRead: 40,
      cacheCreate: 10,
      durationMs: 2000,
    });
    const out = getTokensByDayModel(db, acct, 7);
    const days = Object.keys(out);
    expect(days).toHaveLength(1);
    const day = days[0]!;
    expect(out[day]!['claude-opus-4']).toEqual({
      costUsd: 0.30000000000000004,
      inputTokens: 300,
      outputTokens: 130,
      cacheReadTokens: 60,
      cacheCreationTokens: 15,
    });
  });

  it('getCacheHitRate computes per-model rate as cacheRead / (input + cacheRead)', async () => {
    const { getCacheHitRate, insertUsageEvent } = await import('./db.js');
    insertUsageEvent(db, {
      ts: Date.now(), accountId: acct, sessionId: 's1', model: 'm1',
      costUsd: 0, inputTokens: 800, outputTokens: 0, cacheRead: 200, cacheCreate: 0, durationMs: 0,
    });
    const rates = getCacheHitRate(db, acct, 7);
    expect(rates['m1']?.rate).toBeCloseTo(0.2); // 200 / (800+200)
  });

  it('getCacheHitRate returns rate=0 when no tokens recorded', async () => {
    const { getCacheHitRate, insertUsageEvent } = await import('./db.js');
    insertUsageEvent(db, {
      ts: Date.now(), accountId: acct, sessionId: 's', model: 'm0',
      costUsd: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, durationMs: 0,
    });
    expect(getCacheHitRate(db, acct, 7)['m0']?.rate).toBe(0);
  });

  it('getApiErrorsByDay + retry-exhausted counter (attempt > 10)', async () => {
    const { getApiErrorsByDay, insertApiError } = await import('./db.js');
    const now = Date.now();
    insertApiError(db, { ts: now, accountId: acct, sessionId: 's', model: 'm', statusCode: '429', error: 'rl', durationMs: 1, attempt: 3, requestId: 'r1', speed: 'normal' });
    insertApiError(db, { ts: now, accountId: acct, sessionId: 's', model: 'm', statusCode: '500', error: '5xx', durationMs: 1, attempt: 11, requestId: 'r2', speed: 'normal' });
    insertApiError(db, { ts: now, accountId: acct, sessionId: 's', model: 'm', statusCode: null,  error: '??',  durationMs: 1, attempt: 1, requestId: null, speed: null });
    const out = getApiErrorsByDay(db, acct, 7);
    const day = Object.keys(out.byDay)[0]!;
    expect(out.byDay[day]).toEqual({ '429': 1, '500': 1, unknown: 1 });
    expect(out.retryExhaustedCount).toBe(1);
  });

  it('getToolStats returns calls, p50/p95, successRate, topError', async () => {
    const { getToolStats, insertToolEvent } = await import('./db.js');
    const now = Date.now();
    // 5 Bash calls: 4 success, 1 failure with an error
    for (const ms of [100, 200, 300, 400, 500]) {
      insertToolEvent(db, {
        ts: now, accountId: acct, sessionId: 's', toolName: 'Bash',
        success: ms !== 500, durationMs: ms,
        error: ms === 500 ? 'boom' : null,
        decisionSource: null, mcpServerScope: null, toolResultSizeBytes: null,
      });
    }
    const stats = getToolStats(db, acct, 7);
    const bash = stats.find((s) => s.toolName === 'Bash')!;
    expect(bash.calls).toBe(5);
    expect(bash.successRate).toBeCloseTo(0.8);
    expect(bash.p50Ms).toBe(300);
    expect(bash.p95Ms).toBe(500);
    expect(bash.topError).toBe('boom');
  });

  it('getToolStats handles a tool with no failures (topError=null)', async () => {
    const { getToolStats, insertToolEvent } = await import('./db.js');
    insertToolEvent(db, {
      ts: Date.now(), accountId: acct, sessionId: 's', toolName: 'Read',
      success: true, durationMs: 10, error: null, decisionSource: null,
      mcpServerScope: null, toolResultSizeBytes: null,
    });
    const stats = getToolStats(db, acct, 7);
    expect(stats[0]?.topError).toBeNull();
    expect(stats[0]?.successRate).toBe(1);
  });

  it('getToolStats with no data returns empty list', async () => {
    const { getToolStats } = await import('./db.js');
    expect(getToolStats(db, acct, 7)).toEqual([]);
  });

  it('getActivityCounters sums value per (day, kind)', async () => {
    const { getActivityCounters, insertActivityEvent } = await import('./db.js');
    const now = Date.now();
    insertActivityEvent(db, { ts: now, accountId: acct, sessionId: 's', kind: 'commit', value: 1 });
    insertActivityEvent(db, { ts: now, accountId: acct, sessionId: 's', kind: 'commit', value: 1 });
    insertActivityEvent(db, { ts: now, accountId: acct, sessionId: 's', kind: 'lines_added', value: 100 });
    const out = getActivityCounters(db, acct, 7, ['commit', 'lines_added']);
    const day = Object.keys(out)[0]!;
    expect(out[day]!['commit']).toBe(2);
    expect(out[day]!['lines_added']).toBe(100);
  });

  it('getActivityCounters with empty kinds returns {}', async () => {
    const { getActivityCounters } = await import('./db.js');
    expect(getActivityCounters(db, acct, 7, [])).toEqual({});
  });

  it('getEditAcceptRate tallies per language and overall', async () => {
    const { getEditAcceptRate, insertActivityEvent } = await import('./db.js');
    const now = Date.now();
    const base = { ts: now, accountId: acct, sessionId: 's', kind: 'edit_decision' as const, value: 1 };
    insertActivityEvent(db, { ...base, language: 'TypeScript', decision: 'accept' });
    insertActivityEvent(db, { ...base, language: 'TypeScript', decision: 'accept' });
    insertActivityEvent(db, { ...base, language: 'TypeScript', decision: 'reject' });
    insertActivityEvent(db, { ...base, language: 'Python',     decision: 'accept' });
    const out = getEditAcceptRate(db, acct, 7);
    expect(out.overall.accepts).toBe(3);
    expect(out.overall.rejects).toBe(1);
    expect(out.overall.rate).toBeCloseTo(0.75);
    expect(out.byLanguage['TypeScript']?.rate).toBeCloseTo(2 / 3);
    expect(out.byLanguage['Python']?.rate).toBe(1);
  });

  it('getEditAcceptRate with no decisions has rate=0', async () => {
    const { getEditAcceptRate } = await import('./db.js');
    const out = getEditAcceptRate(db, acct, 7);
    expect(out.overall.rate).toBe(0);
    expect(Object.keys(out.byLanguage)).toHaveLength(0);
  });

  it('getTopSkills returns name + count ordered desc, capped by limit', async () => {
    const { getTopSkills, insertActivityEvent } = await import('./db.js');
    const now = Date.now();
    const row = (name: string) => ({ ts: now, accountId: acct, sessionId: 's', kind: 'skill_activated' as const, value: 1, name, source: 'plugin' });
    insertActivityEvent(db, row('init'));
    insertActivityEvent(db, row('init'));
    insertActivityEvent(db, row('init'));
    insertActivityEvent(db, row('review'));
    insertActivityEvent(db, row('review'));
    const skills = getTopSkills(db, acct, 7, 10);
    expect(skills[0]).toMatchObject({ name: 'init', count: 3 });
    expect(skills[1]).toMatchObject({ name: 'review', count: 2 });
  });

  it('getRecentPlugins returns installs ordered newest first', async () => {
    const { getRecentPlugins, insertActivityEvent } = await import('./db.js');
    insertActivityEvent(db, { ts: 1000, accountId: acct, sessionId: 's', kind: 'plugin_installed', value: 1, name: 'older', version: '1.0', marketplace: 'm' });
    insertActivityEvent(db, { ts: 2000, accountId: acct, sessionId: 's', kind: 'plugin_installed', value: 1, name: 'newer', version: '2.0', marketplace: 'm' });
    const plugins = getRecentPlugins(db, acct, 10);
    expect(plugins.map((p) => p.name)).toEqual(['newer', 'older']);
    expect(plugins[0]?.version).toBe('2.0');
  });

  it('legacy getUsageByDayModel aggregates cost + tokens', async () => {
    const { getUsageByDayModel, insertUsageEvent } = await import('./db.js');
    insertUsageEvent(db, {
      ts: Date.now(), accountId: acct, sessionId: 's', model: 'm',
      costUsd: 0.5, inputTokens: 100, outputTokens: 50, cacheRead: 10, cacheCreate: 5, durationMs: 100,
    });
    const out = getUsageByDayModel(db, acct, 7);
    const day = Object.keys(out)[0]!;
    expect(out[day]!['m']).toEqual({ costUsd: 0.5, tokens: 150 });
  });

  it('acknowledgeAllNotifications with accountId ack\'s scoped + null-scoped rows', async () => {
    const { acknowledgeAllNotifications, insertNotification, listNotifications } = await import('./db.js');
    insertNotification(db, { ts: 1, accountId: 'a', type: 'usage_alert', title: 'x', body: 'x' });
    insertNotification(db, { ts: 2, accountId: null, type: 'account_switched', title: 'x', body: 'x' });
    insertNotification(db, { ts: 3, accountId: 'other', type: 'usage_alert', title: 'x', body: 'x' });
    const n = acknowledgeAllNotifications(db, 'a');
    expect(n).toBe(2); // the 'a' one and the null-scoped one
    const unacked = listNotifications(db, { unacknowledgedOnly: true });
    expect(unacked).toHaveLength(1);
    expect(unacked[0]?.accountId).toBe('other');
  });

  it('acknowledgeAllNotifications without accountId ack\'s every unread', async () => {
    const { acknowledgeAllNotifications, insertNotification, listNotifications } = await import('./db.js');
    insertNotification(db, { ts: 1, accountId: 'a', type: 'usage_alert', title: 'x', body: 'x' });
    insertNotification(db, { ts: 2, accountId: 'b', type: 'usage_alert', title: 'x', body: 'x' });
    const n = acknowledgeAllNotifications(db);
    expect(n).toBe(2);
    expect(listNotifications(db, { unacknowledgedOnly: true })).toHaveLength(0);
  });

  it('listRemovedAccounts + reactivateAccount roundtrip', async () => {
    const { listRemovedAccounts, reactivateAccount } = await import('./db.js');
    const acc: AccountInfo = {
      id: 'rem', accountUuid: 'rem', email: 'r@x', displayName: '', orgUuid: '', orgName: '',
      planType: 'pro', isActive: false, createdAt: Date.now(),
    };
    upsertAccount(db, acc);
    markAccountRemoved(db, 'rem');
    expect(listRemovedAccounts(db)).toHaveLength(1);
    reactivateAccount(db, 'rem');
    expect(listRemovedAccounts(db)).toHaveLength(0);
    expect(listAccounts(db).some((a) => a.id === 'rem')).toBe(true);
  });
});
