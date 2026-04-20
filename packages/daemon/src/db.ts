import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import type {
  AccountInfo,
  UsageEvent,
  OverageEvent,
  NotificationRecord,
  OverageTransition,
  NotificationType,
  PlanType,
  RateLimitWindow,
  Alert,
  MetricsByDayModel,
  CacheHitRate,
  ToolStat,
  EditAcceptRate,
  ToolDecisionBreakdown,
  PromptStats,
  SkillUsage,
  PluginInstall,
  SecurityEvent,
  SecurityKind,
  SecuritySeverity,
  SecurityAllowlistEntry,
} from '@claude-sentinel/shared';

export const SENTINEL_DIR = join(homedir(), '.claude-sentinel');
export const DB_PATH = join(SENTINEL_DIR, 'sentinel.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  account_uuid  TEXT,
  email         TEXT NOT NULL,
  display_name  TEXT,
  org_uuid      TEXT,
  org_name      TEXT,
  plan_type     TEXT,
  removed       INTEGER NOT NULL DEFAULT 0,
  color         TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  account_id    TEXT NOT NULL,
  session_id    TEXT,
  model         TEXT NOT NULL,
  cost_usd      REAL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cache_read    INTEGER,
  cache_create  INTEGER,
  duration_ms   INTEGER
);

CREATE TABLE IF NOT EXISTS overage_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  account_id      TEXT NOT NULL,
  transition      TEXT NOT NULL,
  status          TEXT,
  resets_at       INTEGER,
  disabled_reason TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  account_id    TEXT,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  acknowledged  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rate_limits (
  account_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  status       TEXT,
  utilization  REAL,
  lim          INTEGER,
  remaining    INTEGER,
  reset_ts     INTEGER,
  in_use       INTEGER,
  last_updated INTEGER NOT NULL,
  PRIMARY KEY (account_id, name)
);

-- Alerts come in two scopes:
--   'account' → bound to a specific account; fires on that account's
--               unified-5h utilization. account_id stores the Sentinel key.
--   'pool'    → round-robin only; fires on the pool-wide MEAN unified-5h
--               utilization across every account not in poolExcludedIds.
--               account_id is stored as '' so the NOT NULL constraint still
--               holds on legacy databases (see rowToAlert for the mapping
--               back to null in the TS type).
CREATE TABLE IF NOT EXISTS alerts (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  scope                      TEXT    NOT NULL DEFAULT 'account',
  account_id                 TEXT NOT NULL,
  threshold_pct              INTEGER NOT NULL,
  enabled                    INTEGER NOT NULL DEFAULT 1,
  last_triggered_reset_ts    INTEGER,
  created_at                 INTEGER NOT NULL
);

-- Per-tool-invocation facts from claude_code.tool_result log events.
-- Powers the Top tools view on the Metrics tab (p50/p95 latency,
-- success rate, top error).
CREATE TABLE IF NOT EXISTS tool_events (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                       INTEGER NOT NULL,
  account_id               TEXT NOT NULL,
  session_id               TEXT,
  tool_name                TEXT NOT NULL,
  success                  INTEGER NOT NULL,
  duration_ms              INTEGER,
  error                    TEXT,
  decision_source          TEXT,
  decision_type            TEXT,
  mcp_server_scope         TEXT,
  tool_result_size_bytes   INTEGER
);

-- Terminal API failures from claude_code.api_error log events.
-- Claude Code emits one event *after* retries are exhausted; the attempt
-- attribute tells us whether retries played out before giving up.
CREATE TABLE IF NOT EXISTS api_errors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  account_id    TEXT NOT NULL,
  session_id    TEXT,
  model         TEXT,
  status_code   TEXT,
  error         TEXT,
  duration_ms   INTEGER,
  attempt       INTEGER,
  request_id    TEXT,
  speed         TEXT
);

-- Generic counter-style signal bucket. One row per observation for:
--   session, commit, pull_request, lines_added, lines_removed,
--   active_user_seconds, active_cli_seconds, edit_decision,
--   skill_activated, plugin_installed.
-- Optional dimension columns (model, tool_name, language, decision,
-- source, name, version, marketplace) stay NULL when not applicable to
-- the kind. extra_json reserves room for future dimensions without
-- another migration.
CREATE TABLE IF NOT EXISTS activity_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,
  account_id       TEXT NOT NULL,
  session_id       TEXT,
  kind             TEXT NOT NULL,
  value            REAL,
  model            TEXT,
  tool_name        TEXT,
  language         TEXT,
  decision         TEXT,
  source           TEXT,
  name             TEXT,
  version          TEXT,
  marketplace      TEXT,
  extra_json       TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_ts      ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_usage_account ON usage_events(account_id);
CREATE INDEX IF NOT EXISTS idx_overage_account ON overage_events(account_id);
-- Dedup guarantee: at most one row per (account_id, overage window, transition).
-- COALESCE on resets_at keeps NULL-reset rows comparable — SQLite otherwise
-- treats each NULL as distinct, which would defeat the dedup.
CREATE UNIQUE INDEX IF NOT EXISTS idx_overage_window_transition
  ON overage_events(account_id, COALESCE(resets_at, 0), transition);
CREATE INDEX IF NOT EXISTS idx_notif_ts      ON notifications(ts);
CREATE INDEX IF NOT EXISTS idx_alerts_account ON alerts(account_id);
-- idx_alerts_scope is created after the scope-column migration runs (see
-- getDb below) so legacy DBs whose alerts table predates the column aren't
-- tripped up by a CREATE INDEX referencing a column that doesn't exist yet.
CREATE INDEX IF NOT EXISTS idx_tool_events_ts        ON tool_events(ts);
CREATE INDEX IF NOT EXISTS idx_tool_events_account   ON tool_events(account_id);
CREATE INDEX IF NOT EXISTS idx_tool_events_tool      ON tool_events(tool_name);
CREATE INDEX IF NOT EXISTS idx_api_errors_ts         ON api_errors(ts);
CREATE INDEX IF NOT EXISTS idx_api_errors_account    ON api_errors(account_id);
CREATE INDEX IF NOT EXISTS idx_activity_ts           ON activity_events(ts);
CREATE INDEX IF NOT EXISTS idx_activity_account_kind ON activity_events(account_id, kind);

-- Findings surfaced by the security scanner. Secrets are never stored
-- verbatim — only the masked form (first 4 + last 4 + length) plus a
-- hash for dedup. See packages/daemon/src/security/scanner.ts for the
-- full redaction contract.
CREATE TABLE IF NOT EXISTS security_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  last_seen_ts    INTEGER NOT NULL,
  account_id      TEXT NOT NULL,
  session_id      TEXT,
  direction       TEXT NOT NULL,     -- 'outbound' | 'tool_use'
  severity        TEXT NOT NULL,     -- 'low' | 'medium' | 'high'
  kind            TEXT NOT NULL,
  detector_id     TEXT NOT NULL,
  confidence      REAL NOT NULL,
  title           TEXT NOT NULL,
  reason          TEXT NOT NULL,
  match_mask      TEXT,
  match_hash      TEXT NOT NULL,
  context_hash    TEXT,
  snippet         TEXT,
  source_hint     TEXT,
  details_json    TEXT,
  occurrences     INTEGER NOT NULL DEFAULT 1,
  blocked         INTEGER NOT NULL DEFAULT 0,
  approved        INTEGER NOT NULL DEFAULT 0,
  acknowledged    INTEGER NOT NULL DEFAULT 0,
  provenance      TEXT NOT NULL DEFAULT 'conversation'
);

