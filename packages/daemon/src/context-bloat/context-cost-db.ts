import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { CodeModeAuditRow, MetricsWindow } from '@sentinel/shared';
import { SENTINEL_DIR } from '../db.js';
import type { IpcServer } from '../ipc.js';

export const CONTEXT_COST_DB_PATH = join(SENTINEL_DIR, 'context-cost.db');

/** Reserved server key for non-MCP (built-in) tool definitions, so one table
 *  answers "what share of tools[] is MCP" without a parallel table. */
export const NATIVE_SERVER_KEY = '__native__';

const SCHEMA = `
-- One row per (local day, account, server): aggregated static tool-definition
-- cost measured from live request tools[] arrays. Definitions are static
-- within a session, so MAX is the honest "what it costs when present" and
-- SUM(request_count) is how often it was paid.
CREATE TABLE IF NOT EXISTS mcp_definition_costs (
  day             TEXT    NOT NULL,
  account_id      TEXT    NOT NULL,
  server          TEXT    NOT NULL,
  request_count   INTEGER NOT NULL DEFAULT 0,
  def_bytes_max   INTEGER NOT NULL DEFAULT 0,
  def_bytes_sum   INTEGER NOT NULL DEFAULT 0,
  tool_count_max  INTEGER NOT NULL DEFAULT 0,
  last_seen_ms    INTEGER NOT NULL,
  last_tool_names TEXT    NOT NULL DEFAULT '[]',
  PRIMARY KEY (day, account_id, server)
);

CREATE INDEX IF NOT EXISTS idx_mdc_day ON mcp_definition_costs(day);
CREATE INDEX IF NOT EXISTS idx_mdc_server ON mcp_definition_costs(server);

-- Audit trail for the code-mode bridge endpoint. Metadata only: server, tool,
-- outcome, sizes. Arguments and results are never persisted (same privacy
-- posture as tool_calls in the main DB).
CREATE TABLE IF NOT EXISTS code_mode_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  server      TEXT    NOT NULL,
  tool        TEXT    NOT NULL,
  ok          INTEGER NOT NULL DEFAULT 0,
  bytes_out   INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_code_mode_calls_ts ON code_mode_calls(ts);
`;

const BROADCAST_DEBOUNCE_MS = 1500;

/** Cap the per-row tool-name sample so a pathological server with thousands
 *  of tools can't balloon the row. */
const TOOL_NAMES_CAP = 50;

/** One request's measured definition costs, enqueued by the proxy. */
export interface ContextCostEventRecord {
  ts: number;
  accountId: string;
  perServer: Array<{
    server: string;
    defBytes: number;
    toolCount: number;
    toolNames: string[];
  }>;
  nativeBytes: number;
  nativeToolCount: number;
}

/** Per-server aggregate over a window, for the insights merge. */
export interface ServerDefinitionCostAggregate {
  server: string;
  defBytesMax: number;
  /** Total definition bytes carried across every request in the window —
   *  the exact cost paid, and therefore what bridging would have saved. */
  defBytesSum: number;
  toolCountMax: number;
  requestCount: number;
  lastSeenMs: number;
  toolNames: string[];
}

interface AggRow {
  server: string;
  def_bytes_max: number;
  def_bytes_sum: number;
  tool_count_max: number;
  request_count: number;
  last_seen_ms: number;
  last_tool_names: string;
}

/** Format a Unix-ms timestamp as a local-midnight 'YYYY-MM-DD' day bucket,
 *  matching the optimization metrics' local-time day buckets. */
export function localDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Dedicated SQLite store for measured MCP tool-definition costs and the
 * code-mode call audit. Separate file from the main telemetry DB (like
 * compression-stats.db) so per-request writes don't bloat telemetry queries.
 * Definition writes are batched on a 100ms timer off the proxy hot path and
 * upsert into (day, account, server) rows; a debounced
 * `mcp_context_costs_updated` broadcast fires after any flush that committed
 * a row.
 */
