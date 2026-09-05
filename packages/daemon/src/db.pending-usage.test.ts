/**
 * Staged-usage storage semantics. The pending_usage_events table is the
 * proxy's holding pen for requests whose claude-cli user-agent MAY mean an
 * OTEL report is coming; the request_id keys here and the partial unique
 * index on usage_events.request_id are what make the proxy↔OTEL write race
 * produce exactly one row in every interleaving.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import type Database from 'better-sqlite3';
import {
  getDb,
  closeDb,
  insertUsageEvent,
  getUsageEvents,
  stagePendingUsageEvent,
  claimPendingUsageEvent,
  getPendingUsageEvents,
  commitStalePendingUsage,
  type PendingUsageEvent,
} from './db.js';

const BASE_TS = 1_700_000_000_000;

function makePending(overrides: Partial<PendingUsageEvent> = {}): PendingUsageEvent {
  return {
    requestId: 'req_test_1',
    stagedAt: BASE_TS,
    ts: BASE_TS,
    accountId: 'acct-1',
    sessionId: 'sess-1',
    model: 'claude-opus-4-7',
    costUsd: 0.075,
    inputTokens: 10,
    outputTokens: 1,
    cacheRead: 3,
    cacheCreate: 7,
    durationMs: 1234,
    ...overrides,
  };
}

describe('pending usage events', () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `sentinel-pending-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = getDb(dbPath);
  });

  afterEach(() => {
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  describe('insertUsageEvent request_id idempotency', () => {
    it('ignores a second insert with the same request_id and returns null', () => {
      const first = insertUsageEvent(db, {
        ts: BASE_TS,
        accountId: 'acct-1',
        sessionId: null,
        model: 'claude-opus-4-7',
        costUsd: 0.05,
        inputTokens: 10,
        outputTokens: 1,
        cacheRead: null,
        cacheCreate: null,
        durationMs: null,
        requestId: 'req_dup',
      });
      expect(first).toBeGreaterThan(0);

      const second = insertUsageEvent(db, {
        ts: BASE_TS + 1,
        accountId: 'acct-other',
        sessionId: null,
        model: 'claude-opus-4-7',
        costUsd: 9.99,
        inputTokens: 999,
        outputTokens: 999,
        cacheRead: null,
        cacheCreate: null,
        durationMs: null,
        requestId: 'req_dup',
      });
      expect(second).toBeNull();

      // The first writer's figures survive untouched.
      const events = getUsageEvents(db, {});
      expect(events).toHaveLength(1);
      expect(events[0]!.costUsd).toBe(0.05);
    });

    it('allows any number of rows with a null request_id (partial index)', () => {
      const base = {
        ts: BASE_TS,
        accountId: 'acct-1',
        sessionId: null,
        model: 'claude-opus-4-7',
        costUsd: null,
        inputTokens: 1,
        outputTokens: 1,
        cacheRead: null,
        cacheCreate: null,
        durationMs: null,
      };
      expect(insertUsageEvent(db, base)).toBeGreaterThan(0);
      expect(insertUsageEvent(db, { ...base, requestId: null })).toBeGreaterThan(0);
      expect(getUsageEvents(db, {})).toHaveLength(2);
    });
  });

  describe('stage / claim', () => {
    it('stages a row and claims it exactly once', () => {
      stagePendingUsageEvent(db, makePending());
      expect(getPendingUsageEvents(db)).toHaveLength(1);

      expect(claimPendingUsageEvent(db, 'req_test_1')).toBe(true);
      expect(getPendingUsageEvents(db)).toHaveLength(0);
      // Second claim: nothing left to delete.
      expect(claimPendingUsageEvent(db, 'req_test_1')).toBe(false);
    });

    it('keeps the first observation when the same request_id is staged twice', () => {
      stagePendingUsageEvent(db, makePending({ inputTokens: 10 }));
      stagePendingUsageEvent(db, makePending({ inputTokens: 999 }));
      const pending = getPendingUsageEvents(db);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.inputTokens).toBe(10);
    });
  });

  describe('commitStalePendingUsage', () => {
    it('commits only rows past the grace window, copying every field verbatim', () => {
      stagePendingUsageEvent(db, makePending({ requestId: 'req_old', stagedAt: BASE_TS }));
      stagePendingUsageEvent(
        db,
        makePending({ requestId: 'req_fresh', stagedAt: BASE_TS + 60_000 }),
      );

      const landed = commitStalePendingUsage(db, { graceMs: 90_000, now: BASE_TS + 90_000 });
      expect(landed).toBe(1);

      const events = getUsageEvents(db, {});
      expect(events).toHaveLength(1);
      expect(events[0]!.ts).toBe(BASE_TS);
      expect(events[0]!.accountId).toBe('acct-1');
      expect(events[0]!.sessionId).toBe('sess-1');
      expect(events[0]!.model).toBe('claude-opus-4-7');
      expect(events[0]!.costUsd).toBe(0.075);
      expect(events[0]!.inputTokens).toBe(10);
      expect(events[0]!.outputTokens).toBe(1);
      expect(events[0]!.cacheRead).toBe(3);
      expect(events[0]!.cacheCreate).toBe(7);
      expect(events[0]!.durationMs).toBe(1234);
      const raw = db.prepare('SELECT request_id FROM usage_events').get() as { request_id: string };
      expect(raw.request_id).toBe('req_old');

      // The fresh row is still pending.
      const pending = getPendingUsageEvents(db);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.requestId).toBe('req_fresh');
    });

    it('is idempotent: a rerun after everything committed lands nothing', () => {
      stagePendingUsageEvent(db, makePending());
      expect(commitStalePendingUsage(db, { graceMs: 0, now: BASE_TS + 1 })).toBe(1);
      expect(commitStalePendingUsage(db, { graceMs: 0, now: BASE_TS + 2 })).toBe(0);
      expect(getUsageEvents(db, {})).toHaveLength(1);
    });

    it('deletes without double counting when the request_id already landed via OTEL', () => {
      // Lost-claim race: OTEL inserted its row but its claim never ran
      // (e.g. the daemon restarted between the insert and the delete).
      insertUsageEvent(db, {
        ts: BASE_TS,
        accountId: 'acct-1',
        sessionId: null,
        model: 'claude-opus-4-7',
        costUsd: 0.12,
        inputTokens: 10,
        outputTokens: 1,
        cacheRead: null,
        cacheCreate: null,
        durationMs: null,
        requestId: 'req_test_1',
      });
      stagePendingUsageEvent(db, makePending({ costUsd: 0.05 }));

      const landed = commitStalePendingUsage(db, { graceMs: 0, now: BASE_TS + 1 });
      expect(landed).toBe(0);
      // Pending row is gone, OTEL's figures stand.
      expect(getPendingUsageEvents(db)).toHaveLength(0);
      const events = getUsageEvents(db, {});
      expect(events).toHaveLength(1);
      expect(events[0]!.costUsd).toBe(0.12);
    });
  });
});