CREATE INDEX IF NOT EXISTS idx_sec_ts          ON security_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_sec_account_ts  ON security_events(account_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_sec_ack         ON security_events(acknowledged, ts DESC);
CREATE INDEX IF NOT EXISTS idx_sec_kind_ack    ON security_events(kind, acknowledged);
CREATE INDEX IF NOT EXISTS idx_sec_dedup       ON security_events(match_hash, detector_id, account_id, last_seen_ts);

-- Suppress-list for security findings. Adding a (match_hash, detector_id)
-- pair stops all future detections of that exact match from creating
-- events or firing broadcasts. Populated via the "Always allow" UI action
-- on a Security-tab row; the user manages entries from Settings.
CREATE TABLE IF NOT EXISTS security_allowlist (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  match_hash   TEXT NOT NULL,
  detector_id  TEXT NOT NULL,
  match_mask   TEXT,
  title        TEXT,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE (match_hash, detector_id)
);

CREATE INDEX IF NOT EXISTS idx_sec_allow_lookup ON security_allowlist(match_hash, detector_id);
`;

let _db: Database.Database | null = null;

/**
 * Open (or reuse) the singleton SQLite connection.
 */
export function getDb(dbPath: string = DB_PATH): Database.Database {
  if (_db) return _db;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  // Collapse legacy duplicates before the unique index is created in SCHEMA.
  // Older daemons persisted every transition blindly, so a single overage
  // window could have many identical (account_id, resets_at, transition) rows.
  // Keep the earliest row per key; drop the rest. Safe no-op on fresh DBs.
  try {
    _db.exec(`
      DELETE FROM overage_events
      WHERE id NOT IN (
        SELECT MIN(id) FROM overage_events
        GROUP BY account_id, COALESCE(resets_at, 0), transition
      )
    `);
  } catch {
    /* table may not exist yet on a brand-new DB — SCHEMA will create it */
  }

  _db.exec(SCHEMA);

  // Migrate existing databases that predate the account_uuid column.
  // For old-style rows (id = accountUuid), back-fill account_uuid = id so
  // the column is always populated after this migration.
  const cols = _db.pragma('table_info(accounts)') as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'account_uuid')) {
    _db.exec('ALTER TABLE accounts ADD COLUMN account_uuid TEXT');
  }
  _db.exec("UPDATE accounts SET account_uuid = id WHERE account_uuid IS NULL");
  if (!cols.some((c) => c.name === 'removed')) {
    _db.exec('ALTER TABLE accounts ADD COLUMN removed INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.some((c) => c.name === 'color')) {
    _db.exec('ALTER TABLE accounts ADD COLUMN color TEXT');
  }

  // Migrate rate_limits for pre-in_use databases.
  const rlCols = _db.pragma('table_info(rate_limits)') as Array<{ name: string }>;
  if (!rlCols.some((c) => c.name === 'in_use')) {
    _db.exec('ALTER TABLE rate_limits ADD COLUMN in_use INTEGER');
  }

  // Migrate tool_events for the decision_type column (added with tool_decision
  // event support — distinguishes accept vs. reject for tool-permission prompts).
  const teCols = _db.pragma('table_info(tool_events)') as Array<{ name: string }>;
  if (!teCols.some((c) => c.name === 'decision_type')) {
    _db.exec('ALTER TABLE tool_events ADD COLUMN decision_type TEXT');
  }

  // Migrate security_events for the `approved` column (added in v1.2 for
  // the approve-in-notification flow). Existing rows default to 0.
  const seCols = _db.pragma('table_info(security_events)') as Array<{ name: string }>;
  if (seCols.length > 0 && !seCols.some((c) => c.name === 'approved')) {
    _db.exec('ALTER TABLE security_events ADD COLUMN approved INTEGER NOT NULL DEFAULT 0');
  }

  // Migrate security_events for the `provenance` column (added in v1.4
  // for provenance-gated blocking — see detectors.ts:classifyProvenance).
  // Historical rows back-fill to 'conversation' since their actual
  // provenance isn't recoverable; new rows are tagged correctly.
  const seCols2 = _db.pragma('table_info(security_events)') as Array<{ name: string }>;
  if (seCols2.length > 0 && !seCols2.some((c) => c.name === 'provenance')) {
    _db.exec("ALTER TABLE security_events ADD COLUMN provenance TEXT NOT NULL DEFAULT 'conversation'");
  }

  // Migrate alerts for the `scope` column (added for pooled round-robin
  // alerts). Legacy rows are per-account — back-fill 'account'. Pool rows
  // store account_id = '' because legacy tables kept NOT NULL on that column;
  // rowToAlert normalizes the empty string back to null in the TS type.
  const alertCols = _db.pragma('table_info(alerts)') as Array<{ name: string }>;
  if (alertCols.length > 0 && !alertCols.some((c) => c.name === 'scope')) {
    _db.exec("ALTER TABLE alerts ADD COLUMN scope TEXT NOT NULL DEFAULT 'account'");
  }
  // Budget-scope alerts (scope='budget') use an extra column to discriminate
  // per-account vs. global. Nullable because existing account/pool rows have
  // no meaningful value. Re-read column list so we pick up the scope column
  // we just added (if any) without an extra round trip.
  const alertCols2 = _db.pragma('table_info(alerts)') as Array<{ name: string }>;
  if (alertCols2.length > 0 && !alertCols2.some((c) => c.name === 'budget_scope')) {
    _db.exec('ALTER TABLE alerts ADD COLUMN budget_scope TEXT');
  }
  // Index on the newly-added column. Done here (not in SCHEMA) so legacy
  // databases whose alerts table predates the column aren't tripped up.
  _db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_scope ON alerts(scope)');

  // One-time cleanup of double-counted usage_events. A prior version of the
  // OTEL receiver wrote two rows per request: one from the `api_request` log
  // (full token breakdown) and one from the `claude_code.cost.usage` metric
  // (cost only, null tokens). Summing both inflated weekly spend 2x+. The
  // metric path is now skipped; delete rows that came from it so existing
  // SQLite databases get the correct totals without a full wipe. Guarded by
  // a flag so this runs once per DB.
  _db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = _db
    .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
    .get('dedup_cost_metric_rows_v1') as { ok: number } | undefined;
  if (!applied) {
    const result = _db
      .prepare(`
        DELETE FROM usage_events
        WHERE input_tokens IS NULL
          AND output_tokens IS NULL
          AND cost_usd IS NOT NULL
          AND cost_usd > 0
      `)
      .run();
    _db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)')
      .run('dedup_cost_metric_rows_v1', Date.now());
    if (result.changes > 0) {
      console.log(`[DB] Removed ${result.changes} duplicate cost-metric rows (one-time cleanup)`);
    }
  }

  return _db;
}

/**
 * Close the database connection (used in tests and shutdown).
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ─── Account queries ──────────────────────────────────────────────────────────

export function upsertAccount(db: Database.Database, account: AccountInfo): void {
  // NOTE: `removed` is intentionally absent from the DO UPDATE clause.
  // An account that was explicitly removed stays removed until reactivateAccount()
  // is called (e.g. on an explicit switch or OAuth re-login). This prevents
  // refresh_accounts / startup from resurrecting a removed account.
  db.prepare(`
    INSERT INTO accounts (id, account_uuid, email, display_name, org_uuid, org_name, plan_type, created_at)
    VALUES (@id, @accountUuid, @email, @displayName, @orgUuid, @orgName, @planType, @createdAt)
    ON CONFLICT(id) DO UPDATE SET
      account_uuid = excluded.account_uuid,
      email        = excluded.email,
      display_name = excluded.display_name,
      org_uuid     = excluded.org_uuid,
      org_name     = excluded.org_name,
      plan_type    = excluded.plan_type
  `).run({
    id: account.id,
    accountUuid: account.accountUuid,
    email: account.email,
    displayName: account.displayName,
    orgUuid: account.orgUuid,
    orgName: account.orgName,
    planType: account.planType,
    createdAt: account.createdAt,
  });
}

export function deleteAccount(db: Database.Database, id: string): boolean {
  const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Delete stale duplicate rows for the given email + org that arose from the
 * pre-sentinelKey schema (rows where id = accountUuid instead of orgUuid).
 *
 * Scope is intentionally narrow: only rows with the SAME org_uuid are deleted.
 * This preserves legitimate multi-org accounts where the same email address
 * belongs to different organisations (each has a distinct sentinelKey / id).
 */
export function deleteStaleAccountRows(
  db: Database.Database,
  email: string,
  keepId: string,
  orgUuid: string,
): number {
  const result = db
    .prepare('DELETE FROM accounts WHERE email = ? AND id != ? AND org_uuid = ?')
    .run(email, keepId, orgUuid);
  return result.changes;
}

/**
 * Mark an account as removed so it is hidden from the UI and will not be
 * resurrected by refresh_accounts / startup. Does NOT delete any data —
 * use purgeAccount() when the data should also be wiped.
 */
export function markAccountRemoved(db: Database.Database, id: string): boolean {
  const result = db.prepare('UPDATE accounts SET removed = 1 WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Permanently delete all data for an account and leave a tombstone row
 * (removed = 2) so the account can never be resurrected by refresh_accounts or
 * daemon startup.
 *
 * Why a tombstone instead of a hard DELETE:
 *   refresh_accounts reads the active account from ~/.claude.json and calls
 *   upsertAccount() on every sync.  upsertAccount's ON CONFLICT DO UPDATE SET
 *   intentionally omits the `removed` column, so an existing row with
 *   removed = 2 is updated in place but the tombstone value is preserved.
 *   A hard DELETE would let upsertAccount INSERT a fresh row with removed = 0,
 *   causing the account to reappear.
 *
 * Leaving ~/.claude.json untouched means Claude Code and the Sentinel proxy
 * continue to operate even when the last account is purged from the UI.
 */
export function purgeAccount(db: Database.Database, id: string): boolean {
  db.prepare('DELETE FROM usage_events    WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM rate_limits     WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM overage_events  WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM notifications   WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM alerts          WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM security_events WHERE account_id = ?').run(id);
  // Mark as purged (removed = 2). If the row does not exist yet, insert a bare
  // tombstone so refresh_accounts cannot create a fresh removed = 0 row later.
  const upd = db.prepare('UPDATE accounts SET removed = 2 WHERE id = ?').run(id);
  if (upd.changes > 0) return true;
  // Row didn't exist — insert a minimal tombstone.
  const ins = db.prepare(
    'INSERT OR IGNORE INTO accounts (id, account_uuid, email, removed, created_at) VALUES (?, ?, \'\', 2, ?)',
  ).run(id, id, Date.now());
  return ins.changes > 0;
}

/**
 * Return all accounts that have been soft-removed (removed = 1).
 */
export function listRemovedAccounts(db: Database.Database): AccountInfo[] {
  const rows = db.prepare('SELECT * FROM accounts WHERE removed = 1 ORDER BY email').all() as DbAccountRow[];
  return rows.map(rowToAccount);
}

/**
 * Clear the removed flag so the account is visible again. Called when the user
 * explicitly switches to or re-adds an account.
 */
export function reactivateAccount(db: Database.Database, id: string): void {
  db.prepare('UPDATE accounts SET removed = 0 WHERE id = ?').run(id);
}

/**
 * Returns true when an account with this id exists and has not been hard-purged
 * (removed = 2). Both active (removed=0) and soft-removed (removed=1) rows
 * count. Used by the OAuth login flow to detect re-auth of an existing org.
 */
export function hasNonPurgedAccount(db: Database.Database, id: string): boolean {
  const row = db
    .prepare('SELECT removed FROM accounts WHERE id = ?')
    .get(id) as { removed: number } | undefined;
  return row !== undefined && row.removed !== 2;
}

/**
 * Returns true when an account with this id exists AND is currently active
 * (removed = 0). Unlike `hasNonPurgedAccount`, soft-removed rows (removed = 1)
 * don't count as "existing". Used by the OAuth login flow to decide whether
 * a fresh authorization is really a re-auth of a live account or a genuine
 * re-enrollment of one the user had previously removed. Treating a soft-
 * removed account as "re-auth" skips the post-login Connect claude.ai step
 * and leaves the account without a sessionKey, which is exactly wrong when
 * the user just deliberately put the account back.
 */
export function hasActiveAccount(db: Database.Database, id: string): boolean {
  const row = db
    .prepare('SELECT removed FROM accounts WHERE id = ?')
    .get(id) as { removed: number } | undefined;
  return row !== undefined && row.removed === 0;
}

export function getAccount(
  db: Database.Database,
  accountId: string,
): AccountInfo | null {
  const row = db
    .prepare('SELECT * FROM accounts WHERE id = ?')
    .get(accountId) as DbAccountRow | undefined;
  return row ? rowToAccount(row) : null;
}

export function listAccounts(db: Database.Database): AccountInfo[] {
  const rows = db.prepare('SELECT * FROM accounts WHERE removed = 0 ORDER BY email').all() as DbAccountRow[];
  return rows.map(rowToAccount);
}

/**
 * Persist the user-picked avatar color for an account. Pass `null` to clear
 * the custom color so the UI reverts to the hash-derived default gradient.
 * Returns true when the row existed and was updated.
 */
export function setAccountColor(
  db: Database.Database,
  id: string,
  color: string | null,
): boolean {
  const result = db.prepare('UPDATE accounts SET color = ? WHERE id = ?').run(color, id);
  return result.changes > 0;
}

// ─── Usage event queries ──────────────────────────────────────────────────────

export type InsertUsageEvent = Omit<UsageEvent, 'id'>;

export function insertUsageEvent(db: Database.Database, event: InsertUsageEvent): number {
  const result = db
    .prepare(`
      INSERT INTO usage_events
        (ts, account_id, session_id, model, cost_usd, input_tokens, output_tokens, cache_read, cache_create, duration_ms)
      VALUES
        (@ts, @accountId, @sessionId, @model, @costUsd, @inputTokens, @outputTokens, @cacheRead, @cacheCreate, @durationMs)
    `)
    .run({
      ts: event.ts,
      accountId: event.accountId,
      sessionId: event.sessionId ?? null,
      model: event.model,
      costUsd: event.costUsd ?? null,
      inputTokens: event.inputTokens ?? null,
      outputTokens: event.outputTokens ?? null,
      cacheRead: event.cacheRead ?? null,
      cacheCreate: event.cacheCreate ?? null,
      durationMs: event.durationMs ?? null,
    });
  return Number(result.lastInsertRowid);
}

export function getUsageEvents(
  db: Database.Database,
  opts: { accountId?: string; sinceTs?: number; limit?: number },
): UsageEvent[] {
  let sql = 'SELECT * FROM usage_events WHERE 1=1';
  const params: Record<string, string | number> = {};

  if (opts.accountId !== undefined) {
    sql += ' AND account_id = @accountId';
    params['accountId'] = opts.accountId;
  }
  if (opts.sinceTs !== undefined) {
    sql += ' AND ts >= @sinceTs';
    params['sinceTs'] = opts.sinceTs;
  }
  sql += ' ORDER BY ts DESC';
  if (opts.limit !== undefined) {
    sql += ' LIMIT @limit';
    params['limit'] = opts.limit;
  }

  const rows = db.prepare(sql).all(params) as DbUsageRow[];
  return rows.map(rowToUsageEvent);
}

export function getTodayUsageSummary(
  db: Database.Database,
  accountId: string,
): { costUsd: number; tokens: number; sessionCount: number } {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const sinceTs = startOfDay.getTime();

  const row = db
    .prepare(`
      SELECT
        COALESCE(SUM(cost_usd), 0)      AS total_cost,
        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total_tokens,
        COUNT(DISTINCT session_id)       AS session_count
      FROM usage_events
      WHERE account_id = ? AND ts >= ?
    `)
    .get(accountId, sinceTs) as
    | { total_cost: number; total_tokens: number; session_count: number }
    | undefined;

  // SQLite aggregate always returns a row; ?. / ?? are defensive for type safety
  /* v8 ignore next 5 */
  return {
    costUsd: row?.total_cost ?? 0,
    tokens: row?.total_tokens ?? 0,
    sessionCount: row?.session_count ?? 0,
  };
}

/**
 * Return per-day, per-model cost and token totals for the last N days.
 * Shape: { "2026-04-15": { "claude-sonnet-4-6": { costUsd, tokens } } }
 */
export function getUsageByDayModel(
  db: Database.Database,
  accountId: string,
  days: number,
): Record<string, Record<string, { costUsd: number; tokens: number }>> {
  const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;

  const rows = db
    .prepare(
      `SELECT
         date(ts / 1000, 'unixepoch') AS day,
         model,
         COALESCE(SUM(cost_usd), 0)                                           AS cost_usd,
         COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0)    AS tokens
       FROM usage_events
       WHERE account_id = ? AND ts >= ?
       GROUP BY day, model
       ORDER BY day ASC`,
    )
    .all(accountId, sinceTs) as Array<{
    day: string;
    model: string;
    cost_usd: number;
    tokens: number;
  }>;

  const result: Record<string, Record<string, { costUsd: number; tokens: number }>> = {};
  for (const row of rows) {
    (result[row.day] ??= {})[row.model] = { costUsd: row.cost_usd, tokens: row.tokens };
  }
  return result;
}

// ─── Overage event queries ────────────────────────────────────────────────────

export type InsertOverageEvent = Omit<OverageEvent, 'id'>;

/**
 * Persist an overage transition. Uses `INSERT OR IGNORE` against the unique
 * index on (account_id, resets_at, transition), so a duplicate within the
 * same overage window silently drops. Returns the new row id, or `null` when
 * the insert was skipped — callers use the null to suppress a redundant
 * broadcast / notification.
 */
export function insertOverageEvent(db: Database.Database, event: InsertOverageEvent): number | null {
  const result = db
    .prepare(`
      INSERT OR IGNORE INTO overage_events (ts, account_id, transition, status, resets_at, disabled_reason)
      VALUES (@ts, @accountId, @transition, @status, @resetsAt, @disabledReason)
    `)
    .run({
      ts: event.ts,
      accountId: event.accountId,
      transition: event.transition,
      /* v8 ignore next 3 */
      status: event.status ?? null,
      resetsAt: event.resetsAt ?? null,
      disabledReason: event.disabledReason ?? null,
    });
  if (result.changes === 0) return null;
  return Number(result.lastInsertRowid);
}

export function getOverageEvents(
  db: Database.Database,
  opts: { accountId?: string; limit?: number },
): OverageEvent[] {
  let sql = 'SELECT * FROM overage_events WHERE 1=1';
  const params: Record<string, string | number> = {};

  if (opts.accountId !== undefined) {
    sql += ' AND account_id = @accountId';
    params['accountId'] = opts.accountId;
  }
  sql += ' ORDER BY ts DESC';
  if (opts.limit !== undefined) {
    sql += ' LIMIT @limit';
    params['limit'] = opts.limit;
  }

  const rows = db.prepare(sql).all(params) as DbOverageRow[];
  return rows.map(rowToOverageEvent);
}

/**
 * Delete overage event rows. Scopes to a single account when `accountId` is
 * provided; otherwise wipes every row. Returns the deleted row count.
 */
export function clearOverageEvents(db: Database.Database, accountId?: string): number {
  const result =
    accountId !== undefined
      ? db.prepare('DELETE FROM overage_events WHERE account_id = ?').run(accountId)
      : db.prepare('DELETE FROM overage_events').run();
  return result.changes;
}

/**
 * Return the newest recorded overage event for each account. Used at daemon
 * startup to rehydrate the in-memory state machine so a restart inside an
 * active overage window doesn't re-fire an `entered` transition.
 */
export function getLastOverageEventPerAccount(db: Database.Database): OverageEvent[] {
  const rows = db
    .prepare(`
      SELECT e.* FROM overage_events e
      INNER JOIN (
        SELECT account_id, MAX(ts) AS max_ts
        FROM overage_events
        GROUP BY account_id
      ) m ON e.account_id = m.account_id AND e.ts = m.max_ts
    `)
    .all() as DbOverageRow[];
  return rows.map(rowToOverageEvent);
}

// ─── Notification queries ─────────────────────────────────────────────────────

export type InsertNotification = Omit<NotificationRecord, 'id' | 'acknowledged'>;

export function insertNotification(db: Database.Database, notif: InsertNotification): number {
  const result = db
    .prepare(`
      INSERT INTO notifications (ts, account_id, type, title, body)
      VALUES (@ts, @accountId, @type, @title, @body)
    `)
    .run({
      ts: notif.ts,
      accountId: notif.accountId ?? null,
      type: notif.type,
      title: notif.title,
      body: notif.body,
    });
  return Number(result.lastInsertRowid);
}

export function acknowledgeNotification(db: Database.Database, id: number): boolean {
  const result = db
    .prepare('UPDATE notifications SET acknowledged = 1 WHERE id = ?')
    .run(id);
  return result.changes > 0;
}

/**
 * Mark every unacknowledged notification as acknowledged.
 *
 * When `accountId` is supplied, only notifications scoped to that account —
 * plus unscoped/global rows (account_id IS NULL) — are affected. This matches
 * the UI model where the Alerts tab displays the active account's
 * notifications alongside global events and "Dismiss all" should clear
 * exactly what's on screen.
 *
 * Returns the number of rows modified so the caller can show a toast / count.
 */
export function acknowledgeAllNotifications(
  db: Database.Database,
  accountId?: string,
): number {
  const result = accountId !== undefined
    ? db
        .prepare('UPDATE notifications SET acknowledged = 1 WHERE acknowledged = 0 AND (account_id = ? OR account_id IS NULL)')
        .run(accountId)
    : db
        .prepare('UPDATE notifications SET acknowledged = 1 WHERE acknowledged = 0')
        .run();
  return result.changes;
}

export function listNotifications(
  db: Database.Database,
  opts: { unacknowledgedOnly?: boolean; limit?: number },
): NotificationRecord[] {
  let sql = 'SELECT * FROM notifications WHERE 1=1';
  const params: Record<string, number> = {};

  if (opts.unacknowledgedOnly === true) {
    sql += ' AND acknowledged = 0';
  }
  sql += ' ORDER BY ts DESC';
  if (opts.limit !== undefined) {
    sql += ' LIMIT @limit';
    params['limit'] = opts.limit;
  }

  const rows = db.prepare(sql).all(params) as DbNotificationRow[];
  return rows.map(rowToNotification);
}

// ─── Security event queries ──────────────────────────────────────────────────

export type InsertSecurityEvent = Omit<
  SecurityEvent,
  'id' | 'occurrences' | 'acknowledged' | 'lastSeenTs' | 'approved'
> & {
  /** Optional on insert — defaults to false. Set true when the user has
   *  explicitly approved a pending block via the in-app banner; mirrored
   *  into the security_allowlist in that case. */
  approved?: boolean;
};

/** Dedup window in ms. Identical findings seen within this window bump
 *  `occurrences` + `last_seen_ts` instead of creating a new row. */
export const SECURITY_DEDUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Insert a security event, deduping against rows with the same match_hash +
 * detector_id + account_id within the last hour. When an active dedup row is
 * found, increments `occurrences` and bumps `last_seen_ts` instead. Returns
 * the row id (new or existing) plus a boolean flag indicating whether a new
 * row was created (so callers can decide whether to fire a fresh broadcast
 * and native notification).
 */
export function insertSecurityEvent(
  db: Database.Database,
  event: InsertSecurityEvent,
): { id: number; isNew: boolean } {
  const dedupCutoff = event.ts - SECURITY_DEDUP_WINDOW_MS;
  const existing = db
    .prepare(
      `SELECT id, occurrences FROM security_events
       WHERE match_hash = @matchHash
         AND detector_id = @detectorId
         AND account_id = @accountId
         AND last_seen_ts > @cutoff
       ORDER BY last_seen_ts DESC
       LIMIT 1`,
    )
    .get({
      matchHash: event.matchHash,
      detectorId: event.detectorId,
      accountId: event.accountId,
      cutoff: dedupCutoff,
    }) as { id: number; occurrences: number } | undefined;

  if (existing) {
    // Propagate the block + approved flags on dedup. A repeat hit that
    // escalates an observe row to a block row (or approves one) needs to
    // flip the flag; silently bumping only occurrences loses that signal
    // (v1.1 regression identified in testing).
    db.prepare(
      `UPDATE security_events
       SET occurrences = occurrences + 1,
           last_seen_ts = @lastSeenTs,
           blocked  = CASE WHEN @blocked  = 1 THEN 1 ELSE blocked  END,
           approved = CASE WHEN @approved = 1 THEN 1 ELSE approved END
       WHERE id = @id`,
    ).run({
      lastSeenTs: event.ts,
      blocked: event.blocked ? 1 : 0,
      approved: event.approved ? 1 : 0,
      id: existing.id,
    });
    return { id: existing.id, isNew: false };
  }

  const result = db
    .prepare(
      `INSERT INTO security_events (
         ts, last_seen_ts, account_id, session_id, direction,
         severity, kind, detector_id, confidence, title, reason,
         match_mask, match_hash, context_hash, snippet, source_hint,
         details_json, blocked, approved, provenance
       ) VALUES (
         @ts, @ts, @accountId, @sessionId, @direction,
         @severity, @kind, @detectorId, @confidence, @title, @reason,
         @matchMask, @matchHash, @contextHash, @snippet, @sourceHint,
         @detailsJson, @blocked, @approved, @provenance
       )`,
    )
    .run({
      ts: event.ts,
      accountId: event.accountId,
      sessionId: event.sessionId ?? null,
      direction: event.direction,
      severity: event.severity,
      kind: event.kind,
      detectorId: event.detectorId,
      confidence: event.confidence,
      title: event.title,
      reason: event.reason,
      matchMask: event.matchMask ?? null,
      matchHash: event.matchHash,
      contextHash: event.contextHash ?? null,
      snippet: event.snippet ?? null,
      sourceHint: event.sourceHint ?? null,
      detailsJson: event.details ? JSON.stringify(event.details) : null,
      blocked: event.blocked ? 1 : 0,
      approved: event.approved ? 1 : 0,
      // Provenance is immutable after first insert — the dedup UPDATE
      // above does not touch it, so the first observation's origin
      // category stays authoritative.
      provenance: event.provenance,
    });

  return { id: Number(result.lastInsertRowid), isNew: true };
}

export function listSecurityEvents(
  db: Database.Database,
  opts: {
    accountId?: string;
    limit?: number;
    minConfidence?: number;
  } = {},
): SecurityEvent[] {
  let sql = 'SELECT * FROM security_events WHERE 1=1';
  const params: Record<string, string | number> = {};

  if (opts.accountId !== undefined) {
    sql += ' AND account_id = @accountId';
    params['accountId'] = opts.accountId;
  }
  if (opts.minConfidence !== undefined) {
    sql += ' AND confidence >= @minConfidence';
    params['minConfidence'] = opts.minConfidence;
  }

  sql += ' ORDER BY ts DESC';
  if (opts.limit !== undefined) {
    sql += ' LIMIT @limit';
    params['limit'] = opts.limit;
  }

  const rows = db.prepare(sql).all(params) as DbSecurityEventRow[];
  return rows.map(rowToSecurityEvent);
}

export function acknowledgeSecurityEvent(db: Database.Database, id: number): boolean {
  const result = db
    .prepare('UPDATE security_events SET acknowledged = 1 WHERE id = ?')
    .run(id);
  return result.changes > 0;
}

export function acknowledgeAllSecurityEvents(
  db: Database.Database,
  accountId?: string,
): number {
  const result = accountId !== undefined
    ? db
        .prepare('UPDATE security_events SET acknowledged = 1 WHERE acknowledged = 0 AND account_id = ?')
        .run(accountId)
    : db
        .prepare('UPDATE security_events SET acknowledged = 1 WHERE acknowledged = 0')
        .run();
  return result.changes;
}

export function clearSecurityEvents(db: Database.Database, accountId?: string): number {
  const result = accountId !== undefined
    ? db.prepare('DELETE FROM security_events WHERE account_id = ?').run(accountId)
    : db.prepare('DELETE FROM security_events').run();
  return result.changes;
}

/** Delete OTEL-derived telemetry rows older than the retention window.
 *  Covers usage_events, tool_events, api_errors, and activity_events —
 *  the four tables that grow linearly with Claude Code activity.
 *  Intended to run at daemon startup AND every 24h. Returns the total
 *  number of rows removed across all tables. */
export function purgeTelemetryOlderThan(
  db: Database.Database,
  cutoffMs: number,
): number {
  let total = 0;
  for (const table of ['usage_events', 'tool_events', 'api_errors', 'activity_events'] as const) {
    const result = db.prepare(`DELETE FROM ${table} WHERE ts < ?`).run(cutoffMs);
    total += Number(result.changes);
  }
  return total;
}

/** Delete rows older than the retention window. Intended to run at daemon
 *  startup. Returns the number of rows removed. */
export function purgeSecurityEventsOlderThan(
  db: Database.Database,
  cutoffMs: number,
): number {
  const result = db.prepare('DELETE FROM security_events WHERE ts < ?').run(cutoffMs);
  return result.changes;
}

/** Unread security event count, optionally scoped to an account. Drives the
 *  Security tab badge. */
export function countUnacknowledgedSecurityEvents(
  db: Database.Database,
  accountId?: string,
): number {
  const row = accountId !== undefined
    ? db
        .prepare('SELECT COUNT(*) AS n FROM security_events WHERE acknowledged = 0 AND account_id = ?')
        .get(accountId) as { n: number }
    : db
        .prepare('SELECT COUNT(*) AS n FROM security_events WHERE acknowledged = 0')
        .get() as { n: number };
  return row.n;
}

// ─── Security allowlist queries ──────────────────────────────────────────────

/**
 * True when a (match_hash, detector_id) pair is on the user's allowlist.
 * Called on every finding before persistence so suppressed matches never
 * create events, fire broadcasts, or block outbound requests.
 */
export function isSecurityAllowlisted(
  db: Database.Database,
  matchHash: string,
  detectorId: string,
): boolean {
  const row = db
    .prepare('SELECT 1 FROM security_allowlist WHERE match_hash = ? AND detector_id = ? LIMIT 1')
    .get(matchHash, detectorId);
  return row !== undefined;
}

export interface AddSecurityAllowlistArgs {
  matchHash: string;
  detectorId: string;
  matchMask?: string | null;
  title?: string | null;
  note?: string | null;
}

/**
 * Add a (match_hash, detector_id) pair to the allowlist. Idempotent —
 * duplicates are silently ignored. Also retroactively deletes any existing
 * security_events rows and mirrored notifications for that same match so
 * the badges clear and the Security tab stops showing them.
 *
 * Returns the allowlist row id plus counts of events/notifications removed
 * so callers can surface a confirmation toast if desired.
 */
export function addSecurityAllowlist(
  db: Database.Database,
  args: AddSecurityAllowlistArgs,
): { id: number; deletedEvents: number; deletedNotifications: number } {
  const now = Date.now();
  // ON CONFLICT DO NOTHING — lastInsertRowid reflects the row if inserted,
  // but we want to return the id of the matched/existing row either way.
  db.prepare(
    `INSERT INTO security_allowlist (match_hash, detector_id, match_mask, title, note, created_at)
     VALUES (@matchHash, @detectorId, @matchMask, @title, @note, @createdAt)
     ON CONFLICT(match_hash, detector_id) DO NOTHING`,
  ).run({
    matchHash: args.matchHash,
    detectorId: args.detectorId,
    matchMask: args.matchMask ?? null,
    title: args.title ?? null,
    note: args.note ?? null,
    createdAt: now,
  });
  const row = db
    .prepare('SELECT id FROM security_allowlist WHERE match_hash = ? AND detector_id = ?')
    .get(args.matchHash, args.detectorId) as { id: number };

  // Retroactively clear the noise. Collect notification titles matching the
  // allowlisted events first so we can scrub them from the notifications
  // table — the scanner mirrors each new finding into a notification with a
  // predictable title prefix, but the simplest join is via the shared
  // ts + account_id tuple.
  const victims = db
    .prepare(
      `SELECT ts, account_id, title FROM security_events
       WHERE match_hash = ? AND detector_id = ?`,
    )
    .all(args.matchHash, args.detectorId) as Array<{
      ts: number;
      account_id: string;
      title: string;
    }>;

  let deletedNotifications = 0;
  const delNotif = db.prepare(
    `DELETE FROM notifications
     WHERE ts = ? AND account_id = ?
       AND type IN ('security_low', 'security_medium', 'security_high')
       AND (title LIKE 'Security: ' || ? OR title LIKE 'Blocked: ' || ?)`,
  );
  for (const v of victims) {
    const res = delNotif.run(v.ts, v.account_id, v.title, v.title);
    deletedNotifications += Number(res.changes);
  }

  const delEvents = db
    .prepare('DELETE FROM security_events WHERE match_hash = ? AND detector_id = ?')
    .run(args.matchHash, args.detectorId);

  return {
    id: row.id,
    deletedEvents: Number(delEvents.changes),
    deletedNotifications,
  };
}

export function removeSecurityAllowlist(db: Database.Database, id: number): boolean {
  const res = db.prepare('DELETE FROM security_allowlist WHERE id = ?').run(id);
  return res.changes > 0;
}

export function listSecurityAllowlist(db: Database.Database): SecurityAllowlistEntry[] {
  const rows = db
    .prepare('SELECT * FROM security_allowlist ORDER BY created_at DESC')
    .all() as Array<{
      id: number;
      match_hash: string;
      detector_id: string;
      match_mask: string | null;
      title: string | null;
      note: string | null;
      created_at: number;
    }>;
  return rows.map((r) => ({
    id: r.id,
    matchHash: r.match_hash,
    detectorId: r.detector_id,
    matchMask: r.match_mask,
    title: r.title,
    note: r.note,
    createdAt: r.created_at,
  }));
}

// ─── Rate limit queries ───────────────────────────────────────────────────────

/**
 * Upsert a single rate-limit window for an account.
 * Called after each API response that includes anthropic-ratelimit-* headers.
 */
export function upsertRateLimit(db: Database.Database, accountId: string, window: RateLimitWindow): void {
  db.prepare(`
    INSERT INTO rate_limits (account_id, name, status, utilization, lim, remaining, reset_ts, in_use, last_updated)
    VALUES (@accountId, @name, @status, @utilization, @lim, @remaining, @resetTs, @inUse, @lastUpdated)
    ON CONFLICT(account_id, name) DO UPDATE SET
      status       = excluded.status,
      utilization  = excluded.utilization,
      lim          = excluded.lim,
      remaining    = excluded.remaining,
      reset_ts     = excluded.reset_ts,
      in_use       = excluded.in_use,
      last_updated = excluded.last_updated
  `).run({
    accountId,
    name: window.name,
    status: window.status ?? null,
    utilization: window.utilization ?? null,
    lim: window.limit ?? null,
    remaining: window.remaining ?? null,
    resetTs: window.reset ?? null,
    inUse: window.inUse == null ? null : window.inUse ? 1 : 0,
    lastUpdated: window.lastUpdated,
  });
}

interface DbRateLimitRow {
  account_id: string;
  name: string;
  status: string | null;
  utilization: number | null;
  lim: number | null;
  remaining: number | null;
  reset_ts: number | null;
  in_use: number | null;
  last_updated: number;
}

/**
 * Remove every persisted rate-limit row for an account. Called on switch so
 * a later daemon restart doesn't resurrect the stale values that the probe
 * just replaced.
 */
export function deleteRateLimitsForAccount(db: Database.Database, accountId: string): number {
  const result = db.prepare('DELETE FROM rate_limits WHERE account_id = ?').run(accountId);
  return result.changes;
}

/**
 * Load all persisted rate-limit windows, grouped by accountId.
 * Used at daemon startup to pre-populate the in-memory store.
 */
export function loadRateLimits(db: Database.Database): Map<string, RateLimitWindow[]> {
  const rows = db.prepare('SELECT * FROM rate_limits ORDER BY account_id, name').all() as DbRateLimitRow[];
  const result = new Map<string, RateLimitWindow[]>();
  for (const row of rows) {
    if (!result.has(row.account_id)) result.set(row.account_id, []);
    result.get(row.account_id)!.push({
      name: row.name,
      status: row.status,
      utilization: row.utilization,
      limit: row.lim,
      remaining: row.remaining,
      reset: row.reset_ts,
      inUse: row.in_use == null ? null : row.in_use === 1,
      lastUpdated: row.last_updated,
    });
  }
  return result;
}

// ─── Alert queries ────────────────────────────────────────────────────────────

interface DbAlertRow {
  id: number;
  scope: string;
  account_id: string;
  threshold_pct: number;
  enabled: number;
  last_triggered_reset_ts: number | null;
  created_at: number;
  budget_scope: string | null;
}

function rowToAlert(row: DbAlertRow): Alert {
  const scope: 'account' | 'pool' | 'budget' =
    row.scope === 'pool' ? 'pool' : row.scope === 'budget' ? 'budget' : 'account';
  // Budget-scope rows may be global (account_id = '') or per-account.
  const hasAccountId =
    scope === 'account' || (scope === 'budget' && row.budget_scope !== 'global');
  const alert: Alert = {
    id: row.id,
    scope,
    // Pool rows — and budget-global rows — are stored with account_id = ''
    // to satisfy the legacy NOT NULL column; normalize back to null.
    accountId: hasAccountId ? row.account_id || null : null,
    thresholdPct: row.threshold_pct,
    enabled: row.enabled === 1,
    lastTriggeredResetTs: row.last_triggered_reset_ts,
    createdAt: row.created_at,
  };
  if (scope === 'budget') {
    alert.budgetScope = row.budget_scope === 'global' ? 'global' : 'account';
  }
  return alert;
}

export function listAlerts(
  db: Database.Database,
  opts: { scope?: 'account' | 'pool' | 'budget'; accountId?: string } = {},
): Alert[] {
  const { scope, accountId } = opts;
  // accountId filter implies account scope; honour scope when explicitly set.
  let sql: string;
  let params: unknown[];
  if (scope === 'pool') {
    sql = "SELECT * FROM alerts WHERE scope = 'pool' ORDER BY threshold_pct ASC";
    params = [];
  } else if (scope === 'budget' && accountId) {
    sql = "SELECT * FROM alerts WHERE scope = 'budget' AND account_id = ? ORDER BY threshold_pct ASC";
    params = [accountId];
  } else if (scope === 'budget') {
    sql = "SELECT * FROM alerts WHERE scope = 'budget' ORDER BY budget_scope, account_id, threshold_pct ASC";
    params = [];
  } else if (scope === 'account' && accountId) {
    sql = "SELECT * FROM alerts WHERE scope = 'account' AND account_id = ? ORDER BY threshold_pct ASC";
    params = [accountId];
  } else if (scope === 'account') {
    sql = "SELECT * FROM alerts WHERE scope = 'account' ORDER BY account_id, threshold_pct ASC";
    params = [];
  } else if (accountId) {
    sql = 'SELECT * FROM alerts WHERE account_id = ? ORDER BY threshold_pct ASC';
    params = [accountId];
  } else {
    sql = 'SELECT * FROM alerts ORDER BY scope, account_id, threshold_pct ASC';
    params = [];
  }
  const rows = db.prepare(sql).all(...params) as DbAlertRow[];
  return rows.map(rowToAlert);
}

export function upsertAlert(
  db: Database.Database,
  input: {
    id?: number;
    scope?: 'account' | 'pool' | 'budget';
    accountId: string | null;
    thresholdPct: number;
    enabled: boolean;
    budgetScope?: 'account' | 'global';
  },
): Alert {
  const scope = input.scope ?? 'account';
  if (scope === 'pool' && input.accountId != null) {
    throw new Error("pool-scoped alerts must have accountId = null");
  }
  if (scope === 'account' && !input.accountId) {
    throw new Error("account-scoped alerts require a non-empty accountId");
  }
  const budgetScope: 'account' | 'global' | null =
    scope === 'budget' ? (input.budgetScope ?? 'account') : null;
  if (scope === 'budget' && budgetScope === 'account' && !input.accountId) {
    throw new Error("budget-scoped account alerts require a non-empty accountId");
  }
  if (scope === 'budget' && budgetScope === 'global' && input.accountId != null) {
    throw new Error("budget-scoped global alerts must have accountId = null");
  }
  // Pool rows and budget-global rows store '' for the legacy NOT NULL column;
  // normalized back to null by rowToAlert when reading.
  const dbAccountId =
    scope === 'pool' || (scope === 'budget' && budgetScope === 'global')
      ? ''
      : (input.accountId as string);

  if (input.id !== undefined) {
    db.prepare(`
      UPDATE alerts SET scope = ?, account_id = ?, threshold_pct = ?, enabled = ?, budget_scope = ? WHERE id = ?
    `).run(scope, dbAccountId, input.thresholdPct, input.enabled ? 1 : 0, budgetScope, input.id);
    const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(input.id) as DbAlertRow | undefined;
    /* v8 ignore next 1 */
    if (!row) throw new Error(`alert ${input.id} not found after update`);
    return rowToAlert(row);
  }
  const result = db.prepare(`
    INSERT INTO alerts (scope, account_id, threshold_pct, enabled, budget_scope, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(scope, dbAccountId, input.thresholdPct, input.enabled ? 1 : 0, budgetScope, Date.now());
  const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(Number(result.lastInsertRowid)) as DbAlertRow;
  return rowToAlert(row);
}

