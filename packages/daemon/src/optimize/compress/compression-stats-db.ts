import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { CompressionMetrics, MetricsWindow } from '@claude-sentinel/shared';
import { SENTINEL_DIR } from '../../db.js';
import type { IpcServer } from '../../ipc.js';
import { getBaseInputPricePerMillion } from '../../cache-ttl/pricing.js';
import { byteLen, estimateTokensFromBytes } from './types.js';
import type { CompressionLevel, PerRuleStat, PerToolStat, RuleId, SkipReason } from './types.js';

export const COMPRESSION_STATS_DB_PATH = join(SENTINEL_DIR, 'compression-stats.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS compression_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 INTEGER NOT NULL,
  account_id         TEXT    NOT NULL,
  session_id         TEXT,
  request_id         TEXT,
  model              TEXT    NOT NULL DEFAULT 'unknown',
  level              TEXT    NOT NULL,
  bytes_in           INTEGER NOT NULL DEFAULT 0,
  bytes_out          INTEGER NOT NULL DEFAULT 0,
  est_tokens_in      INTEGER NOT NULL DEFAULT 0,
  est_tokens_out     INTEGER NOT NULL DEFAULT 0,
  est_cost_saved_usd REAL    NOT NULL DEFAULT 0,
  changed            INTEGER NOT NULL DEFAULT 0,
  skip_reason        TEXT,
  per_tool_json      TEXT    NOT NULL DEFAULT '{}',
  per_rule_json      TEXT    NOT NULL DEFAULT '{}',
  est_tokens_potential INTEGER NOT NULL DEFAULT 0,
  est_cost_potential   REAL    NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_compression_events_ts ON compression_events(ts);
CREATE INDEX IF NOT EXISTS idx_compression_events_account_ts ON compression_events(account_id, ts);

-- Reversible-compression originals. Keyed by content-hash id (deterministic),
-- so the same elided text upserts once. The retrieve MCP tool reads this.
CREATE TABLE IF NOT EXISTS compression_retrievals (
  id             TEXT    PRIMARY KEY,
  ts             INTEGER NOT NULL,
  account_id     TEXT    NOT NULL,
  request_id     TEXT,
  rule_id        TEXT    NOT NULL,
  original_text  TEXT    NOT NULL,
  bytes_original INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_compression_retrievals_ts ON compression_retrievals(ts);
`;

const BROADCAST_DEBOUNCE_MS = 1500;

/** Cap on stored retrieval originals. Oldest-by-ts rows beyond this are
 *  evicted after each flush. Upserts refresh ts, so replayed originals stay
 *  warm. Generous enough that a session's retrievals survive until use. */
const RETRIEVAL_MAX_ENTRIES = 5000;

/** Per-request stats enqueued by the proxy after compressing (or skipping) a
 *  /v1/messages body. Mirror of {@link CompressionStats} plus attribution. */
export interface CompressionEventRecord {
  ts: number;
  accountId: string;
  sessionId: string | null;
  requestId: string | null;
  model: string | null;
  level: CompressionLevel;
  bytesIn: number;
  bytesOut: number;
  estTokensIn: number;
  estTokensOut: number;
  changed: boolean;
  skipReason: SkipReason | null;
  perTool: Record<string, PerToolStat>;
  perRule: Partial<Record<string, PerRuleStat>>;
  /** Estimated ADDITIONAL input tokens aggressive compression would save
   *  beyond `estTokensIn - estTokensOut` (from a dry-run). 0 when there's no
   *  headroom (already at aggressive, or nothing more to trim). */
  estTokensPotential: number;
}

interface CompressionEventRow {
  ts: number;
  bytes_in: number;
  bytes_out: number;
  est_tokens_in: number;
  est_tokens_out: number;
  est_cost_saved_usd: number;
  per_tool_json: string;
  per_rule_json: string;
}

/** An elided original to persist for later retrieval via the MCP tool. */
export interface CompressionRetrievalRecord {
  id: string;
  ts: number;
  accountId: string;
  requestId: string | null;
  ruleId: RuleId;
  original: string;
}

/**
 * Dedicated SQLite store for per-request compression stats. Separate file from
 * the main telemetry DB (like request-logs.db) so the high-volume per-request
 * rows don't bloat every telemetry query. Writes are batched on a 100ms timer
 * off the proxy hot path; a debounced `compression_metrics_updated` broadcast
 * fires after any flush that committed a row whose body actually changed.
 */
export class CompressionStatsStore {
  private db: Database.Database;
  private queue: CompressionEventRecord[] = [];
  private retrievalQueue: CompressionRetrievalRecord[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private insertStmt: Database.Statement;
  private retrievalUpsertStmt: Database.Statement;
  private retrievalEvictStmt: Database.Statement;
  private ipcServer: IpcServer | null;
  private closed = false;

  constructor(opts?: { dbPath?: string; ipcServer?: IpcServer }) {
    const dbPath =
      opts?.dbPath ??
      process.env.CLAUDE_SENTINEL_TEST_COMPRESSION_DB_FILE ??
      COMPRESSION_STATS_DB_PATH;
    this.ipcServer = opts?.ipcServer ?? null;

    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    // Additive migration for compression-stats.db files created before the
    // potential columns existed. ADD COLUMN throws if the column is already
    // present, so swallow that case.
    for (const col of [
      'est_tokens_potential INTEGER NOT NULL DEFAULT 0',
      'est_cost_potential REAL NOT NULL DEFAULT 0',
    ]) {
      try {
        this.db.exec(`ALTER TABLE compression_events ADD COLUMN ${col}`);
      } catch {
        /* column already exists */
      }
    }

    this.insertStmt = this.db.prepare(`
      INSERT INTO compression_events (
        ts, account_id, session_id, request_id, model, level,
        bytes_in, bytes_out, est_tokens_in, est_tokens_out, est_cost_saved_usd,
        changed, skip_reason, per_tool_json, per_rule_json,
        est_tokens_potential, est_cost_potential
      ) VALUES (
        @ts, @accountId, @sessionId, @requestId, @model, @level,
        @bytesIn, @bytesOut, @estTokensIn, @estTokensOut, @estCostSavedUsd,
        @changed, @skipReason, @perToolJson, @perRuleJson,
        @estTokensPotential, @estCostPotential
      )
    `);

    this.retrievalUpsertStmt = this.db.prepare(`
      INSERT INTO compression_retrievals (id, ts, account_id, request_id, rule_id, original_text, bytes_original)
      VALUES (@id, @ts, @accountId, @requestId, @ruleId, @original, @bytesOriginal)
      ON CONFLICT(id) DO UPDATE SET ts = excluded.ts
    `);

    // Keep only the newest RETRIEVAL_MAX_ENTRIES rows by ts.
    this.retrievalEvictStmt = this.db.prepare(`
      DELETE FROM compression_retrievals
      WHERE id NOT IN (
        SELECT id FROM compression_retrievals ORDER BY ts DESC, id ASC LIMIT @keep
      )
    `);
  }

  /** Push a stats record onto the write queue. Never awaits IO. */
  enqueue(record: CompressionEventRecord): void {
    if (this.closed) return;
    this.queue.push(record);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 100);
    }
  }

  /** Push reversible-compression originals onto the write queue. Never awaits
   *  IO; drained by the same flush timer. */
  enqueueRetrievals(records: CompressionRetrievalRecord[]): void {
    if (this.closed || records.length === 0) return;
    for (const r of records) this.retrievalQueue.push(r);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 100);
    }
  }

  /** Drain the queue into one transaction. Computes the estimated cost saved
   *  at write time from per-model input pricing so historical rows survive
   *  later pricing changes. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0 && this.retrievalQueue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    const retrievals = this.retrievalQueue;
    this.retrievalQueue = [];
    const stmt = this.insertStmt;
    let anyChanged = false;
    this.db.transaction(() => {
      for (const r of batch) {
        const model = r.model ?? 'unknown';
        const basePrice = getBaseInputPricePerMillion(model);
        const tokensSaved = Math.max(0, r.estTokensIn - r.estTokensOut);
        const costSaved = r.changed ? (tokensSaved / 1_000_000) * basePrice : 0;
        const potentialTokens = Math.max(0, r.estTokensPotential);
        const costPotential = (potentialTokens / 1_000_000) * basePrice;
        if (r.changed) anyChanged = true;
        stmt.run({
          ts: r.ts,
          accountId: r.accountId,
          sessionId: r.sessionId,
          requestId: r.requestId,
          model,
          level: r.level,
          bytesIn: r.bytesIn,
          bytesOut: r.bytesOut,
          estTokensIn: r.estTokensIn,
          estTokensOut: r.estTokensOut,
          estCostSavedUsd: costSaved,
          changed: r.changed ? 1 : 0,
          skipReason: r.skipReason,
          perToolJson: JSON.stringify(r.perTool),
          perRuleJson: JSON.stringify(r.perRule),
          estTokensPotential: potentialTokens,
          estCostPotential: costPotential,
        });
      }
      for (const r of retrievals) {
        this.retrievalUpsertStmt.run({
          id: r.id,
          ts: r.ts,
          accountId: r.accountId,
          requestId: r.requestId,
          ruleId: r.ruleId,
          original: r.original,
          bytesOriginal: byteLen(r.original),
        });
      }
      if (retrievals.length > 0) {
        this.retrievalEvictStmt.run({ keep: RETRIEVAL_MAX_ENTRIES });
      }
    })();
    if (anyChanged) this.scheduleBroadcast();
  }

  /** Look up an elided original by its content-hash id. Flushes first so an
   *  id captured moments ago (and still queued) is visible. Returns null when
   *  the id is unknown or has been evicted. */
  getRetrieval(id: string): { originalText: string } | null {
    this.flush();
    const row = this.db
      .prepare('SELECT original_text AS originalText FROM compression_retrievals WHERE id = ?')
      .get(id) as { originalText: string } | undefined;
    return row ? { originalText: row.originalText } : null;
  }

  private scheduleBroadcast(): void {
    if (!this.ipcServer || this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      try {
        this.ipcServer?.broadcast({ type: 'compression_metrics_updated' });
      } catch (err) {
        console.error('[Compression] metrics broadcast failed:', err);
      }
    }, BROADCAST_DEBOUNCE_MS);
    if (typeof this.broadcastTimer.unref === 'function') this.broadcastTimer.unref();
  }

  /**
   * Aggregate compression metrics over the last `days` (0 = all-time).
   * Delegates to {@link getCompressionMetricsWindow}; retained for the legacy
   * `days`-based callers.
   */
  getCompressionMetrics(days: number): CompressionMetrics {
    return this.getCompressionMetricsWindow(
      days > 0 ? { sinceMs: Date.now() - days * 24 * 60 * 60 * 1000 } : {},
    );
  }

  /**
   * Aggregate compression metrics over an explicit time window (so custom
   * date ranges work). `win = {}` is all-time. The returned `cacheHealth` is a
   * zero/healthy placeholder; the IPC handler overwrites it from the main
   * telemetry DB via `getCacheHealthWindowRange`.
   */
  getCompressionMetricsWindow(win: MetricsWindow = {}): CompressionMetrics {
    this.flush();
    const winParams = { sinceMs: win.sinceMs ?? null, untilMs: win.untilMs ?? null };

    const totalsRow = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN changed = 1 THEN bytes_in ELSE 0 END), 0)            AS bytes_in,
           COALESCE(SUM(CASE WHEN changed = 1 THEN bytes_out ELSE 0 END), 0)           AS bytes_out,
           COALESCE(SUM(CASE WHEN changed = 1 THEN est_tokens_in ELSE 0 END), 0)       AS tokens_in,
           COALESCE(SUM(CASE WHEN changed = 1 THEN est_tokens_in - est_tokens_out ELSE 0 END), 0) AS tokens_saved,
           COALESCE(SUM(CASE WHEN changed = 1 THEN est_cost_saved_usd ELSE 0 END), 0)  AS cost_saved,
           COALESCE(SUM(changed), 0)                                                   AS compressed,
           COALESCE(SUM(CASE WHEN changed = 0 AND skip_reason IS NOT NULL THEN 1 ELSE 0 END), 0) AS skipped,
           COALESCE(SUM(est_tokens_potential), 0)                                      AS tokens_potential,
           COALESCE(SUM(est_cost_potential), 0)                                        AS cost_potential
         FROM compression_events
         WHERE (@sinceMs IS NULL OR ts >= @sinceMs)
           AND (@untilMs IS NULL OR ts <  @untilMs)`,
      )
      .get(winParams) as {
      bytes_in: number;
      bytes_out: number;
      tokens_in: number;
      tokens_saved: number;
      cost_saved: number;
      compressed: number;
      skipped: number;
      tokens_potential: number;
      cost_potential: number;
    };

    const dailyRows = this.db
      .prepare(
        `SELECT
           date(ts / 1000, 'unixepoch', 'localtime') AS day,
           COALESCE(SUM(bytes_in), 0)                 AS bytes_in,
           COALESCE(SUM(bytes_out), 0)                AS bytes_out,
           COALESCE(SUM(est_tokens_in - est_tokens_out), 0) AS tokens_saved,
           COALESCE(SUM(est_cost_saved_usd), 0)       AS cost_saved
         FROM compression_events
         WHERE changed = 1
           AND (@sinceMs IS NULL OR ts >= @sinceMs)
           AND (@untilMs IS NULL OR ts <  @untilMs)
         GROUP BY day
         ORDER BY day ASC`,
      )
      .all(winParams) as Array<{
      day: string;
      bytes_in: number;
      bytes_out: number;
      tokens_saved: number;
      cost_saved: number;
    }>;

    const errorRows = this.db
      .prepare(
        `SELECT skip_reason AS reason, COUNT(*) AS count
         FROM compression_events
         WHERE changed = 0 AND skip_reason IS NOT NULL
           AND (@sinceMs IS NULL OR ts >= @sinceMs)
           AND (@untilMs IS NULL OR ts <  @untilMs)
         GROUP BY skip_reason
         ORDER BY count DESC`,
      )
      .all(winParams) as Array<{ reason: string; count: number }>;

    // by-tool / by-rule are JSON columns; aggregate in JS over changed rows.
    const jsonRows = this.db
      .prepare(
        `SELECT per_tool_json, per_rule_json
         FROM compression_events
         WHERE changed = 1
           AND (@sinceMs IS NULL OR ts >= @sinceMs)
           AND (@untilMs IS NULL OR ts <  @untilMs)`,
      )
      .all(winParams) as Array<Pick<CompressionEventRow, 'per_tool_json' | 'per_rule_json'>>;

    const byToolAcc = new Map<string, { bytesIn: number; bytesOut: number; blocks: number }>();
    const byRuleAcc = new Map<string, { bytesSaved: number; hits: number }>();
    for (const row of jsonRows) {
      const perTool = safeParse<Record<string, PerToolStat>>(row.per_tool_json) ?? {};
      for (const [tool, stat] of Object.entries(perTool)) {
        const cur = byToolAcc.get(tool) ?? { bytesIn: 0, bytesOut: 0, blocks: 0 };
        cur.bytesIn += stat.bytesIn ?? 0;
        cur.bytesOut += stat.bytesOut ?? 0;
        cur.blocks += stat.blocks ?? 0;
        byToolAcc.set(tool, cur);
      }
      const perRule = safeParse<Record<string, PerRuleStat>>(row.per_rule_json) ?? {};
      for (const [rule, stat] of Object.entries(perRule)) {
        const cur = byRuleAcc.get(rule) ?? { bytesSaved: 0, hits: 0 };
        cur.bytesSaved += stat.bytesSaved ?? 0;
        cur.hits += stat.hits ?? 0;
        byRuleAcc.set(rule, cur);
      }
    }

    const byTool = [...byToolAcc.entries()]
      .map(([tool, s]) => ({
        tool,
        bytesIn: s.bytesIn,
        bytesOut: s.bytesOut,
        blocks: s.blocks,
        estTokensSaved: estimateTokensFromBytes(s.bytesIn) - estimateTokensFromBytes(s.bytesOut),
      }))
      .sort((a, b) => b.estTokensSaved - a.estTokensSaved);

    const byRule = [...byRuleAcc.entries()]
      .map(([rule, s]) => ({ rule, bytesSaved: s.bytesSaved, hits: s.hits }))
      .sort((a, b) => b.bytesSaved - a.bytesSaved);

    return {
      totals: {
        bytesIn: totalsRow.bytes_in,
        bytesOut: totalsRow.bytes_out,
        estTokensIn: totalsRow.tokens_in,
        estTokensSaved: totalsRow.tokens_saved,
        estCostSavedUsd: totalsRow.cost_saved,
        requestsCompressed: totalsRow.compressed,
        requestsSkipped: totalsRow.skipped,
        ratio: totalsRow.bytes_in > 0 ? totalsRow.bytes_out / totalsRow.bytes_in : 0,
        estTokensPotential: totalsRow.tokens_potential,
        estCostPotential: totalsRow.cost_potential,
      },
      daily: dailyRows.map((d) => ({
        day: d.day,
        bytesIn: d.bytes_in,
        bytesOut: d.bytes_out,
        estTokensSaved: d.tokens_saved,
        estCostSavedUsd: d.cost_saved,
        ratio: d.bytes_in > 0 ? d.bytes_out / d.bytes_in : 0,
      })),
      byTool,
      byRule,
      errors: errorRows.map((e) => ({ skipReason: e.reason, count: e.count })),
      cacheHealth: { cacheReadTokens: 0, cacheCreateTokens: 0, hitRatio: 1 },
    };
  }

  /** Delete event + retrieval rows older than cutoff (Unix ms). Returns the
   *  combined count deleted. */
  purgeOlderThan(cutoffMs: number): number {
    const events = this.db.prepare('DELETE FROM compression_events WHERE ts < ?').run(cutoffMs);
    const retrievals = this.db
      .prepare('DELETE FROM compression_retrievals WHERE ts < ?')
      .run(cutoffMs);
    const deleted = Number(events.changes) + Number(retrievals.changes);
    if (deleted > 0) {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.exec('VACUUM');
    }
    return deleted;
  }

  /** Delete every event + retrieval row. */
  clearAll(): number {
    this.queue = [];
    this.retrievalQueue = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const events = this.db.prepare('DELETE FROM compression_events').run();
    const retrievals = this.db.prepare('DELETE FROM compression_retrievals').run();
    const deleted = Number(events.changes) + Number(retrievals.changes);
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.exec('VACUUM');
    return deleted;
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = null;
    }
    this.db.close();
    this.closed = true;
  }
}

function safeParse<T>(s: string): T | null {
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

// ── singleton accessor (mirrors request-log-db) ──────────────────────────────

let _store: CompressionStatsStore | null = null;

export function getCompressionStatsStore(opts?: {
  dbPath?: string;
  ipcServer?: IpcServer;
}): CompressionStatsStore {
  if (!_store) _store = new CompressionStatsStore(opts);
  return _store;
}

export function closeCompressionStatsStore(): void {
  if (_store) {
    _store.close();
    _store = null;
  }
}
