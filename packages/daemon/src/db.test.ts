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
  hasActiveAccount,
  setAccountColor,
  insertUsageEvent,
  getUsageEvents,
  getTodayUsageSummary,
  insertOverageEvent,
  getOverageEvents,
  clearOverageEvents,
  getLastOverageEventPerAccount,
  insertNotification,
  acknowledgeNotification,
  listNotifications,
  upsertRateLimit,
  loadRateLimits,
  deleteRateLimitsForAccount,
  listPermissionRules,
  upsertPermissionRule,
  deletePermissionRule,
  runSonnetToFableMigration,
} from './db.js';
import type { AccountInfo, RateLimitWindow } from '@sentinel/shared';

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
      color: null,
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
      upsertAccount(db, {
        ...account,
        id: 'uuid-2',
        accountUuid: 'uuid-2',
        email: 'b@example.com',
      });
      upsertAccount(db, {
        ...account,
        id: 'uuid-1',
        accountUuid: 'uuid-1',
        email: 'a@example.com',
      });
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
      db.prepare(
        'INSERT INTO accounts (id, email, display_name, org_uuid, org_name, plan_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('legacy-id', 'legacy@example.com', 'Legacy', '', '', 'pro', Date.now());
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

    describe('hasActiveAccount', () => {
      it('returns false for a row that does not exist', () => {
        expect(hasActiveAccount(db, 'no-such-id')).toBe(false);
      });

      it('returns true for an active account (removed=0)', () => {
        upsertAccount(db, account);
        expect(hasActiveAccount(db, 'uuid-1')).toBe(true);
      });

      it('returns false for a soft-removed account (removed=1)', () => {
        upsertAccount(db, account);
        markAccountRemoved(db, 'uuid-1');
        expect(hasActiveAccount(db, 'uuid-1')).toBe(false);
      });

      it('returns false for a hard-purged tombstone (removed=2)', () => {
        upsertAccount(db, account);
        purgeAccount(db, 'uuid-1');
        expect(hasActiveAccount(db, 'uuid-1')).toBe(false);
      });
    });

    describe('avatar color', () => {
      it('defaults to null on a freshly-upserted account', () => {
        upsertAccount(db, account);
        expect(getAccount(db, 'uuid-1')?.color).toBeNull();
      });

      it('persists and round-trips a hex color via setAccountColor', () => {
        upsertAccount(db, account);
        expect(setAccountColor(db, 'uuid-1', '#FF9F0A')).toBe(true);
        expect(getAccount(db, 'uuid-1')?.color).toBe('#FF9F0A');
      });

      it('returns false when setAccountColor targets an unknown id', () => {
        expect(setAccountColor(db, 'no-such-id', '#FF9F0A')).toBe(false);
      });

      it('clears the stored color when set to null', () => {
        upsertAccount(db, account);
        setAccountColor(db, 'uuid-1', '#FF9F0A');
        expect(setAccountColor(db, 'uuid-1', null)).toBe(true);
        expect(getAccount(db, 'uuid-1')?.color).toBeNull();
      });

      it('preserves the stored color across subsequent upserts', () => {
        // upsertAccount's ON CONFLICT DO UPDATE intentionally omits the color
        // column so metadata refreshes (e.g. refresh_accounts, login flow)
        // can't clobber the user's pick.
        upsertAccount(db, account);
        setAccountColor(db, 'uuid-1', '#30D158');
        upsertAccount(db, { ...account, displayName: 'Renamed', color: null });
        expect(getAccount(db, 'uuid-1')?.color).toBe('#30D158');
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
      insertUsageEvent(db, {
        ts: Date.now(),
        accountId: 'acc-1',
        sessionId: null,
        model: 'claude-sonnet-4-6',
        costUsd: 0.01,
        inputTokens: 100,
        outputTokens: 50,
        cacheRead: null,
        cacheCreate: null,
        durationMs: null,
      });
      insertUsageEvent(db, {
        ts: Date.now(),
        accountId: 'acc-2',
        sessionId: null,
        model: 'claude-haiku-4',
        costUsd: 0.001,
        inputTokens: 100,
        outputTokens: 50,
        cacheRead: null,
        cacheCreate: null,
        durationMs: null,
      });

      const acc1Events = getUsageEvents(db, { accountId: 'acc-1' });
      expect(acc1Events).toHaveLength(1);
      expect(acc1Events[0]?.accountId).toBe('acc-1');
    });

    it('filters by sinceTs', () => {
      const past = Date.now() - 10000;
      const now = Date.now();
      insertUsageEvent(db, {
        ts: past - 1000,
        accountId: 'acc-1',
        sessionId: null,
        model: 'm',
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        cacheRead: null,
        cacheCreate: null,
        durationMs: null,
      });
      insertUsageEvent(db, {
        ts: now,
        accountId: 'acc-1',
        sessionId: null,
        model: 'm',
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        cacheRead: null,
        cacheCreate: null,
        durationMs: null,
      });

      const events = getUsageEvents(db, { sinceTs: past });
      expect(events).toHaveLength(1);
      expect(events[0]?.ts).toBe(now);
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        insertUsageEvent(db, {
          ts: Date.now() + i,
          accountId: 'acc-1',
          sessionId: null,
          model: 'm',
          costUsd: null,
          inputTokens: null,
          outputTokens: null,
          cacheRead: null,
          cacheCreate: null,
          durationMs: null,
        });
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
      insertUsageEvent(db, {
        ts: now,
        accountId: 'acc-1',
        sessionId: 'sess-1',
        model: 'm',
        costUsd: 0.05,
        inputTokens: 1000,
        outputTokens: 500,
        cacheRead: null,
        cacheCreate: null,
        durationMs: null,
      });
      insertUsageEvent(db, {
        ts: now,
        accountId: 'acc-1',
        sessionId: 'sess-1',
        model: 'm',
        costUsd: 0.03,
        inputTokens: 500,
        outputTokens: 200,
        cacheRead: null,
        cacheCreate: null,
        durationMs: null,
      });

      const summary = getTodayUsageSummary(db, 'acc-1');
      expect(summary.costUsd).toBeCloseTo(0.08);
      expect(summary.tokens).toBe(2200);
      expect(summary.sessionCount).toBe(1); // same session_id
    });

    it('counts distinct sessions', () => {
      const now = Date.now();
      insertUsageEvent(db, {
        ts: now,
        accountId: 'acc-1',
        sessionId: 'sess-1',
        model: 'm',
        costUsd: 0.01,
        inputTokens: 100,
        outputTokens: 50,
        cacheRead: null,
        cacheCreate: null,
        durationMs: null,
      });
      insertUsageEvent(db, {
        ts: now,
        accountId: 'acc-1',
        sessionId: 'sess-2',
        model: 'm',
        costUsd: 0.01,
        inputTokens: 100,
        outputTokens: 50,
        cacheRead: null,
        cacheCreate: null,
        durationMs: null,
      });

      const summary = getTodayUsageSummary(db, 'acc-1');
      expect(summary.sessionCount).toBe(2);
    });

    it('handles null cost_usd in usage events gracefully', () => {
      const now = Date.now();
      insertUsageEvent(db, {
        ts: now,
        accountId: 'acc-null',
        sessionId: null,
        model: 'm',
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        cacheRead: null,
        cacheCreate: null,
        durationMs: null,
      });

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
      expect(id).not.toBeNull();
      expect(id).toBeGreaterThan(0);

      const events = getOverageEvents(db, { accountId: 'acc-1' });
      expect(events).toHaveLength(1);
      expect(events[0]?.transition).toBe('entered');
      expect(events[0]?.resetsAt).toBe(1776700800);
    });

    it('filters by account', () => {
      insertOverageEvent(db, {
        ts: Date.now(),
        accountId: 'acc-1',
        transition: 'entered',
        status: 'active',
        resetsAt: null,
        disabledReason: null,
      });
      insertOverageEvent(db, {
        ts: Date.now(),
        accountId: 'acc-2',
        transition: 'entered',
        status: 'active',
        resetsAt: null,
        disabledReason: null,
      });

      const events = getOverageEvents(db, { accountId: 'acc-1' });
      expect(events).toHaveLength(1);
    });

    it('respects limit', () => {
      // Distinct (accountId, resetsAt, transition) tuples so the unique
      // index doesn't collapse them — rolling resetsAt per row.
      for (let i = 0; i < 5; i++) {
        insertOverageEvent(db, {
          ts: Date.now(),
          accountId: 'acc-1',
          transition: 'entered',
          status: 'active',
          resetsAt: 1_700_000_000 + i,
          disabledReason: null,
        });
      }
      const events = getOverageEvents(db, { limit: 2 });
      expect(events).toHaveLength(2);
    });

    it('clearOverageEvents wipes every row when no account scope is given', () => {
      insertOverageEvent(db, {
        ts: 1,
        accountId: 'acc-1',
        transition: 'entered',
        status: 'a',
        resetsAt: 1,
        disabledReason: null,
      });
      insertOverageEvent(db, {
        ts: 2,
        accountId: 'acc-2',
        transition: 'entered',
        status: 'a',
        resetsAt: 2,
        disabledReason: null,
      });
      const count = clearOverageEvents(db);
      expect(count).toBe(2);
      expect(getOverageEvents(db, {})).toEqual([]);
    });

    it('clearOverageEvents scopes delete to a single account when provided', () => {
      insertOverageEvent(db, {
        ts: 1,
        accountId: 'acc-1',
        transition: 'entered',
        status: 'a',
        resetsAt: 1,
        disabledReason: null,
      });
      insertOverageEvent(db, {
        ts: 2,
        accountId: 'acc-2',
        transition: 'entered',
        status: 'a',
        resetsAt: 2,
        disabledReason: null,
      });
      const count = clearOverageEvents(db, 'acc-1');
      expect(count).toBe(1);
      const remaining = getOverageEvents(db, {});
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.accountId).toBe('acc-2');
    });

    it('getLastOverageEventPerAccount returns one newest row per account', () => {
      insertOverageEvent(db, {
        ts: 100,
        accountId: 'acc-1',
        transition: 'entered',
        status: 'a',
        resetsAt: 1,
        disabledReason: null,
      });
      insertOverageEvent(db, {
        ts: 200,
        accountId: 'acc-1',
        transition: 'exited',
        status: 'a',
        resetsAt: 1,
        disabledReason: null,
      });
      insertOverageEvent(db, {
        ts: 150,
        accountId: 'acc-2',
        transition: 'entered',
        status: 'a',
        resetsAt: 2,
        disabledReason: null,
      });

      const rows = getLastOverageEventPerAccount(db);
      const byAccount = Object.fromEntries(rows.map((r) => [r.accountId, r]));
      expect(byAccount['acc-1']?.ts).toBe(200);
      expect(byAccount['acc-1']?.transition).toBe('exited');
      expect(byAccount['acc-2']?.ts).toBe(150);
    });

    it('returns null on duplicate insert within the same window', () => {
      const first = insertOverageEvent(db, {
        ts: Date.now(),
        accountId: 'acc-1',
        transition: 'entered',
        status: 'active',
        resetsAt: 1776700800,
        disabledReason: null,
      });
      const second = insertOverageEvent(db, {
        ts: Date.now() + 1000,
        accountId: 'acc-1',
        transition: 'entered',
        status: 'active',
        resetsAt: 1776700800,
        disabledReason: null,
      });
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      const events = getOverageEvents(db, { accountId: 'acc-1' });
      expect(events).toHaveLength(1);
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
      const id1 = insertNotification(db, {
        ts: Date.now(),
        accountId: null,
        type: 'overage_entered',
        title: 'T1',
        body: 'B1',
      });
      insertNotification(db, {
        ts: Date.now(),
        accountId: null,
        type: 'overage_entered',
        title: 'T2',
        body: 'B2',
      });
      acknowledgeNotification(db, id1);

      const unacked = listNotifications(db, { unacknowledgedOnly: true });
      expect(unacked).toHaveLength(1);
      expect(unacked[0]?.title).toBe('T2');
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        insertNotification(db, {
          ts: Date.now(),
          accountId: null,
          type: 'account_switched',
          title: `T${i}`,
          body: 'B',
        });
      }
      const limited = listNotifications(db, { limit: 3 });
      expect(limited).toHaveLength(3);
    });

    it('beforeTs cursor pages older notifications', () => {
      const now = Date.now();
      // Three notifications at distinct ts; ORDER BY ts DESC → newest first.
      insertNotification(db, {
        ts: now - 3000,
        accountId: null,
        type: 'account_switched',
        title: 'old',
        body: 'B',
      });
      insertNotification(db, {
        ts: now - 2000,
        accountId: null,
        type: 'account_switched',
        title: 'mid',
        body: 'B',
      });
      insertNotification(db, {
        ts: now - 1000,
        accountId: null,
        type: 'account_switched',
        title: 'new',
        body: 'B',
      });
      const firstPage = listNotifications(db, { limit: 2 });
      expect(firstPage.map((n) => n.title)).toEqual(['new', 'mid']);
      const cursor = firstPage[firstPage.length - 1]!.ts;
      const secondPage = listNotifications(db, { limit: 2, beforeTs: cursor });
      expect(secondPage.map((n) => n.title)).toEqual(['old']);
    });

    it('accountId filter includes account-bound + global rows', () => {
      // Account-bound row.
      insertNotification(db, {
        ts: Date.now(),
        accountId: 'acc-a',
        type: 'overage_entered',
        title: 'acc-a row',
        body: 'B',
      });
      // Different-account row — must NOT come back.
      insertNotification(db, {
        ts: Date.now(),
        accountId: 'acc-b',
        type: 'overage_entered',
        title: 'acc-b row',
        body: 'B',
      });
      // Global row — must come back regardless of accountId filter.
      insertNotification(db, {
        ts: Date.now(),
        accountId: null,
        type: 'account_switched',
        title: 'global row',
        body: 'B',
      });
      const titles = listNotifications(db, { accountId: 'acc-a' })
        .map((n) => n.title)
        .sort();
      expect(titles).toEqual(['acc-a row', 'global row']);
    });

    it('types filter restricts to the given NotificationType set', () => {
      insertNotification(db, {
        ts: Date.now(),
        accountId: null,
        type: 'security_high',
        title: 'sec-high',
        body: 'B',
      });
      insertNotification(db, {
        ts: Date.now(),
        accountId: null,
        type: 'usage_alert',
        title: 'usage',
        body: 'B',
      });
      insertNotification(db, {
        ts: Date.now(),
        accountId: null,
        type: 'overage_entered',
        title: 'overage',
        body: 'B',
      });
      const security = listNotifications(db, {
        types: ['security_low', 'security_medium', 'security_high'],
      });
      expect(security.map((n) => n.title)).toEqual(['sec-high']);
      const usage = listNotifications(db, {
        types: ['usage_alert', 'overage_entered', 'overage_disabled', 'account_switched'],
      });
      expect(usage.map((n) => n.title).sort()).toEqual(['overage', 'usage']);
      // Empty array = no constraint applied.
      expect(listNotifications(db, { types: [] })).toHaveLength(3);
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
      const win: RateLimitWindow = {
        name: 'unified-5h',
        status: 'allowed',
        utilization: 0.1,
        limit: null,
        remaining: null,
        reset: 100,
        lastUpdated: 1,
      };
      upsertRateLimit(db, 'acc-1', win);
      upsertRateLimit(db, 'acc-1', { ...win, utilization: 0.9, reset: 200 });

      const result = loadRateLimits(db);
      const windows = result.get('acc-1');
      expect(windows).toHaveLength(1);
      expect(windows?.[0]?.utilization).toBeCloseTo(0.9);
      expect(windows?.[0]?.reset).toBe(200);
    });

    it('keeps accounts isolated', () => {
      upsertRateLimit(db, 'acc-1', {
        name: 'unified-5h',
        status: null,
        utilization: 0.1,
        limit: null,
        remaining: null,
        reset: 1,
        lastUpdated: 1,
      });
      upsertRateLimit(db, 'acc-2', {
        name: 'unified-5h',
        status: null,
        utilization: 0.9,
        limit: null,
        remaining: null,
        reset: 2,
        lastUpdated: 1,
      });

      const result = loadRateLimits(db);
      expect(result.get('acc-1')?.[0]?.utilization).toBeCloseTo(0.1);
      expect(result.get('acc-2')?.[0]?.utilization).toBeCloseTo(0.9);
    });

    it('deleteRateLimitsForAccount removes only the given account', () => {
      upsertRateLimit(db, 'acc-1', {
        name: 'unified-5h',
        status: null,
        utilization: 0.1,
        limit: null,
        remaining: null,
        reset: 1,
        lastUpdated: 1,
      });
      upsertRateLimit(db, 'acc-1', {
        name: 'unified-7d',
        status: null,
        utilization: 0.2,
        limit: null,
        remaining: null,
        reset: 2,
        lastUpdated: 1,
      });
      upsertRateLimit(db, 'acc-2', {
        name: 'unified-5h',
        status: null,
        utilization: 0.9,
        limit: null,
        remaining: null,
        reset: 2,
        lastUpdated: 1,
      });

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

// ─── Tool decisions + prompt stats ──────────────────────────────────────────

describe('getToolDecisionBreakdown', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('aggregates tool_decision activity rows by overall, tool, and source', async () => {
    const { insertActivityEvent, getToolDecisionBreakdown } = await import('./db.js');
    const now = Date.now();
    const seed = (toolName: string, decision: string, source: string): void => {
      insertActivityEvent(db, {
        ts: now,
        accountId: 'a',
        sessionId: null,
        kind: 'tool_decision',
        value: 1,
        toolName,
        decision,
        source,
      });
    };
    // Bash: 3 accept, 1 reject, all user_temporary
    seed('Bash', 'accept', 'user_temporary');
    seed('Bash', 'accept', 'user_temporary');
    seed('Bash', 'accept', 'user_temporary');
    seed('Bash', 'reject', 'user_reject');
    // WebFetch: 1 accept from hook
    seed('WebFetch', 'accept', 'hook');

    const out = getToolDecisionBreakdown(db, ['a'], 7);
    expect(out.overall.accepts).toBe(4);
    expect(out.overall.rejects).toBe(1);
    expect(out.overall.rate).toBeCloseTo(0.8);

    expect(out.byTool['Bash']).toEqual({ accepts: 3, rejects: 1, rate: 0.75 });
    expect(out.byTool['WebFetch']).toEqual({ accepts: 1, rejects: 0, rate: 1 });

    expect(out.bySource['user_temporary']?.accepts).toBe(3);
    expect(out.bySource['user_reject']?.rejects).toBe(1);
    expect(out.bySource['hook']?.accepts).toBe(1);
  });

  it('ignores rows from other accounts and other kinds', async () => {
    const { insertActivityEvent, getToolDecisionBreakdown } = await import('./db.js');
    const now = Date.now();
    // Wrong account
    insertActivityEvent(db, {
      ts: now,
      accountId: 'b',
      sessionId: null,
      kind: 'tool_decision',
      value: 1,
      toolName: 'Bash',
      decision: 'accept',
      source: 'hook',
    });
    // Right account, wrong kind
    insertActivityEvent(db, {
      ts: now,
      accountId: 'a',
      sessionId: null,
      kind: 'edit_decision',
      value: 1,
      toolName: 'Edit',
      decision: 'accept',
    });
    const out = getToolDecisionBreakdown(db, ['a'], 7);
    expect(out.overall.accepts).toBe(0);
    expect(out.overall.rejects).toBe(0);
    expect(out.overall.rate).toBe(0);
  });

  it('empty window yields zeroed overall and empty byTool/bySource', async () => {
    const { getToolDecisionBreakdown } = await import('./db.js');
    const out = getToolDecisionBreakdown(db, ['a'], 7);
    expect(out).toEqual({
      overall: { accepts: 0, rejects: 0, rate: 0 },
      byTool: {},
      bySource: {},
    });
  });
});

describe('getUserPromptStats', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('returns per-day counts and a prompt-weighted average length', async () => {
    const { insertActivityEvent, getUserPromptStats } = await import('./db.js');
    const now = Date.now();
    // Same day, avg = (100+200)/2 = 150; two prompts.
    insertActivityEvent(db, {
      ts: now,
      accountId: 'a',
      sessionId: null,
      kind: 'user_prompt',
      value: 100,
    });
    insertActivityEvent(db, {
      ts: now,
      accountId: 'a',
      sessionId: null,
      kind: 'user_prompt',
      value: 200,
    });

    const out = getUserPromptStats(db, ['a'], 7);
    expect(out.total).toBe(2);
    expect(out.avgLength).toBe(150);
    // Single day key present with the right count.
    const days = Object.keys(out.perDay);
    expect(days).toHaveLength(1);
    expect(out.perDay[days[0]!]).toEqual({ count: 2, avgLength: 150 });
  });

  it('handles prompts with null length (no prompt_length attribute)', async () => {
    const { insertActivityEvent, getUserPromptStats } = await import('./db.js');
    insertActivityEvent(db, {
      ts: Date.now(),
      accountId: 'a',
      sessionId: null,
      kind: 'user_prompt',
      value: null,
    });
    const out = getUserPromptStats(db, ['a'], 7);
    // Total still increments, but avgLength stays 0 because no row carried a
    // length.
    expect(out.total).toBe(1);
    expect(out.avgLength).toBe(0);
  });

  it('returns empty stats when no user_prompt rows exist', async () => {
    const { getUserPromptStats } = await import('./db.js');
    expect(getUserPromptStats(db, ['a'], 7)).toEqual({ total: 0, avgLength: 0, perDay: {} });
  });
});

// ─── Retention purge ────────────────────────────────────────────────────────

describe('purgeTelemetryOlderThan', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('deletes rows older than cutoff across all four telemetry tables; keeps newer rows', async () => {
    const {
      insertUsageEvent,
      insertToolEvent,
      insertApiError,
      insertActivityEvent,
      purgeTelemetryOlderThan,
    } = await import('./db.js');

    const old = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60d ago
    const fresh = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1d ago
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30d

    const makeUsage = (ts: number): void => {
      insertUsageEvent(db, {
        ts,
        accountId: 'a',
        sessionId: null,
        model: 'm',
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        cacheRead: null,
        cacheCreate: null,
        durationMs: null,
      });
    };
    const makeTool = (ts: number): void => {
      insertToolEvent(db, {
        ts,
        accountId: 'a',
        sessionId: null,
        toolName: 'Bash',
        success: true,
        durationMs: null,
        error: null,
        decisionSource: null,
        decisionType: null,
        mcpServerScope: null,
        toolResultSizeBytes: null,
      });
    };
    const makeErr = (ts: number): void => {
      insertApiError(db, {
        ts,
        accountId: 'a',
        sessionId: null,
        model: null,
        statusCode: '500',
        error: 'x',
        durationMs: null,
        attempt: 1,
        requestId: null,
        speed: null,
      });
    };
    const makeActivity = (ts: number): void => {
      insertActivityEvent(db, { ts, accountId: 'a', sessionId: null, kind: 'session', value: 1 });
    };

    // Two rows per table: one old, one fresh.
    [makeUsage, makeTool, makeErr, makeActivity].forEach((fn) => {
      fn(old);
      fn(fresh);
    });

    const purged = purgeTelemetryOlderThan(db, cutoff);
    expect(purged).toBe(4); // one per table

    for (const table of ['usage_events', 'tool_events', 'api_errors', 'activity_events']) {
      const rows = db.prepare(`SELECT ts FROM ${table}`).all() as Array<{ ts: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.ts).toBe(fresh);
    }
  });

  it('returns 0 when nothing is past the cutoff', async () => {
    const { insertUsageEvent, purgeTelemetryOlderThan } = await import('./db.js');
    insertUsageEvent(db, {
      ts: Date.now(),
      accountId: 'a',
      sessionId: null,
      model: 'm',
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      cacheRead: null,
      cacheCreate: null,
      durationMs: null,
    });
    expect(purgeTelemetryOlderThan(db, Date.now() - 24 * 60 * 60 * 1000)).toBe(0);
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
    const out = getTokensByDayModel(db, [acct], 7);
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
      ts: Date.now(),
      accountId: acct,
      sessionId: 's1',
      model: 'm1',
      costUsd: 0,
      inputTokens: 800,
      outputTokens: 0,
      cacheRead: 200,
      cacheCreate: 0,
      durationMs: 0,
    });
    const rates = getCacheHitRate(db, [acct], 7);
    expect(rates['m1']?.rate).toBeCloseTo(0.2); // 200 / (800+200)
  });

  it('getCacheHitRate returns rate=0 when no tokens recorded', async () => {
    const { getCacheHitRate, insertUsageEvent } = await import('./db.js');
    insertUsageEvent(db, {
      ts: Date.now(),
      accountId: acct,
      sessionId: 's',
      model: 'm0',
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheCreate: 0,
      durationMs: 0,
    });
    expect(getCacheHitRate(db, [acct], 7)['m0']?.rate).toBe(0);
  });

  it('getApiErrorsByDay + retry-exhausted counter (attempt > 10)', async () => {
    const { getApiErrorsByDay, insertApiError } = await import('./db.js');
    const now = Date.now();
    insertApiError(db, {
      ts: now,
      accountId: acct,
      sessionId: 's',
      model: 'm',
      statusCode: '429',
      error: 'rl',
      durationMs: 1,
      attempt: 3,
      requestId: 'r1',
      speed: 'normal',
    });
    insertApiError(db, {
      ts: now,
      accountId: acct,
      sessionId: 's',
      model: 'm',
      statusCode: '500',
      error: '5xx',
      durationMs: 1,
      attempt: 11,
      requestId: 'r2',
      speed: 'normal',
    });
    insertApiError(db, {
      ts: now,
      accountId: acct,
      sessionId: 's',
      model: 'm',
      statusCode: null,
      error: '??',
      durationMs: 1,
      attempt: 1,
      requestId: null,
      speed: null,
    });
    const out = getApiErrorsByDay(db, [acct], 7);
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
        ts: now,
        accountId: acct,
        sessionId: 's',
        toolName: 'Bash',
        success: ms !== 500,
        durationMs: ms,
        error: ms === 500 ? 'boom' : null,
        decisionSource: null,
        decisionType: null,
        mcpServerScope: null,
        toolResultSizeBytes: null,
      });
    }
    const stats = getToolStats(db, [acct], 7);
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
      ts: Date.now(),
      accountId: acct,
      sessionId: 's',
      toolName: 'Read',
      success: true,
      durationMs: 10,
      error: null,
      decisionSource: null,
      decisionType: null,
      mcpServerScope: null,
      toolResultSizeBytes: null,
    });
    const stats = getToolStats(db, [acct], 7);
    expect(stats[0]?.topError).toBeNull();
    expect(stats[0]?.successRate).toBe(1);
  });

  it('getToolStats with no data returns empty list', async () => {
    const { getToolStats } = await import('./db.js');
    expect(getToolStats(db, [acct], 7)).toEqual([]);
  });

  it('getActivityCounters sums value per (day, kind)', async () => {
    const { getActivityCounters, insertActivityEvent } = await import('./db.js');
    const now = Date.now();
    insertActivityEvent(db, { ts: now, accountId: acct, sessionId: 's', kind: 'commit', value: 1 });
    insertActivityEvent(db, { ts: now, accountId: acct, sessionId: 's', kind: 'commit', value: 1 });
    insertActivityEvent(db, {
      ts: now,
      accountId: acct,
      sessionId: 's',
      kind: 'lines_added',
      value: 100,
    });
    const out = getActivityCounters(db, [acct], 7, ['commit', 'lines_added']);
    const day = Object.keys(out)[0]!;
    expect(out[day]!['commit']).toBe(2);
    expect(out[day]!['lines_added']).toBe(100);
  });

  it('getActivityCounters with empty kinds returns {}', async () => {
    const { getActivityCounters } = await import('./db.js');
    expect(getActivityCounters(db, [acct], 7, [])).toEqual({});
  });

  it('getEditAcceptRate tallies per language and overall', async () => {
    const { getEditAcceptRate, insertActivityEvent } = await import('./db.js');
    const now = Date.now();
    const base = {
      ts: now,
      accountId: acct,
      sessionId: 's',
      kind: 'edit_decision' as const,
      value: 1,
    };
    insertActivityEvent(db, { ...base, language: 'TypeScript', decision: 'accept' });
    insertActivityEvent(db, { ...base, language: 'TypeScript', decision: 'accept' });
    insertActivityEvent(db, { ...base, language: 'TypeScript', decision: 'reject' });
    insertActivityEvent(db, { ...base, language: 'Python', decision: 'accept' });
    const out = getEditAcceptRate(db, [acct], 7);
    expect(out.overall.accepts).toBe(3);
    expect(out.overall.rejects).toBe(1);
    expect(out.overall.rate).toBeCloseTo(0.75);
    expect(out.byLanguage['TypeScript']?.rate).toBeCloseTo(2 / 3);
    expect(out.byLanguage['Python']?.rate).toBe(1);
  });

  it('getEditAcceptRate with no decisions has rate=0', async () => {
    const { getEditAcceptRate } = await import('./db.js');
    const out = getEditAcceptRate(db, [acct], 7);
    expect(out.overall.rate).toBe(0);
    expect(Object.keys(out.byLanguage)).toHaveLength(0);
  });

  it('getTopSkills returns name + count ordered desc, capped by limit', async () => {
    const { getTopSkills, insertActivityEvent } = await import('./db.js');
    const now = Date.now();
    const row = (name: string) => ({
      ts: now,
      accountId: acct,
      sessionId: 's',
      kind: 'skill_activated' as const,
      value: 1,
      name,
      source: 'plugin',
    });
    insertActivityEvent(db, row('init'));
    insertActivityEvent(db, row('init'));
    insertActivityEvent(db, row('init'));
    insertActivityEvent(db, row('review'));
    insertActivityEvent(db, row('review'));
    const skills = getTopSkills(db, [acct], 7, 10);
    expect(skills[0]).toMatchObject({ name: 'init', count: 3 });
    expect(skills[1]).toMatchObject({ name: 'review', count: 2 });
  });

  it('getRecentPlugins returns installs ordered newest first', async () => {
    const { getRecentPlugins, insertActivityEvent } = await import('./db.js');
    insertActivityEvent(db, {
      ts: 1000,
      accountId: acct,
      sessionId: 's',
      kind: 'plugin_installed',
      value: 1,
      name: 'older',
      version: '1.0',
      marketplace: 'm',
    });
    insertActivityEvent(db, {
      ts: 2000,
      accountId: acct,
      sessionId: 's',
      kind: 'plugin_installed',
      value: 1,
      name: 'newer',
      version: '2.0',
      marketplace: 'm',
    });
    const plugins = getRecentPlugins(db, [acct], 10);
    expect(plugins.map((p) => p.name)).toEqual(['newer', 'older']);
    expect(plugins[0]?.version).toBe('2.0');
  });

  it('getTokensByDayModel sums across multiple account IDs (pool view)', async () => {
    const { getTokensByDayModel, insertUsageEvent } = await import('./db.js');
    const common = {
      ts: Date.now(),
      sessionId: 's',
      model: 'claude-opus-4',
      outputTokens: 0,
      cacheRead: 0,
      cacheCreate: 0,
      durationMs: 0,
    };
    insertUsageEvent(db, { ...common, accountId: 'a', costUsd: 1, inputTokens: 100 });
    insertUsageEvent(db, { ...common, accountId: 'b', costUsd: 2, inputTokens: 300 });
    const perA = getTokensByDayModel(db, ['a'], 7);
    const perB = getTokensByDayModel(db, ['b'], 7);
    const pooled = getTokensByDayModel(db, ['a', 'b'], 7);
    const day = Object.keys(pooled)[0]!;
    expect(pooled[day]!['claude-opus-4']!.costUsd).toBeCloseTo(
      perA[day]!['claude-opus-4']!.costUsd + perB[day]!['claude-opus-4']!.costUsd,
    );
    expect(pooled[day]!['claude-opus-4']!.inputTokens).toBe(400);
  });

  it('getToolStats computes percentiles over the union of pool account rows', async () => {
    const { getToolStats, insertToolEvent } = await import('./db.js');
    // Account A: durations 10..50 ms. Account B: durations 100..500 ms.
    for (const d of [10, 20, 30, 40, 50]) {
      insertToolEvent(db, {
        ts: Date.now(),
        accountId: 'a',
        sessionId: 's',
        toolName: 'Bash',
        success: true,
        durationMs: d,
        error: null,
        decisionSource: null,
        decisionType: null,
        mcpServerScope: null,
        toolResultSizeBytes: null,
      });
    }
    for (const d of [100, 200, 300, 400, 500]) {
      insertToolEvent(db, {
        ts: Date.now(),
        accountId: 'b',
        sessionId: 's',
        toolName: 'Bash',
        success: true,
        durationMs: d,
        error: null,
        decisionSource: null,
        decisionType: null,
        mcpServerScope: null,
        toolResultSizeBytes: null,
      });
    }
    const pooled = getToolStats(db, ['a', 'b'], 7);
    const bash = pooled.find((t) => t.toolName === 'Bash')!;
    // With 10 samples [10,20,30,40,50,100,200,300,400,500] sorted, the helper's
    // percentile picks floor(q*n) which gives index 5 (=100) for p50 and
    // index 9 (=500) for p95. The key check: pooled p95 must exceed A-alone p95.
    const aOnly = getToolStats(db, ['a'], 7).find((t) => t.toolName === 'Bash')!;
    expect(bash.calls).toBe(10);
    expect(bash.p95Ms).toBeGreaterThan(aOnly.p95Ms);
    expect(bash.successRate).toBe(1);
  });

  it('getApiErrorsByDay merges by-day buckets and sums retry-exhausted across accounts', async () => {
    const { getApiErrorsByDay, insertApiError } = await import('./db.js');
    insertApiError(db, {
      ts: Date.now(),
      accountId: 'a',
      sessionId: 's',
      model: 'm',
      statusCode: '429',
      error: 'rate limit',
      durationMs: 1,
      attempt: 11,
      requestId: 'r1',
      speed: 'normal',
    });
    insertApiError(db, {
      ts: Date.now(),
      accountId: 'b',
      sessionId: 's',
      model: 'm',
      statusCode: '429',
      error: 'rate limit',
      durationMs: 1,
      attempt: 11,
      requestId: 'r2',
      speed: 'normal',
    });
    insertApiError(db, {
      ts: Date.now(),
      accountId: 'b',
      sessionId: 's',
      model: 'm',
      statusCode: '500',
      error: 'boom',
      durationMs: 1,
      attempt: 2,
      requestId: 'r3',
      speed: 'normal',
    });
    const pooled = getApiErrorsByDay(db, ['a', 'b'], 7);
    const day = Object.keys(pooled.byDay)[0]!;
    expect(pooled.byDay[day]!['429']).toBe(2);
    expect(pooled.byDay[day]!['500']).toBe(1);
    expect(pooled.retryExhaustedCount).toBe(2);
  });

  it('pool helpers short-circuit cleanly on empty accountIds', async () => {
    const mod = await import('./db.js');
    expect(mod.getTokensByDayModel(db, [], 7)).toEqual({});
    expect(mod.getCacheHitRate(db, [], 7)).toEqual({});
    expect(mod.getApiErrorsByDay(db, [], 7)).toEqual({ byDay: {}, retryExhaustedCount: 0 });
    expect(mod.getToolStats(db, [], 7)).toEqual([]);
    expect(mod.getActivityCounters(db, [], 7, ['commit'])).toEqual({});
    expect(mod.getEditAcceptRate(db, [], 7)).toEqual({
      overall: { accepts: 0, rejects: 0, rate: 0 },
      byLanguage: {},
    });
    expect(mod.getToolDecisionBreakdown(db, [], 7)).toEqual({
      overall: { accepts: 0, rejects: 0, rate: 0 },
      byTool: {},
      bySource: {},
    });
    expect(mod.getUserPromptStats(db, [], 7)).toEqual({ total: 0, avgLength: 0, perDay: {} });
    expect(mod.getTopSkills(db, [], 7)).toEqual([]);
    expect(mod.getRecentPlugins(db, [], 10)).toEqual([]);
    expect(mod.getCacheTtlByDayModel(db, [], 7)).toEqual({});
    expect(mod.getCacheTtlBySession(db, [], 7)).toEqual([]);
  });

  it('legacy getUsageByDayModel aggregates cost + tokens', async () => {
    const { getUsageByDayModel, insertUsageEvent } = await import('./db.js');
    insertUsageEvent(db, {
      ts: Date.now(),
      accountId: acct,
      sessionId: 's',
      model: 'm',
      costUsd: 0.5,
      inputTokens: 100,
      outputTokens: 50,
      cacheRead: 10,
      cacheCreate: 5,
      durationMs: 100,
    });
    const out = getUsageByDayModel(db, acct, 7);
    const day = Object.keys(out)[0]!;
    expect(out[day]!['m']).toEqual({ costUsd: 0.5, tokens: 150 });
  });

  it('getTokensByDayModel: explicit window overrides days and applies exclusive untilMs', async () => {
    const { getTokensByDayModel, insertUsageEvent } = await import('./db.js');
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const tenDaysAgo = now - 10 * DAY_MS;
    const twoDaysAgo = now - 2 * DAY_MS;
    const seed = (ts: number, sessionId: string, inputTokens: number) =>
      insertUsageEvent(db, {
        ts,
        accountId: acct,
        sessionId,
        model: 'm',
        costUsd: 0,
        inputTokens,
        outputTokens: 0,
        cacheRead: 0,
        cacheCreate: 0,
        durationMs: 0,
      });
    seed(tenDaysAgo, 's-old', 111);
    seed(twoDaysAgo, 's-mid', 222);
    seed(now, 's-now', 333);

    // Window [5 days ago, 1 day ago) overrides days=1; only the 2-days-ago row
    // falls inside it (10-days-ago is below sinceMs, now is at/after untilMs).
    const windowed = getTokensByDayModel(db, [acct], 1, {
      sinceMs: now - 5 * DAY_MS,
      untilMs: now - 1 * DAY_MS,
    });
    const windowedDays = Object.keys(windowed);
    expect(windowedDays).toHaveLength(1);
    expect(windowed[windowedDays[0]!]!['m']!.inputTokens).toBe(222);

    // untilMs is exclusive: a window ending exactly at the mid row's ts must
    // exclude it, leaving the older row as the only in-range match.
    const exclusiveUpper = getTokensByDayModel(db, [acct], 1, {
      sinceMs: tenDaysAgo,
      untilMs: twoDaysAgo,
    });
    const exclusiveTotal = Object.values(exclusiveUpper).reduce(
      (sum, byModel) => sum + (byModel['m']?.inputTokens ?? 0),
      0,
    );
    expect(exclusiveTotal).toBe(111);

    // All-time `{}` returns every row regardless of days.
    const allTime = getTokensByDayModel(db, [acct], 1, {});
    const allTimeTotal = Object.values(allTime).reduce(
      (sum, byModel) => sum + (byModel['m']?.inputTokens ?? 0),
      0,
    );
    expect(allTimeTotal).toBe(111 + 222 + 333);
  });

  it('getToolStats: window excludes out-of-range rows in totals and percentiles', async () => {
    const { getToolStats, insertToolEvent } = await import('./db.js');
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const seed = (ts: number, durationMs: number, success: boolean, error: string | null) =>
      insertToolEvent(db, {
        ts,
        accountId: acct,
        sessionId: 's',
        toolName: 'Bash',
        success,
        durationMs,
        error,
        decisionSource: null,
        decisionType: null,
        mcpServerScope: null,
        toolResultSizeBytes: null,
      });
    // Out-of-window rows: one before sinceMs, one at/after untilMs. Both have
    // extreme durations + failures that would skew the result if leaked in.
    seed(now - 10 * DAY_MS, 9000, false, 'leaked-before');
    seed(now, 9999, false, 'leaked-after');
    // In-window rows (around 2 days ago): 3 successes, no failures.
    for (const d of [100, 200, 300]) {
      seed(now - 2 * DAY_MS, d, true, null);
    }

    const windowed = getToolStats(db, [acct], 1, 20, {
      sinceMs: now - 5 * DAY_MS,
      untilMs: now - 1 * DAY_MS,
    });
    const bash = windowed.find((s) => s.toolName === 'Bash')!;
    // Totals reflect only the 3 in-window rows.
    expect(bash.calls).toBe(3);
    // Success rate is 1: the two failures are out of window.
    expect(bash.successRate).toBe(1);
    // Percentiles come from [100,200,300] only — the 9000/9999 outliers are gone.
    expect(bash.p50Ms).toBe(200);
    expect(bash.p95Ms).toBe(300);
    // The out-of-window failure's error never surfaces.
    expect(bash.topError).toBeNull();
  });

  it('getToolStats: legacy days-only lookback still filters the rolling window', async () => {
    const { getToolStats, insertToolEvent } = await import('./db.js');
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const seed = (ts: number) =>
      insertToolEvent(db, {
        ts,
        accountId: acct,
        sessionId: 's',
        toolName: 'Bash',
        success: true,
        durationMs: 50,
        error: null,
        decisionSource: null,
        decisionType: null,
        mcpServerScope: null,
        toolResultSizeBytes: null,
      });
    seed(now); // inside a 7-day lookback
    seed(now - 30 * DAY_MS); // outside it

    // No window arg: rolling 7-day lookback excludes the 30-days-ago row.
    const recent = getToolStats(db, [acct], 7).find((s) => s.toolName === 'Bash')!;
    expect(recent.calls).toBe(1);
    // A 60-day lookback includes both rows — proves the bound is the day count.
    const wide = getToolStats(db, [acct], 60).find((s) => s.toolName === 'Bash')!;
    expect(wide.calls).toBe(2);
  });

  it("acknowledgeAllNotifications with accountId ack's scoped + null-scoped rows", async () => {
    const { acknowledgeAllNotifications, insertNotification, listNotifications } =
      await import('./db.js');
    insertNotification(db, { ts: 1, accountId: 'a', type: 'usage_alert', title: 'x', body: 'x' });
    insertNotification(db, {
      ts: 2,
      accountId: null,
      type: 'account_switched',
      title: 'x',
      body: 'x',
    });
    insertNotification(db, {
      ts: 3,
      accountId: 'other',
      type: 'usage_alert',
      title: 'x',
      body: 'x',
    });
    const n = acknowledgeAllNotifications(db, 'a');
    expect(n).toBe(2); // the 'a' one and the null-scoped one
    const unacked = listNotifications(db, { unacknowledgedOnly: true });
    expect(unacked).toHaveLength(1);
    expect(unacked[0]?.accountId).toBe('other');
  });

  it("acknowledgeAllNotifications without accountId ack's every unread", async () => {
    const { acknowledgeAllNotifications, insertNotification, listNotifications } =
      await import('./db.js');
    insertNotification(db, { ts: 1, accountId: 'a', type: 'usage_alert', title: 'x', body: 'x' });
    insertNotification(db, { ts: 2, accountId: 'b', type: 'usage_alert', title: 'x', body: 'x' });
    const n = acknowledgeAllNotifications(db);
    expect(n).toBe(2);
    expect(listNotifications(db, { unacknowledgedOnly: true })).toHaveLength(0);
  });

  it('listRemovedAccounts + reactivateAccount roundtrip', async () => {
    const { listRemovedAccounts, reactivateAccount } = await import('./db.js');
    const acc: AccountInfo = {
      id: 'rem',
      accountUuid: 'rem',
      email: 'r@x',
      displayName: '',
      orgUuid: '',
      orgName: '',
      planType: 'pro',
      isActive: false,
      createdAt: Date.now(),
      color: null,
    };
    upsertAccount(db, acc);
    markAccountRemoved(db, 'rem');
    expect(listRemovedAccounts(db)).toHaveLength(1);
    reactivateAccount(db, 'rem');
    expect(listRemovedAccounts(db)).toHaveLength(0);
    expect(listAccounts(db).some((a) => a.id === 'rem')).toBe(true);
  });
});