export function deleteAlert(db: Database.Database, id: number): boolean {
  const result = db.prepare('DELETE FROM alerts WHERE id = ?').run(id);
  return result.changes > 0;
}

export function markAlertTriggered(
  db: Database.Database,
  id: number,
  resetTs: number,
): void {
  db.prepare('UPDATE alerts SET last_triggered_reset_ts = ? WHERE id = ?').run(resetTs, id);
}

// ─── Row type helpers ─────────────────────────────────────────────────────────

interface DbAccountRow {
  id: string;
  account_uuid: string | null;
  email: string;
  display_name: string | null;
  org_uuid: string | null;
  org_name: string | null;
  plan_type: string | null;
  removed: number;
  color: string | null;
  created_at: number;
}

interface DbUsageRow {
  id: number;
  ts: number;
  account_id: string;
  session_id: string | null;
  model: string;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read: number | null;
  cache_create: number | null;
  duration_ms: number | null;
}

interface DbOverageRow {
  id: number;
  ts: number;
  account_id: string;
  transition: string;
  status: string | null;
  resets_at: number | null;
  disabled_reason: string | null;
}

interface DbNotificationRow {
  id: number;
  ts: number;
  account_id: string | null;
  type: string;
  title: string;
  body: string;
  acknowledged: number;
}

