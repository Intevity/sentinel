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
  SkillUsage,
  PluginInstall,
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

CREATE TABLE IF NOT EXISTS alerts (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
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
CREATE INDEX IF NOT EXISTS idx_notif_ts      ON notifications(ts);
CREATE INDEX IF NOT EXISTS idx_alerts_account ON alerts(account_id);
CREATE INDEX IF NOT EXISTS idx_tool_events_ts        ON tool_events(ts);
CREATE INDEX IF NOT EXISTS idx_tool_events_account   ON tool_events(account_id);
CREATE INDEX IF NOT EXISTS idx_tool_events_tool      ON tool_events(tool_name);
CREATE INDEX IF NOT EXISTS idx_api_errors_ts         ON api_errors(ts);
CREATE INDEX IF NOT EXISTS idx_api_errors_account    ON api_errors(account_id);
CREATE INDEX IF NOT EXISTS idx_activity_ts           ON activity_events(ts);
CREATE INDEX IF NOT EXISTS idx_activity_account_kind ON activity_events(account_id, kind);
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

  // Migrate rate_limits for pre-in_use databases.
  const rlCols = _db.pragma('table_info(rate_limits)') as Array<{ name: string }>;
  if (!rlCols.some((c) => c.name === 'in_use')) {
    _db.exec('ALTER TABLE rate_limits ADD COLUMN in_use INTEGER');
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
  db.prepare('DELETE FROM usage_events   WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM rate_limits    WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM overage_events WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM notifications  WHERE account_id = ?').run(id);
  db.prepare('DELETE FROM alerts         WHERE account_id = ?').run(id);
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

export function insertOverageEvent(db: Database.Database, event: InsertOverageEvent): number {
  const result = db
    .prepare(`
      INSERT INTO overage_events (ts, account_id, transition, status, resets_at, disabled_reason)
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
  account_id: string;
  threshold_pct: number;
  enabled: number;
  last_triggered_reset_ts: number | null;
  created_at: number;
}

function rowToAlert(row: DbAlertRow): Alert {
  return {
    id: row.id,
    accountId: row.account_id,
    thresholdPct: row.threshold_pct,
    enabled: row.enabled === 1,
    lastTriggeredResetTs: row.last_triggered_reset_ts,
    createdAt: row.created_at,
  };
}

export function listAlerts(db: Database.Database, accountId?: string): Alert[] {
  const sql = accountId
    ? 'SELECT * FROM alerts WHERE account_id = ? ORDER BY threshold_pct ASC'
    : 'SELECT * FROM alerts ORDER BY account_id, threshold_pct ASC';
  const rows = (accountId
    ? db.prepare(sql).all(accountId)
    : db.prepare(sql).all()
  ) as DbAlertRow[];
  return rows.map(rowToAlert);
}

export function upsertAlert(
  db: Database.Database,
  input: { id?: number; accountId: string; thresholdPct: number; enabled: boolean },
): Alert {
  if (input.id !== undefined) {
    db.prepare(`
      UPDATE alerts SET account_id = ?, threshold_pct = ?, enabled = ? WHERE id = ?
    `).run(input.accountId, input.thresholdPct, input.enabled ? 1 : 0, input.id);
    const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(input.id) as DbAlertRow | undefined;
    /* v8 ignore next 1 */
    if (!row) throw new Error(`alert ${input.id} not found after update`);
    return rowToAlert(row);
  }
  const result = db.prepare(`
    INSERT INTO alerts (account_id, threshold_pct, enabled, created_at)
    VALUES (?, ?, ?, ?)
  `).run(input.accountId, input.thresholdPct, input.enabled ? 1 : 0, Date.now());
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
  mcpServerScope: string | null;
  toolResultSizeBytes: number | null;
}

export function insertToolEvent(db: Database.Database, e: InsertToolEvent): number {
  const result = db.prepare(`
    INSERT INTO tool_events (ts, account_id, session_id, tool_name, success, duration_ms, error, decision_source, mcp_server_scope, tool_result_size_bytes)
    VALUES (@ts, @accountId, @sessionId, @toolName, @success, @durationMs, @error, @decisionSource, @mcpServerScope, @toolResultSizeBytes)
  `).run({
    ts: e.ts,
    accountId: e.accountId,
    sessionId: e.sessionId,
    toolName: e.toolName,
    success: e.success ? 1 : 0,
    durationMs: e.durationMs,
    error: e.error,
    decisionSource: e.decisionSource,
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