describe('Optimize window + retention DB helpers', () => {
  let db: Database.Database;
  const DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  // Seed cache_ttl_events — the proxy-written, live source the denominator
  // reads from (NOT usage_events, which is OTEL-fed and can stall).
  const seedProcessed = async (
    accountId: string,
    ts: number,
    tokens: { input: number; cacheRead: number; cacheCreate: number },
  ): Promise<void> => {
    const { insertCacheTtlEvent } = await import('./db.js');
    insertCacheTtlEvent(db, {
      ts,
      accountId,
      sessionId: 's',
      model: 'm',
      requestId: `r-${accountId}-${ts}-${tokens.input}`,
      reqMarkers5m: 0,
      reqMarkers1h: 0,
      cacheCreate5m: tokens.cacheCreate,
      cacheCreate1h: 0,
      cacheRead: tokens.cacheRead,
      inputTokens: tokens.input,
      cost5mWrite: 0,
      cost1hWrite: 0,
      costRead: 0,
    });
  };

  describe('getProcessedTokenTotals', () => {
    it('sums input-side tokens across all accounts and exposes the breakdown', async () => {
      const { getProcessedTokenTotals } = await import('./db.js');
      const now = Date.now();
      await seedProcessed('a', now, { input: 100, cacheRead: 20, cacheCreate: 5 });
      await seedProcessed('b', now, { input: 200, cacheRead: 40, cacheCreate: 10 });
      const t = getProcessedTokenTotals(db, {});
      expect(t.inputTokens).toBe(300);
      expect(t.cacheReadTokens).toBe(60);
      expect(t.cacheCreateTokens).toBe(15);
      // input-side = input + cache_read + cache_create (output excluded)
      expect(t.inputSideTokens).toBe(300 + 60 + 15);
    });

    it('returns zeros on an empty table', async () => {
      const { getProcessedTokenTotals } = await import('./db.js');
      expect(getProcessedTokenTotals(db, {})).toEqual({
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        inputSideTokens: 0,
      });
    });

    it('honors sinceMs, untilMs, and both together', async () => {
      const { getProcessedTokenTotals } = await import('./db.js');
      const now = Date.now();
      await seedProcessed('a', now - 10 * DAY, { input: 10, cacheRead: 0, cacheCreate: 0 });
      await seedProcessed('a', now - 5 * DAY, { input: 100, cacheRead: 0, cacheCreate: 0 });
      await seedProcessed('a', now - 1 * DAY, { input: 1000, cacheRead: 0, cacheCreate: 0 });
      // sinceMs only: excludes the 10-day-old row.
      expect(getProcessedTokenTotals(db, { sinceMs: now - 7 * DAY }).inputTokens).toBe(1100);
      // untilMs only: excludes the 1-day-old row.
      expect(getProcessedTokenTotals(db, { untilMs: now - 3 * DAY }).inputTokens).toBe(110);
      // both: only the middle row.
      expect(
        getProcessedTokenTotals(db, { sinceMs: now - 7 * DAY, untilMs: now - 3 * DAY }).inputTokens,
      ).toBe(100);
    });
  });

  describe('purgeOptimizationOlderThan', () => {
    const seedOpt = async (ts: number): Promise<void> => {
      const { insertOptimizationEvent } = await import('./db.js');
      insertOptimizationEvent(db, {
        ts,
        accountId: 'a',
        sessionId: null,
        curatedId: 'file-reader',
        kind: 'measured',
        pattern: 'p',
        savingsUsd: 0.01,
        actualInputTokens: 100,
        actualCachedTokens: 0,
        actualCostUsd: 0.02,
        hypotheticalCostUsd: 0.01,
        hypotheticalTotalTokens: 100,
        sourceToolCallIds: [],
      });
    };

    it('deletes only rows older than the cutoff and leaves usage_events untouched', async () => {
      const { purgeOptimizationOlderThan } = await import('./db.js');
      const now = Date.now();
      await seedOpt(now - 400 * DAY); // ancient
      await seedOpt(now - 1 * DAY); // fresh
      insertUsageEvent(db, {
        ts: now - 400 * DAY,
        accountId: 'a',
        sessionId: null,
        model: 'm',
        costUsd: 0,
        inputTokens: 5,
        outputTokens: 0,
        cacheRead: 0,
        cacheCreate: 0,
        durationMs: 0,
      });

      const cutoff = now - 365 * DAY;
      expect(purgeOptimizationOlderThan(db, cutoff)).toBe(1);

      const optRows = db.prepare('SELECT ts FROM optimization_events').all() as Array<{
        ts: number;
      }>;
      expect(optRows).toHaveLength(1);
      expect(optRows[0]!.ts).toBe(now - 1 * DAY);
      // usage_events (telemetry) is a different retention concern — untouched.
      expect((db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }).n).toBe(
        1,
      );
    });

    it('returns 0 when nothing is past the cutoff', async () => {
      const { purgeOptimizationOlderThan } = await import('./db.js');
      await seedOpt(Date.now());
      expect(purgeOptimizationOlderThan(db, Date.now() - 365 * DAY)).toBe(0);
    });
  });

  describe('getCacheHealthWindowRange', () => {
    const seedTtl = async (ts: number, cacheRead: number, create5m: number): Promise<void> => {
      const { insertCacheTtlEvent } = await import('./db.js');
      insertCacheTtlEvent(db, {
        ts,
        accountId: 'a',
        sessionId: 's',
        model: 'm',
        requestId: `r-${ts}-${create5m}`,
        reqMarkers5m: 1,
        reqMarkers1h: 0,
        cacheCreate5m: create5m,
        cacheCreate1h: 0,
        cacheRead,
        inputTokens: 0,
        cost5mWrite: 0,
        cost1hWrite: 0,
        costRead: 0,
      });
    };

    it('filters by an explicit window and computes the hit ratio', async () => {
      const { getCacheHealthWindowRange } = await import('./db.js');
      const now = Date.now();
      await seedTtl(now - 10 * DAY, 1000, 0); // out of window
      await seedTtl(now - 1 * DAY, 300, 100); // in window
      const h = getCacheHealthWindowRange(db, ['a'], { sinceMs: now - 7 * DAY });
      expect(h.cacheReadTokens).toBe(300);
      expect(h.cacheCreateTokens).toBe(100);
      expect(h.hitRatio).toBeCloseTo(300 / 400);
    });

    it('returns a healthy placeholder when no accounts are given', async () => {
      const { getCacheHealthWindowRange } = await import('./db.js');
      expect(getCacheHealthWindowRange(db, [], {})).toEqual({
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        hitRatio: 1,
      });
    });
  });
});