interface DbSecurityEventRow {
  id: number;
  ts: number;
  last_seen_ts: number;
  account_id: string;
  session_id: string | null;
  direction: string;
  severity: string;
  kind: string;
  detector_id: string;
  confidence: number;
  title: string;
  reason: string;
  match_mask: string | null;
  match_hash: string;
  context_hash: string | null;
  snippet: string | null;
  source_hint: string | null;
  details_json: string | null;
  occurrences: number;
  blocked: number;
  approved: number;
  acknowledged: number;
  provenance: string;
}

function rowToAccount(row: DbAccountRow): AccountInfo {
  // Nullable columns default to empty strings; ?? branches are type-safety guards
  // account_uuid falls back to id for rows created before the column was added
  /* v8 ignore next 8 */
  return {
    id: row.id,
    accountUuid: row.account_uuid ?? row.id,
    email: row.email,
    displayName: row.display_name ?? '',
    orgUuid: row.org_uuid ?? '',
    orgName: row.org_name ?? '',
    planType: (row.plan_type as PlanType) ?? 'pro',
    isActive: false, // resolved at call site
    createdAt: row.created_at,
    color: row.color ?? null,
  };
}

function rowToUsageEvent(row: DbUsageRow): UsageEvent {
  return {
    id: row.id,
    ts: row.ts,
    accountId: row.account_id,
    sessionId: row.session_id,
    model: row.model,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheRead: row.cache_read,
    cacheCreate: row.cache_create,
    durationMs: row.duration_ms,
  };
}

