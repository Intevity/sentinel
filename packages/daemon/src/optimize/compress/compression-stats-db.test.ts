import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, rmSync } from 'fs';
import Database from 'better-sqlite3';
import { estimateTokensFromBytes } from '@sentinel/shared';
import {
  CompressionStatsStore,
  getCompressionStatsStore,
  closeCompressionStatsStore,
  type CompressionEventRecord,
  type CompressionRetrievalRecord,
} from './compression-stats-db.js';
import { getDb, closeDb, insertCacheTtlEvent, getCacheHealthWindow } from '../../db.js';
import type { IpcServer } from '../../ipc.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function tmpPath(prefix: string): string {
  return join(
    tmpdir(),
    `sentinel-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function rmDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(path + suffix)) rmSync(path + suffix);
  }
}

function changedRecord(over: Partial<CompressionEventRecord> = {}): CompressionEventRecord {
  return {
    ts: Date.now(),
    accountId: 'acc-1',
    sessionId: 'sess-1',
    requestId: 'req-1',
    model: 'claude-sonnet-4-6',
    level: 'conservative',
    bytesIn: 1000,
    bytesOut: 400,
    estTokensIn: 250,
    estTokensOut: 100,
    changed: true,
    skipReason: null,
    perTool: { Bash: { bytesIn: 1000, bytesOut: 400, blocks: 1 } },
    perRule: { ansi_strip: { bytesSaved: 600, hits: 1 } },
    estTokensPotential: 0,
    ...over,
  };
}

function skippedRecord(skipReason: CompressionEventRecord['skipReason']): CompressionEventRecord {
  return {
    ts: Date.now(),
    accountId: 'acc-1',
    sessionId: null,
    requestId: null,
    model: 'claude-sonnet-4-6',
    level: 'conservative',
    bytesIn: 0,
    bytesOut: 0,
    estTokensIn: 0,
    estTokensOut: 0,
    changed: false,
    skipReason,
    perTool: {},
    perRule: {},
    estTokensPotential: 0,
  };
}

function retrievalRecord(
  over: Partial<CompressionRetrievalRecord> = {},
): CompressionRetrievalRecord {
  return {
    id: 'abc123def4567890',
    ts: Date.now(),
    accountId: 'acc-1',
    requestId: 'req-1',
    ruleId: 'log_truncate',
    original: 'the full elided original text',
    ...over,
  };
}

describe('CompressionStatsStore retrievals', () => {
  let dbPath: string;
  let store: CompressionStatsStore;

  beforeEach(() => {
    dbPath = tmpPath('compression-retr');
    store = new CompressionStatsStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    rmDb(dbPath);
  });

  it('stores and retrieves an original by id (flush on read)', () => {
    store.enqueueRetrievals([retrievalRecord({ id: 'id-1', original: 'hello world' })]);
    expect(store.getRetrieval('id-1')).toEqual({ originalText: 'hello world' });
  });

  it('returns null for an unknown id', () => {
    expect(store.getRetrieval('missing')).toBeNull();
  });

  it('ignores an empty batch and enqueue after close', () => {
    store.enqueueRetrievals([]);
    expect(store.getRetrieval('id-1')).toBeNull();
    store.close();
    expect(() => store.enqueueRetrievals([retrievalRecord()])).not.toThrow();
  });

  it('upserts by id and refreshes ts without duplicating', () => {
    store.enqueueRetrievals([retrievalRecord({ id: 'dup', ts: 100, original: 'v1' })]);
    store.flush();
    // Same id again — upsert keeps one row, refreshes ts, original unchanged.
    store.enqueueRetrievals([retrievalRecord({ id: 'dup', ts: 999, original: 'v1' })]);
    store.flush();
    const raw = new Database(dbPath);
    const row = raw
      .prepare('SELECT COUNT(*) AS n, MAX(ts) AS ts FROM compression_retrievals WHERE id = ?')
      .get('dup') as { n: number; ts: number };
    raw.close();
    expect(row.n).toBe(1);
    expect(row.ts).toBe(999);
  });

  it('caps the table to the newest RETRIEVAL_MAX_ENTRIES rows, evicting the oldest', () => {
    const CAP = 5000;
    const overflow = 6;
    const records = Array.from({ length: CAP + overflow }, (_, i) =>
      retrievalRecord({ id: `r${i}`, ts: 1000 + i, original: `o${i}` }),
    );
    store.enqueueRetrievals(records);
    store.flush();
    const raw = new Database(dbPath);
    const count = (
      raw.prepare('SELECT COUNT(*) AS n FROM compression_retrievals').get() as { n: number }
    ).n;
    raw.close();
    expect(count).toBe(CAP);
    // The oldest `overflow` ids are evicted; the newest survive.
    expect(store.getRetrieval('r0')).toBeNull();
    expect(store.getRetrieval(`r${CAP + overflow - 1}`)).not.toBeNull();
  });

  it('age-purges old retrieval rows', () => {
    const now = Date.now();
    store.enqueueRetrievals([
      retrievalRecord({ id: 'old', ts: now - 100 * DAY_MS }),
      retrievalRecord({ id: 'new', ts: now }),
    ]);
    store.flush();
    const deleted = store.purgeOlderThan(now - 30 * DAY_MS);
    expect(deleted).toBe(1);
    expect(store.getRetrieval('old')).toBeNull();
    expect(store.getRetrieval('new')).not.toBeNull();
  });

  it('clearAll removes retrievals too', () => {
    store.enqueueRetrievals([retrievalRecord({ id: 'a' }), retrievalRecord({ id: 'b' })]);
    store.flush();
    const deleted = store.clearAll();
    expect(deleted).toBe(2);
    expect(store.getRetrieval('a')).toBeNull();
  });
});

describe('CompressionStatsStore', () => {
  let dbPath: string;
  let store: CompressionStatsStore;

  beforeEach(() => {
    dbPath = tmpPath('compression');
    store = new CompressionStatsStore({ dbPath });
  });

  afterEach(() => {
    store.close();
    rmDb(dbPath);
  });

  it('aggregates totals over changed rows and counts skips (flush on read)', () => {
    store.enqueue(changedRecord());
    store.enqueue(
      changedRecord({ bytesIn: 2000, bytesOut: 1000, estTokensIn: 500, estTokensOut: 250 }),
    );
    store.enqueue(skippedRecord('already_compressed'));

    const m = store.getCompressionMetrics(0);
    expect(m.totals.requestsCompressed).toBe(2);
    expect(m.totals.requestsSkipped).toBe(1);
    expect(m.totals.bytesIn).toBe(3000);
    expect(m.totals.bytesOut).toBe(1400);
    expect(m.totals.estTokensIn).toBe(250 + 500); // gross, changed rows only
    expect(m.totals.estTokensSaved).toBe(250 - 100 + (500 - 250));
    expect(m.totals.ratio).toBeCloseTo(1400 / 3000, 5);
    expect(m.totals.estCostSavedUsd).toBeGreaterThan(0);
  });

  it('computes cost saved from per-model input pricing at write time', () => {
    // Opus base rate is $15 / MTok. 1,000,000 tokens saved => ~$15.
    store.enqueue(
      changedRecord({ model: 'claude-opus-4-1', estTokensIn: 2_000_000, estTokensOut: 1_000_000 }),
    );
    const m = store.getCompressionMetrics(0);
    expect(m.totals.estCostSavedUsd).toBeCloseTo(15, 5);
  });

  it('sums potential across realized and measure-only rows; excludes measure-only from skips', () => {
    // A realized row that also carries potential headroom.
    store.enqueue(changedRecord({ estTokensPotential: 100 }));
    // A measure-only row (compression was off): changed=0, no skip_reason.
    store.enqueue(
      changedRecord({
        changed: false,
        skipReason: null,
        bytesIn: 0,
        bytesOut: 0,
        estTokensIn: 0,
        estTokensOut: 0,
        perTool: {},
        perRule: {},
        estTokensPotential: 50,
      }),
    );
    // A genuine skip (compression ran, didn't help).
    store.enqueue(skippedRecord('oversized'));

    const m = store.getCompressionMetrics(0);
    expect(m.totals.estTokensPotential).toBe(150);
    expect(m.totals.estCostPotential).toBeGreaterThan(0);
    expect(m.totals.requestsCompressed).toBe(1); // only the changed row
    // The measure-only row (skip_reason null) is NOT a skip; the oversized one is.
    expect(m.totals.requestsSkipped).toBe(1);
  });

  it('computes potential cost from per-model pricing', () => {
    store.enqueue(
      changedRecord({
        model: 'claude-opus-4-1',
        changed: false,
        skipReason: null,
        bytesIn: 0,
        bytesOut: 0,
        estTokensIn: 0,
        estTokensOut: 0,
        perTool: {},
        perRule: {},
        estTokensPotential: 1_000_000,
      }),
    );
    const m = store.getCompressionMetrics(0);
    expect(m.totals.estCostPotential).toBeCloseTo(15, 5);
  });

  it('groups daily savings by local day', () => {
    const base = Date.UTC(2026, 0, 15, 12, 0, 0);
    store.enqueue(changedRecord({ ts: base }));
    store.enqueue(changedRecord({ ts: base - 2 * DAY_MS }));
    const m = store.getCompressionMetrics(0);
    expect(m.daily).toHaveLength(2);
    // Ascending by day.
    expect(m.daily[0]!.day < m.daily[1]!.day).toBe(true);
    expect(m.daily[0]!.ratio).toBeCloseTo(400 / 1000, 5);
  });

  it('aggregates by tool and by rule across rows, sorted by impact', () => {
    store.enqueue(
      changedRecord({
        perTool: { Bash: { bytesIn: 1000, bytesOut: 400, blocks: 1 } },
        perRule: { ansi_strip: { bytesSaved: 600, hits: 1 } },
      }),
    );
    store.enqueue(
      changedRecord({
        perTool: {
          Bash: { bytesIn: 500, bytesOut: 250, blocks: 1 },
          Read: { bytesIn: 4000, bytesOut: 1000, blocks: 1 },
        },
        perRule: {
          ansi_strip: { bytesSaved: 250, hits: 1 },
          log_truncate: { bytesSaved: 3000, hits: 1 },
        },
      }),
    );

    const m = store.getCompressionMetrics(0);
    // Read saved more tokens than Bash, so it sorts first.
    expect(m.byTool[0]!.tool).toBe('Read');
    const bash = m.byTool.find((t) => t.tool === 'Bash');
    expect(bash).toEqual({
      tool: 'Bash',
      bytesIn: 1500,
      bytesOut: 650,
      blocks: 2,
      estTokensSaved: estimateTokensFromBytes(1500) - estimateTokensFromBytes(650),
    });
    // log_truncate saved the most bytes, so it sorts first.
    expect(m.byRule[0]!.rule).toBe('log_truncate');
    const ansi = m.byRule.find((r) => r.rule === 'ansi_strip');
    expect(ansi).toEqual({ rule: 'ansi_strip', bytesSaved: 850, hits: 2 });
  });

  it('counts skip reasons, excluding changed rows', () => {
    store.enqueue(changedRecord());
    store.enqueue(skippedRecord('oversized'));
    store.enqueue(skippedRecord('oversized'));
    store.enqueue(skippedRecord('parse_error'));
    const m = store.getCompressionMetrics(0);
    const oversized = m.errors.find((e) => e.skipReason === 'oversized');
    expect(oversized?.count).toBe(2);
    expect(m.errors.find((e) => e.skipReason === 'parse_error')?.count).toBe(1);
    // A changed row never appears in the error breakdown.
    expect(m.errors.reduce((n, e) => n + e.count, 0)).toBe(3);
  });

  it('respects the days window', () => {
    const now = Date.now();
    store.enqueue(changedRecord({ ts: now }));
    store.enqueue(changedRecord({ ts: now - 100 * DAY_MS }));
    expect(store.getCompressionMetrics(7).totals.requestsCompressed).toBe(1);
    expect(store.getCompressionMetrics(0).totals.requestsCompressed).toBe(2);
  });

  it('getCompressionMetricsWindow filters by sinceMs/untilMs and matches the days delegate', () => {
    const now = Date.now();
    store.enqueue(changedRecord({ ts: now - 1 * DAY_MS, requestId: 'recent' }));
    store.enqueue(changedRecord({ ts: now - 10 * DAY_MS, requestId: 'mid' }));
    store.enqueue(changedRecord({ ts: now - 100 * DAY_MS, requestId: 'old' }));
    // sinceMs excludes the 100-day row; untilMs excludes the 1-day row.
    expect(
      store.getCompressionMetricsWindow({ sinceMs: now - 30 * DAY_MS }).totals.requestsCompressed,
    ).toBe(2);
    expect(
      store.getCompressionMetricsWindow({ untilMs: now - 3 * DAY_MS }).totals.requestsCompressed,
    ).toBe(2);
    expect(
      store.getCompressionMetricsWindow({ sinceMs: now - 30 * DAY_MS, untilMs: now - 3 * DAY_MS })
        .totals.requestsCompressed,
    ).toBe(1);
    expect(store.getCompressionMetricsWindow({}).totals.requestsCompressed).toBe(3);
    // The legacy days API delegates to the window form: a 7-day lookback must
    // equal an explicit `{ sinceMs: now - 7d }`.
    const days = store.getCompressionMetrics(7).totals;
    const win = store.getCompressionMetricsWindow({ sinceMs: now - 7 * DAY_MS }).totals;
    expect(days).toEqual(win);
  });

  it('purgeOlderThan deletes old rows and returns the count', () => {
    const now = Date.now();
    store.enqueue(changedRecord({ ts: now }));
    store.enqueue(changedRecord({ ts: now - 100 * DAY_MS }));
    store.flush();
    const deleted = store.purgeOlderThan(now - 30 * DAY_MS);
    expect(deleted).toBe(1);
    expect(store.getCompressionMetrics(0).totals.requestsCompressed).toBe(1);
  });

  it('clearAll wipes persisted rows and discards the pending queue', () => {
    store.enqueue(changedRecord());
    store.enqueue(changedRecord());
    store.flush(); // these two land in the table
    store.enqueue(changedRecord()); // this one is only queued
    const deleted = store.clearAll();
    expect(deleted).toBe(2); // only persisted rows are counted
    expect(store.getCompressionMetrics(0).totals.requestsCompressed).toBe(0);
  });

  it('returns an empty/healthy shape when there are no rows', () => {
    const m = store.getCompressionMetrics(0);
    expect(m.totals.requestsCompressed).toBe(0);
    expect(m.totals.ratio).toBe(0);
    expect(m.byTool).toEqual([]);
    expect(m.byRule).toEqual([]);
    expect(m.errors).toEqual([]);
    expect(m.cacheHealth).toEqual({ cacheReadTokens: 0, cacheCreateTokens: 0, hitRatio: 1 });
  });

  it('ignores enqueue after close', () => {
    store.close();
    expect(() => store.enqueue(changedRecord())).not.toThrow();
  });

  it('tolerates malformed or partial per-tool/per-rule JSON', () => {
    store.flush(); // ensure schema exists and no pending writes
    // Insert raw rows bypassing the store, mimicking corrupted columns.
    const raw = new Database(dbPath);
    const insert = raw.prepare(
      `INSERT INTO compression_events
        (ts, account_id, level, bytes_in, bytes_out, est_tokens_in, est_tokens_out,
         est_cost_saved_usd, changed, skip_reason, per_tool_json, per_rule_json)
       VALUES (?, 'acc-1', 'conservative', 100, 40, 25, 10, 0, 1, NULL, ?, ?)`,
    );
    insert.run(Date.now(), '{bad json', '42'); // unparseable + valid-but-not-object
    insert.run(Date.now(), '{"Bash":{}}', '{"ansi_strip":{}}'); // object, missing fields
    raw.close();

    const m = store.getCompressionMetrics(0);
    // Malformed JSON contributes nothing; the partial object yields zeroed stats.
    const bash = m.byTool.find((t) => t.tool === 'Bash');
    expect(bash).toEqual({ tool: 'Bash', bytesIn: 0, bytesOut: 0, blocks: 0, estTokensSaved: 0 });
    const ansi = m.byRule.find((r) => r.rule === 'ansi_strip');
    expect(ansi).toEqual({ rule: 'ansi_strip', bytesSaved: 0, hits: 0 });
  });
});

describe('compression stats store db path resolution', () => {
  it('falls back to SENTINEL_TEST_COMPRESSION_DB_FILE when no dbPath is given', () => {
    const envPath = tmpPath('compression-env');
    const prev = process.env.SENTINEL_TEST_COMPRESSION_DB_FILE;
    process.env.SENTINEL_TEST_COMPRESSION_DB_FILE = envPath;
    const s = new CompressionStatsStore();
    try {
      s.enqueue(changedRecord());
      expect(s.getCompressionMetrics(0).totals.requestsCompressed).toBe(1);
      expect(existsSync(envPath)).toBe(true);
    } finally {
      s.close();
      if (prev === undefined) delete process.env.SENTINEL_TEST_COMPRESSION_DB_FILE;
      else process.env.SENTINEL_TEST_COMPRESSION_DB_FILE = prev;
      rmDb(envPath);
    }
  });
});

describe('compression stats store singleton', () => {
  it('returns the same instance until closed, then a fresh one', () => {
    const dbPath = tmpPath('compression-singleton');
    try {
      const a = getCompressionStatsStore({ dbPath });
      const b = getCompressionStatsStore({ dbPath });
      expect(a).toBe(b);
      closeCompressionStatsStore();
      const c = getCompressionStatsStore({ dbPath });
      expect(c).not.toBe(a);
      closeCompressionStatsStore();
      // Idempotent close.
      expect(() => closeCompressionStatsStore()).not.toThrow();
    } finally {
      closeCompressionStatsStore();
      rmDb(dbPath);
    }
  });
});

describe('CompressionStatsStore broadcasts', () => {
  let dbPath: string;
  let store: CompressionStatsStore;
  let broadcast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    dbPath = tmpPath('compression-bcast');
    broadcast = vi.fn();
    store = new CompressionStatsStore({
      dbPath,
      ipcServer: { broadcast } as unknown as IpcServer,
    });
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
    rmDb(dbPath);
  });

  it('debounces a single compression_metrics_updated after a changed batch', () => {
    store.enqueue(changedRecord());
    store.enqueue(changedRecord());
    vi.advanceTimersByTime(100); // flush timer fires
    expect(broadcast).not.toHaveBeenCalled(); // still debouncing
    vi.advanceTimersByTime(1500); // broadcast debounce fires
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({ type: 'compression_metrics_updated' });
  });

  it('does not broadcast when a batch only contains skipped rows', () => {
    store.enqueue(skippedRecord('already_compressed'));
    vi.advanceTimersByTime(100 + 1500);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('coalesces broadcasts across back-to-back flushes', () => {
    store.enqueue(changedRecord());
    vi.advanceTimersByTime(100); // flush 1 schedules the broadcast
    store.enqueue(changedRecord());
    vi.advanceTimersByTime(100); // flush 2: broadcast timer already pending, no reschedule
    vi.advanceTimersByTime(1500);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending broadcast on close', () => {
    store.enqueue(changedRecord());
    vi.advanceTimersByTime(100); // schedules the broadcast
    store.close(); // clears the pending broadcast timer
    vi.advanceTimersByTime(5000);
    expect(broadcast).not.toHaveBeenCalled();
  });
});

describe('getCacheHealthWindow', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpPath('cachehealth');
    getDb(dbPath);
  });

  afterEach(() => {
    closeDb();
    rmDb(dbPath);
  });

  function seed(over: Partial<Parameters<typeof insertCacheTtlEvent>[1]> = {}): void {
    insertCacheTtlEvent(getDb(dbPath), {
      ts: Date.now(),
      accountId: 'acc-1',
      sessionId: 's',
      model: 'claude-sonnet-4-6',
      requestId: 'r',
      reqMarkers5m: 0,
      reqMarkers1h: 0,
      cacheCreate5m: 0,
      cacheCreate1h: 0,
      cacheRead: 0,
      inputTokens: 0,
      cost5mWrite: 0,
      cost1hWrite: 0,
      costRead: 0,
      ...over,
    });
  }

  it('sums reads and creates and computes the hit ratio', () => {
    seed({ cacheRead: 900, cacheCreate5m: 50, cacheCreate1h: 50 });
    seed({ cacheRead: 100 });
    const h = getCacheHealthWindow(getDb(dbPath), ['acc-1'], 0);
    expect(h.cacheReadTokens).toBe(1000);
    expect(h.cacheCreateTokens).toBe(100);
    expect(h.hitRatio).toBeCloseTo(1000 / 1100, 5);
  });

  it('returns a healthy ratio of 1 when nothing was created', () => {
    seed({ cacheRead: 500 });
    const h = getCacheHealthWindow(getDb(dbPath), ['acc-1'], 0);
    expect(h.hitRatio).toBe(1);
  });

  it('returns zeros for an empty account list', () => {
    const h = getCacheHealthWindow(getDb(dbPath), [], 0);
    expect(h).toEqual({ cacheReadTokens: 0, cacheCreateTokens: 0, hitRatio: 1 });
  });

  it('respects the days window', () => {
    seed({ cacheRead: 500, ts: Date.now() - 100 * DAY_MS });
    const recent = getCacheHealthWindow(getDb(dbPath), ['acc-1'], 7);
    expect(recent.cacheReadTokens).toBe(0);
    const all = getCacheHealthWindow(getDb(dbPath), ['acc-1'], 0);
    expect(all.cacheReadTokens).toBe(500);
  });
});
