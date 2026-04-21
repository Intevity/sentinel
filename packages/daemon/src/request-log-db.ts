import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import type { RequestDetail } from '@claude-sentinel/shared';
import { SENTINEL_DIR } from './db.js';

export const REQUEST_LOG_DB_PATH = join(SENTINEL_DIR, 'request-logs.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS request_logs (
  request_id               TEXT PRIMARY KEY,
  timestamp                INTEGER NOT NULL,
  duration_ms              INTEGER,
  method                   TEXT NOT NULL,
  url_path                 TEXT NOT NULL,
  status_code              INTEGER,
  request_headers          TEXT NOT NULL,
  request_body             BLOB,
  request_body_truncated   INTEGER NOT NULL DEFAULT 0,
  request_body_size        INTEGER NOT NULL,
  response_headers         TEXT,
  response_body            BLOB,
  response_body_truncated  INTEGER NOT NULL DEFAULT 0,
  response_body_size       INTEGER,
  is_sse                   INTEGER NOT NULL DEFAULT 0,
  error_message            TEXT
);

CREATE INDEX IF NOT EXISTS idx_request_logs_timestamp ON request_logs(timestamp);
`;

/** Input shape enqueued by the proxy. Buffers are converted to BLOBs on write;
 *  decoding back to UTF-8 happens on read via {@link RequestLogStore.get}. */
export interface RequestLogRecord {
  requestId: string;
  timestamp: number;
  durationMs: number | null;
  method: string;
  urlPath: string;
  statusCode: number | null;
  requestHeaders: Record<string, string>;
  requestBody: Buffer | null;
  requestBodyTruncated: boolean;
  requestBodySize: number;
  responseHeaders: Record<string, string> | null;
  responseBody: Buffer | null;
  responseBodyTruncated: boolean;
  responseBodySize: number | null;
  isSse: boolean;
  errorMessage: string | null;
}

/** Dedicated SQLite store for captured Claude API request/response pairs.
 *  Separate from the main telemetry DB so the large BLOBs don't bloat every
 *  query and so "clear all" can be implemented as a file-level wipe if
 *  needed. Writes are batched through a 100ms flush timer. */
export class RequestLogStore {
  private db: Database.Database;
  private queue: RequestLogRecord[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private insertStmt: Database.Statement;
  private closed = false;

  constructor(dbPath: string = REQUEST_LOG_DB_PATH) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);

    this.insertStmt = this.db.prepare(`
      INSERT OR REPLACE INTO request_logs (
        request_id, timestamp, duration_ms, method, url_path, status_code,
        request_headers, request_body, request_body_truncated, request_body_size,
        response_headers, response_body, response_body_truncated, response_body_size,
        is_sse, error_message
      ) VALUES (
        @requestId, @timestamp, @durationMs, @method, @urlPath, @statusCode,
        @requestHeaders, @requestBody, @requestBodyTruncated, @requestBodySize,
        @responseHeaders, @responseBody, @responseBodyTruncated, @responseBodySize,
        @isSse, @errorMessage
      )
    `);
  }

  /** Push a captured record onto the write queue. Never awaits IO — the
   *  100ms flush timer commits the batch off the proxy hot path. */
  enqueue(record: RequestLogRecord): void {
    if (this.closed) return;
    this.queue.push(record);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 100);
    }
  }

  /** Drain the queue into a single transaction. Called by the timer, on
   *  shutdown, and by `get()` when the caller asks for a record that might
   *  still be queued. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    const stmt = this.insertStmt;
    this.db.transaction(() => {
      for (const r of batch) {
        stmt.run({
          requestId: r.requestId,
          timestamp: r.timestamp,
          durationMs: r.durationMs,
          method: r.method,
          urlPath: r.urlPath,
          statusCode: r.statusCode,
          requestHeaders: JSON.stringify(r.requestHeaders),
          requestBody: r.requestBody,
          requestBodyTruncated: r.requestBodyTruncated ? 1 : 0,
          requestBodySize: r.requestBodySize,
          responseHeaders: r.responseHeaders ? JSON.stringify(r.responseHeaders) : null,
          responseBody: r.responseBody,
          responseBodyTruncated: r.responseBodyTruncated ? 1 : 0,
          responseBodySize: r.responseBodySize,
          isSse: r.isSse ? 1 : 0,
          errorMessage: r.errorMessage,
        });
      }
    })();
  }

  /** Look up a captured request/response pair for the Logs UI detail view.
   *  Calls flush() first so an expand-click that lands while the row is
   *  still queued still returns the record. */
  get(requestId: string): RequestDetail | null {
    this.flush();
    const row = this.db
      .prepare('SELECT * FROM request_logs WHERE request_id = ?')
      .get(requestId) as RequestLogRow | undefined;
    return row ? rowToDetail(row) : null;
  }

  /** Delete rows older than cutoff (Unix ms) and reclaim disk. Bodies are
   *  large — VACUUM matters here more than it does for telemetry. */
  purgeOlderThan(cutoffMs: number): number {
    const result = this.db.prepare('DELETE FROM request_logs WHERE timestamp < ?').run(cutoffMs);
    const deleted = Number(result.changes);
    if (deleted > 0) {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
      this.db.exec('VACUUM');
    }
    return deleted;
  }

  /** Delete every row. Used by the Settings panel "Clear all request logs"
   *  button. Also VACUUMs since the BLOBs are large. */
  clearAll(): number {
    this.queue = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const result = this.db.prepare('DELETE FROM request_logs').run();
    const deleted = Number(result.changes);
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.exec('VACUUM');
    return deleted;
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.db.close();
    this.closed = true;
  }
}

interface RequestLogRow {
  request_id: string;
  timestamp: number;
  duration_ms: number | null;
  method: string;
  url_path: string;
  status_code: number | null;
  request_headers: string;
  request_body: Buffer | null;
  request_body_truncated: number;
  request_body_size: number;
  response_headers: string | null;
  response_body: Buffer | null;
  response_body_truncated: number;
  response_body_size: number | null;
  is_sse: number;
  error_message: string | null;
}

function rowToDetail(row: RequestLogRow): RequestDetail {
  const responseHeaders = row.response_headers ? safeJsonParse(row.response_headers) : null;
  const hasResponse = responseHeaders !== null || row.response_body !== null;
  return {
    requestId: row.request_id,
    timestamp: row.timestamp,
    durationMs: row.duration_ms,
    method: row.method,
    urlPath: row.url_path,
    statusCode: row.status_code,
    isSse: row.is_sse === 1,
    request: {
      headers: safeJsonParse(row.request_headers) ?? {},
      body: bufferToUtf8(row.request_body),
      bodyTruncated: row.request_body_truncated === 1,
      bodySize: row.request_body_size,
    },
    response: hasResponse
      ? {
          headers: responseHeaders ?? {},
          body: bufferToUtf8(row.response_body),
          bodyTruncated: row.response_body_truncated === 1,
          bodySize: row.response_body_size ?? 0,
        }
      : null,
    errorMessage: row.error_message,
  };
}

function bufferToUtf8(buf: Buffer | null): string {
  if (!buf) return '';
  // `fatal: false` replaces invalid sequences with U+FFFD so non-UTF-8
  // payloads (rare — Anthropic API is JSON/SSE text) still render instead
  // of throwing inside the IPC handler.
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

function safeJsonParse(s: string): Record<string, string> | null {
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : null;
  } catch {
    return null;
  }
}

/** Headers that must ALWAYS be redacted regardless of user setting — static
 *  API keys, proxy auth, and cookies. The `authorization` bearer header is
 *  handled separately because it's an OAuth token the user may want to see
 *  for debugging. */
const ALWAYS_REDACT = new Set(['x-api-key', 'proxy-authorization', 'cookie', 'set-cookie']);

/** Produce a copy of `headers` with sensitive values replaced by
 *  `[REDACTED]`. Keys are compared case-insensitively; the returned object
 *  preserves the original casing of the input keys. */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
  redactAuth: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    const raw = Array.isArray(value) ? value.join(', ') : String(value);
    if (ALWAYS_REDACT.has(lower) || (redactAuth && lower === 'authorization')) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = raw;
    }
  }
  return out;
}

// ── singleton accessor ────────────────────────────────────────────────────

let _store: RequestLogStore | null = null;

export function getRequestLogStore(dbPath: string = REQUEST_LOG_DB_PATH): RequestLogStore {
  if (!_store) _store = new RequestLogStore(dbPath);
  return _store;
}

export function closeRequestLogStore(): void {
  if (_store) {
    _store.close();
    _store = null;
  }
}