export class ContextCostStore {
  private db: Database.Database;
  private queue: ContextCostEventRecord[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private upsertStmt: Database.Statement;
  private auditInsertStmt: Database.Statement;
  private ipcServer: IpcServer | null;
  private closed = false;

  constructor(opts?: { dbPath?: string; ipcServer?: IpcServer }) {
    const dbPath =
      opts?.dbPath ?? process.env.SENTINEL_TEST_CONTEXT_COST_DB_FILE ?? CONTEXT_COST_DB_PATH;
    this.ipcServer = opts?.ipcServer ?? null;

    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);

    this.upsertStmt = this.db.prepare(`
      INSERT INTO mcp_definition_costs (
        day, account_id, server, request_count, def_bytes_max, def_bytes_sum,
        tool_count_max, last_seen_ms, last_tool_names
      ) VALUES (
        @day, @accountId, @server, 1, @defBytes, @defBytes,
        @toolCount, @ts, @toolNames
      )
      ON CONFLICT(day, account_id, server) DO UPDATE SET
        request_count   = request_count + 1,
        def_bytes_max   = MAX(def_bytes_max, excluded.def_bytes_max),
        def_bytes_sum   = def_bytes_sum + excluded.def_bytes_sum,
        tool_count_max  = MAX(tool_count_max, excluded.tool_count_max),
        last_seen_ms    = excluded.last_seen_ms,
        last_tool_names = excluded.last_tool_names
    `);

    this.auditInsertStmt = this.db.prepare(`
      INSERT INTO code_mode_calls (ts, server, tool, ok, bytes_out, duration_ms)
      VALUES (@ts, @server, @tool, @ok, @bytesOut, @durationMs)
    `);
  }