describe('alerts schema migration', () => {
  const LEGACY_DB = join(tmpdir(), `sentinel-alerts-legacy-${Date.now()}.db`);

  afterEach(() => {
    closeDb();
    if (existsSync(LEGACY_DB)) unlinkSync(LEGACY_DB);
  });

  it('adds the scope column to a pre-existing alerts table and back-fills "account"', async () => {
    // Build a DB that predates the `scope` column by hand.
    const raw = new Database(LEGACY_DB);
    raw.exec(`
      CREATE TABLE alerts (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id              TEXT NOT NULL,
        threshold_pct           INTEGER NOT NULL,
        enabled                 INTEGER NOT NULL DEFAULT 1,
        last_triggered_reset_ts INTEGER,
        created_at              INTEGER NOT NULL
      );
    `);
    raw
      .prepare(
        'INSERT INTO alerts (account_id, threshold_pct, enabled, created_at) VALUES (?, ?, ?, ?)',
      )
      .run('acc-legacy', 75, 1, Date.now());
    raw.close();

    // Reopen through getDb so the migration runs.
    const db = getDb(LEGACY_DB);
    const cols = db.pragma('table_info(alerts)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'scope')).toBe(true);

    // Legacy rows should read as scope='account' via the row mapper.
    const { listAlerts } = await import('./db.js');
    const rows = listAlerts(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scope).toBe('account');
    expect(rows[0]?.accountId).toBe('acc-legacy');
  });

  it('adds the budget_scope column to a pre-scope-migration alerts table', async () => {
    // DB that predates both the scope and budget_scope columns.
    const raw = new Database(LEGACY_DB);
    raw.exec(`
      CREATE TABLE alerts (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id              TEXT NOT NULL,
        threshold_pct           INTEGER NOT NULL,
        enabled                 INTEGER NOT NULL DEFAULT 1,
        last_triggered_reset_ts INTEGER,
        created_at              INTEGER NOT NULL
      );
    `);
    raw.close();

    const db = getDb(LEGACY_DB);
    const cols = db.pragma('table_info(alerts)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'scope')).toBe(true);
    expect(cols.some((c) => c.name === 'budget_scope')).toBe(true);
  });
});

describe('runSonnetToFableMigration', () => {
  const FABLE_DB = join(
    tmpdir(),
    `sentinel-sonnet-fable-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  afterEach(() => {
    closeDb();
    if (existsSync(FABLE_DB)) unlinkSync(FABLE_DB);
  });

  // Seed a pre-upgrade DB the way an old daemon left it: `account-sonnet`
  // alerts and a `unified-7d_sonnet` rate-limit row. These legacy string
  // values are no longer valid TS types, so they go in via raw SQL / the
  // free-form window name.
  function seedLegacy(db: Database.Database): void {
    db.prepare(
      'INSERT INTO alerts (scope, account_id, threshold_pct, enabled, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('account-sonnet', 'acc-1', 80, 1, 1_000);
    // A control alert on a different scope that must NOT be touched.
    db.prepare(
      'INSERT INTO alerts (scope, account_id, threshold_pct, enabled, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('account-weekly', 'acc-1', 90, 1, 1_000);
    const now = Date.now();
    upsertRateLimit(db, 'acc-1', {
      name: 'unified-7d_sonnet',
      status: 'allowed',
      utilization: 0.9,
      limit: null,
      remaining: null,
      reset: 200,
      lastUpdated: now,
    });
    // Control windows that must survive the purge.
    upsertRateLimit(db, 'acc-1', {
      name: 'unified-7d_oi',
      status: 'allowed',
      utilization: 0.1,
      limit: null,
      remaining: null,
      reset: 200,
      lastUpdated: now,
    });
    upsertRateLimit(db, 'acc-1', {
      name: 'unified-5h',
      status: 'allowed',
      utilization: 0.3,
      limit: null,
      remaining: null,
      reset: 100,
      lastUpdated: now,
    });
  }

  it('re-points account-sonnet alerts to account-fable and purges unified-7d_sonnet rows', () => {
    const db = getDb(FABLE_DB);
    seedLegacy(db);

    const result = runSonnetToFableMigration(db, 12_345);
    expect(result).toEqual({ alertsMigrated: 1, staleWindowsDeleted: 1 });

    // No account-sonnet rows remain; the migrated row is now account-fable
    // and keeps its account_id + threshold. The account-weekly control is
    // untouched.
    const scopes = db
      .prepare('SELECT scope, account_id, threshold_pct FROM alerts ORDER BY threshold_pct')
      .all() as Array<{ scope: string; account_id: string; threshold_pct: number }>;
    expect(scopes).toEqual([
      { scope: 'account-fable', account_id: 'acc-1', threshold_pct: 80 },
      { scope: 'account-weekly', account_id: 'acc-1', threshold_pct: 90 },
    ]);

    // Stale sonnet window gone; fable + 5h survive.
    const windows = (loadRateLimits(db).get('acc-1') ?? []).map((w) => w.name).sort();
    expect(windows).toEqual(['unified-5h', 'unified-7d_oi']);

    // Marker persisted.
    const marker = db
      .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
      .get('sonnet_to_fable_v1') as { ok: number } | undefined;
    expect(marker?.ok).toBe(1);
  });

  it('is idempotent — a second run is a no-op returning null', () => {
    const db = getDb(FABLE_DB);
    seedLegacy(db);

    expect(runSonnetToFableMigration(db, 1)).toEqual({ alertsMigrated: 1, staleWindowsDeleted: 1 });

    // Second run: marker present → null, no further mutation.
    expect(runSonnetToFableMigration(db, 2)).toBeNull();
    const fableAlerts = db
      .prepare("SELECT COUNT(*) AS n FROM alerts WHERE scope = 'account-fable'")
      .get() as { n: number };
    expect(fableAlerts.n).toBe(1);
    const sonnetRows = db
      .prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE name = 'unified-7d_sonnet'")
      .get() as { n: number };
    expect(sonnetRows.n).toBe(0);
  });

  it('returns zero counts when there is nothing to migrate', () => {
    const db = getDb(FABLE_DB);
    // Fresh DB, no legacy sonnet data.
    const result = runSonnetToFableMigration(db, 7);
    expect(result).toEqual({ alertsMigrated: 0, staleWindowsDeleted: 0 });
  });
});

describe('budget-scope alerts', () => {
  const BUDGET_DB = join(
    tmpdir(),
    `sentinel-alerts-budget-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  afterEach(() => {
    closeDb();
    if (existsSync(BUDGET_DB)) unlinkSync(BUDGET_DB);
  });

  it('round-trips a budget:account alert', async () => {
    const db = getDb(BUDGET_DB);
    const { upsertAlert, listAlerts } = await import('./db.js');
    const saved = upsertAlert(db, {
      scope: 'budget',
      budgetScope: 'account',
      accountId: 'acc-a',
      thresholdPct: 80,
      enabled: true,
    });
    expect(saved.scope).toBe('budget');
    expect(saved.budgetScope).toBe('account');
    expect(saved.accountId).toBe('acc-a');
    expect(saved.thresholdPct).toBe(80);

    const rows = listAlerts(db, { scope: 'budget' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scope).toBe('budget');
    expect(rows[0]?.accountId).toBe('acc-a');
  });

  it('round-trips a budget:global alert with null accountId', async () => {
    const db = getDb(BUDGET_DB);
    const { upsertAlert, listAlerts } = await import('./db.js');
    const saved = upsertAlert(db, {
      scope: 'budget',
      budgetScope: 'global',
      accountId: null,
      thresholdPct: 90,
      enabled: true,
    });
    expect(saved.scope).toBe('budget');
    expect(saved.budgetScope).toBe('global');
    expect(saved.accountId).toBe(null);

    const rows = listAlerts(db, { scope: 'budget' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountId).toBe(null);
    expect(rows[0]?.budgetScope).toBe('global');
  });

  it('rejects a budget:global alert with a non-null accountId', async () => {
    const db = getDb(BUDGET_DB);
    const { upsertAlert } = await import('./db.js');
    expect(() =>
      upsertAlert(db, {
        scope: 'budget',
        budgetScope: 'global',
        accountId: 'acc-a',
        thresholdPct: 80,
        enabled: true,
      }),
    ).toThrow();
  });

  it('rejects a budget:account alert with a null accountId', async () => {
    const db = getDb(BUDGET_DB);
    const { upsertAlert } = await import('./db.js');
    expect(() =>
      upsertAlert(db, {
        scope: 'budget',
        budgetScope: 'account',
        accountId: null,
        thresholdPct: 80,
        enabled: true,
      }),
    ).toThrow();
  });

  it('listAlerts by scope:budget + accountId returns only that account', async () => {
    const db = getDb(BUDGET_DB);
    const { upsertAlert, listAlerts } = await import('./db.js');
    upsertAlert(db, {
      scope: 'budget',
      budgetScope: 'account',
      accountId: 'acc-a',
      thresholdPct: 80,
      enabled: true,
    });
    upsertAlert(db, {
      scope: 'budget',
      budgetScope: 'account',
      accountId: 'acc-b',
      thresholdPct: 80,
      enabled: true,
    });
    upsertAlert(db, {
      scope: 'budget',
      budgetScope: 'global',
      accountId: null,
      thresholdPct: 90,
      enabled: true,
    });

    const aRows = listAlerts(db, { scope: 'budget', accountId: 'acc-a' });
    expect(aRows).toHaveLength(1);
    expect(aRows[0]?.accountId).toBe('acc-a');

    const all = listAlerts(db, { scope: 'budget' });
    expect(all).toHaveLength(3);
  });

  it('updates an existing budget alert in place', async () => {
    const db = getDb(BUDGET_DB);
    const { upsertAlert } = await import('./db.js');
    const saved = upsertAlert(db, {
      scope: 'budget',
      budgetScope: 'account',
      accountId: 'acc-a',
      thresholdPct: 80,
      enabled: true,
    });
    const updated = upsertAlert(db, {
      id: saved.id,
      scope: 'budget',
      budgetScope: 'account',
      accountId: 'acc-a',
      thresholdPct: 95,
      enabled: false,
    });
    expect(updated.id).toBe(saved.id);
    expect(updated.thresholdPct).toBe(95);
    expect(updated.enabled).toBe(false);
  });
});

describe('weekly-scope alerts (account-weekly + pool-weekly)', () => {
  const WEEKLY_DB = join(
    tmpdir(),
    `sentinel-alerts-weekly-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  afterEach(() => {
    closeDb();
    if (existsSync(WEEKLY_DB)) unlinkSync(WEEKLY_DB);
  });

  it('round-trips an account-weekly alert', async () => {
    const db = getDb(WEEKLY_DB);
    const { upsertAlert, listAlerts } = await import('./db.js');
    const saved = upsertAlert(db, {
      scope: 'account-weekly',
      accountId: 'acc-a',
      thresholdPct: 75,
      enabled: true,
    });
    expect(saved.scope).toBe('account-weekly');
    expect(saved.accountId).toBe('acc-a');
    expect(saved.thresholdPct).toBe(75);

    const rows = listAlerts(db, { scope: 'account-weekly', accountId: 'acc-a' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scope).toBe('account-weekly');
  });

  it('round-trips a pool-weekly alert with null accountId', async () => {
    const db = getDb(WEEKLY_DB);
    const { upsertAlert, listAlerts } = await import('./db.js');
    const saved = upsertAlert(db, {
      scope: 'pool-weekly',
      accountId: null,
      thresholdPct: 85,
      enabled: true,
    });
    expect(saved.scope).toBe('pool-weekly');
    expect(saved.accountId).toBe(null);

    const rows = listAlerts(db, { scope: 'pool-weekly' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountId).toBe(null);
  });

  it('rejects an account-weekly alert with no accountId', async () => {
    const db = getDb(WEEKLY_DB);
    const { upsertAlert } = await import('./db.js');
    expect(() =>
      upsertAlert(db, {
        scope: 'account-weekly',
        accountId: null,
        thresholdPct: 80,
        enabled: true,
      }),
    ).toThrow();
  });

  it('rejects a pool-weekly alert with a non-null accountId', async () => {
    const db = getDb(WEEKLY_DB);
    const { upsertAlert } = await import('./db.js');
    expect(() =>
      upsertAlert(db, {
        scope: 'pool-weekly',
        accountId: 'acc-a',
        thresholdPct: 80,
        enabled: true,
      }),
    ).toThrow();
  });

  it('listAlerts by account-weekly scope with no accountId returns every row ordered by account', async () => {
    const db = getDb(WEEKLY_DB);
    const { upsertAlert, listAlerts } = await import('./db.js');
    upsertAlert(db, {
      scope: 'account-weekly',
      accountId: 'acc-b',
      thresholdPct: 70,
      enabled: true,
    });
    upsertAlert(db, {
      scope: 'account-weekly',
      accountId: 'acc-a',
      thresholdPct: 80,
      enabled: true,
    });

    const rows = listAlerts(db, { scope: 'account-weekly' });
    expect(rows).toHaveLength(2);
    // Ordered by account_id, threshold_pct ASC.
    expect(rows[0]?.accountId).toBe('acc-a');
    expect(rows[1]?.accountId).toBe('acc-b');
  });

  it('updates an account-weekly alert in place', async () => {
    const db = getDb(WEEKLY_DB);
    const { upsertAlert } = await import('./db.js');
    const saved = upsertAlert(db, {
      scope: 'account-weekly',
      accountId: 'acc-a',
      thresholdPct: 80,
      enabled: true,
    });
    const updated = upsertAlert(db, {
      id: saved.id,
      scope: 'account-weekly',
      accountId: 'acc-a',
      thresholdPct: 90,
      enabled: false,
    });
    expect(updated.id).toBe(saved.id);
    expect(updated.thresholdPct).toBe(90);
    expect(updated.enabled).toBe(false);
  });

  it('updates a pool-weekly alert in place', async () => {
    const db = getDb(WEEKLY_DB);
    const { upsertAlert } = await import('./db.js');
    const saved = upsertAlert(db, {
      scope: 'pool-weekly',
      accountId: null,
      thresholdPct: 85,
      enabled: true,
    });
    const updated = upsertAlert(db, {
      id: saved.id,
      scope: 'pool-weekly',
      accountId: null,
      thresholdPct: 75,
      enabled: false,
    });
    expect(updated.id).toBe(saved.id);
    expect(updated.thresholdPct).toBe(75);
    expect(updated.enabled).toBe(false);
  });

  it('normalizes pool-weekly storage to account_id="" then back to null', async () => {
    // Mirrors the pool-scope invariant: the schema has a legacy NOT NULL
    // on account_id so the row is stored with '' and normalized back to
    // null in rowToAlert. Guards against a regression in either direction.
    const db = getDb(WEEKLY_DB);
    const { upsertAlert, listAlerts } = await import('./db.js');
    upsertAlert(db, {
      scope: 'pool-weekly',
      accountId: null,
      thresholdPct: 80,
      enabled: true,
    });
    // Raw SQL: row should have account_id = '' (stored form).
    const rawRows = db
      .prepare("SELECT account_id FROM alerts WHERE scope = 'pool-weekly'")
      .all() as Array<{ account_id: string }>;
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0]?.account_id).toBe('');
    // Typed listAlerts normalizes back to null.
    const rows = listAlerts(db, { scope: 'pool-weekly' });
    expect(rows[0]?.accountId).toBe(null);
  });
});

const PERMS_DB = join(
  tmpdir(),
  `sentinel-perms-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
);

describe('permission_rules CRUD', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = getDb(PERMS_DB);
  });

  afterEach(() => {
    closeDb();
    if (existsSync(PERMS_DB)) unlinkSync(PERMS_DB);
  });

  it('creates a new rule with auto-assigned id and priority', () => {
    const saved = upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
    });
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.priority).toBeGreaterThan(0);
    expect(saved.enabled).toBe(true);
    expect(saved.decision).toBe('deny');
    expect(saved.tool).toBe('Bash');
    expect(saved.pattern).toBe('rm -rf *');
    expect(saved.raw).toBe('Bash(rm -rf *)');
  });

  it('appends new rules with priority > existing', () => {
    const a = upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: null,
      raw: 'Bash',
    });
    const b = upsertPermissionRule(db, {
      decision: 'allow',
      tool: 'Read',
      pattern: null,
      raw: 'Read',
    });
    expect(b.priority).toBeGreaterThan(a.priority);
  });

  it('lists rules in priority order', () => {
    upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: null,
      raw: 'Bash',
      priority: 50,
    });
    upsertPermissionRule(db, {
      decision: 'allow',
      tool: 'Read',
      pattern: null,
      raw: 'Read',
      priority: 10,
    });
    const list = listPermissionRules(db);
    expect(list.map((r) => r.tool)).toEqual(['Read', 'Bash']);
  });

  it('updates a rule in place by id', () => {
    const saved = upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: null,
      raw: 'Bash',
    });
    const updated = upsertPermissionRule(db, {
      id: saved.id,
      decision: 'allow',
      tool: 'Bash',
      pattern: 'npm *',
      raw: 'Bash(npm *)',
      note: 'trusted',
    });
    expect(updated.id).toBe(saved.id);
    expect(updated.decision).toBe('allow');
    expect(updated.pattern).toBe('npm *');
    expect(updated.note).toBe('trusted');
    expect(listPermissionRules(db)).toHaveLength(1);
  });

  it('toggles enabled via upsert', () => {
    const saved = upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: null,
      raw: 'Bash',
    });
    const disabled = upsertPermissionRule(db, {
      id: saved.id,
      decision: saved.decision,
      tool: saved.tool,
      pattern: saved.pattern,
      raw: saved.raw,
      enabled: false,
    });
    expect(disabled.enabled).toBe(false);
  });

  it('deletes a rule by id', () => {
    const saved = upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: null,
      raw: 'Bash',
    });
    expect(deletePermissionRule(db, saved.id)).toBe(true);
    expect(listPermissionRules(db)).toHaveLength(0);
  });

  it('returns false when deleting unknown id', () => {
    expect(deletePermissionRule(db, 'nope')).toBe(false);
  });

  it('falls back to create when upsert id does not exist', () => {
    const saved = upsertPermissionRule(db, {
      id: '00000000-0000-0000-0000-000000000000',
      decision: 'deny',
      tool: 'Bash',
      pattern: null,
      raw: 'Bash',
    });
    expect(saved.id).toBe('00000000-0000-0000-0000-000000000000');
    expect(listPermissionRules(db)).toHaveLength(1);
  });

  it('upserts by raw when no id is supplied — same raw updates in place', () => {
    // Historical bug: an upsert without id for a rule whose raw already
    // existed would insert a second row because the fallback lookup
    // keyed on id. Canonical identity is `raw`; same raw = same rule.
    const first = upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
    });
    const second = upsertPermissionRule(db, {
      decision: 'ask',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
    });
    expect(second.id).toBe(first.id);
    expect(second.decision).toBe('ask');
    expect(listPermissionRules(db)).toHaveLength(1);
  });

  it('upsert-by-raw preserves sticky source when caller omits it', () => {
    // Once a rule is claude-code (imported from settings.json), a
    // bare upsert from some other code path shouldn't silently flip
    // its ownership back to local — that would break orphan cleanup.
    const imported = upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      source: 'claude-code',
    });
    const touched = upsertPermissionRule(db, {
      decision: 'ask',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      // no source
    });
    expect(touched.id).toBe(imported.id);
    expect(touched.source).toBe('claude-code');
  });
});