function rowToOverageEvent(row: DbOverageRow): OverageEvent {
  return {
    id: row.id,
    ts: row.ts,
    accountId: row.account_id,
    transition: row.transition as OverageTransition,
    status: row.status,
    resetsAt: row.resets_at,
    disabledReason: row.disabled_reason,
  };
}

function rowToNotification(row: DbNotificationRow): NotificationRecord {
  return {
    id: row.id,
    ts: row.ts,
    accountId: row.account_id,
    type: row.type as NotificationType,
    title: row.title,
    body: row.body,
    acknowledged: row.acknowledged === 1,
  };
}

function rowToSecurityEvent(row: DbSecurityEventRow): SecurityEvent {
  let details: Record<string, unknown> | null = null;
  if (row.details_json) {
    try {
      details = JSON.parse(row.details_json) as Record<string, unknown>;
    } catch {
      details = null;
    }
  }
  return {
    id: row.id,
    ts: row.ts,
    lastSeenTs: row.last_seen_ts,
    accountId: row.account_id,
    sessionId: row.session_id,
    direction: row.direction as SecurityEvent['direction'],
    severity: row.severity as SecuritySeverity,
    kind: row.kind as SecurityKind,
    detectorId: row.detector_id,
    confidence: row.confidence,
    title: row.title,
    reason: row.reason,
    matchMask: row.match_mask,
    matchHash: row.match_hash,
    contextHash: row.context_hash,
    snippet: row.snippet,
    sourceHint: row.source_hint,
    details,
    occurrences: row.occurrences,
    blocked: row.blocked === 1,
    approved: row.approved === 1,
    acknowledged: row.acknowledged === 1,
    provenance: row.provenance as SecurityEvent['provenance'],
  };
}

