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
  claimPendingUsageByFingerprint,
  adoptCommittedProxyUsage,
  usageModelsCompatible,
  purgeAccount,
  USAGE_FINGERPRINT_WINDOW_MS,
  type PendingUsageEvent,
  type UsageFingerprint,
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
  /** An OTEL-shaped usage row with no request_id, matching makePending(). */
  function insertUnlinkedOtelRow(overrides: Partial<UsageFingerprint> & { costUsd?: number } = {}) {
    return insertUsageEvent(db, {
      ts: BASE_TS + 500,
      accountId: 'acct-1',
      sessionId: 'sess-1',
      model: 'claude-opus-4-7',
      costUsd: 0.2,
      inputTokens: 10,
      outputTokens: 1,
      cacheRead: 3,
      cacheCreate: 7,
      durationMs: 900,
      requestId: null,
      ...overrides,
    });
  }

  function fingerprint(overrides: Partial<UsageFingerprint> = {}): UsageFingerprint {
    return {
      ts: BASE_TS + 500,
      accountId: 'acct-1',
      model: 'claude-opus-4-7',
      inputTokens: 10,
      outputTokens: 1,
      cacheRead: 3,
      cacheCreate: 7,
      ...overrides,
    };
  }

  function rowsById(): Array<{ account_id: string; request_id: string | null; cost_usd: number }> {
    return db
      .prepare('SELECT account_id, request_id, cost_usd FROM usage_events ORDER BY id')
      .all() as Array<{ account_id: string; request_id: string | null; cost_usd: number }>;
  }

  describe('usageModelsCompatible', () => {
    it('matches equal, dated-alias, context-suffixed and unknown models only', () => {
      expect(usageModelsCompatible('claude-opus-4-7', 'claude-opus-4-7')).toBe(true);
      expect(usageModelsCompatible('claude-sonnet-4-5', 'claude-sonnet-4-5-20250929')).toBe(true);
      expect(usageModelsCompatible('claude-sonnet-4-5-20250929', 'claude-sonnet-4-5')).toBe(true);
      expect(usageModelsCompatible('claude-opus-4-6[1m]', 'claude-opus-4-6')).toBe(true);
      expect(usageModelsCompatible('unknown', 'claude-opus-4-7')).toBe(true);
      expect(usageModelsCompatible('claude-opus-4-7', 'unknown')).toBe(true);
      expect(usageModelsCompatible('claude-opus-4-7', 'claude-haiku-4-5')).toBe(false);
      // A shared prefix that is not a dated suffix must not match.
      expect(usageModelsCompatible('claude-opus-4', 'claude-opus-4x')).toBe(false);
    });

    it('matches a -latest alias against the dated response model', () => {
      expect(usageModelsCompatible('claude-3-5-haiku-latest', 'claude-3-5-haiku-20241022')).toBe(
        true,
      );
      expect(usageModelsCompatible('claude-3-5-haiku-20241022', 'claude-3-5-haiku-latest')).toBe(
        true,
      );
      // The alias still names one family: it must not match another model.
      expect(usageModelsCompatible('claude-3-5-haiku-latest', 'claude-3-5-sonnet-20241022')).toBe(
        false,
      );
    });
  });

  describe('claimPendingUsageByFingerprint (OTEL without request_id)', () => {
    it('claims the matching staged row and returns it', () => {
      stagePendingUsageEvent(db, makePending());
      const claimed = claimPendingUsageByFingerprint(db, fingerprint());
      expect(claimed?.requestId).toBe('req_test_1');
      expect(claimed?.accountId).toBe('acct-1');
      expect(getPendingUsageEvents(db)).toEqual([]);
    });

    it('never claims without real token counts', () => {
      stagePendingUsageEvent(db, makePending());
      expect(claimPendingUsageByFingerprint(db, fingerprint({ inputTokens: null }))).toBeNull();
      expect(claimPendingUsageByFingerprint(db, fingerprint({ outputTokens: null }))).toBeNull();
      expect(getPendingUsageEvents(db)).toHaveLength(1);
    });

    it('requires exact tokens, a compatible model and the time window', () => {
      stagePendingUsageEvent(db, makePending());
      const misses = [
        fingerprint({ inputTokens: 11 }),
        fingerprint({ outputTokens: 2 }),
        fingerprint({ cacheRead: 4 }),
        fingerprint({ cacheCreate: 8 }),
        fingerprint({ model: 'claude-haiku-4-5' }),
        fingerprint({ ts: BASE_TS + USAGE_FINGERPRINT_WINDOW_MS + 1 }),
        fingerprint({ ts: BASE_TS - USAGE_FINGERPRINT_WINDOW_MS - 1 }),
      ];
      for (const fp of misses) expect(claimPendingUsageByFingerprint(db, fp)).toBeNull();
      expect(getPendingUsageEvents(db)).toHaveLength(1);
    });

    it('matches stringified token counts (the COALESCE side has no column affinity)', () => {
      stagePendingUsageEvent(db, makePending({ cacheRead: 0, cacheCreate: 0 }));
      const stringified = fingerprint({
        inputTokens: '10',
        outputTokens: '1',
        cacheRead: '0',
        cacheCreate: '0',
      } as unknown as Partial<UsageFingerprint>);
      expect(claimPendingUsageByFingerprint(db, stringified)?.requestId).toBe('req_test_1');
    });

    it('treats absent cache counts as zero on both sides', () => {
      stagePendingUsageEvent(db, makePending({ cacheRead: 0, cacheCreate: null }));
      const claimed = claimPendingUsageByFingerprint(
        db,
        fingerprint({ cacheRead: null, cacheCreate: 0 }),
      );
      expect(claimed?.requestId).toBe('req_test_1');
    });

    it('prefers the same account, then the oldest staged row, and claims only one', () => {
      stagePendingUsageEvent(
        db,
        makePending({ requestId: 'req_other_acct', accountId: 'acct-2', stagedAt: BASE_TS - 10 }),
      );
      stagePendingUsageEvent(db, makePending({ requestId: 'req_newer', stagedAt: BASE_TS + 20 }));
      stagePendingUsageEvent(db, makePending({ requestId: 'req_older', stagedAt: BASE_TS + 10 }));

      expect(claimPendingUsageByFingerprint(db, fingerprint())?.requestId).toBe('req_older');
      expect(getPendingUsageEvents(db).map((p) => p.requestId)).toEqual([
        'req_other_acct',
        'req_newer',
      ]);
      expect(claimPendingUsageByFingerprint(db, fingerprint())?.requestId).toBe('req_newer');
      // Same account exhausted: falls back to the other account's row.
      expect(claimPendingUsageByFingerprint(db, fingerprint())?.requestId).toBe('req_other_acct');
      expect(claimPendingUsageByFingerprint(db, fingerprint())).toBeNull();
    });
  });

  describe('commitStalePendingUsage with an unlinked OTEL row (OTEL arrived first)', () => {
    it('links the OTEL row to the staged request instead of committing a second row', () => {
      insertUnlinkedOtelRow();
      stagePendingUsageEvent(db, makePending());

      expect(commitStalePendingUsage(db, { graceMs: 0, now: BASE_TS + 1 })).toBe(0);

      expect(rowsById()).toEqual([
        { account_id: 'acct-1', request_id: 'req_test_1', cost_usd: 0.2 },
      ]);
      expect(getPendingUsageEvents(db)).toEqual([]);
    });

    it('moves a linked row onto the staged account and reports it as a change', () => {
      insertUnlinkedOtelRow({ accountId: 'acct-signed-in' });
      stagePendingUsageEvent(db, makePending());

      expect(commitStalePendingUsage(db, { graceMs: 0, now: BASE_TS + 1 })).toBe(1);
      expect(rowsById()).toEqual([
        { account_id: 'acct-1', request_id: 'req_test_1', cost_usd: 0.2 },
      ]);
    });

    it('links one OTEL row to at most one staged request', () => {
      insertUnlinkedOtelRow();
      stagePendingUsageEvent(db, makePending({ requestId: 'req_a', stagedAt: BASE_TS }));
      stagePendingUsageEvent(db, makePending({ requestId: 'req_b', stagedAt: BASE_TS + 1 }));

      expect(commitStalePendingUsage(db, { graceMs: 0, now: BASE_TS + 2 })).toBe(1);

      const rows = rowsById();
      expect(rows.map((r) => r.request_id)).toEqual(['req_a', 'req_b']);
      expect(rows[1]!.cost_usd).toBe(0.075);
    });

    it('commits normally when the OTEL row is for a different request', () => {
      insertUnlinkedOtelRow({ outputTokens: 99 });
      stagePendingUsageEvent(db, makePending());

      expect(commitStalePendingUsage(db, { graceMs: 0, now: BASE_TS + 1 })).toBe(1);
      expect(rowsById().map((r) => r.request_id)).toEqual([null, 'req_test_1']);
    });

    it('commits a staged row without token counts (no fingerprint to match)', () => {
      insertUnlinkedOtelRow();
      stagePendingUsageEvent(db, makePending({ inputTokens: null }));

      expect(commitStalePendingUsage(db, { graceMs: 0, now: BASE_TS + 1 })).toBe(1);
      expect(rowsById().map((r) => r.request_id)).toEqual([null, 'req_test_1']);
    });
  });

  describe('adoptCommittedProxyUsage (OTEL without request_id after the sweep)', () => {
    function lateOtel(overrides: Partial<UsageFingerprint> = {}) {
      return {
        ...fingerprint(overrides),
        costUsd: 0.3,
        sessionId: 'sess-otel',
        durationMs: 777,
      };
    }

    it('marks only sweeper-committed rows as adoptable', () => {
      stagePendingUsageEvent(db, makePending());
      commitStalePendingUsage(db, { graceMs: 0, now: BASE_TS + 1 });
      insertUnlinkedOtelRow({ outputTokens: 50 });
      const origins = db.prepare('SELECT origin FROM usage_events ORDER BY id').all();
      expect(origins).toEqual([{ origin: 'proxy' }, { origin: null }]);
    });

    it('adopts the committed proxy row once, taking OTEL figures', () => {
      stagePendingUsageEvent(db, makePending({ sessionId: null }));
      commitStalePendingUsage(db, { graceMs: 0, now: BASE_TS + 1 });

      expect(adoptCommittedProxyUsage(db, lateOtel())).toBe(true);
      expect(
        db
          .prepare(
            'SELECT request_id, account_id, cost_usd, session_id, duration_ms, origin FROM usage_events',
          )
          .all(),
      ).toEqual([
        {
          request_id: 'req_test_1',
          account_id: 'acct-1',
          cost_usd: 0.3,
          session_id: 'sess-otel',
          duration_ms: 777,
          origin: null,
        },
      ]);
      // A second identical report is a different request: never adopt twice.
      expect(adoptCommittedProxyUsage(db, lateOtel())).toBe(false);
    });

    it('keeps the proxy figures an OTEL event leaves out', () => {
      stagePendingUsageEvent(db, makePending());
      commitStalePendingUsage(db, { graceMs: 0, now: BASE_TS + 1 });
      expect(
        adoptCommittedProxyUsage(db, {
          ...fingerprint(),
          costUsd: null,
          sessionId: null,
          durationMs: null,
        }),
      ).toBe(true);
      expect(
        db.prepare('SELECT cost_usd, session_id, duration_ms FROM usage_events').all(),
      ).toEqual([{ cost_usd: 0.075, session_id: 'sess-1', duration_ms: 1234 }]);
    });

    it('never adopts an OTEL row, a mismatched row, or without token counts', () => {
      insertUnlinkedOtelRow();
      stagePendingUsageEvent(db, makePending({ model: 'claude-haiku-4-5' }));
      commitStalePendingUsage(db, { graceMs: 0, now: BASE_TS + 1 });

      expect(adoptCommittedProxyUsage(db, lateOtel())).toBe(false);
      expect(adoptCommittedProxyUsage(db, lateOtel({ inputTokens: null }))).toBe(false);
      expect(rowsById().map((r) => r.cost_usd)).toEqual([0.2, 0.075]);
    });
  });

  describe('purgeAccount', () => {
    it('drops the purged account staged rows so the sweeper cannot resurrect them', () => {
      stagePendingUsageEvent(db, makePending({ requestId: 'req_purged', accountId: 'acct-1' }));
      stagePendingUsageEvent(db, makePending({ requestId: 'req_kept', accountId: 'acct-2' }));

      purgeAccount(db, 'acct-1');
      commitStalePendingUsage(db, { graceMs: 0, now: BASE_TS + 1 });

      expect(getUsageEvents(db, { accountId: 'acct-1' })).toEqual([]);
      expect(getUsageEvents(db, { accountId: 'acct-2' }).map((e) => e.accountId)).toEqual([
        'acct-2',
      ]);
      expect(getPendingUsageEvents(db)).toEqual([]);
    });
  });
});