describe('cache_ttl_events', () => {
  let db: Database.Database;
  const acct = 'acct-ttl';

  beforeEach(() => {
    db = makeTestDb();
  });

  afterEach(() => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  async function seed(
    overrides: Partial<Parameters<typeof import('./db.js').insertCacheTtlEvent>[1]> = {},
  ): Promise<void> {
    const { insertCacheTtlEvent } = await import('./db.js');
    insertCacheTtlEvent(db, {
      ts: Date.now(),
      accountId: acct,
      sessionId: 's1',
      model: 'claude-sonnet-4-6',
      requestId: 'req-1',
      reqMarkers5m: 1,
      reqMarkers1h: 1,
      cacheCreate5m: 100,
      cacheCreate1h: 200,
      cacheRead: 50,
      inputTokens: 10,
      cost5mWrite: 0.000375,
      cost1hWrite: 0.0012,
      costRead: 0.000015,
      ...overrides,
    });
  }

  it('insertCacheTtlEvent persists every column', async () => {
    const { insertCacheTtlEvent } = await import('./db.js');
    const id = insertCacheTtlEvent(db, {
      ts: 1_700_000_000_000,
      accountId: acct,
      sessionId: 'sess-x',
      model: 'claude-opus-4-7',
      requestId: 'r1',
      reqMarkers5m: 2,
      reqMarkers1h: 3,
      cacheCreate5m: 400,
      cacheCreate1h: 500,
      cacheRead: 600,
      inputTokens: 7,
      cost5mWrite: 0.0075,
      cost1hWrite: 0.015,
      costRead: 0.0009,
    });
    expect(id).toBeGreaterThan(0);
    const row = db.prepare('SELECT * FROM cache_ttl_events WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    expect(row).toMatchObject({
      ts: 1_700_000_000_000,
      account_id: acct,
      session_id: 'sess-x',
      model: 'claude-opus-4-7',
      request_id: 'r1',
      req_markers_5m: 2,
      req_markers_1h: 3,
      cache_create_5m: 400,
      cache_create_1h: 500,
      cache_read: 600,
      input_tokens: 7,
      cost_5m_write: 0.0075,
      cost_1h_write: 0.015,
      cost_read: 0.0009,
    });
  });

  it('getCacheTtlByDayModel groups by day and model', async () => {
    const { getCacheTtlByDayModel } = await import('./db.js');
    await seed({ model: 'claude-sonnet-4-6', cacheCreate5m: 100, cacheCreate1h: 0 });
    await seed({ model: 'claude-sonnet-4-6', cacheCreate5m: 50, cacheCreate1h: 0 });
    await seed({ model: 'claude-opus-4-7', cacheCreate5m: 0, cacheCreate1h: 300 });
    const out = getCacheTtlByDayModel(db, [acct], 7);
    const days = Object.keys(out);
    expect(days).toHaveLength(1);
    const day = days[0]!;
    expect(out[day]!['claude-sonnet-4-6']?.create5m).toBe(150);
    expect(out[day]!['claude-sonnet-4-6']?.create1h).toBe(0);
    expect(out[day]!['claude-opus-4-7']?.create1h).toBe(300);
  });

  it('getCacheTtlByDayModel filters by accountId and date window', async () => {
    const { getCacheTtlByDayModel } = await import('./db.js');
    const tooOld = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await seed({ ts: tooOld });
    await seed({ accountId: 'other-acct' });
    await seed({ cacheCreate5m: 42 });
    const out = getCacheTtlByDayModel(db, [acct], 7);
    const totals = Object.values(out).flatMap((m) => Object.values(m));
    expect(totals).toHaveLength(1);
    expect(totals[0]!.create5m).toBe(42);
  });

  it('getCacheTtlByDayModel returns empty object when no rows', async () => {
    const { getCacheTtlByDayModel } = await import('./db.js');
    expect(getCacheTtlByDayModel(db, [acct], 7)).toEqual({});
  });

  it('getCacheTtlBySession groups rows and sums token + cost fields', async () => {
    const { getCacheTtlBySession } = await import('./db.js');
    const base = Date.now();
    await seed({
      ts: base - 2000,
      sessionId: 's1',
      cacheCreate5m: 10,
      cacheCreate1h: 0,
      cost5mWrite: 0.01,
    });
    await seed({
      ts: base - 1000,
      sessionId: 's1',
      cacheCreate5m: 20,
      cacheCreate1h: 5,
      cost5mWrite: 0.02,
      cost1hWrite: 0.01,
    });
    await seed({ ts: base, sessionId: 's2', cacheCreate5m: 3 });
    const rows = getCacheTtlBySession(db, [acct], 7);
    expect(rows).toHaveLength(2);
    // Ordered by lastTs DESC → s2 first
    expect(rows[0]!.sessionId).toBe('s2');
    expect(rows[1]!.sessionId).toBe('s1');
    expect(rows[1]!.create5m).toBe(30);
    expect(rows[1]!.create1h).toBe(5);
    expect(rows[1]!.requestCount).toBe(2);
    expect(rows[1]!.cost5mWrite).toBeCloseTo(0.03);
    expect(rows[1]!.cost1hWrite).toBeCloseTo(0.01);
    expect(rows[1]!.firstTs).toBe(base - 2000);
    expect(rows[1]!.lastTs).toBe(base - 1000);
  });

  it('getCacheTtlBySession skips rows with null or empty session_id', async () => {
    const { getCacheTtlBySession } = await import('./db.js');
    await seed({ sessionId: null });
    await seed({ sessionId: '' });
    await seed({ sessionId: 'real' });
    const rows = getCacheTtlBySession(db, [acct], 7);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sessionId).toBe('real');
  });

  it('getCacheTtlBySession respects the limit parameter', async () => {
    const { getCacheTtlBySession } = await import('./db.js');
    for (let i = 0; i < 5; i++) {
      await seed({ ts: Date.now() - i * 1000, sessionId: `s${i}` });
    }
    expect(getCacheTtlBySession(db, [acct], 7, 3)).toHaveLength(3);
  });

  it('getCacheTtlBySession picks the most recent model per session', async () => {
    const { getCacheTtlBySession } = await import('./db.js');
    const base = Date.now();
    await seed({ ts: base - 5000, sessionId: 'sx', model: 'claude-sonnet-4-6' });
    await seed({ ts: base, sessionId: 'sx', model: 'claude-opus-4-7' });
    const rows = getCacheTtlBySession(db, [acct], 7);
    expect(rows[0]!.model).toBe('claude-opus-4-7');
  });
});