  /** Push a measured request onto the write queue. Never awaits IO. */
  enqueue(record: ContextCostEventRecord): void {
    if (this.closed) return;
    this.queue.push(record);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 100);
    }
  }

  /** Drain the queue into one transaction of (day, account, server) upserts.
   *  Native definitions fold into the reserved `__native__` row. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    let anyCommitted = false;
    this.db.transaction(() => {
      for (const r of batch) {
        const day = localDay(r.ts);
        for (const s of r.perServer) {
          this.upsertStmt.run({
            day,
            accountId: r.accountId,
            server: s.server,
            defBytes: s.defBytes,
            toolCount: s.toolCount,
            ts: r.ts,
            toolNames: JSON.stringify(s.toolNames.slice(0, TOOL_NAMES_CAP)),
          });
          anyCommitted = true;
        }
        if (r.nativeToolCount > 0) {
          this.upsertStmt.run({
            day,
            accountId: r.accountId,
            server: NATIVE_SERVER_KEY,
            defBytes: r.nativeBytes,
            toolCount: r.nativeToolCount,
            ts: r.ts,
            toolNames: '[]',
          });
          anyCommitted = true;
        }
      }
    })();
    if (anyCommitted) this.scheduleBroadcast();
  }

  private scheduleBroadcast(): void {
    if (!this.ipcServer || this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      try {
        this.ipcServer?.broadcast({ type: 'mcp_context_costs_updated' });
      } catch (err) {
        console.error('[ContextCost] metrics broadcast failed:', err);
      }
    }, BROADCAST_DEBOUNCE_MS);
    if (typeof this.broadcastTimer.unref === 'function') this.broadcastTimer.unref();
  }

  /**
   * Per-server definition-cost aggregates over an explicit time window
   * (`{}` = all-time). Window bounds resolve to local-day buckets — a window
   * covering any part of a day includes that day's row, matching the daily
   * granularity of the storage. The `__native__` row is included; callers
   * split it out by key.
   */
  getServerDefinitionCosts(win: MetricsWindow = {}): ServerDefinitionCostAggregate[] {
    this.flush();
    const sinceDay = win.sinceMs !== undefined ? localDay(win.sinceMs) : null;
    // untilMs is exclusive; the day containing (untilMs - 1) is the last
    // included bucket.
    const untilDay = win.untilMs !== undefined ? localDay(win.untilMs - 1) : null;
    const rows = this.db
      .prepare(
        `SELECT server,
                MAX(def_bytes_max)  AS def_bytes_max,
                SUM(def_bytes_sum)  AS def_bytes_sum,
                MAX(tool_count_max) AS tool_count_max,
                SUM(request_count)  AS request_count,
                MAX(last_seen_ms)   AS last_seen_ms,
                (SELECT last_tool_names FROM mcp_definition_costs i
                  WHERE i.server = o.server
                    AND (@sinceDay IS NULL OR i.day >= @sinceDay)
                    AND (@untilDay IS NULL OR i.day <= @untilDay)
                  ORDER BY i.last_seen_ms DESC LIMIT 1) AS last_tool_names
         FROM mcp_definition_costs o
         WHERE (@sinceDay IS NULL OR day >= @sinceDay)
           AND (@untilDay IS NULL OR day <= @untilDay)
         GROUP BY server
         ORDER BY def_bytes_max DESC`,
      )
      .all({ sinceDay, untilDay }) as AggRow[];

    return rows.map((r) => ({
      server: r.server,
      defBytesMax: r.def_bytes_max,
      defBytesSum: r.def_bytes_sum,
      toolCountMax: r.tool_count_max,
      requestCount: r.request_count,
      lastSeenMs: r.last_seen_ms,
      toolNames: safeParseNames(r.last_tool_names),
    }));
  }

  /** Record one bridge call to the audit trail. Direct insert — bridge calls
   *  are orders of magnitude rarer than proxy requests, so no batching. */
  recordCall(row: Omit<CodeModeAuditRow, 'ok'> & { ok: boolean }): void {
    if (this.closed) return;
    this.auditInsertStmt.run({
      ts: row.ts,
      server: row.server,
      tool: row.tool,
      ok: row.ok ? 1 : 0,
      bytesOut: row.bytesOut,
      durationMs: row.durationMs,
    });
  }

  /** Recent bridge calls, newest first. `limit` clamps to [1, 500]. */
  getAudit(win: MetricsWindow = {}, limit = 50): CodeModeAuditRow[] {
    const capped = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT ts, server, tool, ok, bytes_out, duration_ms
         FROM code_mode_calls
         WHERE (@sinceMs IS NULL OR ts >= @sinceMs)
           AND (@untilMs IS NULL OR ts <  @untilMs)
         ORDER BY ts DESC, id DESC
         LIMIT @limit`,
      )
      .all({
        sinceMs: win.sinceMs ?? null,
        untilMs: win.untilMs ?? null,
        limit: capped,
      }) as Array<{
      ts: number;
      server: string;
      tool: string;
      ok: number;
      bytes_out: number;
      duration_ms: number;
    }>;
    return rows.map((r) => ({
      ts: r.ts,
      server: r.server,
      tool: r.tool,
      ok: r.ok === 1,
      bytesOut: r.bytes_out,
      durationMs: r.duration_ms,
    }));
  }

  /** Delete definition rows last seen before cutoff and audit rows older than
   *  cutoff (Unix ms). Returns the combined count deleted. */
  purgeOlderThan(cutoffMs: number): number {
    const defs = this.db
      .prepare('DELETE FROM mcp_definition_costs WHERE last_seen_ms < ?')
      .run(cutoffMs);
    const calls = this.db.prepare('DELETE FROM code_mode_calls WHERE ts < ?').run(cutoffMs);
    const deleted = Number(defs.changes) + Number(calls.changes);
    if (deleted > 0) {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.exec('VACUUM');
    }
    return deleted;
  }

  /** Delete every row. Used by the purge-all-data flow. */
  clearAll(): number {
    this.queue = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const defs = this.db.prepare('DELETE FROM mcp_definition_costs').run();
    const calls = this.db.prepare('DELETE FROM code_mode_calls').run();
    const deleted = Number(defs.changes) + Number(calls.changes);
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

function safeParseNames(s: string): string[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

// ── singleton accessor (mirrors compression-stats-db) ────────────────────────

let _store: ContextCostStore | null = null;

export function getContextCostStore(opts?: {
  dbPath?: string;
  ipcServer?: IpcServer;
}): ContextCostStore {
  if (!_store) _store = new ContextCostStore(opts);
  return _store;
}

export function closeContextCostStore(): void {
  if (_store) {
    _store.close();
    _store = null;
  }
}
