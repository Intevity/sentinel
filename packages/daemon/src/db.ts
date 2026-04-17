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

CREATE INDEX IF NOT EXISTS idx_usage_ts      ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_usage_account ON usage_events(account_id);
CREATE INDEX IF NOT EXISTS idx_overage_account ON overage_events(account_id);
CREATE INDEX IF NOT EXISTS idx_notif_ts      ON notifications(ts);
CREATE INDEX IF NOT EXISTS idx_alerts_account ON alerts(account_id);
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
    INSERT INTO rate_limits (account_id, name, status, utilization, lim, remaining, reset_ts, last_updated)
    VALUES (@accountId, @name, @status, @utilization, @lim, @remaining, @resetTs, @lastUpdated)
    ON CONFLICT(account_id, name) DO UPDATE SET
      status       = excluded.status,
      utilization  = excluded.utilization,
      lim          = excluded.lim,
      remaining    = excluded.remaining,
      reset_ts     = excluded.reset_ts,
      last_updated = excluded.last_updated
  `).run({
    accountId,
    name: window.name,
    status: window.status ?? null,
    utilization: window.utilization ?? null,
    lim: window.limit ?? null,
    remaining: window.remaining ?? null,
    resetTs: window.reset ?? null,
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