// ─── Tool / API error / activity event inserts ────────────────────────────────

export interface InsertToolEvent {
  ts: number;
  accountId: string;
  sessionId: string | null;
  toolName: string;
  success: boolean;
  durationMs: number | null;
  error: string | null;
  decisionSource: string | null;
  /** accept | reject — from the tool_result event's decision_type attribute. */
  decisionType: string | null;
  mcpServerScope: string | null;
  toolResultSizeBytes: number | null;
}

export function insertToolEvent(db: Database.Database, e: InsertToolEvent): number {
  const result = db.prepare(`
    INSERT INTO tool_events (ts, account_id, session_id, tool_name, success, duration_ms, error, decision_source, decision_type, mcp_server_scope, tool_result_size_bytes)
    VALUES (@ts, @accountId, @sessionId, @toolName, @success, @durationMs, @error, @decisionSource, @decisionType, @mcpServerScope, @toolResultSizeBytes)
  `).run({
    ts: e.ts,
    accountId: e.accountId,
    sessionId: e.sessionId,
    toolName: e.toolName,
    success: e.success ? 1 : 0,
    durationMs: e.durationMs,
    error: e.error,
    decisionSource: e.decisionSource,
    decisionType: e.decisionType,
    mcpServerScope: e.mcpServerScope,
    toolResultSizeBytes: e.toolResultSizeBytes,
  });
  return Number(result.lastInsertRowid);
}