describe('listOptimizationEventsWithSources', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  async function seedToolCall(args: {
    id?: number;
    ts?: number;
    sessionId?: string | null;
    toolName?: string;
    filePath?: string | null;
    responseSizeBytes?: number | null;
    denied?: boolean;
  }): Promise<number> {
    const { insertToolCall } = await import('./db.js');
    return insertToolCall(db, {
      ts: args.ts ?? Date.now(),
      accountId: 'a1',
      sessionId: args.sessionId ?? 's1',
      requestId: 'r1',
      requestSeqInSession: 1,
      toolUseId: `toolu_${args.id ?? Math.random()}`,
      toolName: args.toolName ?? 'Read',
      filePath: args.filePath ?? '/x.ts',
      inputSizeBytes: 100,
      responseSizeBytes: args.responseSizeBytes ?? 50_000,
      denied: args.denied ?? false,
      model: 'claude-opus-4-7',
    });
  }

  async function seedEvent(args: {
    ts?: number;
    curatedId?: string;
    pattern?: string;
    kind?: 'measured' | 'dismissed' | 'recommended' | 'installed';
    savings?: number | null;
    sourceIds?: number[];
  }): Promise<void> {
    const { insertOptimizationEvent } = await import('./db.js');
    insertOptimizationEvent(db, {
      ts: args.ts ?? Date.now(),
      accountId: 'a1',
      sessionId: 's1',
      curatedId: args.curatedId ?? 'file-explorer',
      kind: args.kind ?? 'measured',
      pattern: args.pattern ?? 'short_turn_after_large_read',
      savingsUsd: args.savings ?? 0.25,
      actualInputTokens: 1000,
      actualCachedTokens: 0,
      actualCostUsd: 0.5,
      hypotheticalCostUsd: 0.25,
      hypotheticalTotalTokens: 600,
      sourceToolCallIds: args.sourceIds ?? [],
    });
  }

  it('hydrates source_tool_call_ids into inline ToolCallSummary[]', async () => {
    const { listOptimizationEventsWithSources } = await import('./db.js');
    const id1 = await seedToolCall({ filePath: '/a.ts' });
    const id2 = await seedToolCall({ filePath: '/b.ts', responseSizeBytes: 12_345 });
    await seedEvent({ sourceIds: [id1, id2] });
    const r = listOptimizationEventsWithSources(db);
    expect(r.events).toHaveLength(1);
    expect(r.total).toBe(1);
    expect(r.events[0]?.sourceCalls).toHaveLength(2);
    const paths = r.events[0]?.sourceCalls.map((c) => c.filePath).sort();
    expect(paths).toEqual(['/a.ts', '/b.ts']);
    const sizes = r.events[0]?.sourceCalls.map((c) => c.responseSizeBytes).sort();
    expect(sizes).toEqual([12345, 50000]);
  });

  it('marks events realized=true when an active install covers their timestamp', async () => {
    const { upsertSubagentInstall, listOptimizationEventsWithSources } = await import('./db.js');
    const t = Date.now();
    upsertSubagentInstall(db, {
      name: 'file-explorer',
      source: 'curated',
      curatedId: 'file-explorer',
      gapFingerprint: null,
      mdPath: '/tmp/fe.md',
      mdHash: 'h',
      installedAt: t - 60_000,
    });
    await seedEvent({ ts: t, curatedId: 'file-explorer' });
    const r = listOptimizationEventsWithSources(db);
    expect(r.events[0]?.realized).toBe(true);
  });

  it('marks events realized=false when no install covers their timestamp', async () => {
    const { listOptimizationEventsWithSources } = await import('./db.js');
    await seedEvent({ curatedId: 'file-explorer' });
    const r = listOptimizationEventsWithSources(db);
    expect(r.events[0]?.realized).toBe(false);
  });

  it('filters by kind=dismissed', async () => {
    const { listOptimizationEventsWithSources } = await import('./db.js');
    await seedEvent({ kind: 'measured' });
    await seedEvent({ kind: 'dismissed', savings: null });
    const measured = listOptimizationEventsWithSources(db, { kind: 'measured' });
    const dismissed = listOptimizationEventsWithSources(db, { kind: 'dismissed' });
    expect(measured.events).toHaveLength(1);
    expect(measured.total).toBe(1);
    expect(measured.events[0]?.kind).toBe('measured');
    expect(dismissed.events).toHaveLength(1);
    expect(dismissed.events[0]?.kind).toBe('dismissed');
  });

  it('filters by curatedId', async () => {
    const { listOptimizationEventsWithSources } = await import('./db.js');
    await seedEvent({ curatedId: 'file-explorer' });
    await seedEvent({ curatedId: 'log-analyzer' });
    const fe = listOptimizationEventsWithSources(db, { curatedId: 'file-explorer' });
    expect(fe.events).toHaveLength(1);
    expect(fe.events[0]?.curatedId).toBe('file-explorer');
  });

  it('window narrows rows AND the pagination total by oe.ts', async () => {
    const { listOptimizationEventsWithSources } = await import('./db.js');
    const DAY = 86_400_000;
    const base = Date.now();
    await seedEvent({ ts: base - 2 * DAY, curatedId: 'too-old' });
    await seedEvent({ ts: base, curatedId: 'in-window' });
    await seedEvent({ ts: base + 2 * DAY, curatedId: 'too-new' });
    const r = listOptimizationEventsWithSources(db, {
      window: { sinceMs: base - DAY, untilMs: base + DAY },
    });
    expect(r.events.map((e) => e.curatedId)).toEqual(['in-window']);
    expect(r.total).toBe(1);
  });

  it('window bounds are half-open: sinceMs inclusive, untilMs exclusive', async () => {
    const { listOptimizationEventsWithSources } = await import('./db.js');
    const DAY = 86_400_000;
    const t0 = Date.now();
    const t1 = t0 + DAY;
    await seedEvent({ ts: t0, curatedId: 'at-since' });
    await seedEvent({ ts: t1, curatedId: 'at-until' });
    const r = listOptimizationEventsWithSources(db, { window: { sinceMs: t0, untilMs: t1 } });
    expect(r.events.map((e) => e.curatedId)).toEqual(['at-since']);
    expect(r.total).toBe(1);
  });

  it('an empty window object behaves as all-time', async () => {
    const { listOptimizationEventsWithSources } = await import('./db.js');
    const DAY = 86_400_000;
    await seedEvent({ ts: Date.now() - 90 * DAY, curatedId: 'ancient' });
    await seedEvent({ ts: Date.now(), curatedId: 'fresh' });
    const r = listOptimizationEventsWithSources(db, { window: {} });
    expect(r.events).toHaveLength(2);
    expect(r.total).toBe(2);
  });

  it('window composes with the realized filter (JS-counted total path)', async () => {
    const { upsertSubagentInstall, listOptimizationEventsWithSources } = await import('./db.js');
    const DAY = 86_400_000;
    const t = Date.now();
    upsertSubagentInstall(db, {
      name: 'file-explorer',
      source: 'curated',
      curatedId: 'file-explorer',
      gapFingerprint: null,
      mdPath: '/tmp/fe.md',
      mdHash: 'h',
      installedAt: t - 5 * DAY,
    });
    // Two realized events, only one inside the window.
    await seedEvent({ ts: t - 3 * DAY, curatedId: 'file-explorer' });
    await seedEvent({ ts: t, curatedId: 'file-explorer' });
    const r = listOptimizationEventsWithSources(db, {
      realized: true,
      window: { sinceMs: t - DAY },
    });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.realized).toBe(true);
    expect(r.total).toBe(1);
  });

  it('filters by realized=true after the LEFT JOIN computes the flag', async () => {
    const { upsertSubagentInstall, listOptimizationEventsWithSources } = await import('./db.js');
    const t = Date.now();
    upsertSubagentInstall(db, {
      name: 'file-explorer',
      source: 'curated',
      curatedId: 'file-explorer',
      gapFingerprint: null,
      mdPath: '/tmp/fe.md',
      mdHash: 'h',
      installedAt: t - 60_000,
    });
    await seedEvent({ ts: t, curatedId: 'file-explorer' });
    await seedEvent({ ts: t, curatedId: 'log-analyzer' }); // no install -> potential
    const realized = listOptimizationEventsWithSources(db, { realized: true });
    expect(realized.events).toHaveLength(1);
    expect(realized.total).toBe(1);
    expect(realized.events[0]?.curatedId).toBe('file-explorer');
    const potential = listOptimizationEventsWithSources(db, { realized: false });
    expect(potential.events).toHaveLength(1);
    expect(potential.events[0]?.curatedId).toBe('log-analyzer');
  });

  it('clamps limit to [1, 500]', async () => {
    const { listOptimizationEventsWithSources } = await import('./db.js');
    for (let i = 0; i < 3; i++) await seedEvent({ ts: Date.now() + i });
    const r0 = listOptimizationEventsWithSources(db, { limit: 0 });
    expect(r0.events).toHaveLength(1); // clamped to 1
    expect(r0.total).toBe(3);
    const rBig = listOptimizationEventsWithSources(db, { limit: 9999 });
    expect(rBig.events.length).toBeLessThanOrEqual(500);
  });

  it('returns empty sourceCalls when source_tool_call_ids reference pruned rows', async () => {
    const { listOptimizationEventsWithSources } = await import('./db.js');
    await seedEvent({ sourceIds: [99999] });
    const r = listOptimizationEventsWithSources(db);
    expect(r.events[0]?.sourceCalls).toEqual([]);
  });

  it('paginates via offset and reports a stable total across pages', async () => {
    const { listOptimizationEventsWithSources } = await import('./db.js');
    // Five rows ordered by ts desc; pages of two should cover them in
    // exactly three calls and the total stays at 5 throughout.
    const base = Date.now();
    for (let i = 0; i < 5; i++) await seedEvent({ ts: base + i });
    const page1 = listOptimizationEventsWithSources(db, { limit: 2, offset: 0 });
    const page2 = listOptimizationEventsWithSources(db, { limit: 2, offset: 2 });
    const page3 = listOptimizationEventsWithSources(db, { limit: 2, offset: 4 });
    expect(page1.events).toHaveLength(2);
    expect(page2.events).toHaveLength(2);
    expect(page3.events).toHaveLength(1);
    for (const r of [page1, page2, page3]) expect(r.total).toBe(5);
    // No row appears on more than one page.
    const ids = [...page1.events, ...page2.events, ...page3.events].map((e) => e.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('search matches curated_id, pattern, and session_id (case-insensitive)', async () => {
    const { listOptimizationEventsWithSources } = await import('./db.js');
    await seedEvent({ curatedId: 'file-explorer', pattern: 'short_turn_after_large_read' });
    await seedEvent({ curatedId: 'log-analyzer', pattern: 'bash_log_parse' });
    // curated_id match (case-insensitive)
    expect(listOptimizationEventsWithSources(db, { search: 'EXPLORER' }).total).toBe(1);
    // pattern match
    expect(listOptimizationEventsWithSources(db, { search: 'bash_log' }).total).toBe(1);
    // session_id match (seedEvent uses 's1' for both, so this matches everything)
    expect(listOptimizationEventsWithSources(db, { search: 's1' }).total).toBe(2);
    // no match
    expect(listOptimizationEventsWithSources(db, { search: 'nope' }).total).toBe(0);
  });

  it('regressionsOnly filters to realized rows below the half-cent threshold', async () => {
    const { upsertSubagentInstall, listOptimizationEventsWithSources } = await import('./db.js');
    const t = Date.now();
    upsertSubagentInstall(db, {
      name: 'file-explorer',
      source: 'curated',
      curatedId: 'file-explorer',
      gapFingerprint: null,
      mdPath: '/tmp/fe.md',
      mdHash: 'h',
      installedAt: t - 60_000,
    });
    upsertSubagentInstall(db, {
      name: 'log-analyzer',
      source: 'curated',
      curatedId: 'log-analyzer',
      gapFingerprint: null,
      mdPath: '/tmp/la.md',
      mdHash: 'h',
      installedAt: t - 60_000,
    });
    // Three measured rows under installed subagents. Only the misfit
    // (negative savings beyond the noise floor) should match.
    await seedEvent({ ts: t, curatedId: 'file-explorer', savings: 0.42 }); // realized win
    await seedEvent({ ts: t, curatedId: 'log-analyzer', savings: -0.05 }); // realized regression
    await seedEvent({ ts: t, curatedId: 'file-explorer', savings: -0.001 }); // sub-noise, not a regression

    const r = listOptimizationEventsWithSources(db, { regressionsOnly: true });
    expect(r.events).toHaveLength(1);
    expect(r.total).toBe(1);
    expect(r.events[0]?.curatedId).toBe('log-analyzer');
    expect(r.events[0]?.savingsUsd).toBe(-0.05);
    expect(r.events[0]?.realized).toBe(true);
  });

  it('regressionsOnly excludes potential rows even if their savings are negative', async () => {
    const { listOptimizationEventsWithSources } = await import('./db.js');
    // No install at all → all rows are "potential". Even with negative
    // savings, none should appear because regressionsOnly pins
    // realized=true.
    await seedEvent({ curatedId: 'log-analyzer', savings: -0.5 });
    const r = listOptimizationEventsWithSources(db, { regressionsOnly: true });
    expect(r.events).toHaveLength(0);
    expect(r.total).toBe(0);
  });

  it('regressionsOnly composes with curatedId and search filters', async () => {
    const { upsertSubagentInstall, listOptimizationEventsWithSources } = await import('./db.js');
    const t = Date.now();
    upsertSubagentInstall(db, {
      name: 'file-explorer',
      source: 'curated',
      curatedId: 'file-explorer',
      gapFingerprint: null,
      mdPath: '/tmp/fe.md',
      mdHash: 'h',
      installedAt: t - 60_000,
    });
    upsertSubagentInstall(db, {
      name: 'log-analyzer',
      source: 'curated',
      curatedId: 'log-analyzer',
      gapFingerprint: null,
      mdPath: '/tmp/la.md',
      mdHash: 'h',
      installedAt: t - 60_000,
    });
    await seedEvent({ ts: t, curatedId: 'file-explorer', savings: -0.1 });
    await seedEvent({ ts: t, curatedId: 'log-analyzer', savings: -0.2 });

    const fe = listOptimizationEventsWithSources(db, {
      regressionsOnly: true,
      curatedId: 'file-explorer',
    });
    expect(fe.events).toHaveLength(1);
    expect(fe.events[0]?.curatedId).toBe('file-explorer');

    const search = listOptimizationEventsWithSources(db, {
      regressionsOnly: true,
      search: 'analyzer',
    });
    expect(search.events).toHaveLength(1);
    expect(search.events[0]?.curatedId).toBe('log-analyzer');
  });

  it('positiveSavingsOnly excludes rows at or below the half-cent floor', async () => {
    const { listOptimizationEventsWithSources } = await import('./db.js');
    await seedEvent({ curatedId: 'file-explorer', savings: 0.42 }); // real opportunity
    await seedEvent({ curatedId: 'file-explorer', savings: 0.001 }); // sub-floor noise
    await seedEvent({ curatedId: 'log-analyzer', savings: -0.05 }); // misfit warning
    const r = listOptimizationEventsWithSources(db, { positiveSavingsOnly: true });
    expect(r.events).toHaveLength(1);
    expect(r.total).toBe(1);
    expect(r.events[0]?.savingsUsd).toBe(0.42);
  });

  it('listOptimizationEventsWithSources returns digestTokens per row from the shared lookup', async () => {
    const { listOptimizationEventsWithSources } = await import('./db.js');
    await seedEvent({ curatedId: 'file-explorer' });
    await seedEvent({ curatedId: 'log-analyzer' });
    await seedEvent({ curatedId: 'unknown-future-agent' });
    const r = listOptimizationEventsWithSources(db);
    const byId = new Map(r.events.map((e) => [e.curatedId, e.digestTokens]));
    // Numbers must match the shared optimize-digests table; refusing to
    // duplicate them in the assertion keeps the source-of-truth single.
    const { getDigestTokens } = await import('@sentinel/shared');
    expect(byId.get('file-explorer')).toBe(getDigestTokens('file-explorer'));
    expect(byId.get('log-analyzer')).toBe(getDigestTokens('log-analyzer'));
    expect(byId.get('unknown-future-agent')).toBe(getDigestTokens('unknown-future-agent'));
  });

  it('search composes with realized filter and reports the correct total', async () => {
    const { upsertSubagentInstall, listOptimizationEventsWithSources } = await import('./db.js');
    const t = Date.now();
    upsertSubagentInstall(db, {
      name: 'file-explorer',
      source: 'curated',
      curatedId: 'file-explorer',
      gapFingerprint: null,
      mdPath: '/tmp/fe.md',
      mdHash: 'h',
      installedAt: t - 60_000,
    });
    await seedEvent({ ts: t, curatedId: 'file-explorer' }); // realized
    await seedEvent({ ts: t, curatedId: 'log-analyzer' }); // potential
    // Search for 'analyzer' AND realized=true → no rows.
    const r = listOptimizationEventsWithSources(db, {
      search: 'analyzer',
      realized: true,
    });
    expect(r.events).toHaveLength(0);
    expect(r.total).toBe(0);
    // Search for 'analyzer' AND realized=false → the log-analyzer row.
    const p = listOptimizationEventsWithSources(db, {
      search: 'analyzer',
      realized: false,
    });
    expect(p.total).toBe(1);
    expect(p.events[0]?.curatedId).toBe('log-analyzer');
  });
});

describe('hypothetical_total_tokens back-fill migration', () => {
  // Mirrors the schema as it shipped before the column existed. The
  // back-fill migration only fires on rows where the column is NULL,
  // so we build a "legacy" DB by hand and read back through getDb()
  // (which runs the migration on open).
  const LEGACY_DB = join(tmpdir(), `sentinel-token-backfill-${Date.now()}-${Math.random()}.db`);

  afterEach(() => {
    closeDb();
    if (existsSync(LEGACY_DB)) unlinkSync(LEGACY_DB);
  });

  it('back-fills hypothetical_total_tokens by inverting the savings formula', async () => {
    // Pre-column schema: optimization_events without hypothetical_total_tokens.
    const raw = new Database(LEGACY_DB);
    raw.exec(`
      CREATE TABLE optimization_events (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                       INTEGER NOT NULL,
        account_id               TEXT    NOT NULL,
        session_id               TEXT,
        curated_id               TEXT    NOT NULL,
        kind                     TEXT    NOT NULL,
        pattern                  TEXT,
        savings_usd              REAL,
        actual_input_tokens      INTEGER,
        actual_cached_tokens     INTEGER,
        actual_cost_usd          REAL,
        hypothetical_cost_usd    REAL,
        source_tool_call_ids     TEXT
      );
    `);
    // Seed three measured rows representative of the curated library.
    // hypothetical_cost_usd values picked so the inversion produces
    // round numbers we can assert on.
    raw
      .prepare(
        `INSERT INTO optimization_events
           (ts, account_id, curated_id, kind, pattern, savings_usd,
            actual_input_tokens, actual_cached_tokens,
            actual_cost_usd, hypothetical_cost_usd, source_tool_call_ids)
         VALUES (?, ?, ?, 'measured', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        'a1',
        'file-explorer',
        'short_turn_after_large_read',
        0.3,
        50_000,
        0,
        0.5,
        0.0125, // pre-migration row
        '[]',
      );
    raw
      .prepare(
        `INSERT INTO optimization_events
           (ts, account_id, curated_id, kind, pattern, savings_usd,
            actual_input_tokens, actual_cached_tokens,
            actual_cost_usd, hypothetical_cost_usd, source_tool_call_ids)
         VALUES (?, ?, ?, 'measured', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        'a1',
        'log-analyzer',
        'bash_log_parse',
        0.2,
        30_000,
        0,
        0.4,
        0.018, // pre-migration row
        '[]',
      );
    // A 'dismissed' row with no hypothetical cost — must NOT be touched.
    raw
      .prepare(
        `INSERT INTO optimization_events
           (ts, account_id, curated_id, kind, pattern, source_tool_call_ids)
         VALUES (?, 'a1', 'file-explorer', 'dismissed', 'short_turn_after_large_read', '[]')`,
      )
      .run(Date.now());
    raw.close();

    // Open via getDb — both the column-add and the back-fill should run.
    const db = getDb(LEGACY_DB);
    const cols = db.pragma('table_info(optimization_events)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'hypothetical_total_tokens')).toBe(true);

    // file-explorer: digest=500, baseActual=15, baseHypo=1
    //   hypoInputTokens = (0.0125 * 1e6 - 500*15) / 1 = 12500 - 7500 = 5000
    //   total = 5000 + 500 = 5500
    const fe = db
      .prepare(
        "SELECT hypothetical_total_tokens FROM optimization_events WHERE curated_id='file-explorer' AND kind='measured'",
      )
      .get() as { hypothetical_total_tokens: number };
    expect(fe.hypothetical_total_tokens).toBe(5500);

    // log-analyzer: digest=800
    //   hypoInputTokens = (0.018 * 1e6 - 800*15) / 1 = 18000 - 12000 = 6000
    //   total = 6000 + 800 = 6800
    const la = db
      .prepare(
        "SELECT hypothetical_total_tokens FROM optimization_events WHERE curated_id='log-analyzer' AND kind='measured'",
      )
      .get() as { hypothetical_total_tokens: number };
    expect(la.hypothetical_total_tokens).toBe(6800);

    // Dismissed rows are left alone — no hypothetical_cost_usd to invert.
    const dismissed = db
      .prepare("SELECT hypothetical_total_tokens FROM optimization_events WHERE kind='dismissed'")
      .get() as { hypothetical_total_tokens: number | null };
    expect(dismissed.hypothetical_total_tokens).toBeNull();
  });

  it('floors at 0 when the hypothetical cost is below the digest baseline', async () => {
    // A degenerate row whose hypothetical_cost_usd is tiny — the
    // inversion would otherwise produce a negative input-token count,
    // which is meaningless. We clamp to 0 so the stored total equals
    // just the digest size.
    const raw = new Database(LEGACY_DB);
    raw.exec(`
      CREATE TABLE optimization_events (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                       INTEGER NOT NULL,
        account_id               TEXT    NOT NULL,
        session_id               TEXT,
        curated_id               TEXT    NOT NULL,
        kind                     TEXT    NOT NULL,
        pattern                  TEXT,
        savings_usd              REAL,
        actual_input_tokens      INTEGER,
        actual_cached_tokens     INTEGER,
        actual_cost_usd          REAL,
        hypothetical_cost_usd    REAL,
        source_tool_call_ids     TEXT
      );
    `);
    raw
      .prepare(
        `INSERT INTO optimization_events
           (ts, account_id, curated_id, kind, pattern,
            actual_cost_usd, hypothetical_cost_usd, source_tool_call_ids)
         VALUES (?, 'a1', 'file-explorer', 'measured', 'short_turn_after_large_read',
                 0.001, 0.000001, '[]')`,
      )
      .run(Date.now());
    raw.close();

    const db = getDb(LEGACY_DB);
    const row = db.prepare('SELECT hypothetical_total_tokens FROM optimization_events').get() as {
      hypothetical_total_tokens: number;
    };
    // hypoInputTokens floored to 0 → total = digestTokens(file-explorer) = 500.
    expect(row.hypothetical_total_tokens).toBe(500);
  });

  it('uses the default digest size for unknown curated ids', async () => {
    const raw = new Database(LEGACY_DB);
    raw.exec(`
      CREATE TABLE optimization_events (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                       INTEGER NOT NULL,
        account_id               TEXT    NOT NULL,
        session_id               TEXT,
        curated_id               TEXT    NOT NULL,
        kind                     TEXT    NOT NULL,
        pattern                  TEXT,
        savings_usd              REAL,
        actual_input_tokens      INTEGER,
        actual_cached_tokens     INTEGER,
        actual_cost_usd          REAL,
        hypothetical_cost_usd    REAL,
        source_tool_call_ids     TEXT
      );
    `);
    // unknown curated id — should fall back to the 700-token default.
    // hypoCost=0.014, digest=700
    //   hypoInputTokens = (0.014 * 1e6 - 700*15) / 1 = 14000 - 10500 = 3500
    //   total = 3500 + 700 = 4200
    raw
      .prepare(
        `INSERT INTO optimization_events
           (ts, account_id, curated_id, kind, pattern,
            actual_cost_usd, hypothetical_cost_usd, source_tool_call_ids)
         VALUES (?, 'a1', 'future-agent', 'measured', 'unknown_pattern',
                 0.5, 0.014, '[]')`,
      )
      .run(Date.now());
    raw.close();

    const db = getDb(LEGACY_DB);
    const row = db.prepare('SELECT hypothetical_total_tokens FROM optimization_events').get() as {
      hypothetical_total_tokens: number;
    };
    expect(row.hypothetical_total_tokens).toBe(4200);
  });

  it('runs at most once per database (marker-guarded)', async () => {
    // Run getDb twice on the same legacy DB. After the first run,
    // re-NULL the column manually; if the migration is properly
    // marker-guarded, the second open should leave it NULL.
    const raw = new Database(LEGACY_DB);
    raw.exec(`
      CREATE TABLE optimization_events (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                       INTEGER NOT NULL,
        account_id               TEXT    NOT NULL,
        session_id               TEXT,
        curated_id               TEXT    NOT NULL,
        kind                     TEXT    NOT NULL,
        pattern                  TEXT,
        savings_usd              REAL,
        actual_input_tokens      INTEGER,
        actual_cached_tokens     INTEGER,
        actual_cost_usd          REAL,
        hypothetical_cost_usd    REAL,
        source_tool_call_ids     TEXT
      );
    `);
    raw
      .prepare(
        `INSERT INTO optimization_events
           (ts, account_id, curated_id, kind, pattern,
            actual_cost_usd, hypothetical_cost_usd, source_tool_call_ids)
         VALUES (?, 'a1', 'file-explorer', 'measured', 'short_turn_after_large_read',
                 0.5, 0.0125, '[]')`,
      )
      .run(Date.now());
    raw.close();

    // First open → migration fires.
    let db = getDb(LEGACY_DB);
    const after1 = db
      .prepare('SELECT hypothetical_total_tokens FROM optimization_events')
      .get() as { hypothetical_total_tokens: number };
    expect(after1.hypothetical_total_tokens).toBe(5500);

    // Force the column back to NULL behind the migration's back.
    db.prepare('UPDATE optimization_events SET hypothetical_total_tokens = NULL').run();
    closeDb();

    // Second open — the marker should prevent the back-fill from running again.
    db = getDb(LEGACY_DB);
    const after2 = db
      .prepare('SELECT hypothetical_total_tokens FROM optimization_events')
      .get() as { hypothetical_total_tokens: number | null };
    expect(after2.hypothetical_total_tokens).toBeNull();
  });
});