export interface InsertApiError {
  ts: number;
  accountId: string;
  sessionId: string | null;
  model: string | null;
  statusCode: string | null;
  error: string | null;
  durationMs: number | null;
  attempt: number | null;
  requestId: string | null;
  speed: string | null;
}

export function insertApiError(db: Database.Database, e: InsertApiError): number {
  const result = db.prepare(`
    INSERT INTO api_errors (ts, account_id, session_id, model, status_code, error, duration_ms, attempt, request_id, speed)
    VALUES (@ts, @accountId, @sessionId, @model, @statusCode, @error, @durationMs, @attempt, @requestId, @speed)
  `).run(e as unknown as Record<string, unknown>);
  return Number(result.lastInsertRowid);
}

/** Kind values the receiver emits into activity_events. */
export type ActivityKind =
  | 'session'
  | 'commit'
  | 'pull_request'
  | 'lines_added'
  | 'lines_removed'
  | 'active_user_seconds'
  | 'active_cli_seconds'
  | 'edit_decision'
  | 'tool_decision'
  | 'user_prompt'
  | 'skill_activated'
  | 'plugin_installed';

export interface InsertActivityEvent {
  ts: number;
  accountId: string;
  sessionId: string | null;
  kind: ActivityKind;
  value: number | null;
  model?: string | null;
  toolName?: string | null;
  language?: string | null;
  decision?: string | null;
  source?: string | null;
  name?: string | null;
  version?: string | null;
  marketplace?: string | null;
  extraJson?: string | null;
}

export function insertActivityEvent(db: Database.Database, e: InsertActivityEvent): number {
  const result = db.prepare(`
    INSERT INTO activity_events (ts, account_id, session_id, kind, value, model, tool_name, language, decision, source, name, version, marketplace, extra_json)
    VALUES (@ts, @accountId, @sessionId, @kind, @value, @model, @toolName, @language, @decision, @source, @name, @version, @marketplace, @extraJson)
  `).run({
    ts: e.ts,
    accountId: e.accountId,
    sessionId: e.sessionId,
    kind: e.kind,
    value: e.value,
    model: e.model ?? null,
    toolName: e.toolName ?? null,
    language: e.language ?? null,
    decision: e.decision ?? null,
    source: e.source ?? null,
    name: e.name ?? null,
    version: e.version ?? null,
    marketplace: e.marketplace ?? null,
    extraJson: e.extraJson ?? null,
  });
  return Number(result.lastInsertRowid);
}

// ─── Metrics tab query helpers ────────────────────────────────────────────────

/**
 * Per-day, per-model rollup with the full token breakdown (input / output /
 * cacheRead / cacheCreation) plus cost. Drives the Tokens and Cost charts on
 * the Metrics tab.
 */
export function getTokensByDayModel(
  db: Database.Database,
  accountId: string,
  days: number,
): Record<string, Record<string, MetricsByDayModel>> {
  const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db.prepare(
    `SELECT
       date(ts / 1000, 'unixepoch')          AS day,
       model,
       COALESCE(SUM(cost_usd), 0)            AS cost_usd,
       COALESCE(SUM(input_tokens), 0)        AS input_tokens,
       COALESCE(SUM(output_tokens), 0)       AS output_tokens,
       COALESCE(SUM(cache_read), 0)          AS cache_read,
       COALESCE(SUM(cache_create), 0)        AS cache_create
     FROM usage_events
     WHERE account_id = ? AND ts >= ?
     GROUP BY day, model
     ORDER BY day ASC`,
  ).all(accountId, sinceTs) as Array<{
    day: string;
    model: string;
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read: number;
    cache_create: number;
  }>;

  const result: Record<string, Record<string, MetricsByDayModel>> = {};
  for (const r of rows) {
    (result[r.day] ??= {})[r.model] = {
      costUsd: r.cost_usd,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read,
      cacheCreationTokens: r.cache_create,
    };
  }
  return result;
}

/**
 * Cache-hit rate per model over the period. Rate = cacheRead / (input + cacheRead);
 * cache creation tokens are excluded from the denominator since they represent
 * the "first write" of cacheable content rather than a read.
 */
export function getCacheHitRate(
  db: Database.Database,
  accountId: string,
  days: number,
): Record<string, CacheHitRate> {
  const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db.prepare(
    `SELECT
       model,
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(cache_read), 0)   AS cache_read
     FROM usage_events
     WHERE account_id = ? AND ts >= ?
     GROUP BY model`,
  ).all(accountId, sinceTs) as Array<{ model: string; input_tokens: number; cache_read: number }>;

  const result: Record<string, CacheHitRate> = {};
  for (const r of rows) {
    const denom = r.input_tokens + r.cache_read;
    result[r.model] = {
      input: r.input_tokens,
      cacheRead: r.cache_read,
      rate: denom > 0 ? r.cache_read / denom : 0,
    };
  }
  return result;
}

/** Per-day counts of api_errors grouped by status code + retry-exhausted tally. */
export function getApiErrorsByDay(
  db: Database.Database,
  accountId: string,
  days: number,
): { byDay: Record<string, Record<string, number>>; retryExhaustedCount: number } {
  const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db.prepare(
    `SELECT
       date(ts / 1000, 'unixepoch') AS day,
       COALESCE(status_code, 'unknown') AS status_code,
       COUNT(*)                    AS n
     FROM api_errors
     WHERE account_id = ? AND ts >= ?
     GROUP BY day, status_code
     ORDER BY day ASC`,
  ).all(accountId, sinceTs) as Array<{ day: string; status_code: string; n: number }>;

  const byDay: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    (byDay[r.day] ??= {})[r.status_code] = r.n;
  }

  // Claude Code's CLAUDE_CODE_MAX_RETRIES default is 10; attempt > 10 means
  // retries were exhausted. Uses > so we match what the docs describe.
  const exhaustedRow = db.prepare(
    `SELECT COUNT(*) AS n FROM api_errors WHERE account_id = ? AND ts >= ? AND attempt > 10`,
  ).get(accountId, sinceTs) as { n: number };

  return { byDay, retryExhaustedCount: exhaustedRow.n };
}

/**
 * Per-tool rollup: calls, p50/p95 duration, success rate, most common error.
 * Returns tools ordered by call count (highest first). `limit` caps results.
 */
export function getToolStats(
  db: Database.Database,
  accountId: string,
  days: number,
  limit = 20,
): ToolStat[] {
  const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;

  // First pass: per-tool totals + success counts
  const totals = db.prepare(
    `SELECT
       tool_name,
       COUNT(*) AS calls,
       SUM(success) AS successes
     FROM tool_events
     WHERE account_id = ? AND ts >= ?
     GROUP BY tool_name
     ORDER BY calls DESC
     LIMIT ?`,
  ).all(accountId, sinceTs, limit) as Array<{ tool_name: string; calls: number; successes: number }>;

  const result: ToolStat[] = [];
  for (const t of totals) {
    // Second pass: percentiles from the sorted duration list. SQLite lacks
    // a built-in percentile function, so we compute it in JS.
    const durations = db.prepare(
      `SELECT duration_ms FROM tool_events
       WHERE account_id = ? AND ts >= ? AND tool_name = ? AND duration_ms IS NOT NULL
       ORDER BY duration_ms ASC`,
    ).all(accountId, sinceTs, t.tool_name) as Array<{ duration_ms: number }>;

    const p50 = percentile(durations.map((r) => r.duration_ms), 0.5);
    const p95 = percentile(durations.map((r) => r.duration_ms), 0.95);

    // Top error — most common non-null error message for failures
    const topErrorRow = db.prepare(
      `SELECT error, COUNT(*) AS n FROM tool_events
       WHERE account_id = ? AND ts >= ? AND tool_name = ? AND success = 0 AND error IS NOT NULL
       GROUP BY error ORDER BY n DESC LIMIT 1`,
    ).get(accountId, sinceTs, t.tool_name) as { error: string; n: number } | undefined;

    result.push({
      toolName: t.tool_name,
      calls: t.calls,
      successRate: t.calls > 0 ? t.successes / t.calls : 0,
      p50Ms: p50,
      p95Ms: p95,
      topError: topErrorRow?.error ?? null,
    });
  }
  return result;
}

function percentile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return sortedValues[0]!;
  const idx = Math.min(sortedValues.length - 1, Math.floor(q * sortedValues.length));
  return sortedValues[idx]!;
}

/** Per-day totals for a set of activity kinds. */
export function getActivityCounters(
  db: Database.Database,
  accountId: string,
  days: number,
  kinds: ActivityKind[],
): Record<string, Record<ActivityKind, number>> {
  if (kinds.length === 0) return {};
  const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;
  const placeholders = kinds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT
       date(ts / 1000, 'unixepoch') AS day,
       kind,
       COALESCE(SUM(value), COUNT(*)) AS total
     FROM activity_events
     WHERE account_id = ? AND ts >= ? AND kind IN (${placeholders})
     GROUP BY day, kind
     ORDER BY day ASC`,
  ).all(accountId, sinceTs, ...kinds) as Array<{ day: string; kind: ActivityKind; total: number }>;

  const result: Record<string, Record<ActivityKind, number>> = {};
  for (const r of rows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result[r.day] ??= {} as any)[r.kind] = r.total;
  }
  return result;
}

/**
 * Edit-decision accept rate overall and broken down by programming language.
 * Only counts `kind = 'edit_decision'` rows (from code_edit_tool.decision metric).
 */
export function getEditAcceptRate(
  db: Database.Database,
  accountId: string,
  days: number,
): { overall: EditAcceptRate; byLanguage: Record<string, EditAcceptRate> } {
  const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db.prepare(
    `SELECT
       COALESCE(language, 'unknown') AS language,
       decision,
       COUNT(*)                       AS n
     FROM activity_events
     WHERE account_id = ? AND ts >= ? AND kind = 'edit_decision'
     GROUP BY language, decision`,
  ).all(accountId, sinceTs) as Array<{ language: string; decision: string | null; n: number }>;

  let overallAccepts = 0;
  let overallRejects = 0;
  const byLangAccum: Record<string, { accepts: number; rejects: number }> = {};
  for (const r of rows) {
    const bucket = (byLangAccum[r.language] ??= { accepts: 0, rejects: 0 });
    if (r.decision === 'accept') {
      bucket.accepts += r.n;
      overallAccepts += r.n;
    } else if (r.decision === 'reject') {
      bucket.rejects += r.n;
      overallRejects += r.n;
    }
  }
  const byLanguage: Record<string, EditAcceptRate> = {};
  for (const [lang, b] of Object.entries(byLangAccum)) {
    const total = b.accepts + b.rejects;
    byLanguage[lang] = { accepts: b.accepts, rejects: b.rejects, rate: total > 0 ? b.accepts / total : 0 };
  }
  const overallTotal = overallAccepts + overallRejects;
  return {
    overall: {
      accepts: overallAccepts,
      rejects: overallRejects,
      rate: overallTotal > 0 ? overallAccepts / overallTotal : 0,
    },
    byLanguage,
  };
}

/**
 * Accept/reject breakdown from `tool_decision` OTEL events over the window.
 * Covers ALL tools that hit a permission prompt (Bash, Read, WebFetch, MCP,
 * etc.) — distinct from getEditAcceptRate which is the Edit/Write/NotebookEdit
 * metric only.
 */
export function getToolDecisionBreakdown(
  db: Database.Database,
  accountId: string,
  days: number,
): ToolDecisionBreakdown {
  const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db.prepare(
    `SELECT
       COALESCE(tool_name, 'unknown') AS tool_name,
       COALESCE(source, 'unknown')    AS source,
       decision,
       COUNT(*)                       AS n
     FROM activity_events
     WHERE account_id = ? AND ts >= ? AND kind = 'tool_decision'
     GROUP BY tool_name, source, decision`,
  ).all(accountId, sinceTs) as Array<{ tool_name: string; source: string; decision: string | null; n: number }>;

  let overallAccepts = 0;
  let overallRejects = 0;
  const byToolAccum: Record<string, { accepts: number; rejects: number }> = {};
  const bySourceAccum: Record<string, { accepts: number; rejects: number }> = {};
  for (const r of rows) {
    const toolBucket = (byToolAccum[r.tool_name] ??= { accepts: 0, rejects: 0 });
    const sourceBucket = (bySourceAccum[r.source] ??= { accepts: 0, rejects: 0 });
    if (r.decision === 'accept') {
      toolBucket.accepts += r.n;
      sourceBucket.accepts += r.n;
      overallAccepts += r.n;
    } else if (r.decision === 'reject') {
      toolBucket.rejects += r.n;
      sourceBucket.rejects += r.n;
      overallRejects += r.n;
    }
  }
  const toRate = (b: { accepts: number; rejects: number }): EditAcceptRate => {
    const total = b.accepts + b.rejects;
    return { accepts: b.accepts, rejects: b.rejects, rate: total > 0 ? b.accepts / total : 0 };
  };
  const byTool: Record<string, EditAcceptRate> = {};
  for (const [k, v] of Object.entries(byToolAccum)) byTool[k] = toRate(v);
  const bySource: Record<string, EditAcceptRate> = {};
  for (const [k, v] of Object.entries(bySourceAccum)) bySource[k] = toRate(v);
  const overallTotal = overallAccepts + overallRejects;
  return {
    overall: {
      accepts: overallAccepts,
      rejects: overallRejects,
      rate: overallTotal > 0 ? overallAccepts / overallTotal : 0,
    },
    byTool,
    bySource,
  };
}

/**
 * Per-day rollup of `user_prompt` OTEL events over the window. `value` on
 * the activity row carries prompt character length (or NULL when the event
 * arrived without `prompt_length`).
 */
export function getUserPromptStats(
  db: Database.Database,
  accountId: string,
  days: number,
): PromptStats {
  const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db.prepare(
    `SELECT
       strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day,
       COUNT(*)                                                  AS n,
       AVG(value)                                                AS avg_len
     FROM activity_events
     WHERE account_id = ? AND ts >= ? AND kind = 'user_prompt'
     GROUP BY day
     ORDER BY day`,
  ).all(accountId, sinceTs) as Array<{ day: string; n: number; avg_len: number | null }>;

  let total = 0;
  let weightedLenSum = 0;
  let weightedLenDenom = 0;
  const perDay: Record<string, { count: number; avgLength: number }> = {};
  for (const r of rows) {
    total += r.n;
    const avgLen = r.avg_len ?? 0;
    perDay[r.day] = { count: r.n, avgLength: avgLen };
    if (r.avg_len !== null) {
      weightedLenSum += avgLen * r.n;
      weightedLenDenom += r.n;
    }
  }
  return {
    total,
    avgLength: weightedLenDenom > 0 ? weightedLenSum / weightedLenDenom : 0,
    perDay,
  };
}

/** Top skills invoked over the period, ordered by invocation count. */
export function getTopSkills(
  db: Database.Database,
  accountId: string,
  days: number,
  limit = 10,
): SkillUsage[] {
  const sinceTs = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = db.prepare(
    `SELECT
       name,
       COUNT(*)                 AS n,
       MAX(source)              AS plugin
     FROM activity_events
     WHERE account_id = ? AND ts >= ? AND kind = 'skill_activated' AND name IS NOT NULL
     GROUP BY name
     ORDER BY n DESC
     LIMIT ?`,
  ).all(accountId, sinceTs, limit) as Array<{ name: string; n: number; plugin: string | null }>;
  return rows.map((r) => ({ name: r.name, count: r.n, plugin: r.plugin }));
}

/**
 * Recent plugin installs for this account. Order is install time descending.
 * Not windowed by `days` — plugin history is valuable even if old.
 */
export function getRecentPlugins(
  db: Database.Database,
  accountId: string,
  limit = 10,
): PluginInstall[] {
  const rows = db.prepare(
    `SELECT ts, name, version, marketplace
     FROM activity_events
     WHERE account_id = ? AND kind = 'plugin_installed' AND name IS NOT NULL
     ORDER BY ts DESC
     LIMIT ?`,
  ).all(accountId, limit) as Array<{ ts: number; name: string; version: string | null; marketplace: string | null }>;
  return rows.map((r) => ({ name: r.name, version: r.version, marketplace: r.marketplace, installedAt: r.ts }));
}
