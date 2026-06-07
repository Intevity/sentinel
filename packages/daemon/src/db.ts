import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { getDigestTokens } from '@claude-sentinel/shared';
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
  AlertScope,
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
  PermissionRule,
  PermissionRuleInput,
  OptimizationMetrics,
  OptimizationMetricsBySubagent,
  MetricsWindow,
  ProcessedTokens,
} from '@claude-sentinel/shared';

export const SENTINEL_DIR = join(homedir(), '.claude-sentinel');
export const DB_PATH = join(SENTINEL_DIR, 'sentinel.db');

/** Sprint 8 chain-write gate. Flipped to true by `withChainBridge`
 *  while a sweep-time DELETE / chain-column UPDATE is in progress.
 *  Read by the `is_sweep_active()` SQLite UDF that the append-only
 *  triggers consult before deciding whether to RAISE(ABORT). Module
 *  scope: the daemon's single connection sees a consistent value;
 *  no concurrency since better-sqlite3 is single-writer. */
let sweepActive = false;

export const SCHEMA = `
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

-- Persisted SpendTracker pause set. Without this, the in-memory paused
-- set starts empty on every daemon launch and the first recompute
-- re-broadcasts account_paused for any account still tripping its pause
-- condition, which fires a redundant OS notification and writes a
-- duplicate row to the notifications table. reset_ts is the Unix-seconds
-- reset value of the triggering window at the moment the pause fired;
-- on rehydrate we compare against the current window reset to detect
-- whether a rollover happened while the daemon was off.
CREATE TABLE IF NOT EXISTS paused_accounts (
  account_id TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  reset_ts   INTEGER,
  paused_at  INTEGER NOT NULL
);

-- Alerts come in several scopes (see AlertScope in shared/types.ts for the
-- full discriminator). account_id stores '' for any scope whose TS type is
-- null (pool, pool-weekly, budget:global) so the legacy NOT NULL constraint
-- still holds; rowToAlert normalizes back to null when reading.
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

-- One row per /v1/messages request that yielded a response usage payload.
-- Captures BOTH surfaces of the cache-TTL picture so the Metrics tab can
-- show what Claude Code asked for (request cache_control markers) side by
-- side with what upstream actually wrote (response per-TTL token counts).
-- Cost fields are computed at write-time from a base $/MTok table and
-- fixed multipliers (5m write 1.25x, 1h write 2.0x, read 0.1x) so
-- aggregation stays pure SUM and historical rows survive future pricing
-- shifts.
CREATE TABLE IF NOT EXISTS cache_ttl_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              INTEGER NOT NULL,
  account_id      TEXT    NOT NULL,
  session_id      TEXT,
  model           TEXT    NOT NULL,
  request_id      TEXT,
  req_markers_5m  INTEGER NOT NULL DEFAULT 0,
  req_markers_1h  INTEGER NOT NULL DEFAULT 0,
  cache_create_5m INTEGER NOT NULL DEFAULT 0,
  cache_create_1h INTEGER NOT NULL DEFAULT 0,
  cache_read      INTEGER NOT NULL DEFAULT 0,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  cost_5m_write   REAL    NOT NULL DEFAULT 0,
  cost_1h_write   REAL    NOT NULL DEFAULT 0,
  cost_read       REAL    NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cache_ttl_account_ts ON cache_ttl_events(account_id, ts);
CREATE INDEX IF NOT EXISTS idx_cache_ttl_session    ON cache_ttl_events(account_id, session_id, ts);

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
  provenance      TEXT NOT NULL DEFAULT 'conversation',
  resolution      TEXT
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

-- Per-rule input bypass. When the user approves a pending tool_use
-- permission block AND ticks "Always allow this exact input" on the
-- banner, we record a (rule_id, input_hash) row so the evaluator can
-- short-circuit the matching deny on future identical calls. Differs
-- from security_allowlist in that the key is scoped to a specific
-- permission_rules row rather than a scanner match_hash — disabling
-- the rule or removing this bypass restores the original prompt flow.
CREATE TABLE IF NOT EXISTS permission_bypass (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id     TEXT    NOT NULL,
  tool_name   TEXT    NOT NULL,
  input_hash  TEXT    NOT NULL,
  mask        TEXT    NOT NULL,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (rule_id, input_hash)
);

CREATE INDEX IF NOT EXISTS idx_permission_bypass_rule ON permission_bypass(rule_id);
CREATE INDEX IF NOT EXISTS idx_permission_bypass_lookup ON permission_bypass(rule_id, input_hash);

-- User-configured tool permission rules evaluated by the proxy against
-- every outbound /v1/messages request (whole-tool denies) and every
-- inbound tool_use block (sub-command enforcement). Independent of
-- Claude Code's own ~/.claude/settings.json — this is a second
-- enforcement layer the user owns from Sentinel's UI. See
-- packages/daemon/src/security/permissions/ for the evaluator + matchers.
CREATE TABLE IF NOT EXISTS permission_rules (
  id          TEXT    PRIMARY KEY,
  -- decision is one of 'allow' | 'deny' | 'ask'. We don't use a CHECK
  -- constraint because 'ask' was added later and SQLite can't relax
  -- CHECKs without a full table rebuild; the TS layer validates input.
  decision    TEXT    NOT NULL,
  tool        TEXT    NOT NULL,
  pattern     TEXT,
  raw         TEXT    NOT NULL,
  note        TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  -- Origin of the rule. 'local' for rules authored in Sentinel's UI;
  -- 'claude-code' for rules imported from ~/.claude/settings.json by
  -- the sync engine. Drives reconciliation: claude-code rules are
  -- deleted when they vanish from the file, local rules are not.
  source      TEXT    NOT NULL DEFAULT 'local'
);

CREATE INDEX IF NOT EXISTS idx_perm_rules_priority ON permission_rules(priority);
-- The idx_perm_rules_source index is NOT created here because
-- existing installs predate the source column. CREATE INDEX ... ON
-- permission_rules(source) would fail against a legacy table that
-- still lacks the column. The migration block in getDb() adds the
-- column first (or rebuilds the table) and creates the index there.

-- Sprint 9 — Per-session approval grants. When the user picks
-- "Approve for session" on a pending banner, the enforcer writes a
-- (session_id, rule_key) row here so the next matching tool_use in the
-- same Claude Code session skips the prompt. expires_at bounds the
-- grant at 12 hours so a long-lived session doesn't permanently
-- remember a one-time decision; expired rows are pruned lazily on
-- read and aggressively at startup.
CREATE TABLE IF NOT EXISTS session_approval_grants (
  session_id TEXT NOT NULL,
  rule_key   TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, rule_key)
);
CREATE INDEX IF NOT EXISTS idx_sag_expires ON session_approval_grants(expires_at);

-- Sprint 9 — Approval-event audit. Every approve outcome on a
-- permission pending block lands here so the banner can warn "you've
-- approved this 5 times in 5 minutes — edit the rule?" without a
-- per-session in-memory tracker (which would drop on restart). Bounded
-- in size by the same retention sweep that prunes security_events.
CREATE TABLE IF NOT EXISTS approval_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  rule_key    TEXT NOT NULL,
  approved_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ae_lookup ON approval_events(session_id, rule_key, approved_at);

-- Optimize feature: per-tool-call structured metadata captured by the
-- in-proxy tool-call extractor. Stores ONLY the fields needed to score
-- subagent opportunities (file paths, sizes, model). Never stores raw
-- tool inputs or outputs. Privacy posture documented inline in the
-- Optimize Settings section: "Optimize captures file paths and tool
-- call sizes, not contents."
CREATE TABLE IF NOT EXISTS tool_calls (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                       INTEGER NOT NULL,
  account_id               TEXT    NOT NULL,
  session_id               TEXT,
  request_id               TEXT,
  request_seq_in_session   INTEGER,
  -- Anthropic API tool_use block id (e.g. "toolu_01abcd..."). Used to
  -- match the matching tool_result that arrives in a later request's
  -- user message and backfill response_size_bytes. Nullable because
  -- some upstream paths produce responses we can't parse.
  tool_use_id              TEXT,
  tool_name                TEXT    NOT NULL,
  -- Set for Read/Write/Edit/Glob/Grep when a path/pattern is present in
  -- the tool_use input. Null otherwise. Already discoverable via the
  -- request-log raw bodies when logging is on; this index does not add
  -- a new exfil surface, only a query-friendly form.
  file_path                TEXT,
  -- Bytes of the tool_use input JSON (input.length). Used to bias the
  -- proportional split when the same turn issued multiple tool_use
  -- calls.
  input_size_bytes         INTEGER NOT NULL DEFAULT 0,
  -- Bytes of the matching tool_result content (filled async on the
  -- next request, where the prior turn's tool_result blocks live).
  response_size_bytes      INTEGER,
  -- 1 when a later request in the same session contains the file_path
  -- string in its text content; 0 when the next request arrived without
  -- it; NULL while the next request hasn't arrived yet.
  was_quoted_in_later_turn INTEGER,
  -- Matches PermissionsEnforcer's deny decision for this tool_use. The
  -- analyzer filters out denied calls — they don't reflect intended
  -- token spend.
  denied                   INTEGER NOT NULL DEFAULT 0,
  model                    TEXT    NOT NULL,
  -- Approximate input-token contribution attributed to this call by
  -- the analyzer (proportional split of the parent turn's tokens).
  -- Filled lazily; null until the analyzer runs.
  attributed_input_tokens  INTEGER,
  attributed_cached_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tc_session_seq ON tool_calls(session_id, request_seq_in_session);
CREATE INDEX IF NOT EXISTS idx_tc_account_ts  ON tool_calls(account_id, ts);
CREATE INDEX IF NOT EXISTS idx_tc_tool_ts     ON tool_calls(tool_name, ts);
CREATE INDEX IF NOT EXISTS idx_tc_request     ON tool_calls(request_id);

-- Optimize feature: ledger of recommend / install / dismiss / measure
-- events keyed by curated subagent id. Joined to subagent_installs by
-- (curated_id) for the dashboard. One row per analyzer pass per
-- (account_id, session_id, curated_id, pattern) — the analyzer dedups
-- against this table over the past 7 days so a noisy session doesn't
-- spam multiple identical recommendations.
CREATE TABLE IF NOT EXISTS optimization_events (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                       INTEGER NOT NULL,
  account_id               TEXT    NOT NULL,
  session_id               TEXT,
  curated_id               TEXT    NOT NULL,
  -- 'recommended' | 'installed' | 'dismissed' | 'measured'
  kind                     TEXT    NOT NULL,
  pattern                  TEXT,
  savings_usd              REAL,
  actual_input_tokens      INTEGER,
  actual_cached_tokens     INTEGER,
  actual_cost_usd          REAL,
  hypothetical_cost_usd    REAL,
  -- Total input tokens the hypothetical (subagent) path would have
  -- consumed: hypoInputTokens + digestTokens from savings-calc. Stored
  -- so the dashboard can render savings in tokens without re-running
  -- savings-calc. Nullable for migration compatibility (historical
  -- rows render as a placeholder for token savings).
  hypothetical_total_tokens INTEGER,
  source_tool_call_ids     TEXT
);
CREATE INDEX IF NOT EXISTS idx_oe_ts           ON optimization_events(ts);
CREATE INDEX IF NOT EXISTS idx_oe_curated_kind ON optimization_events(curated_id, kind);
CREATE INDEX IF NOT EXISTS idx_oe_account_ts   ON optimization_events(account_id, ts);

-- Optimize feature: DB-as-source-of-truth mirror of ~/.claude/agents/.
-- One row per installed subagent. The agents-sync engine pushes
-- 'curated' rows to disk and pulls 'local' rows from user-authored .md
-- files. Soft-delete via uninstalled_at preserves history for the
-- savings dashboard.
CREATE TABLE IF NOT EXISTS subagent_installs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The frontmatter name field, also the .md filename stem and the
  -- canonical key. UNIQUE so the sync engine can upsert by name.
  name              TEXT    NOT NULL UNIQUE,
  -- 'curated' rows track a Sentinel-shipped GAP entry by curated_id;
  -- 'local' rows mirror user-authored .md files. Push only writes
  -- curated rows; pull never overwrites curated rows with local data.
  source            TEXT    NOT NULL DEFAULT 'curated',
  curated_id        TEXT,
  -- SHA-256 of the GAP folder we generated this install from. Lets a
  -- future daemon upgrade detect "your installed version is stale".
  gap_fingerprint   TEXT,
  md_path           TEXT    NOT NULL,
  -- SHA-256 of the rendered .md content. Drives echo detection in
  -- agents-sync — when a watcher event reports the same hash we just
  -- wrote, skip the pull.
  md_hash           TEXT    NOT NULL DEFAULT '',
  installed_at      INTEGER NOT NULL,
  uninstalled_at    INTEGER,
  -- 1 = user opted this curated subagent out of auto-recommend. The
  -- analyzer skips opportunities whose curated_id is opted out.
  opted_out         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_si_source ON subagent_installs(source);
CREATE INDEX IF NOT EXISTS idx_si_active ON subagent_installs(uninstalled_at);
`;

let _db: Database.Database | null = null;

/**
 * Open (or reuse) the singleton SQLite connection.
 */
export function getDb(
  dbPath: string = process.env.CLAUDE_SENTINEL_TEST_DB_FILE ?? DB_PATH,
): Database.Database {
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
  _db.exec('UPDATE accounts SET account_uuid = id WHERE account_uuid IS NULL');
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
    _db.exec(
      "ALTER TABLE security_events ADD COLUMN provenance TEXT NOT NULL DEFAULT 'conversation'",
    );
  }

  // resolution: explicit signal for how a block-or-hold was settled.
  // NULL for observe-only findings that never held the request.
  // 'user_approve' | 'user_deny' | 'timeout' for held requests.
  // The frontend StatusPill needs this to distinguish "Allowed by you"
  // from "Blocked" and to label timed-out denies. Approved + blocked
  // alone can't carry the timeout vs user-deny distinction.
  const seCols3 = _db.pragma('table_info(security_events)') as Array<{ name: string }>;
  if (seCols3.length > 0 && !seCols3.some((c) => c.name === 'resolution')) {
    _db.exec('ALTER TABLE security_events ADD COLUMN resolution TEXT');
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

  // Migrate permission_rules for the `source` column (added for
  // bi-directional Claude Code sync). Existing rows default to 'local'
  // so they survive the sync engine's delete-orphans pass. Older DBs
  // also have a CHECK(decision IN ('allow','deny')) constraint that
  // would reject 'ask' on import — detected by inspecting sqlite_master
  // for the literal CHECK text. When present, rebuild the table
  // (sqlite's only way to relax a CHECK constraint) preserving every
  // row. The rebuild also adds `source` so we skip the ALTER in that
  // branch.
  const prCols = _db.pragma('table_info(permission_rules)') as Array<{ name: string }>;
  if (prCols.length > 0) {
    const prSql = _db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='permission_rules'`)
      .get() as { sql: string } | undefined;
    const hasLegacyCheck = prSql?.sql.includes("CHECK(decision IN ('allow','deny'))") === true;
    const hasSource = prCols.some((c) => c.name === 'source');
    if (hasLegacyCheck) {
      _db.exec(`
        BEGIN;
        CREATE TABLE permission_rules_new (
          id          TEXT    PRIMARY KEY,
          decision    TEXT    NOT NULL,
          tool        TEXT    NOT NULL,
          pattern     TEXT,
          raw         TEXT    NOT NULL,
          note        TEXT,
          enabled     INTEGER NOT NULL DEFAULT 1,
          priority    INTEGER NOT NULL,
          created_at  INTEGER NOT NULL,
          source      TEXT    NOT NULL DEFAULT 'local'
        );
        INSERT INTO permission_rules_new
          (id, decision, tool, pattern, raw, note, enabled, priority, created_at, source)
          SELECT id, decision, tool, pattern, raw, note, enabled, priority, created_at, 'local'
          FROM permission_rules;
        DROP TABLE permission_rules;
        ALTER TABLE permission_rules_new RENAME TO permission_rules;
        COMMIT;
      `);
    } else if (!hasSource) {
      _db.exec("ALTER TABLE permission_rules ADD COLUMN source TEXT NOT NULL DEFAULT 'local'");
    }
  }
  _db.exec('CREATE INDEX IF NOT EXISTS idx_perm_rules_source ON permission_rules(source)');

  // Sprint 9: per-project rule scoping. NULL means global (legacy
  // behavior). The column is nullable so existing rules survive
  // unchanged. Index is intentionally absent — the evaluator filters
  // in-memory after the priority-ordered scan, and the table stays
  // small enough that an extra index would cost more on writes than
  // it saves on reads.
  const prCols2 = _db.pragma('table_info(permission_rules)') as Array<{ name: string }>;
  if (prCols2.length > 0 && !prCols2.some((c) => c.name === 'project_scope')) {
    _db.exec('ALTER TABLE permission_rules ADD COLUMN project_scope TEXT');
  }

  // One-time cleanup of double-counted usage_events. A prior version of the
  // OTEL receiver wrote two rows per request: one from the `api_request` log
  // (full token breakdown) and one from the `claude_code.cost.usage` metric
  // (cost only, null tokens). Summing both inflated weekly spend 2x+. The
  // metric path is now skipped; delete rows that came from it so existing
  // SQLite databases get the correct totals without a full wipe. Guarded by
  // a flag so this runs once per DB.
  _db.exec(
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const applied = _db
    .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
    .get('dedup_cost_metric_rows_v1') as { ok: number } | undefined;
  if (!applied) {
    const result = _db
      .prepare(
        `
        DELETE FROM usage_events
        WHERE input_tokens IS NULL
          AND output_tokens IS NULL
          AND cost_usd IS NOT NULL
          AND cost_usd > 0
      `,
      )
      .run();
    _db
      .prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)')
      .run('dedup_cost_metric_rows_v1', Date.now());
    if (result.changes > 0) {
      console.log(`[DB] Removed ${result.changes} duplicate cost-metric rows (one-time cleanup)`);
    }
  }

  // One-time dedup of permission_rules rows sharing the same `raw`. An
  // earlier version of claude-sync.ts (pullNow) keyed the existing-row
  // lookup on `decision|raw` but upsertPermissionRule keyed on `id`,
  // so re-classifying a rule across decision buckets produced a new
  // row instead of updating the old one. The unique index created
  // afterward enforces the invariant going forward; rowToPermissionRule
  // + the TS layer keep `raw` canonical so this key is stable.
  const permDedupApplied = _db
    .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
    .get('dedup_permission_rules_v1') as { ok: number } | undefined;
  if (!permDedupApplied) {
    const pruned = _db
      .prepare(
        `DELETE FROM permission_rules
         WHERE id NOT IN (
           SELECT id FROM (
             SELECT id, raw, created_at,
                    ROW_NUMBER() OVER (PARTITION BY raw ORDER BY created_at ASC, id ASC) AS rn
             FROM permission_rules
           ) WHERE rn = 1
         )`,
      )
      .run();
    _db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_perm_rules_raw_unique ON permission_rules(raw)',
    );
    _db
      .prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)')
      .run('dedup_permission_rules_v1', Date.now());
    if (pruned.changes > 0) {
      console.log(
        `[DB] Collapsed ${pruned.changes} duplicate permission_rules rows (one-time cleanup)`,
      );
    }
  } else {
    _db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_perm_rules_raw_unique ON permission_rules(raw)',
    );
  }

  // Sprint 8 — security_events_chain_v1: tamper-evident hash chain over
  // every `security_events` row, append-only via triggers, with a
  // separate summary table that bridges the chain across retention
  // gaps and a TEMP-table sweep token that the trigger checks to
  // permit deletes only when invoked from a sweep-aware path.
  // Migrate optimization_events for the `hypothetical_total_tokens`
  // column. Used by the dashboard's tokens toggle (savings rendered in
  // input-tokens instead of dollars). The follow-up back-fill below
  // populates historical rows so the token view isn't blank after upgrade.
  const oeCols = _db.pragma('table_info(optimization_events)') as Array<{ name: string }>;
  if (oeCols.length > 0 && !oeCols.some((c) => c.name === 'hypothetical_total_tokens')) {
    _db.exec('ALTER TABLE optimization_events ADD COLUMN hypothetical_total_tokens INTEGER');
  }

  // One-shot back-fill of `hypothetical_total_tokens` for measured rows
  // written before the column existed. We invert the savings-calc
  // formula:
  //   hypoCost = (hypoInputTokens * baseHypo + digestTokens * baseActual) / 1_000_000
  //   → hypoInputTokens = (hypoCost * 1_000_000 - digestTokens * baseActual) / baseHypo
  // baseActual is assumed Opus ($15/MTok) — most Claude Code traffic.
  // For Sonnet rows the result is slightly low (by roughly digestTokens
  // worth of attribution at the rate gap); acceptable for a historical
  // back-fill. Digest sizes mirror the constants in
  // `optimize/savings-calc.ts`; if those change, ship a v2 migration.
  // Marked in `_migrations` so it only runs once.
  const tokenBackfillApplied = _db
    .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
    .get('optimization_events_token_backfill_v1') as { ok: number } | undefined;
  if (!tokenBackfillApplied) {
    const BASE_ACTUAL_OPUS = 15; // $/MTok, matches getBaseInputPricePerMillion('claude-opus-4')
    const BASE_HYPO_HAIKU = 1; // $/MTok, matches 'claude-haiku-4'

    const rows = _db
      .prepare(
        `SELECT id, curated_id, hypothetical_cost_usd
           FROM optimization_events
           WHERE kind = 'measured'
             AND hypothetical_total_tokens IS NULL
             AND hypothetical_cost_usd IS NOT NULL`,
      )
      .all() as Array<{ id: number; curated_id: string; hypothetical_cost_usd: number }>;

    const update = _db.prepare(
      'UPDATE optimization_events SET hypothetical_total_tokens = ? WHERE id = ?',
    );
    _db.transaction(() => {
      for (const r of rows) {
        const digestTokens = getDigestTokens(r.curated_id);
        // Floor at 0: a cheap-enough hypothetical (e.g., a buggy Opus
        // override on a Sonnet conversation) could otherwise produce a
        // negative input-token estimate, which is meaningless.
        const hypoInputTokens = Math.max(
          0,
          (r.hypothetical_cost_usd * 1_000_000 - digestTokens * BASE_ACTUAL_OPUS) / BASE_HYPO_HAIKU,
        );
        const total = Math.round(hypoInputTokens + digestTokens);
        update.run(total, r.id);
      }
    })();

    _db
      .prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)')
      .run('optimization_events_token_backfill_v1', Date.now());
  }

  const chainApplied = _db
    .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
    .get('security_events_chain_v1') as { ok: number } | undefined;
  if (!chainApplied) {
    const cols = _db.pragma('table_info(security_events)') as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'prev_hash')) {
      _db.exec("ALTER TABLE security_events ADD COLUMN prev_hash    TEXT NOT NULL DEFAULT ''");
    }
    if (!cols.some((c) => c.name === 'payload_hash')) {
      _db.exec("ALTER TABLE security_events ADD COLUMN payload_hash TEXT NOT NULL DEFAULT ''");
    }
    _db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sec_prev_hash    ON security_events(prev_hash);
      CREATE INDEX IF NOT EXISTS idx_sec_payload_hash ON security_events(payload_hash);
      CREATE TABLE IF NOT EXISTS security_events_daily_summary (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        day_ts               INTEGER NOT NULL,
        count                INTEGER NOT NULL,
        first_payload_hash   TEXT    NOT NULL,
        last_payload_hash    TEXT    NOT NULL,
        prev_hash            TEXT    NOT NULL,
        payload_hash         TEXT    NOT NULL,
        reason               TEXT    NOT NULL DEFAULT 'retention',
        deleted_hashes_json  TEXT    NOT NULL DEFAULT '[]',
        created_at           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sec_summary_day_ts      ON security_events_daily_summary(day_ts);
      CREATE INDEX IF NOT EXISTS idx_sec_summary_prev_hash   ON security_events_daily_summary(prev_hash);
      CREATE TABLE IF NOT EXISTS incident_replays (
        event_id      INTEGER PRIMARY KEY,
        captured_at   INTEGER NOT NULL,
        messages_json TEXT    NOT NULL,
        FOREIGN KEY (event_id) REFERENCES security_events(id) ON DELETE CASCADE
      );
    `);
    _db
      .prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)')
      .run('security_events_chain_v1', Date.now());
  }

  // The sweep-active gate is a per-connection user-defined function.
  // Triggers reference `is_sweep_active()` — when the value is 1, the
  // trigger lets a chain-column UPDATE or a DELETE through; when 0, it
  // RAISE(ABORT)s. External `sqlite3` CLI sessions don't have this
  // function registered, so when they trigger an UPDATE/DELETE, SQLite
  // raises "no such function" and the operation fails. (We previously
  // tried a TEMP TABLE flag here, but SQLite triggers can't reference
  // TEMP tables across schemas — `main`-attached triggers see only
  // `main`-attached tables. The UDF works because it lives in the
  // SQLite engine state of the registering connection.)
  // Triggers are idempotent (CREATE TRIGGER IF NOT EXISTS), so
  // re-applying on every getDb() open is safe.
  _db.function('is_sweep_active', { deterministic: false }, () => (sweepActive ? 1 : 0));
  // DROP + CREATE rather than CREATE IF NOT EXISTS so a daemon upgrade
  // that changes trigger logic actually picks up the new definition.
  // SQLite has no CREATE OR REPLACE TRIGGER; drop is the standard path.
  _db.exec('DROP TRIGGER IF EXISTS trg_sec_no_update_chain');
  _db.exec('DROP TRIGGER IF EXISTS trg_sec_no_delete');
  // Trigger guards every column EXCEPT the bookkeeping ones the
  // dedup path legitimately mutates without changing the row's
  // detection identity: last_seen_ts, occurrences, acknowledged.
  // `blocked` and `approved` are dispositions that dedup CAN flip
  // (a repeat detection escalating to a block), so they're gated
  // through the sweep-active check rather than freely mutable —
  // external `UPDATE security_events SET blocked = 0` is still
  // rejected (sweep is inactive), but internal dedup running under
  // the sweep gate succeeds.
  _db.exec(`
    CREATE TRIGGER trg_sec_no_update_chain
    BEFORE UPDATE ON security_events
    WHEN (
      is_sweep_active() = 0
      AND (
           OLD.id            != NEW.id
        OR OLD.ts            != NEW.ts
        OR OLD.account_id    != NEW.account_id
        OR IFNULL(OLD.session_id,'')   != IFNULL(NEW.session_id,'')
        OR OLD.direction     != NEW.direction
        OR OLD.severity      != NEW.severity
        OR OLD.kind          != NEW.kind
        OR OLD.detector_id   != NEW.detector_id
        OR OLD.confidence    != NEW.confidence
        OR OLD.title         != NEW.title
        OR OLD.reason        != NEW.reason
        OR IFNULL(OLD.match_mask,'')   != IFNULL(NEW.match_mask,'')
        OR OLD.match_hash    != NEW.match_hash
        OR IFNULL(OLD.context_hash,'') != IFNULL(NEW.context_hash,'')
        OR IFNULL(OLD.snippet,'')      != IFNULL(NEW.snippet,'')
        OR IFNULL(OLD.source_hint,'')  != IFNULL(NEW.source_hint,'')
        OR IFNULL(OLD.details_json,'') != IFNULL(NEW.details_json,'')
        OR OLD.blocked       != NEW.blocked
        OR OLD.approved      != NEW.approved
        OR OLD.provenance    != NEW.provenance
        OR OLD.prev_hash     != NEW.prev_hash
        OR OLD.payload_hash  != NEW.payload_hash
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'security_events: chain columns are append-only');
    END
  `);
  _db.exec(`
    CREATE TRIGGER trg_sec_no_delete
    BEFORE DELETE ON security_events
    WHEN is_sweep_active() = 0
    BEGIN
      SELECT RAISE(ABORT, 'security_events: deletes only allowed during retention sweep');
    END
  `);

  // Backfill chain hashes for rows that pre-date `security_events_chain_v1`.
  // The chain_v1 migration ALTERed the table to add `prev_hash` and
  // `payload_hash` with `DEFAULT ''`, but did not populate existing rows;
  // the very first integrity check at startup then trips on row id=1 with
  // "payload_hash mismatch on event id=1" because the recomputed SHA-256
  // doesn't match the empty string. Walk those rows in id order, compute
  // each row's chain hashes (first row = genesis with prev_hash=''; each
  // subsequent row chains off the prior backfilled hash), and write them
  // through the sweep gate so the append-only triggers above let the
  // UPDATE through. Filtered on `payload_hash = ''` only so a torn state
  // (partial earlier backfill) is also healed. Idempotent: marker check
  // short-circuits the SELECT/UPDATE on the second open.
  const chainBackfillApplied = _db
    .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
    .get('security_events_chain_backfill_v1') as { ok: number } | undefined;
  if (!chainBackfillApplied) {
    const legacyRows = _db
      .prepare(
        `SELECT id, ts, account_id, session_id, direction, severity, kind,
                detector_id, confidence, title, reason, match_mask, match_hash,
                context_hash, snippet, source_hint, details_json, provenance
           FROM security_events
           WHERE payload_hash = ''
           ORDER BY id ASC`,
      )
      .all() as Array<{
      id: number;
      ts: number;
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
      provenance: string;
    }>;

    if (legacyRows.length > 0) {
      const update = _db.prepare(
        'UPDATE security_events SET prev_hash = ?, payload_hash = ? WHERE id = ?',
      );
      const txn = _db.transaction(() => {
        let prev = '';
        for (const r of legacyRows) {
          const payloadHash = computePayloadHash({
            ts: r.ts,
            accountId: r.account_id,
            sessionId: r.session_id,
            direction: r.direction,
            severity: r.severity,
            kind: r.kind,
            detectorId: r.detector_id,
            confidence: r.confidence,
            title: r.title,
            reason: r.reason,
            matchMask: r.match_mask,
            matchHash: r.match_hash,
            contextHash: r.context_hash,
            snippet: r.snippet,
            sourceHint: r.source_hint,
            detailsJson: r.details_json,
            provenance: r.provenance,
            prevHash: prev,
          });
          update.run(prev, payloadHash, r.id);
          prev = payloadHash;
        }
      });
      sweepActive = true;
      try {
        txn();
      } finally {
        sweepActive = false;
      }
      console.log(
        `[DB] security_events_chain_backfill_v1: rehydrated chain for ${legacyRows.length} pre-chain row(s)`,
      );
    }
    _db
      .prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)')
      .run('security_events_chain_backfill_v1', Date.now());
  }

  // Optimize feature schema marker. The CREATE TABLE statements in SCHEMA
  // are idempotent (IF NOT EXISTS) so a fresh install gets the tables
  // created automatically. The marker exists so retention sweeps and
  // future column-additive migrations can key off whether v1 already ran
  // on this DB without inspecting table_info every startup.
  const optimizeApplied = _db
    .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
    .get('optimize_v1_schema_2026_05') as { ok: number } | undefined;
  if (!optimizeApplied) {
    _db
      .prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)')
      .run('optimize_v1_schema_2026_05', Date.now());
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
  db.prepare(
    `
    INSERT INTO accounts (id, account_uuid, email, display_name, org_uuid, org_name, plan_type, created_at)
    VALUES (@id, @accountUuid, @email, @displayName, @orgUuid, @orgName, @planType, @createdAt)
    ON CONFLICT(id) DO UPDATE SET
      account_uuid = excluded.account_uuid,
      email        = excluded.email,
      display_name = excluded.display_name,
      org_uuid     = excluded.org_uuid,
      org_name     = excluded.org_name,
      plan_type    = excluded.plan_type
  `,
  ).run({
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
  withChainBridge(db, 'account_purge', () => {
    const rows = db
      .prepare('SELECT payload_hash, ts FROM security_events WHERE account_id = ? ORDER BY id ASC')
      .all(id) as Array<{ payload_hash: string; ts: number }>;
    if (rows.length === 0) return { deletedHashes: [], deletedTs: [] };
    db.prepare('DELETE FROM security_events WHERE account_id = ?').run(id);
    return {
      deletedHashes: rows.map((r) => r.payload_hash),
      deletedTs: rows.map((r) => r.ts),
    };
  });
  db.prepare('DELETE FROM paused_accounts WHERE account_id = ?').run(id);
  // Mark as purged (removed = 2). If the row does not exist yet, insert a bare
  // tombstone so refresh_accounts cannot create a fresh removed = 0 row later.
  const upd = db.prepare('UPDATE accounts SET removed = 2 WHERE id = ?').run(id);
  if (upd.changes > 0) return true;
  // Row didn't exist — insert a minimal tombstone.
  const ins = db
    .prepare(
      "INSERT OR IGNORE INTO accounts (id, account_uuid, email, removed, created_at) VALUES (?, ?, '', 2, ?)",
    )
    .run(id, id, Date.now());
  return ins.changes > 0;
}

/**
 * Return all accounts that have been soft-removed (removed = 1).
 */
export function listRemovedAccounts(db: Database.Database): AccountInfo[] {
  const rows = db
    .prepare('SELECT * FROM accounts WHERE removed = 1 ORDER BY email')
    .all() as DbAccountRow[];
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
  const row = db.prepare('SELECT removed FROM accounts WHERE id = ?').get(id) as
    | { removed: number }
    | undefined;
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
  const row = db.prepare('SELECT removed FROM accounts WHERE id = ?').get(id) as
    | { removed: number }
    | undefined;
  return row !== undefined && row.removed === 0;
}

export function getAccount(db: Database.Database, accountId: string): AccountInfo | null {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as
    | DbAccountRow
    | undefined;
  return row ? rowToAccount(row) : null;
}

export function listAccounts(db: Database.Database): AccountInfo[] {
  const rows = db
    .prepare('SELECT * FROM accounts WHERE removed = 0 ORDER BY email')
    .all() as DbAccountRow[];
  return rows.map(rowToAccount);
}

/**
 * Persist the user-picked avatar color for an account. Pass `null` to clear
 * the custom color so the UI reverts to the hash-derived default gradient.
 * Returns true when the row existed and was updated.
 */
export function setAccountColor(db: Database.Database, id: string, color: string | null): boolean {
  const result = db.prepare('UPDATE accounts SET color = ? WHERE id = ?').run(color, id);
  return result.changes > 0;
}

// ─── Usage event queries ──────────────────────────────────────────────────────

export type InsertUsageEvent = Omit<UsageEvent, 'id'>;

export function insertUsageEvent(db: Database.Database, event: InsertUsageEvent): number {
  const result = db
    .prepare(
      `
      INSERT INTO usage_events
        (ts, account_id, session_id, model, cost_usd, input_tokens, output_tokens, cache_read, cache_create, duration_ms)
      VALUES
        (@ts, @accountId, @sessionId, @model, @costUsd, @inputTokens, @outputTokens, @cacheRead, @cacheCreate, @durationMs)
    `,
    )
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
    .prepare(
      `
      SELECT
        COALESCE(SUM(cost_usd), 0)      AS total_cost,
        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total_tokens,
        COUNT(DISTINCT session_id)       AS session_count
      FROM usage_events
      WHERE account_id = ? AND ts >= ?
    `,
    )
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
      // 'localtime' bucket boundaries — Metrics and Optimize charts must
      // render days in the user's local timezone (the daemon runs on the
      // user's machine, so SQLite's localtime modifier is exactly that).
      // Without it, late-evening UTC-offset users see "tomorrow" appear
      // on the rightmost x-axis and same-day usage gets split across the
      // UTC midnight boundary.
      `SELECT
         date(ts / 1000, 'unixepoch', 'localtime') AS day,
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
export function insertOverageEvent(
  db: Database.Database,
  event: InsertOverageEvent,
): number | null {
  const result = db
    .prepare(
      `
      INSERT OR IGNORE INTO overage_events (ts, account_id, transition, status, resets_at, disabled_reason)
      VALUES (@ts, @accountId, @transition, @status, @resetsAt, @disabledReason)
    `,
    )
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
    .prepare(
      `
      SELECT e.* FROM overage_events e
      INNER JOIN (
        SELECT account_id, MAX(ts) AS max_ts
        FROM overage_events
        GROUP BY account_id
      ) m ON e.account_id = m.account_id AND e.ts = m.max_ts
    `,
    )
    .all() as DbOverageRow[];
  return rows.map(rowToOverageEvent);
}

// ─── Notification queries ─────────────────────────────────────────────────────

export type InsertNotification = Omit<NotificationRecord, 'id' | 'acknowledged'>;

export function insertNotification(db: Database.Database, notif: InsertNotification): number {
  const result = db
    .prepare(
      `
      INSERT INTO notifications (ts, account_id, type, title, body)
      VALUES (@ts, @accountId, @type, @title, @body)
    `,
    )
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
  const result = db.prepare('UPDATE notifications SET acknowledged = 1 WHERE id = ?').run(id);
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
export function acknowledgeAllNotifications(db: Database.Database, accountId?: string): number {
  const result =
    accountId !== undefined
      ? db
          .prepare(
            'UPDATE notifications SET acknowledged = 1 WHERE acknowledged = 0 AND (account_id = ? OR account_id IS NULL)',
          )
          .run(accountId)
      : db.prepare('UPDATE notifications SET acknowledged = 1 WHERE acknowledged = 0').run();
  return result.changes;
}

export function listNotifications(
  db: Database.Database,
  opts: {
    unacknowledgedOnly?: boolean;
    limit?: number;
    /** Cursor: when set, restrict to rows with `ts < beforeTs`. Used by the
     *  Alerts tab's infinite scroll. */
    beforeTs?: number;
    /** When set, restrict to rows scoped to this account (or to the global
     *  bucket where account_id IS NULL). Mirrors the per-account filter the
     *  AlertsEditor previously did client-side. */
    accountId?: string;
    /** When set, only rows whose `type` is in this list are returned.
     *  Drives the all/usage/security category filter on the Alerts tab. */
    types?: NotificationType[];
  },
): NotificationRecord[] {
  let sql = 'SELECT * FROM notifications WHERE 1=1';
  const params: Record<string, string | number> = {};

  if (opts.unacknowledgedOnly === true) {
    sql += ' AND acknowledged = 0';
  }
  if (opts.beforeTs !== undefined) {
    sql += ' AND ts < @beforeTs';
    params['beforeTs'] = opts.beforeTs;
  }
  if (opts.accountId !== undefined) {
    sql += ' AND (account_id = @accountId OR account_id IS NULL)';
    params['accountId'] = opts.accountId;
  }
  if (opts.types !== undefined && opts.types.length > 0) {
    const placeholders = opts.types.map((_, i) => `@type${i}`).join(', ');
    sql += ` AND type IN (${placeholders})`;
    opts.types.forEach((t, i) => {
      params[`type${i}`] = t;
    });
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
  'id' | 'occurrences' | 'acknowledged' | 'lastSeenTs' | 'approved' | 'resolution'
> & {
  /** Optional on insert — defaults to false. Set true when the user has
   *  explicitly approved a pending block via the in-app banner; mirrored
   *  into the security_allowlist in that case. */
  approved?: boolean;
  /** Optional on insert — null for observe-only findings. Set to
   *  'user_approve' | 'user_deny' | 'timeout' when a pending hold
   *  settled. Drives the Security tab's StatusPill (Allowed by you vs
   *  Blocked vs timed-out Blocked). */
  resolution?: SecurityEvent['resolution'];
};

/** Dedup window in ms. Identical findings seen within this window bump
 *  `occurrences` + `last_seen_ts` instead of creating a new row. */
export const SECURITY_DEDUP_WINDOW_MS = 60 * 60 * 1000;

/** Sprint 8 — set of column values that participate in a row's
 *  `payload_hash`. The chain protects WHAT was detected (the immutable
 *  detection content), not HOW the daemon responded.
 *
 *  Excluded from the hash:
 *    - `id` (auto-assigned; excluding lets us hash pre-INSERT)
 *    - `last_seen_ts`, `occurrences`, `acknowledged` (free-mutable
 *      bookkeeping)
 *    - `blocked`, `approved` (dispositions, not detections —
 *      legitimately flipped by dedup when a repeat detection
 *      escalates from observe to block, or by user approval).
 *      These ARE protected by the append-only trigger via the sweep
 *      gate, so external `UPDATE security_events SET blocked = 0` is
 *      still rejected; dedup flips them under the sweep gate so the
 *      chain stays consistent. */
interface ChainPayload {
  ts: number;
  accountId: string;
  sessionId: string | null;
  direction: string;
  severity: string;
  kind: string;
  detectorId: string;
  confidence: number;
  title: string;
  reason: string;
  matchMask: string | null;
  matchHash: string;
  contextHash: string | null;
  snippet: string | null;
  sourceHint: string | null;
  detailsJson: string | null;
  provenance: string;
  prevHash: string;
}

/** Compute the SHA-256 payload hash for a security_events row. The
 *  field order is fixed (a JSON.stringify with sorted keys) so the
 *  chain is deterministic across processes and language runtimes —
 *  important because the export handler emits a portable hash. */
export function computePayloadHash(payload: ChainPayload): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(payload).sort()) {
    sorted[k] = (payload as unknown as Record<string, unknown>)[k];
  }
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/** Read the most-recent payload_hash from either `security_events` or
 *  the `security_events_daily_summary` bridge table — whichever is
 *  fresher. Used to seed the next insert's `prev_hash`. Returns ''
 *  for an empty chain (first-ever insert). */
function readChainTip(db: Database.Database): string {
  const fromEvent = db
    .prepare('SELECT payload_hash, ts FROM security_events ORDER BY id DESC LIMIT 1')
    .get() as { payload_hash: string; ts: number } | undefined;
  const fromSummary = db
    .prepare(
      'SELECT payload_hash, day_ts FROM security_events_daily_summary ORDER BY id DESC LIMIT 1',
    )
    .get() as { payload_hash: string; day_ts: number } | undefined;
  if (fromEvent && fromSummary) {
    return fromEvent.ts >= fromSummary.day_ts ? fromEvent.payload_hash : fromSummary.payload_hash;
  }
  if (fromEvent) return fromEvent.payload_hash;
  if (fromSummary) return fromSummary.payload_hash;
  return '';
}

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
    // (v1.1 regression identified in testing). Both flags are
    // chain-protected via the trigger, so the dedup UPDATE runs under
    // the sweep gate — that lets the legitimate internal mutation
    // through without weakening the protection against external
    // `UPDATE security_events SET blocked = 0` tamper attempts.
    // resolution propagates one-way: NULL → user_approve|user_deny|timeout.
    // Once a row has been resolved we keep that resolution sticky — a
    // subsequent observe-only repeat of the same match must not clear the
    // "Allowed by you" badge. This is the fix for approved/denied rows
    // that visibly fell back to "Detected" because the dedup branch never
    // carried the resolution column from the finalizePending call.
    sweepActive = true;
    try {
      db.prepare(
        `UPDATE security_events
         SET occurrences = occurrences + 1,
             last_seen_ts = @lastSeenTs,
             blocked  = CASE WHEN @blocked  = 1 THEN 1 ELSE blocked  END,
             approved = CASE WHEN @approved = 1 THEN 1 ELSE approved END,
             resolution = CASE
               WHEN resolution IS NOT NULL THEN resolution
               WHEN @resolution IS NOT NULL THEN @resolution
               ELSE NULL
             END
         WHERE id = @id`,
      ).run({
        lastSeenTs: event.ts,
        blocked: event.blocked ? 1 : 0,
        approved: event.approved ? 1 : 0,
        resolution: event.resolution ?? null,
        id: existing.id,
      });
    } finally {
      sweepActive = false;
    }
    return { id: existing.id, isNew: false };
  }

  // Sprint 8 chain: compute payload_hash before the INSERT so we can
  // write both prev_hash and payload_hash in one statement. Excludes
  // the auto-assigned `id` from the hash so we don't need a post-insert
  // chain-column UPDATE (which would require the sweep gate to be open
  // per insert). The chain protects content integrity; row id is
  // metadata. Walker recomputes without id.
  const detailsJson = event.details ? JSON.stringify(event.details) : null;
  const insertWithChain = db.transaction(() => {
    const prevHash = readChainTip(db);
    const payloadHash = computePayloadHash({
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
      detailsJson,
      provenance: event.provenance,
      prevHash,
    });
    const inserted = db
      .prepare(
        `INSERT INTO security_events (
           ts, last_seen_ts, account_id, session_id, direction,
           severity, kind, detector_id, confidence, title, reason,
           match_mask, match_hash, context_hash, snippet, source_hint,
           details_json, blocked, approved, provenance, resolution,
           prev_hash, payload_hash
         ) VALUES (
           @ts, @ts, @accountId, @sessionId, @direction,
           @severity, @kind, @detectorId, @confidence, @title, @reason,
           @matchMask, @matchHash, @contextHash, @snippet, @sourceHint,
           @detailsJson, @blocked, @approved, @provenance, @resolution,
           @prevHash, @payloadHash
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
        detailsJson,
        blocked: event.blocked ? 1 : 0,
        approved: event.approved ? 1 : 0,
        // Provenance is immutable after first insert — the dedup UPDATE
        // above does not touch it, so the first observation's origin
        // category stays authoritative.
        provenance: event.provenance,
        resolution: event.resolution ?? null,
        prevHash,
        payloadHash,
      });
    return Number(inserted.lastInsertRowid);
  });

  const id = insertWithChain();
  return { id, isNew: true };
}

/** Scanner-self-telemetry kinds — informational events the scanner emits about
 *  its own state (truncation, encoding-skip, deferred-oversized). They are
 *  always low-severity, low-signal, and easy to ignore once seen, so the
 *  Security panel hides them behind the "Show scan diagnostics" toggle.
 *  Real findings (any severity) are never excluded by this list. */
export const TELEMETRY_SECURITY_KINDS: readonly SecurityKind[] = [
  'scan_truncated',
  'scan_skipped_encoding',
  'scan_deferred_oversized',
];

export function listSecurityEvents(
  db: Database.Database,
  opts: {
    accountId?: string;
    limit?: number;
    /** Cursor: when set, restrict to rows with `ts < beforeTs`. Used by the
     *  Security tab's infinite scroll to fetch the next page after the
     *  oldest currently-loaded event. */
    beforeTs?: number;
    /** When true, filter out scanner-self-telemetry kinds (see
     *  TELEMETRY_SECURITY_KINDS). Real findings of any severity are always
     *  returned regardless of this flag. */
    excludeTelemetry?: boolean;
    /** Restrict to a single severity bucket. */
    severity?: SecuritySeverity;
    /** Restrict to this set of kinds. Used by the Security tab to push the
     *  scanner-only / permissions-only mode narrowing AND the user's
     *  explicit kind chip filter down to SQL in one shot. Pre-intersected
     *  with the telemetry-exclude list at the call site so we don't have
     *  to reason about both filters interacting here. */
    kinds?: SecurityKind[];
    /** Case-insensitive substring match across title / reason / match_mask /
     *  source_hint. */
    search?: string;
  } = {},
): SecurityEvent[] {
  let sql = 'SELECT * FROM security_events WHERE 1=1';
  const params: Record<string, string | number> = {};

  if (opts.accountId !== undefined) {
    sql += ' AND account_id = @accountId';
    params['accountId'] = opts.accountId;
  }
  if (opts.beforeTs !== undefined) {
    sql += ' AND ts < @beforeTs';
    params['beforeTs'] = opts.beforeTs;
  }
  if (opts.excludeTelemetry === true) {
    const placeholders = TELEMETRY_SECURITY_KINDS.map((_, i) => `@telemetry${i}`).join(', ');
    sql += ` AND kind NOT IN (${placeholders})`;
    TELEMETRY_SECURITY_KINDS.forEach((k, i) => {
      params[`telemetry${i}`] = k;
    });
  }
  if (opts.severity !== undefined) {
    sql += ' AND severity = @severity';
    params['severity'] = opts.severity;
  }
  if (opts.kinds !== undefined && opts.kinds.length > 0) {
    const placeholders = opts.kinds.map((_, i) => `@kind${i}`).join(', ');
    sql += ` AND kind IN (${placeholders})`;
    opts.kinds.forEach((k, i) => {
      params[`kind${i}`] = k;
    });
  }
  if (opts.search !== undefined && opts.search.trim() !== '') {
    // Single-quoted empty string for the COALESCE fallback — SQLite
    // treats `""` as an identifier reference, not a literal.
    sql +=
      ' AND (LOWER(title) LIKE @search OR LOWER(reason) LIKE @search ' +
      "OR LOWER(COALESCE(match_mask, '')) LIKE @search " +
      "OR LOWER(COALESCE(source_hint, '')) LIKE @search)";
    params['search'] = `%${opts.search.trim().toLowerCase()}%`;
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
  const result = db.prepare('UPDATE security_events SET acknowledged = 1 WHERE id = ?').run(id);
  return result.changes > 0;
}

export function acknowledgeAllSecurityEvents(db: Database.Database, accountId?: string): number {
  const result =
    accountId !== undefined
      ? db
          .prepare(
            'UPDATE security_events SET acknowledged = 1 WHERE acknowledged = 0 AND account_id = ?',
          )
          .run(accountId)
      : db.prepare('UPDATE security_events SET acknowledged = 1 WHERE acknowledged = 0').run();
  return result.changes;
}

export function clearSecurityEvents(db: Database.Database, accountId?: string): number {
  return withChainBridge(db, accountId !== undefined ? 'clear_account' : 'clear_all', () => {
    const rows =
      accountId !== undefined
        ? (db
            .prepare(
              'SELECT payload_hash, ts FROM security_events WHERE account_id = ? ORDER BY id ASC',
            )
            .all(accountId) as Array<{ payload_hash: string; ts: number }>)
        : (db
            .prepare('SELECT payload_hash, ts FROM security_events ORDER BY id ASC')
            .all() as Array<{ payload_hash: string; ts: number }>);
    if (rows.length === 0) return { deletedHashes: [], deletedTs: [] };
    if (accountId !== undefined) {
      db.prepare('DELETE FROM security_events WHERE account_id = ?').run(accountId);
    } else {
      db.prepare('DELETE FROM security_events').run();
    }
    return {
      deletedHashes: rows.map((r) => r.payload_hash),
      deletedTs: rows.map((r) => r.ts),
    };
  });
}

/** Delete OTEL-derived telemetry rows older than the retention window.
 *  Covers usage_events, tool_events, api_errors, and activity_events —
 *  the four tables that grow linearly with Claude Code activity.
 *  Intended to run at daemon startup AND every 24h. Returns the total
 *  number of rows removed across all tables. */
export function purgeTelemetryOlderThan(db: Database.Database, cutoffMs: number): number {
  let total = 0;
  for (const table of ['usage_events', 'tool_events', 'api_errors', 'activity_events'] as const) {
    const result = db.prepare(`DELETE FROM ${table} WHERE ts < ?`).run(cutoffMs);
    total += Number(result.changes);
  }
  return total;
}

/** Delete optimization analyzer rows older than the retention window. Plain
 *  DELETE — `optimization_events` is not part of the security audit chain, so
 *  no chain bridge is needed (unlike `purgeSecurityEventsOlderThan`).
 *  `subagent_installs` is install bookkeeping, NOT telemetry, and is left
 *  untouched — purging it would corrupt the realized/potential LEFT JOIN in
 *  `getOptimizationMetrics`. Returns the number of rows removed. */
export function purgeOptimizationOlderThan(db: Database.Database, cutoffMs: number): number {
  const result = db.prepare('DELETE FROM optimization_events WHERE ts < ?').run(cutoffMs);
  return Number(result.changes);
}

/** Sprint 8 — wrap a destructive operation against `security_events` so
 *  the trigger lets it through and the chain stays internally consistent.
 *
 *  Runs `deleteFn` inside a transaction with the sweep token set. The
 *  `deleteFn` is responsible for SELECTing the rows it's about to remove
 *  (we need their payload_hashes and timestamps to write the summary)
 *  and then DELETE-ing them. After deletion this helper:
 *    1. Writes one row to `security_events_daily_summary` recording
 *       the deletion's chain-tip metadata.
 *    2. Re-links every surviving event whose `prev_hash` pointed at a
 *       just-deleted row to the new summary's payload_hash (so the
 *       chain walker still sees a valid linkage). For retention this
 *       is one row; for ad-hoc deletions (clear, allowlist consume,
 *       account purge) it can be several. */
function withChainBridge(
  db: Database.Database,
  reason: string,
  deleteFn: () => { deletedHashes: string[]; deletedTs: number[] },
): number {
  const run = db.transaction(() => {
    const prevTip = readChainTip(db);
    sweepActive = true;
    try {
      const { deletedHashes, deletedTs } = deleteFn();
      if (deletedHashes.length === 0) return 0;
      const dayTs = Math.max(...deletedTs);
      const first = deletedHashes[0] ?? '';
      const last = deletedHashes[deletedHashes.length - 1] ?? '';
      const deletedHashesJson = JSON.stringify(deletedHashes);
      const summaryPayload = createHash('sha256')
        .update(
          JSON.stringify({
            prevHash: prevTip,
            firstPayloadHash: first,
            lastPayloadHash: last,
            deletedHashes,
            count: deletedHashes.length,
            dayTs,
            reason,
          }),
        )
        .digest('hex');
      db.prepare(
        `INSERT INTO security_events_daily_summary
           (day_ts, count, first_payload_hash, last_payload_hash, prev_hash, payload_hash, reason, deleted_hashes_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        dayTs,
        deletedHashes.length,
        first,
        last,
        prevTip,
        summaryPayload,
        reason,
        deletedHashesJson,
        Date.now(),
      );
      // No re-linking. Survivors keep their original prev_hash (which
      // points at a now-deleted payload_hash). The chain walker reads
      // each summary's `deleted_hashes_json` and treats those hashes
      // as still-known-to-the-chain — bridging every gap without
      // having to mutate any survivor's payload_hash (which would
      // cascade hashes through every downstream row).
      return deletedHashes.length;
    } finally {
      sweepActive = false;
    }
  });
  return run();
}

/** Test-only escape hatch. Lets the tamper-detection tests simulate an
 *  external attacker that already wrote past the trigger (e.g. through
 *  an out-of-band sqlite3 process). Production code should never call
 *  this — `withChainBridge` is the only legitimate gate-flipper. */
export function _setSweepActiveForTests(on: boolean): void {
  sweepActive = on;
}

/** Delete rows older than the retention window, preserving chain
 *  integrity by writing a summary row that captures the deleted range's
 *  payload_hashes. Intended to run at daemon startup AND once per 24h.
 *  Returns the number of rows removed. */
export function purgeSecurityEventsOlderThan(db: Database.Database, cutoffMs: number): number {
  return withChainBridge(db, 'retention', () => {
    const rows = db
      .prepare('SELECT payload_hash, ts FROM security_events WHERE ts < ? ORDER BY id ASC')
      .all(cutoffMs) as Array<{ payload_hash: string; ts: number }>;
    if (rows.length === 0) return { deletedHashes: [], deletedTs: [] };
    db.prepare('DELETE FROM security_events WHERE ts < ?').run(cutoffMs);
    return {
      deletedHashes: rows.map((r) => r.payload_hash),
      deletedTs: rows.map((r) => r.ts),
    };
  });
}

/** One-time auto-demotion of provably-noisy detectors. Selects any
 *  detector that has fired ≥20 times in the last 30 days with **zero**
 *  blocks and **zero** approvals — the dogfood data fingerprint for "pure
 *  acknowledged noise". The caller (daemon startup) merges the returned
 *  ids into `settings.detectorOverrides` as `'informational'`, so future
 *  matches still persist for audit but skip the banner + notification +
 *  broadcast path.
 *
 *  Also bulk-acknowledges existing rows for those detectors so the Alerts
 *  badge stops counting them — the user has already implicitly seen
 *  them. Returns `null` if the migration has already run (idempotent).
 *
 *  Threshold rationale (n=20 / 30d / 0 blocks / 0 approvals):
 *    - n=20 catches truly chronic offenders; one-off bursts (e.g. a
 *      single bad fetch) stay active.
 *    - 0 blocks AND 0 approvals = the user never had to act on this
 *      finding kind. If even one row had been approved by a pending
 *      block, the rule has live value and stays active.
 *
 *  Not called from `getDb`. The daemon entrypoint invokes this after
 *  settings are loaded so it can decide which ids to demote vs. leave
 *  alone (explicit user `'active'`/`'disabled'` choices stick). */
export interface DetectorTuningMigrationResult {
  /** Detector ids the heuristic identified as noisy. */
  demotedIds: string[];
  /** Number of existing `security_events` rows flipped from
   *  acknowledged=0 to 1. Informational only — drives the
   *  one-time notification body. */
  acknowledgedRowCount: number;
}

/** One aggregate row per detector that has fired in the window. Joins
 *  with `settings.detectorOverrides` at the daemon-handler level for the
 *  `override` field — db.ts itself stays settings-agnostic. */
export interface DetectorStatsRowDb {
  detectorId: string;
  total: number;
  blocked: number;
  approved: number;
  acknowledged: number;
  avgConfidence: number;
}

export function listDetectorStats(
  db: Database.Database,
  windowMs: number,
  nowMs: number = Date.now(),
): DetectorStatsRowDb[] {
  const cutoff = nowMs - windowMs;
  const rows = db
    .prepare(
      `SELECT detector_id AS detectorId,
              COUNT(*) AS total,
              SUM(blocked) AS blocked,
              SUM(approved) AS approved,
              SUM(acknowledged) AS acknowledged,
              AVG(confidence) AS avgConfidence
         FROM security_events
        WHERE ts >= ?
        GROUP BY detector_id
        ORDER BY total DESC`,
    )
    .all(cutoff) as Array<{
    detectorId: string;
    total: number;
    blocked: number;
    approved: number;
    acknowledged: number;
    avgConfidence: number;
  }>;
  // SUM() returns null for an empty group; the WHERE+GROUP BY guarantees
  // total ≥ 1, but the type system can't see that. Coerce defensively.
  return rows.map((r) => ({
    detectorId: r.detectorId,
    total: r.total,
    blocked: r.blocked ?? 0,
    approved: r.approved ?? 0,
    acknowledged: r.acknowledged ?? 0,
    avgConfidence: Math.round((r.avgConfidence ?? 0) * 100) / 100,
  }));
}

export function runDetectorTuningMigration(
  db: Database.Database,
  nowMs: number = Date.now(),
): DetectorTuningMigrationResult | null {
  const MIGRATION_NAME = 'detector_tuning_v1';
  const applied = db
    .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
    .get(MIGRATION_NAME) as { ok: number } | undefined;
  if (applied) return null;

  const cutoff = nowMs - 30 * 24 * 3600 * 1000;
  const noisy = db
    .prepare(
      `SELECT detector_id, COUNT(*) AS n
         FROM security_events
        WHERE ts >= ?
        GROUP BY detector_id
       HAVING COUNT(*) >= 20
          AND SUM(blocked) = 0
          AND SUM(approved) = 0
        ORDER BY COUNT(*) DESC`,
    )
    .all(cutoff) as Array<{ detector_id: string; n: number }>;

  const demotedIds = noisy.map((r) => r.detector_id);
  let acknowledgedRowCount = 0;
  if (demotedIds.length > 0) {
    const placeholders = demotedIds.map(() => '?').join(',');
    // Update only unacknowledged rows so we don't churn the index for
    // already-acknowledged entries. Restricted to the demoted ids so a
    // user re-promoting a detector later doesn't inherit a silenced
    // backlog for other still-active detectors.
    const result = db
      .prepare(
        `UPDATE security_events
            SET acknowledged = 1
          WHERE acknowledged = 0
            AND detector_id IN (${placeholders})`,
      )
      .run(...demotedIds);
    acknowledgedRowCount = result.changes;
  }

  db.prepare('INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES (?, ?)').run(
    MIGRATION_NAME,
    nowMs,
  );

  return { demotedIds, acknowledgedRowCount };
}

/** Walk the audit log chain from oldest to newest, recomputing each
 *  row's payload_hash and verifying every prev_hash links to a known
 *  chain element (event row OR summary row). Returns the first break
 *  found, or `{ ok: true }` if the chain is intact. Does NOT throw —
 *  the caller decides whether to log/broadcast/banner. */
export function walkChain(
  db: Database.Database,
):
  | { ok: true; eventCount: number; summaryCount: number; tipPayloadHash: string }
  | { ok: false; brokenAtRowId: number; reason: string } {
  // Build the lookup of every payload_hash the chain has ever
  // contained: live event hashes, summary hashes, and the
  // payload_hashes of events that were deleted but recorded in a
  // summary's `deleted_hashes_json`. The walker treats any prev_hash
  // pointing into this lookup as a satisfied linkage.
  const eventHashes = new Set<string>();
  const summaryHashes = new Set<string>();
  type EventRow = DbSecurityEventRow & { prev_hash: string; payload_hash: string };
  const events = db.prepare('SELECT * FROM security_events ORDER BY id ASC').all() as EventRow[];
  for (const r of events) eventHashes.add(r.payload_hash);
  const summaries = db
    .prepare(
      'SELECT id, prev_hash, payload_hash, deleted_hashes_json FROM security_events_daily_summary ORDER BY id ASC',
    )
    .all() as Array<{
    id: number;
    prev_hash: string;
    payload_hash: string;
    deleted_hashes_json: string;
  }>;
  for (const r of summaries) {
    summaryHashes.add(r.payload_hash);
    try {
      const deleted = JSON.parse(r.deleted_hashes_json) as unknown;
      if (Array.isArray(deleted)) {
        for (const h of deleted) {
          if (typeof h === 'string') summaryHashes.add(h);
        }
      }
      /* v8 ignore next 3 */
    } catch {
      // Malformed JSON in deleted_hashes_json — treat as no recorded
      // hashes. Walker will fall back to flagging any prev_hash
      // referencing the missing range as an orphan.
    }
  }
  for (const row of events) {
    const expected = computePayloadHash({
      ts: row.ts,
      accountId: row.account_id,
      sessionId: row.session_id,
      direction: row.direction,
      severity: row.severity,
      kind: row.kind,
      detectorId: row.detector_id,
      confidence: row.confidence,
      title: row.title,
      reason: row.reason,
      matchMask: row.match_mask,
      matchHash: row.match_hash,
      contextHash: row.context_hash,
      snippet: row.snippet,
      sourceHint: row.source_hint,
      detailsJson: row.details_json,
      provenance: row.provenance,
      prevHash: row.prev_hash,
    });
    if (expected !== row.payload_hash) {
      return {
        ok: false,
        brokenAtRowId: row.id,
        reason: `payload_hash mismatch on event id=${row.id}`,
      };
    }
    if (
      row.prev_hash !== '' &&
      !eventHashes.has(row.prev_hash) &&
      !summaryHashes.has(row.prev_hash)
    ) {
      return {
        ok: false,
        brokenAtRowId: row.id,
        reason: `prev_hash on event id=${row.id} does not link to any known chain element`,
      };
    }
  }
  for (const r of summaries) {
    if (r.prev_hash !== '' && !eventHashes.has(r.prev_hash) && !summaryHashes.has(r.prev_hash)) {
      return {
        ok: false,
        brokenAtRowId: r.id,
        reason: `prev_hash on summary id=${r.id} does not link to any known chain element`,
      };
    }
  }
  const tip = readChainTip(db);
  return {
    ok: true,
    eventCount: events.length,
    summaryCount: summaries.length,
    tipPayloadHash: tip,
  };
}

/** Sprint 8 incident-replay storage. Writes a captured tool-use chain
 *  to `incident_replays` keyed by event id. Overwrites on conflict so
 *  a redundant capture (rare; would require dedup of the same event id
 *  somehow) leaves the most-recent version. */
export interface IncidentReplayMessage {
  ts: number;
  role: string;
  text: string;
  tool?: string;
}
export function insertIncidentReplay(
  db: Database.Database,
  eventId: number,
  capturedAt: number,
  messages: IncidentReplayMessage[],
): void {
  db.prepare(
    `INSERT INTO incident_replays (event_id, captured_at, messages_json)
     VALUES (?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET captured_at = excluded.captured_at, messages_json = excluded.messages_json`,
  ).run(eventId, capturedAt, JSON.stringify(messages));
}

/** Read a captured replay by event id. Returns null when no capture
 *  exists for that event (default — replay is opt-in via the
 *  `securityIncidentReplay` setting). */
export function listIncidentReplay(
  db: Database.Database,
  eventId: number,
): { eventId: number; capturedAt: number; messages: IncidentReplayMessage[] } | null {
  const row = db
    .prepare('SELECT event_id, captured_at, messages_json FROM incident_replays WHERE event_id = ?')
    .get(eventId) as { event_id: number; captured_at: number; messages_json: string } | undefined;
  if (!row) return null;
  let parsed: IncidentReplayMessage[];
  try {
    const j = JSON.parse(row.messages_json) as unknown;
    parsed = Array.isArray(j) ? (j as IncidentReplayMessage[]) : [];
  } catch {
    parsed = [];
  }
  return { eventId: row.event_id, capturedAt: row.captured_at, messages: parsed };
}

/** Read every audit log entry (events + summary bridges) for export.
 *  The export handler in `index.ts` streams these out and computes a
 *  top-level integrity envelope. Optional filters scope what comes back. */
export interface AuditExportEntry {
  kind: 'event' | 'summary';
  id: number;
  ts: number;
  prevHash: string;
  payloadHash: string;
  /** For 'event' entries: the full row (decoded). For 'summary': a
   *  compact metadata block describing what was bridged. */
  data: Record<string, unknown>;
}
export function listAuditExport(
  db: Database.Database,
  opts: { accountId?: string; sinceTs?: number } = {},
): AuditExportEntry[] {
  const params: Record<string, string | number> = {};
  let eventSql = 'SELECT * FROM security_events';
  const eventWhere: string[] = [];
  if (opts.accountId !== undefined) {
    eventWhere.push('account_id = @accountId');
    params['accountId'] = opts.accountId;
  }
  if (opts.sinceTs !== undefined) {
    eventWhere.push('ts >= @sinceTs');
    params['sinceTs'] = opts.sinceTs;
  }
  if (eventWhere.length > 0) eventSql += ' WHERE ' + eventWhere.join(' AND ');
  eventSql += ' ORDER BY id ASC';
  const events = db.prepare(eventSql).all(params) as Array<
    DbSecurityEventRow & { prev_hash: string; payload_hash: string }
  >;
  const summarySql =
    opts.sinceTs !== undefined
      ? 'SELECT * FROM security_events_daily_summary WHERE day_ts >= @sinceTs ORDER BY id ASC'
      : 'SELECT * FROM security_events_daily_summary ORDER BY id ASC';
  const summaries = db.prepare(summarySql).all(params) as Array<{
    id: number;
    day_ts: number;
    count: number;
    first_payload_hash: string;
    last_payload_hash: string;
    prev_hash: string;
    payload_hash: string;
    reason: string;
    created_at: number;
  }>;
  const out: AuditExportEntry[] = [];
  for (const r of events) {
    out.push({
      kind: 'event',
      id: r.id,
      ts: r.ts,
      prevHash: r.prev_hash,
      payloadHash: r.payload_hash,
      data: rowToSecurityEvent(r) as unknown as Record<string, unknown>,
    });
  }
  for (const r of summaries) {
    out.push({
      kind: 'summary',
      id: r.id,
      ts: r.day_ts,
      prevHash: r.prev_hash,
      payloadHash: r.payload_hash,
      data: {
        count: r.count,
        firstPayloadHash: r.first_payload_hash,
        lastPayloadHash: r.last_payload_hash,
        reason: r.reason,
        createdAt: r.created_at,
      },
    });
  }
  out.sort((a, b) => a.ts - b.ts || a.id - b.id);
  return out;
}

/** Unread security event count, optionally scoped to an account. Drives the
 *  Security tab badge. */
export function countUnacknowledgedSecurityEvents(
  db: Database.Database,
  accountId?: string,
): number {
  const row =
    accountId !== undefined
      ? (db
          .prepare(
            'SELECT COUNT(*) AS n FROM security_events WHERE acknowledged = 0 AND account_id = ?',
          )
          .get(accountId) as { n: number })
      : (db.prepare('SELECT COUNT(*) AS n FROM security_events WHERE acknowledged = 0').get() as {
          n: number;
        });
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

  let deletedEvents = 0;
  withChainBridge(db, 'allowlist', () => {
    const rows = db
      .prepare(
        'SELECT payload_hash, ts FROM security_events WHERE match_hash = ? AND detector_id = ? ORDER BY id ASC',
      )
      .all(args.matchHash, args.detectorId) as Array<{ payload_hash: string; ts: number }>;
    if (rows.length === 0) return { deletedHashes: [], deletedTs: [] };
    const res = db
      .prepare('DELETE FROM security_events WHERE match_hash = ? AND detector_id = ?')
      .run(args.matchHash, args.detectorId);
    deletedEvents = Number(res.changes);
    return {
      deletedHashes: rows.map((r) => r.payload_hash),
      deletedTs: rows.map((r) => r.ts),
    };
  });

  return {
    id: row.id,
    deletedEvents,
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

// ─── Permission-bypass queries ───────────────────────────────────────────────

/**
 * True when (rule_id, input_hash) is registered as a user-approved bypass.
 * Called on the hot evaluator path when a deny rule matches — if bypassed,
 * the evaluator flips the decision to 'allow' without emitting a block.
 *
 * Mirrors `isSecurityAllowlisted` in shape (and use site) — the caller owns
 * any caching that's needed on top.
 */
export function isPermissionBypassed(
  db: Database.Database,
  ruleId: string,
  inputHash: string,
): boolean {
  const row = db
    .prepare('SELECT 1 FROM permission_bypass WHERE rule_id = ? AND input_hash = ? LIMIT 1')
    .get(ruleId, inputHash);
  return row !== undefined;
}

export interface AddPermissionBypassArgs {
  ruleId: string;
  toolName: string;
  inputHash: string;
  mask: string;
  note?: string | null;
}

/**
 * Add a (rule_id, input_hash) pair to the bypass table. Idempotent — the
 * UNIQUE constraint drops duplicate inserts silently. Returns the row id
 * of the (possibly-existing) bypass.
 */
export function addPermissionBypass(
  db: Database.Database,
  args: AddPermissionBypassArgs,
): { id: number } {
  const now = Date.now();
  db.prepare(
    `INSERT INTO permission_bypass (rule_id, tool_name, input_hash, mask, note, created_at)
     VALUES (@ruleId, @toolName, @inputHash, @mask, @note, @createdAt)
     ON CONFLICT(rule_id, input_hash) DO NOTHING`,
  ).run({
    ruleId: args.ruleId,
    toolName: args.toolName,
    inputHash: args.inputHash,
    mask: args.mask,
    note: args.note ?? null,
    createdAt: now,
  });
  const row = db
    .prepare('SELECT id FROM permission_bypass WHERE rule_id = ? AND input_hash = ?')
    .get(args.ruleId, args.inputHash) as { id: number };
  return { id: row.id };
}

export function removePermissionBypass(db: Database.Database, id: number): boolean {
  const res = db.prepare('DELETE FROM permission_bypass WHERE id = ?').run(id);
  return res.changes > 0;
}

export interface PermissionBypassRow {
  id: number;
  ruleId: string;
  toolName: string;
  inputHash: string;
  mask: string;
  note: string | null;
  createdAt: number;
}

export function listPermissionBypasses(db: Database.Database): PermissionBypassRow[] {
  const rows = db
    .prepare('SELECT * FROM permission_bypass ORDER BY created_at DESC')
    .all() as Array<{
    id: number;
    rule_id: string;
    tool_name: string;
    input_hash: string;
    mask: string;
    note: string | null;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ruleId: r.rule_id,
    toolName: r.tool_name,
    inputHash: r.input_hash,
    mask: r.mask,
    note: r.note,
    createdAt: r.created_at,
  }));
}

// ─── Rate limit queries ───────────────────────────────────────────────────────

/**
 * Upsert a single rate-limit window for an account.
 * Called after each API response that includes anthropic-ratelimit-* headers.
 */
export function upsertRateLimit(
  db: Database.Database,
  accountId: string,
  window: RateLimitWindow,
): void {
  db.prepare(
    `
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
  `,
  ).run({
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
  const rows = db
    .prepare('SELECT * FROM rate_limits ORDER BY account_id, name')
    .all() as DbRateLimitRow[];
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

// ─── Paused account queries ──────────────────────────────────────────────────

export interface PersistedPause {
  accountId: string;
  reason: string;
  resetTs: number | null;
  pausedAt: number;
}

/**
 * Upsert a paused-account row. Called by SpendTracker whenever an account
 * transitions into a paused state (budget cap tripped, weekly rate limit
 * reached). The reason + resetTs are captured at the moment of the
 * transition so startup rehydration can detect whether the triggering
 * window has rolled over while the daemon was off.
 */
export function upsertPausedAccount(
  db: Database.Database,
  accountId: string,
  reason: string,
  resetTs: number | null,
  pausedAt: number,
): void {
  db.prepare(
    `
    INSERT INTO paused_accounts (account_id, reason, reset_ts, paused_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      reason    = excluded.reason,
      reset_ts  = excluded.reset_ts,
      paused_at = excluded.paused_at
  `,
  ).run(accountId, reason, resetTs, pausedAt);
}

/** Delete a paused-account row. Called by SpendTracker on every
 *  out-of-paused transition (evaluator cleanup, rollover, sweep). */
export function deletePausedAccount(db: Database.Database, accountId: string): void {
  db.prepare('DELETE FROM paused_accounts WHERE account_id = ?').run(accountId);
}

/** Load every persisted paused-account row. Called once at daemon startup
 *  by SpendTracker.loadPersistedPauses to rehydrate the in-memory map. */
export function listPausedAccounts(db: Database.Database): PersistedPause[] {
  const rows = db.prepare('SELECT * FROM paused_accounts').all() as Array<{
    account_id: string;
    reason: string;
    reset_ts: number | null;
    paused_at: number;
  }>;
  return rows.map((r) => ({
    accountId: r.account_id,
    reason: r.reason,
    resetTs: r.reset_ts,
    pausedAt: r.paused_at,
  }));
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
  const scope: AlertScope =
    row.scope === 'pool'
      ? 'pool'
      : row.scope === 'pool-weekly'
        ? 'pool-weekly'
        : row.scope === 'budget'
          ? 'budget'
          : row.scope === 'account-sonnet'
            ? 'account-sonnet'
            : row.scope === 'account-weekly'
              ? 'account-weekly'
              : 'account';
  // Account-bound scopes use their stored account_id; pool and
  // budget-global rows were stored with ''.
  const hasAccountId =
    scope === 'account' ||
    scope === 'account-sonnet' ||
    scope === 'account-weekly' ||
    (scope === 'budget' && row.budget_scope !== 'global');
  const alert: Alert = {
    id: row.id,
    scope,
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
  opts: { scope?: AlertScope; accountId?: string } = {},
): Alert[] {
  const { scope, accountId } = opts;
  // accountId filter implies an account-bound scope; honour scope when
  // explicitly set. Pool scopes ignore accountId; budget branches on both.
  let sql: string;
  let params: unknown[];
  if (scope === 'pool' || scope === 'pool-weekly') {
    sql = 'SELECT * FROM alerts WHERE scope = ? ORDER BY threshold_pct ASC';
    params = [scope];
  } else if (scope === 'budget' && accountId) {
    sql =
      "SELECT * FROM alerts WHERE scope = 'budget' AND account_id = ? ORDER BY threshold_pct ASC";
    params = [accountId];
  } else if (scope === 'budget') {
    sql =
      "SELECT * FROM alerts WHERE scope = 'budget' ORDER BY budget_scope, account_id, threshold_pct ASC";
    params = [];
  } else if (
    (scope === 'account-sonnet' || scope === 'account-weekly' || scope === 'account') &&
    accountId
  ) {
    sql = 'SELECT * FROM alerts WHERE scope = ? AND account_id = ? ORDER BY threshold_pct ASC';
    params = [scope, accountId];
  } else if (scope === 'account-sonnet' || scope === 'account-weekly' || scope === 'account') {
    sql = 'SELECT * FROM alerts WHERE scope = ? ORDER BY account_id, threshold_pct ASC';
    params = [scope];
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
    scope?: AlertScope;
    accountId: string | null;
    thresholdPct: number;
    enabled: boolean;
    budgetScope?: 'account' | 'global';
  },
): Alert {
  const scope = input.scope ?? 'account';
  if ((scope === 'pool' || scope === 'pool-weekly') && input.accountId != null) {
    throw new Error(`${scope}-scoped alerts must have accountId = null`);
  }
  if (
    (scope === 'account' || scope === 'account-sonnet' || scope === 'account-weekly') &&
    !input.accountId
  ) {
    throw new Error(`${scope}-scoped alerts require a non-empty accountId`);
  }
  const budgetScope: 'account' | 'global' | null =
    scope === 'budget' ? (input.budgetScope ?? 'account') : null;
  if (scope === 'budget' && budgetScope === 'account' && !input.accountId) {
    throw new Error('budget-scoped account alerts require a non-empty accountId');
  }
  if (scope === 'budget' && budgetScope === 'global' && input.accountId != null) {
    throw new Error('budget-scoped global alerts must have accountId = null');
  }
  // Pool rows and budget-global rows store '' for the legacy NOT NULL column;
  // normalized back to null by rowToAlert when reading.
  const dbAccountId =
    scope === 'pool' || scope === 'pool-weekly' || (scope === 'budget' && budgetScope === 'global')
      ? ''
      : (input.accountId as string);

  if (input.id !== undefined) {
    db.prepare(
      `
      UPDATE alerts SET scope = ?, account_id = ?, threshold_pct = ?, enabled = ?, budget_scope = ? WHERE id = ?
    `,
    ).run(scope, dbAccountId, input.thresholdPct, input.enabled ? 1 : 0, budgetScope, input.id);
    const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(input.id) as
      | DbAlertRow
      | undefined;
    /* v8 ignore next 1 */
    if (!row) throw new Error(`alert ${input.id} not found after update`);
    return rowToAlert(row);
  }
  const result = db
    .prepare(
      `
    INSERT INTO alerts (scope, account_id, threshold_pct, enabled, budget_scope, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .run(scope, dbAccountId, input.thresholdPct, input.enabled ? 1 : 0, budgetScope, Date.now());
  const row = db
    .prepare('SELECT * FROM alerts WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as DbAlertRow;
  return rowToAlert(row);
}

export function deleteAlert(db: Database.Database, id: number): boolean {
  const result = db.prepare('DELETE FROM alerts WHERE id = ?').run(id);
  return result.changes > 0;
}

export function markAlertTriggered(db: Database.Database, id: number, resetTs: number): void {
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
  resolution: string | null;
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
    resolution: row.resolution as SecurityEvent['resolution'],
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
  const result = db
    .prepare(
      `
    INSERT INTO tool_events (ts, account_id, session_id, tool_name, success, duration_ms, error, decision_source, decision_type, mcp_server_scope, tool_result_size_bytes)
    VALUES (@ts, @accountId, @sessionId, @toolName, @success, @durationMs, @error, @decisionSource, @decisionType, @mcpServerScope, @toolResultSizeBytes)
  `,
    )
    .run({
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
  const result = db
    .prepare(
      `
    INSERT INTO api_errors (ts, account_id, session_id, model, status_code, error, duration_ms, attempt, request_id, speed)
    VALUES (@ts, @accountId, @sessionId, @model, @statusCode, @error, @durationMs, @attempt, @requestId, @speed)
  `,
    )
    .run(e as unknown as Record<string, unknown>);
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
  const result = db
    .prepare(
      `
    INSERT INTO activity_events (ts, account_id, session_id, kind, value, model, tool_name, language, decision, source, name, version, marketplace, extra_json)
    VALUES (@ts, @accountId, @sessionId, @kind, @value, @model, @toolName, @language, @decision, @source, @name, @version, @marketplace, @extraJson)
  `,
    )
    .run({
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

/** Resolve the (days, window) pair the metrics helpers accept into absolute
 *  ts bounds. An explicit window wins (absent edges mean unbounded; untilMs
 *  is exclusive); otherwise the legacy rolling N-day lookback. `untilTs`
 *  uses MAX_SAFE_INTEGER instead of null so callers can always bind it
 *  positionally as `ts < ?`. */
function resolveTsWindow(days: number, win?: MetricsWindow): { sinceTs: number; untilTs: number } {
  if (win) return { sinceTs: win.sinceMs ?? 0, untilTs: win.untilMs ?? Number.MAX_SAFE_INTEGER };
  return { sinceTs: Date.now() - days * 24 * 60 * 60 * 1000, untilTs: Number.MAX_SAFE_INTEGER };
}

/**
 * Per-day, per-model rollup with the full token breakdown (input / output /
 * cacheRead / cacheCreation) plus cost. Drives the Tokens and Cost charts on
 * the Metrics tab. An optional `win` overrides the rolling `days` lookback
 * with absolute bounds (midnight presets, custom ranges, or all-time).
 */
export function getTokensByDayModel(
  db: Database.Database,
  accountIds: string[],
  days: number,
  win?: MetricsWindow,
): Record<string, Record<string, MetricsByDayModel>> {
  if (accountIds.length === 0) return {};
  const { sinceTs, untilTs } = resolveTsWindow(days, win);
  const placeholders = accountIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
       date(ts / 1000, 'unixepoch', 'localtime') AS day,
       model,
       COALESCE(SUM(cost_usd), 0)            AS cost_usd,
       COALESCE(SUM(input_tokens), 0)        AS input_tokens,
       COALESCE(SUM(output_tokens), 0)       AS output_tokens,
       COALESCE(SUM(cache_read), 0)          AS cache_read,
       COALESCE(SUM(cache_create), 0)        AS cache_create
     FROM usage_events
     WHERE account_id IN (${placeholders}) AND ts >= ? AND ts < ?
     GROUP BY day, model
     ORDER BY day ASC`,
    )
    .all(...accountIds, sinceTs, untilTs) as Array<{
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
 * Total input tokens Sentinel has processed (forwarded to Anthropic) over the
 * window, summed across ALL accounts — the "total Sentinel processed"
 * denominator for the Optimize header's savings percentage, so it is
 * deliberately not account-scoped.
 *
 * Sourced from `cache_ttl_events`, which the PROXY writes live from every
 * response's `usage` object — the same request stream that records compression
 * savings. We deliberately do NOT use `usage_events`: that table is populated
 * from Claude Code's OTEL export, which can lag or stall independently of proxy
 * traffic. Using it as the denominator while savings come from the live proxy
 * produced a degenerate "100% saved" whenever OTEL was behind for the window.
 *
 * `inputSideTokens` = `input_tokens + cache_read + cache_create` (the full
 * input side; output is not counted). `win = {}` is all-time.
 */
export function getProcessedTokenTotals(
  db: Database.Database,
  win: MetricsWindow = {},
): ProcessedTokens {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0)                       AS input_tokens,
         COALESCE(SUM(cache_read), 0)                         AS cache_read,
         COALESCE(SUM(cache_create_5m + cache_create_1h), 0)  AS cache_create
       FROM cache_ttl_events
       WHERE (@sinceMs IS NULL OR ts >= @sinceMs)
         AND (@untilMs IS NULL OR ts <  @untilMs)`,
    )
    .get({ sinceMs: win.sinceMs ?? null, untilMs: win.untilMs ?? null }) as {
    input_tokens: number;
    cache_read: number;
    cache_create: number;
  };
  return {
    inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read,
    cacheCreateTokens: row.cache_create,
    inputSideTokens: row.input_tokens + row.cache_read + row.cache_create,
  };
}

/**
 * Cache-hit rate per model over the period. Rate = cacheRead / (input + cacheRead);
 * cache creation tokens are excluded from the denominator since they represent
 * the "first write" of cacheable content rather than a read. An optional `win`
 * overrides the rolling `days` lookback with absolute bounds.
 */
export function getCacheHitRate(
  db: Database.Database,
  accountIds: string[],
  days: number,
  win?: MetricsWindow,
): Record<string, CacheHitRate> {
  if (accountIds.length === 0) return {};
  const { sinceTs, untilTs } = resolveTsWindow(days, win);
  const placeholders = accountIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
       model,
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(cache_read), 0)   AS cache_read
     FROM usage_events
     WHERE account_id IN (${placeholders}) AND ts >= ? AND ts < ?
     GROUP BY model`,
    )
    .all(...accountIds, sinceTs, untilTs) as Array<{
    model: string;
    input_tokens: number;
    cache_read: number;
  }>;

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

// ─── Cache TTL events ─────────────────────────────────────────────────────────

export interface InsertCacheTtlEvent {
  ts: number;
  accountId: string;
  sessionId: string | null;
  model: string;
  requestId: string | null;
  reqMarkers5m: number;
  reqMarkers1h: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  cacheRead: number;
  inputTokens: number;
  cost5mWrite: number;
  cost1hWrite: number;
  costRead: number;
}

export interface CacheTtlDayRow {
  reqMarkers5m: number;
  reqMarkers1h: number;
  create5m: number;
  create1h: number;
  read: number;
  inputTokens: number;
  cost5mWrite: number;
  cost1hWrite: number;
  costRead: number;
}

export interface CacheTtlSessionRow extends CacheTtlDayRow {
  sessionId: string;
  firstTs: number;
  lastTs: number;
  requestCount: number;
  model: string;
}

export function insertCacheTtlEvent(db: Database.Database, event: InsertCacheTtlEvent): number {
  const result = db
    .prepare(
      `
      INSERT INTO cache_ttl_events
        (ts, account_id, session_id, model, request_id,
         req_markers_5m, req_markers_1h,
         cache_create_5m, cache_create_1h, cache_read, input_tokens,
         cost_5m_write, cost_1h_write, cost_read)
      VALUES
        (@ts, @accountId, @sessionId, @model, @requestId,
         @reqMarkers5m, @reqMarkers1h,
         @cacheCreate5m, @cacheCreate1h, @cacheRead, @inputTokens,
         @cost5mWrite, @cost1hWrite, @costRead)
    `,
    )
    .run(event);
  return Number(result.lastInsertRowid);
}

/**
 * Per-day, per-model rollup of cache TTL events. Keyed by `YYYY-MM-DD` then
 * by model so the frontend can stack or split however it likes without a
 * second round-trip. An optional `win` overrides the rolling `days` lookback
 * with absolute bounds.
 */
export function getCacheTtlByDayModel(
  db: Database.Database,
  accountIds: string[],
  days: number,
  win?: MetricsWindow,
): Record<string, Record<string, CacheTtlDayRow>> {
  if (accountIds.length === 0) return {};
  const { sinceTs, untilTs } = resolveTsWindow(days, win);
  const placeholders = accountIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
       date(ts / 1000, 'unixepoch', 'localtime') AS day,
       model                              AS model,
       COALESCE(SUM(req_markers_5m), 0)   AS req_markers_5m,
       COALESCE(SUM(req_markers_1h), 0)   AS req_markers_1h,
       COALESCE(SUM(cache_create_5m), 0)  AS create_5m,
       COALESCE(SUM(cache_create_1h), 0)  AS create_1h,
       COALESCE(SUM(cache_read), 0)       AS cache_read,
       COALESCE(SUM(input_tokens), 0)     AS input_tokens,
       COALESCE(SUM(cost_5m_write), 0)    AS cost_5m_write,
       COALESCE(SUM(cost_1h_write), 0)    AS cost_1h_write,
       COALESCE(SUM(cost_read), 0)        AS cost_read
     FROM cache_ttl_events
     WHERE account_id IN (${placeholders}) AND ts >= ? AND ts < ?
     GROUP BY day, model
     ORDER BY day ASC`,
    )
    .all(...accountIds, sinceTs, untilTs) as Array<{
    day: string;
    model: string;
    req_markers_5m: number;
    req_markers_1h: number;
    create_5m: number;
    create_1h: number;
    cache_read: number;
    input_tokens: number;
    cost_5m_write: number;
    cost_1h_write: number;
    cost_read: number;
  }>;
  const result: Record<string, Record<string, CacheTtlDayRow>> = {};
  for (const r of rows) {
    (result[r.day] ??= {})[r.model] = {
      reqMarkers5m: r.req_markers_5m,
      reqMarkers1h: r.req_markers_1h,
      create5m: r.create_5m,
      create1h: r.create_1h,
      read: r.cache_read,
      inputTokens: r.input_tokens,
      cost5mWrite: r.cost_5m_write,
      cost1hWrite: r.cost_1h_write,
      costRead: r.cost_read,
    };
  }
  return result;
}

/**
 * Prompt-cache health over a window, summed from `cache_ttl_events`. Used by
 * the compression analytics to cross-check that byte savings aren't being
 * erased by cache busting: a hit ratio that drops after enabling compression
 * is the warning sign. `days <= 0` means all-time. Returns a hit ratio of 1
 * when nothing was created (no cache writes = no busting to report).
 */
export function getCacheHealthWindow(
  db: Database.Database,
  accountIds: string[],
  days: number,
): { cacheReadTokens: number; cacheCreateTokens: number; hitRatio: number } {
  return getCacheHealthWindowRange(
    db,
    accountIds,
    days > 0 ? { sinceMs: Date.now() - days * 24 * 60 * 60 * 1000 } : {},
  );
}

/**
 * Window-range variant of {@link getCacheHealthWindow}, taking an explicit
 * `MetricsWindow` (so custom date ranges work). `getCacheHealthWindow(days)`
 * delegates here; `win = {}` is all-time.
 */
export function getCacheHealthWindowRange(
  db: Database.Database,
  accountIds: string[],
  win: MetricsWindow = {},
): { cacheReadTokens: number; cacheCreateTokens: number; hitRatio: number } {
  if (accountIds.length === 0) {
    return { cacheReadTokens: 0, cacheCreateTokens: 0, hitRatio: 1 };
  }
  const placeholders = accountIds.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(cache_read), 0)                          AS read,
         COALESCE(SUM(cache_create_5m + cache_create_1h), 0)   AS created
       FROM cache_ttl_events
       WHERE account_id IN (${placeholders})
         AND (? IS NULL OR ts >= ?)
         AND (? IS NULL OR ts <  ?)`,
    )
    .get(
      ...accountIds,
      win.sinceMs ?? null,
      win.sinceMs ?? null,
      win.untilMs ?? null,
      win.untilMs ?? null,
    ) as { read: number; created: number };
  const read = row.read;
  const created = row.created;
  const total = read + created;
  return {
    cacheReadTokens: read,
    cacheCreateTokens: created,
    hitRatio: total > 0 ? read / total : 1,
  };
}

/**
 * Per-session rollup of cache TTL events, ordered by most-recently-seen.
 * Rows without a session_id are excluded. `limit` caps the result size
 * (default 50) so the UI never renders a runaway list. An optional `win`
 * overrides the rolling `days` lookback with absolute bounds.
 */
export function getCacheTtlBySession(
  db: Database.Database,
  accountIds: string[],
  days: number,
  limit = 50,
  win?: MetricsWindow,
): CacheTtlSessionRow[] {
  if (accountIds.length === 0) return [];
  const { sinceTs, untilTs } = resolveTsWindow(days, win);
  const placeholders = accountIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
       session_id                         AS session_id,
       MIN(ts)                            AS first_ts,
       MAX(ts)                            AS last_ts,
       COUNT(*)                           AS request_count,
       -- Pick a representative model for the session: the most recent one.
       (SELECT model FROM cache_ttl_events e2
         WHERE e2.account_id = cache_ttl_events.account_id
           AND e2.session_id = cache_ttl_events.session_id
         ORDER BY ts DESC LIMIT 1)        AS model,
       COALESCE(SUM(req_markers_5m), 0)   AS req_markers_5m,
       COALESCE(SUM(req_markers_1h), 0)   AS req_markers_1h,
       COALESCE(SUM(cache_create_5m), 0)  AS create_5m,
       COALESCE(SUM(cache_create_1h), 0)  AS create_1h,
       COALESCE(SUM(cache_read), 0)       AS cache_read,
       COALESCE(SUM(input_tokens), 0)     AS input_tokens,
       COALESCE(SUM(cost_5m_write), 0)    AS cost_5m_write,
       COALESCE(SUM(cost_1h_write), 0)    AS cost_1h_write,
       COALESCE(SUM(cost_read), 0)        AS cost_read
     FROM cache_ttl_events
     WHERE account_id IN (${placeholders}) AND ts >= ? AND ts < ? AND session_id IS NOT NULL AND session_id <> ''
     GROUP BY session_id
     ORDER BY last_ts DESC
     LIMIT ?`,
    )
    .all(...accountIds, sinceTs, untilTs, limit) as Array<{
    session_id: string;
    first_ts: number;
    last_ts: number;
    request_count: number;
    model: string | null;
    req_markers_5m: number;
    req_markers_1h: number;
    create_5m: number;
    create_1h: number;
    cache_read: number;
    input_tokens: number;
    cost_5m_write: number;
    cost_1h_write: number;
    cost_read: number;
  }>;
  return rows.map((r) => ({
    sessionId: r.session_id,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    requestCount: r.request_count,
    model: r.model ?? '',
    reqMarkers5m: r.req_markers_5m,
    reqMarkers1h: r.req_markers_1h,
    create5m: r.create_5m,
    create1h: r.create_1h,
    read: r.cache_read,
    inputTokens: r.input_tokens,
    cost5mWrite: r.cost_5m_write,
    cost1hWrite: r.cost_1h_write,
    costRead: r.cost_read,
  }));
}

/** Per-day counts of api_errors grouped by status code + retry-exhausted tally.
 *  An optional `win` overrides the rolling `days` lookback with absolute bounds. */
export function getApiErrorsByDay(
  db: Database.Database,
  accountIds: string[],
  days: number,
  win?: MetricsWindow,
): { byDay: Record<string, Record<string, number>>; retryExhaustedCount: number } {
  if (accountIds.length === 0) return { byDay: {}, retryExhaustedCount: 0 };
  const { sinceTs, untilTs } = resolveTsWindow(days, win);
  const placeholders = accountIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
       date(ts / 1000, 'unixepoch', 'localtime') AS day,
       COALESCE(status_code, 'unknown') AS status_code,
       COUNT(*)                    AS n
     FROM api_errors
     WHERE account_id IN (${placeholders}) AND ts >= ? AND ts < ?
     GROUP BY day, status_code
     ORDER BY day ASC`,
    )
    .all(...accountIds, sinceTs, untilTs) as Array<{
    day: string;
    status_code: string;
    n: number;
  }>;

  const byDay: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    (byDay[r.day] ??= {})[r.status_code] = r.n;
  }

  // Claude Code's CLAUDE_CODE_MAX_RETRIES default is 10; attempt > 10 means
  // retries were exhausted. Uses > so we match what the docs describe.
  const exhaustedRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM api_errors
       WHERE account_id IN (${placeholders}) AND ts >= ? AND ts < ? AND attempt > 10`,
    )
    .get(...accountIds, sinceTs, untilTs) as { n: number };

  return { byDay, retryExhaustedCount: exhaustedRow.n };
}

/**
 * Per-tool rollup: calls, p50/p95 duration, success rate, most common error.
 * Returns tools ordered by call count (highest first). `limit` caps results.
 * An optional `win` overrides the rolling `days` lookback with absolute bounds.
 */
export function getToolStats(
  db: Database.Database,
  accountIds: string[],
  days: number,
  limit = 20,
  win?: MetricsWindow,
): ToolStat[] {
  if (accountIds.length === 0) return [];
  const { sinceTs, untilTs } = resolveTsWindow(days, win);
  const placeholders = accountIds.map(() => '?').join(',');

  // First pass: per-tool totals + success counts
  const totals = db
    .prepare(
      `SELECT
       tool_name,
       COUNT(*) AS calls,
       SUM(success) AS successes
     FROM tool_events
     WHERE account_id IN (${placeholders}) AND ts >= ? AND ts < ?
     GROUP BY tool_name
     ORDER BY calls DESC
     LIMIT ?`,
    )
    .all(...accountIds, sinceTs, untilTs, limit) as Array<{
    tool_name: string;
    calls: number;
    successes: number;
  }>;

  const result: ToolStat[] = [];
  for (const t of totals) {
    // Second pass: percentiles from the sorted duration list. SQLite lacks
    // a built-in percentile function, so we compute it in JS. With multiple
    // account IDs we're computing percentiles over the union of raw rows,
    // which is the "accurate" pooled p50/p95.
    const durations = db
      .prepare(
        `SELECT duration_ms FROM tool_events
       WHERE account_id IN (${placeholders}) AND ts >= ? AND ts < ? AND tool_name = ? AND duration_ms IS NOT NULL
       ORDER BY duration_ms ASC`,
      )
      .all(...accountIds, sinceTs, untilTs, t.tool_name) as Array<{ duration_ms: number }>;

    const p50 = percentile(
      durations.map((r) => r.duration_ms),
      0.5,
    );
    const p95 = percentile(
      durations.map((r) => r.duration_ms),
      0.95,
    );

    // Top error — most common non-null error message for failures
    const topErrorRow = db
      .prepare(
        `SELECT error, COUNT(*) AS n FROM tool_events
       WHERE account_id IN (${placeholders}) AND ts >= ? AND ts < ? AND tool_name = ? AND success = 0 AND error IS NOT NULL
       GROUP BY error ORDER BY n DESC LIMIT 1`,
      )
      .get(...accountIds, sinceTs, untilTs, t.tool_name) as
      | { error: string; n: number }
      | undefined;

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

/** Per-day totals for a set of activity kinds. An optional `win` overrides the
 *  rolling `days` lookback with absolute bounds. */
export function getActivityCounters(
  db: Database.Database,
  accountIds: string[],
  days: number,
  kinds: ActivityKind[],
  win?: MetricsWindow,
): Record<string, Record<ActivityKind, number>> {
  if (kinds.length === 0 || accountIds.length === 0) return {};
  const { sinceTs, untilTs } = resolveTsWindow(days, win);
  const accountPlaceholders = accountIds.map(() => '?').join(',');
  const kindPlaceholders = kinds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
       date(ts / 1000, 'unixepoch', 'localtime') AS day,
       kind,
       COALESCE(SUM(value), COUNT(*)) AS total
     FROM activity_events
     WHERE account_id IN (${accountPlaceholders}) AND ts >= ? AND ts < ? AND kind IN (${kindPlaceholders})
     GROUP BY day, kind
     ORDER BY day ASC`,
    )
    .all(...accountIds, sinceTs, untilTs, ...kinds) as Array<{
    day: string;
    kind: ActivityKind;
    total: number;
  }>;

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
 * An optional `win` overrides the rolling `days` lookback with absolute bounds.
 */
export function getEditAcceptRate(
  db: Database.Database,
  accountIds: string[],
  days: number,
  win?: MetricsWindow,
): { overall: EditAcceptRate; byLanguage: Record<string, EditAcceptRate> } {
  if (accountIds.length === 0) {
    return { overall: { accepts: 0, rejects: 0, rate: 0 }, byLanguage: {} };
  }
  const { sinceTs, untilTs } = resolveTsWindow(days, win);
  const placeholders = accountIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
       COALESCE(language, 'unknown') AS language,
       decision,
       COUNT(*)                       AS n
     FROM activity_events
     WHERE account_id IN (${placeholders}) AND ts >= ? AND ts < ? AND kind = 'edit_decision'
     GROUP BY language, decision`,
    )
    .all(...accountIds, sinceTs, untilTs) as Array<{
    language: string;
    decision: string | null;
    n: number;
  }>;

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
    byLanguage[lang] = {
      accepts: b.accepts,
      rejects: b.rejects,
      rate: total > 0 ? b.accepts / total : 0,
    };
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
 * metric only. An optional `win` overrides the rolling `days` lookback with
 * absolute bounds.
 */
export function getToolDecisionBreakdown(
  db: Database.Database,
  accountIds: string[],
  days: number,
  win?: MetricsWindow,
): ToolDecisionBreakdown {
  if (accountIds.length === 0) {
    return {
      overall: { accepts: 0, rejects: 0, rate: 0 },
      byTool: {},
      bySource: {},
    };
  }
  const { sinceTs, untilTs } = resolveTsWindow(days, win);
  const placeholders = accountIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
       COALESCE(tool_name, 'unknown') AS tool_name,
       COALESCE(source, 'unknown')    AS source,
       decision,
       COUNT(*)                       AS n
     FROM activity_events
     WHERE account_id IN (${placeholders}) AND ts >= ? AND ts < ? AND kind = 'tool_decision'
     GROUP BY tool_name, source, decision`,
    )
    .all(...accountIds, sinceTs, untilTs) as Array<{
    tool_name: string;
    source: string;
    decision: string | null;
    n: number;
  }>;

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
 * arrived without `prompt_length`). An optional `win` overrides the rolling
 * `days` lookback with absolute bounds.
 */
export function getUserPromptStats(
  db: Database.Database,
  accountIds: string[],
  days: number,
  win?: MetricsWindow,
): PromptStats {
  if (accountIds.length === 0) return { total: 0, avgLength: 0, perDay: {} };
  const { sinceTs, untilTs } = resolveTsWindow(days, win);
  const placeholders = accountIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
       strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day,
       COUNT(*)                                                  AS n,
       AVG(value)                                                AS avg_len
     FROM activity_events
     WHERE account_id IN (${placeholders}) AND ts >= ? AND ts < ? AND kind = 'user_prompt'
     GROUP BY day
     ORDER BY day`,
    )
    .all(...accountIds, sinceTs, untilTs) as Array<{
    day: string;
    n: number;
    avg_len: number | null;
  }>;

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

/** Top skills invoked over the period, ordered by invocation count. An optional
 *  `win` overrides the rolling `days` lookback with absolute bounds. */
export function getTopSkills(
  db: Database.Database,
  accountIds: string[],
  days: number,
  limit = 10,
  win?: MetricsWindow,
): SkillUsage[] {
  if (accountIds.length === 0) return [];
  const { sinceTs, untilTs } = resolveTsWindow(days, win);
  const placeholders = accountIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
       name,
       COUNT(*)                 AS n,
       MAX(source)              AS plugin
     FROM activity_events
     WHERE account_id IN (${placeholders}) AND ts >= ? AND ts < ? AND kind = 'skill_activated' AND name IS NOT NULL
     GROUP BY name
     ORDER BY n DESC
     LIMIT ?`,
    )
    .all(...accountIds, sinceTs, untilTs, limit) as Array<{
    name: string;
    n: number;
    plugin: string | null;
  }>;
  return rows.map((r) => ({ name: r.name, count: r.n, plugin: r.plugin }));
}

/**
 * Recent plugin installs for this account. Order is install time descending.
 * Not windowed by `days` — plugin history is valuable even if old.
 */
export function getRecentPlugins(
  db: Database.Database,
  accountIds: string[],
  limit = 10,
): PluginInstall[] {
  if (accountIds.length === 0) return [];
  const placeholders = accountIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ts, name, version, marketplace
     FROM activity_events
     WHERE account_id IN (${placeholders}) AND kind = 'plugin_installed' AND name IS NOT NULL
     ORDER BY ts DESC
     LIMIT ?`,
    )
    .all(...accountIds, limit) as Array<{
    ts: number;
    name: string;
    version: string | null;
    marketplace: string | null;
  }>;
  return rows.map((r) => ({
    name: r.name,
    version: r.version,
    marketplace: r.marketplace,
    installedAt: r.ts,
  }));
}

// ─── Tool permission rules ────────────────────────────────────────────────────

interface DbPermissionRuleRow {
  id: string;
  decision: 'allow' | 'deny' | 'ask';
  tool: string;
  pattern: string | null;
  raw: string;
  note: string | null;
  enabled: number;
  priority: number;
  created_at: number;
  // May be missing on rows inserted before the source column was
  // added. `rowToPermissionRule` coerces the undefined / null to
  // 'local' so consumers always see a concrete value.
  source: 'local' | 'claude-code' | null;
  // Sprint 9: undefined / null when the rule predates the migration
  // or the user left it blank (= global scope).
  project_scope: string | null;
}

function rowToPermissionRule(row: DbPermissionRuleRow): PermissionRule {
  return {
    id: row.id,
    decision: row.decision,
    tool: row.tool,
    pattern: row.pattern,
    raw: row.raw,
    note: row.note,
    enabled: row.enabled === 1,
    priority: row.priority,
    createdAt: row.created_at,
    source: row.source ?? 'local',
    projectScope: row.project_scope ?? null,
  };
}

/** List every permission rule in evaluation order (priority ASC, created_at ASC).
 *  Returns the full set — the rule editor typically needs all of them anyway
 *  and the table stays small (dozens of rows at most). */
export function listPermissionRules(db: Database.Database): PermissionRule[] {
  const rows = db
    .prepare('SELECT * FROM permission_rules ORDER BY priority ASC, created_at ASC')
    .all() as DbPermissionRuleRow[];
  return rows.map(rowToPermissionRule);
}

/** Insert a new rule or update the existing row. Canonical key is `raw` —
 *  a rule's raw text uniquely identifies it, so changing its decision bucket
 *  (allow → ask, deny → ask, etc.) updates the existing row instead of
 *  creating a second one. `id` is honoured as a secondary lookup when
 *  provided (the UI edit path passes it). Auto-assigns a UUID and createdAt
 *  when creating. Priority defaults to `max(existing priorities) + 10` so
 *  new rules append without re-ordering. Returns the full persisted row. */
export function upsertPermissionRule(
  db: Database.Database,
  input: PermissionRuleInput,
): PermissionRule {
  const now = Date.now();
  // Prefer lookup by id when the caller supplied one; fall back to `raw`
  // so an upsert with no id still hits the existing row instead of
  // inserting a duplicate (which would also violate the UNIQUE index
  // on raw added in dedup_permission_rules_v1).
  let existing: DbPermissionRuleRow | undefined;
  if (input.id) {
    existing = db.prepare('SELECT * FROM permission_rules WHERE id = ?').get(input.id) as
      | DbPermissionRuleRow
      | undefined;
  }
  if (!existing) {
    existing = db.prepare('SELECT * FROM permission_rules WHERE raw = ?').get(input.raw) as
      | DbPermissionRuleRow
      | undefined;
  }
  if (existing) {
    const enabled = (input.enabled ?? existing.enabled === 1) ? 1 : 0;
    const priority = input.priority ?? existing.priority;
    // `source` is sticky once set — updates from the UI never change
    // it (a user editing the raw text of an imported rule should
    // still see it as claude-code so the sync engine keeps managing
    // it). The sync engine itself overrides via explicit `source`
    // on the input.
    const source = input.source ?? existing.source ?? 'local';
    // project_scope is freely editable: an empty/missing value means
    // "global" (NULL in SQLite). undefined on the input preserves
    // the existing value so partial updates from non-scope-aware
    // callers don't accidentally clear the scope.
    const projectScope =
      input.projectScope === undefined
        ? (existing.project_scope ?? null)
        : (input.projectScope ?? null);
    db.prepare(
      `UPDATE permission_rules
       SET decision = ?, tool = ?, pattern = ?, raw = ?, note = ?, enabled = ?, priority = ?, source = ?, project_scope = ?
       WHERE id = ?`,
    ).run(
      input.decision,
      input.tool,
      input.pattern,
      input.raw,
      input.note ?? null,
      enabled,
      priority,
      source,
      projectScope,
      existing.id,
    );
    const row = db
      .prepare('SELECT * FROM permission_rules WHERE id = ?')
      .get(existing.id) as DbPermissionRuleRow;
    return rowToPermissionRule(row);
  }
  // Create path.
  const id = input.id ?? randomPermissionRuleId();
  const maxPriority = (
    db.prepare('SELECT COALESCE(MAX(priority), 0) AS p FROM permission_rules').get() as {
      p: number;
    }
  ).p;
  const priority = input.priority ?? maxPriority + 10;
  const enabled = (input.enabled ?? true) ? 1 : 0;
  const source = input.source ?? 'local';
  const projectScope = input.projectScope ?? null;
  db.prepare(
    `INSERT INTO permission_rules (id, decision, tool, pattern, raw, note, enabled, priority, created_at, source, project_scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.decision,
    input.tool,
    input.pattern,
    input.raw,
    input.note ?? null,
    enabled,
    priority,
    now,
    source,
    projectScope,
  );
  const row = db
    .prepare('SELECT * FROM permission_rules WHERE id = ?')
    .get(id) as DbPermissionRuleRow;
  return rowToPermissionRule(row);
}

// ─── Sprint 9 — Session approval grants ────────────────────────────────

/** Insert (or upsert) a session-scoped approval. Used when the user
 *  picks "Approve for session" on a pending banner. The rule_key is
 *  the canonical `tool|pattern` form so a deny rule rewritten to allow
 *  the same input survives the change. expires_at is in unix ms. */
export function insertSessionGrant(
  db: Database.Database,
  args: { sessionId: string; ruleKey: string; nowMs: number; expiresAtMs: number },
): void {
  db.prepare(
    `INSERT INTO session_approval_grants (session_id, rule_key, granted_at, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, rule_key) DO UPDATE SET
       granted_at = excluded.granted_at,
       expires_at = excluded.expires_at`,
  ).run(args.sessionId, args.ruleKey, args.nowMs, args.expiresAtMs);
}

/** True iff a non-expired grant exists for this (session_id, rule_key)
 *  pair. Lazily prunes the matched row when expired so the table doesn't
 *  grow unbounded between explicit sweeps. */
export function findSessionGrant(
  db: Database.Database,
  args: { sessionId: string; ruleKey: string; nowMs: number },
): boolean {
  const row = db
    .prepare('SELECT expires_at FROM session_approval_grants WHERE session_id = ? AND rule_key = ?')
    .get(args.sessionId, args.ruleKey) as { expires_at: number } | undefined;
  if (!row) return false;
  if (row.expires_at <= args.nowMs) {
    db.prepare('DELETE FROM session_approval_grants WHERE session_id = ? AND rule_key = ?').run(
      args.sessionId,
      args.ruleKey,
    );
    return false;
  }
  return true;
}

/** Sweep all expired grants. Called at startup and periodically by the
 *  housekeeping path. */
export function pruneExpiredSessionGrants(db: Database.Database, nowMs: number): number {
  const result = db.prepare('DELETE FROM session_approval_grants WHERE expires_at <= ?').run(nowMs);
  return result.changes;
}

// ─── Sprint 9 — Approval-event audit ───────────────────────────────────

/** Append an approval-event row. Caller (enforcer) records on every
 *  approve outcome so the banner's "approved 5x in 5min" surface has a
 *  durable count. */
export function recordApprovalEvent(
  db: Database.Database,
  args: { sessionId: string; ruleKey: string; approvedAtMs: number },
): void {
  db.prepare(
    'INSERT INTO approval_events (session_id, rule_key, approved_at) VALUES (?, ?, ?)',
  ).run(args.sessionId, args.ruleKey, args.approvedAtMs);
}

/** Count approves of `(sessionId, ruleKey)` in the window
 *  `[sinceMs, +inf)`. */
export function countRecentApprovals(
  db: Database.Database,
  args: { sessionId: string; ruleKey: string; sinceMs: number },
): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM approval_events WHERE session_id = ? AND rule_key = ? AND approved_at >= ?',
    )
    .get(args.sessionId, args.ruleKey, args.sinceMs) as { n: number };
  return row.n;
}

export function deletePermissionRule(db: Database.Database, id: string): boolean {
  const result = db.prepare('DELETE FROM permission_rules WHERE id = ?').run(id);
  return result.changes > 0;
}

function randomPermissionRuleId(): string {
  return randomUUID();
}

// ─── Optimize feature: tool_calls ─────────────────────────────────────────────

export interface InsertToolCall {
  ts: number;
  accountId: string;
  sessionId: string | null;
  requestId: string | null;
  requestSeqInSession: number | null;
  toolUseId: string | null;
  toolName: string;
  filePath: string | null;
  inputSizeBytes: number;
  responseSizeBytes: number | null;
  denied: boolean;
  model: string;
}

export interface ToolCallRow {
  id: number;
  ts: number;
  accountId: string;
  sessionId: string | null;
  requestId: string | null;
  requestSeqInSession: number | null;
  toolUseId: string | null;
  toolName: string;
  filePath: string | null;
  inputSizeBytes: number;
  responseSizeBytes: number | null;
  wasQuotedInLaterTurn: boolean | null;
  denied: boolean;
  model: string;
  attributedInputTokens: number | null;
  attributedCachedTokens: number | null;
}

interface DbToolCallRow {
  id: number;
  ts: number;
  account_id: string;
  session_id: string | null;
  request_id: string | null;
  request_seq_in_session: number | null;
  tool_use_id: string | null;
  tool_name: string;
  file_path: string | null;
  input_size_bytes: number;
  response_size_bytes: number | null;
  was_quoted_in_later_turn: number | null;
  denied: number;
  model: string;
  attributed_input_tokens: number | null;
  attributed_cached_tokens: number | null;
}

function rowToToolCall(row: DbToolCallRow): ToolCallRow {
  return {
    id: row.id,
    ts: row.ts,
    accountId: row.account_id,
    sessionId: row.session_id,
    requestId: row.request_id,
    requestSeqInSession: row.request_seq_in_session,
    toolUseId: row.tool_use_id,
    toolName: row.tool_name,
    filePath: row.file_path,
    inputSizeBytes: row.input_size_bytes,
    responseSizeBytes: row.response_size_bytes,
    wasQuotedInLaterTurn:
      row.was_quoted_in_later_turn === null ? null : row.was_quoted_in_later_turn === 1,
    denied: row.denied === 1,
    model: row.model,
    attributedInputTokens: row.attributed_input_tokens,
    attributedCachedTokens: row.attributed_cached_tokens,
  };
}

export function insertToolCall(db: Database.Database, e: InsertToolCall): number {
  const result = db
    .prepare(
      `
      INSERT INTO tool_calls (
        ts, account_id, session_id, request_id, request_seq_in_session, tool_use_id,
        tool_name, file_path, input_size_bytes, response_size_bytes, denied, model
      ) VALUES (
        @ts, @accountId, @sessionId, @requestId, @requestSeqInSession, @toolUseId,
        @toolName, @filePath, @inputSizeBytes, @responseSizeBytes, @denied, @model
      )
    `,
    )
    .run({
      ts: e.ts,
      accountId: e.accountId,
      sessionId: e.sessionId,
      requestId: e.requestId,
      requestSeqInSession: e.requestSeqInSession,
      toolUseId: e.toolUseId,
      toolName: e.toolName,
      filePath: e.filePath,
      inputSizeBytes: e.inputSizeBytes,
      responseSizeBytes: e.responseSizeBytes,
      denied: e.denied ? 1 : 0,
      model: e.model,
    });
  return Number(result.lastInsertRowid);
}

/**
 * Find a recently-recorded tool_calls row by tool_use_id within a session.
 * Used when a later request brings tool_result blocks for the prior turn:
 * the extractor walks each tool_result, looks up the matching prior row by
 * tool_use_id, and backfills response_size_bytes.
 */
export function findToolCallByToolUseId(
  db: Database.Database,
  toolUseId: string,
): ToolCallRow | null {
  const row = db
    .prepare('SELECT * FROM tool_calls WHERE tool_use_id = ? LIMIT 1')
    .get(toolUseId) as DbToolCallRow | undefined;
  return row ? rowToToolCall(row) : null;
}

export function listRecentToolCalls(
  db: Database.Database,
  opts: { sessionId?: string; sinceMs?: number; limit?: number },
): ToolCallRow[] {
  let sql = 'SELECT * FROM tool_calls WHERE 1=1';
  const params: Record<string, string | number> = {};
  if (opts.sessionId !== undefined) {
    sql += ' AND session_id = @sessionId';
    params['sessionId'] = opts.sessionId;
  }
  if (opts.sinceMs !== undefined) {
    sql += ' AND ts >= @sinceMs';
    params['sinceMs'] = opts.sinceMs;
  }
  sql += ' ORDER BY ts DESC';
  if (opts.limit !== undefined) {
    sql += ' LIMIT @limit';
    params['limit'] = opts.limit;
  }
  const rows = db.prepare(sql).all(params) as DbToolCallRow[];
  return rows.map(rowToToolCall);
}

export function backfillToolCallResponseSize(
  db: Database.Database,
  toolCallId: number,
  bytes: number,
): boolean {
  const result = db
    .prepare('UPDATE tool_calls SET response_size_bytes = ? WHERE id = ?')
    .run(bytes, toolCallId);
  return result.changes > 0;
}

export function backfillToolCallQuoteDetection(
  db: Database.Database,
  toolCallId: number,
  wasQuoted: boolean,
): boolean {
  const result = db
    .prepare('UPDATE tool_calls SET was_quoted_in_later_turn = ? WHERE id = ?')
    .run(wasQuoted ? 1 : 0, toolCallId);
  return result.changes > 0;
}

// ─── Optimize feature: optimization_events ────────────────────────────────────

export type OptimizationEventKind = 'recommended' | 'installed' | 'dismissed' | 'measured';

export interface InsertOptimizationEvent {
  ts: number;
  accountId: string;
  sessionId: string | null;
  curatedId: string;
  kind: OptimizationEventKind;
  pattern: string | null;
  savingsUsd: number | null;
  actualInputTokens: number | null;
  actualCachedTokens: number | null;
  actualCostUsd: number | null;
  hypotheticalCostUsd: number | null;
  /** Total input tokens the hypothetical (subagent) path would have
   *  consumed, for the dashboard's tokens-toggle render. Pass null on
   *  non-`measured` rows where the savings calculator wasn't run
   *  (e.g. dismissed / installed bookkeeping rows). */
  hypotheticalTotalTokens: number | null;
  sourceToolCallIds: number[];
}

export function insertOptimizationEvent(db: Database.Database, e: InsertOptimizationEvent): number {
  const result = db
    .prepare(
      `
      INSERT INTO optimization_events (
        ts, account_id, session_id, curated_id, kind, pattern,
        savings_usd, actual_input_tokens, actual_cached_tokens,
        actual_cost_usd, hypothetical_cost_usd, hypothetical_total_tokens,
        source_tool_call_ids
      ) VALUES (
        @ts, @accountId, @sessionId, @curatedId, @kind, @pattern,
        @savingsUsd, @actualInputTokens, @actualCachedTokens,
        @actualCostUsd, @hypotheticalCostUsd, @hypotheticalTotalTokens,
        @sourceToolCallIds
      )
    `,
    )
    .run({
      ts: e.ts,
      accountId: e.accountId,
      sessionId: e.sessionId,
      curatedId: e.curatedId,
      kind: e.kind,
      pattern: e.pattern,
      savingsUsd: e.savingsUsd,
      actualInputTokens: e.actualInputTokens,
      actualCachedTokens: e.actualCachedTokens,
      actualCostUsd: e.actualCostUsd,
      hypotheticalCostUsd: e.hypotheticalCostUsd,
      hypotheticalTotalTokens: e.hypotheticalTotalTokens,
      sourceToolCallIds: JSON.stringify(e.sourceToolCallIds),
    });
  return Number(result.lastInsertRowid);
}

/**
 * True iff a row matching (account_id, session_id, curated_id, pattern)
 * was inserted on or after `sinceMs`. The analyzer uses this to dedup
 * `kind='measured'` writes — a single session that fits a heuristic on
 * every 5-min poll shouldn't accumulate many duplicate measured rows.
 *
 * `kind` is intentionally not part of the dedup key: a session that
 * already has a `recommended` row should also suppress a follow-up
 * `measured` row for the same pattern (we have ONE measurement per
 * (session, curated_id, pattern) and the bucket distinction comes from
 * the JOIN with `subagent_installs`).
 */
export function hasRecentOptimizationEvent(
  db: Database.Database,
  args: {
    accountId: string;
    sessionId: string | null;
    curatedId: string;
    pattern: string;
    sinceMs: number;
  },
): boolean {
  const sql =
    args.sessionId === null
      ? 'SELECT 1 AS ok FROM optimization_events WHERE account_id = ? AND session_id IS NULL AND curated_id = ? AND pattern = ? AND ts >= ? LIMIT 1'
      : 'SELECT 1 AS ok FROM optimization_events WHERE account_id = ? AND session_id = ? AND curated_id = ? AND pattern = ? AND ts >= ? LIMIT 1';
  const row =
    args.sessionId === null
      ? db.prepare(sql).get(args.accountId, args.curatedId, args.pattern, args.sinceMs)
      : db
          .prepare(sql)
          .get(args.accountId, args.sessionId, args.curatedId, args.pattern, args.sinceMs);
  return row !== undefined;
}

interface DbOptimizationEventRow {
  id: number;
  ts: number;
  account_id: string;
  session_id: string | null;
  curated_id: string;
  kind: string;
  pattern: string | null;
  savings_usd: number | null;
  actual_input_tokens: number | null;
  actual_cached_tokens: number | null;
  actual_cost_usd: number | null;
  hypothetical_cost_usd: number | null;
  source_tool_call_ids: string | null;
}

export interface OptimizationEventRow {
  id: number;
  ts: number;
  accountId: string;
  sessionId: string | null;
  curatedId: string;
  kind: OptimizationEventKind;
  pattern: string | null;
  savingsUsd: number | null;
}

function rowToOptimizationEvent(row: DbOptimizationEventRow): OptimizationEventRow {
  return {
    id: row.id,
    ts: row.ts,
    accountId: row.account_id,
    sessionId: row.session_id,
    curatedId: row.curated_id,
    kind: row.kind as OptimizationEventKind,
    pattern: row.pattern,
    savingsUsd: row.savings_usd,
  };
}

/**
 * Aggregate savings totals plus a per-day series, split into buckets:
 *
 *   - **realized**: opportunity timestamp falls inside an active install
 *     window for the matching curated subagent
 *     (subagent_installs.installed_at ≤ ts < uninstalled_at OR uninstalled_at IS NULL)
 *   - **potential**: opportunity exists but no active install for that
 *     curated_id at the time
 *
 * Only `kind='measured'` rows count toward savings. The realized/
 * potential split is determined by a LEFT JOIN with subagent_installs
 * keyed on curated_id and timestamp — a multi-install / reinstall
 * history would need a separate audit table for full precision; v1
 * uses the latest install row's window only.
 *
 * `installs` returns the count of currently-active subagent_installs
 * rows (uninstalled_at IS NULL) — drives the "N subagents installed"
 * label in the dashboard header. It is a point-in-time count and is
 * intentionally NOT filtered by `win` (the active-subagent count isn't a
 * windowed quantity).
 *
 * `win` narrows the measured rows to a time range (by `oe.ts`); default `{}`
 * is all-time. Only the row set narrows — every returned shape is identical.
 *
 * Headline buckets count BENEFICIAL rows only: a measured row whose
 * estimated savings is non-positive in both units (tokens and dollars) is
 * a misfit — routing through the subagent would have cost more than the
 * inline read — and contributes to no bucket, no opportunity count, and no
 * denominator. Counted rows accumulate per-unit clamped at zero, so the
 * dashboard's Saved/Potential tiles can never read negative in either unit
 * view. Misfit rows stay queryable in the drill-down list
 * (`listOptimizationEventsWithSources`, the regressions filter), which is
 * the deliberate surface for "this install backfires" signals.
 */
export function getOptimizationMetrics(
  db: Database.Database,
  win: MetricsWindow = {},
): OptimizationMetrics {
  // Bucket each measured row by realized/potential via a LEFT JOIN.
  // SQLite's COALESCE handles the no-matching-install case. `curated_id`
  // is included so the same loop can build a per-subagent breakdown
  // alongside the daily series.
  //
  // We also pull `actual_input_tokens` and `hypothetical_total_tokens`
  // so the dashboard can render savings in tokens (the user-preferred
  // default for Claude Code subscription users where dollars don't map
  // to billable activity).
  const rows = db
    .prepare(
      `
      SELECT
        date(oe.ts / 1000, 'unixepoch', 'localtime') AS day,
        oe.curated_id                        AS curated_id,
        oe.pattern                           AS pattern,
        oe.savings_usd                       AS savings_usd,
        oe.actual_input_tokens               AS actual_input_tokens,
        oe.hypothetical_total_tokens         AS hypothetical_total_tokens,
        CASE
          WHEN si.installed_at IS NOT NULL
            AND si.installed_at <= oe.ts
            AND (si.uninstalled_at IS NULL OR si.uninstalled_at > oe.ts)
          THEN 1 ELSE 0
        END AS is_realized
      FROM optimization_events oe
      LEFT JOIN subagent_installs si ON si.curated_id = oe.curated_id
      WHERE oe.kind = 'measured' AND oe.savings_usd IS NOT NULL
        AND (@sinceMs IS NULL OR oe.ts >= @sinceMs)
        AND (@untilMs IS NULL OR oe.ts <  @untilMs)
    `,
    )
    .all({ sinceMs: win.sinceMs ?? null, untilMs: win.untilMs ?? null }) as Array<{
    day: string;
    curated_id: string;
    pattern: string | null;
    savings_usd: number;
    actual_input_tokens: number | null;
    hypothetical_total_tokens: number | null;
    is_realized: number;
  }>;

  /** Parent-context-tokens savings: how many fewer tokens flow into the
   *  parent conversation when the subagent absorbs the read. Equal to
   *  `hypoInputTokens − digestTokens`, where hypoInputTokens is what
   *  the subagent reads cold and digestTokens is what the parent
   *  re-injects. Always positive when the file is bigger than the
   *  digest, which matches the user-mental model of "context saved" —
   *  and NEGATIVE when the digest exceeds the absorbed read (a misfit;
   *  the beneficial gate below keeps such rows out of the headline).
   *  Pre-migration rows whose hypothetical_total_tokens is NULL
   *  contribute 0 — deliberately conflated with "zero token benefit" so
   *  the gate judges them on dollars alone. */
  const tokenSavings = (r: {
    hypothetical_total_tokens: number | null;
    curated_id: string;
  }): number => {
    if (r.hypothetical_total_tokens === null) return 0;
    const digest = getDigestTokens(r.curated_id);
    const hypoInputTokens = r.hypothetical_total_tokens - digest;
    return hypoInputTokens - digest;
  };

  interface BucketTokens {
    realized: number;
    potential: number;
    tokensRealized: number;
    tokensPotential: number;
  }
  const daily = new Map<string, BucketTokens>();
  const bySubagent = new Map<string, BucketTokens & { opportunities: number }>();
  // Per-(day, curated_id) and per-pattern aggregates power the
  // "by subagent over time" and "by pattern" charts. Built in the same
  // single pass so we don't re-query SQLite. Composite key for daily-by-
  // subagent uses '\x1f' (ASCII Unit Separator) since neither YYYY-MM-DD
  // nor curated_id slugs ever contain it.
  const dailyBySubagent = new Map<string, BucketTokens & { day: string; curatedId: string }>();
  const byPattern = new Map<string, BucketTokens & { opportunities: number }>();
  const emptyBucket = (): BucketTokens => ({
    realized: 0,
    potential: 0,
    tokensRealized: 0,
    tokensPotential: 0,
  });
  let totalRealized = 0;
  let totalPotential = 0;
  let totalTokensRealized = 0;
  let totalTokensPotential = 0;
  // Gross subagent read tokens (hypoInputTokens) for REALIZED rows only — the
  // subagent half of the denominator for the "% of optimized content" ratio.
  // Realized-only so it pairs with `tokensRealized` (the realized savings the
  // header's percentage divides). Distinct from the net savings totals above.
  let totalHypoInput = 0;
  // Rows that pass the beneficial gate; replaces `rows.length` as the
  // headline opportunity count so misfit rows aren't advertised as
  // opportunities.
  let totalOpportunities = 0;
  for (const r of rows) {
    const dailySlot = daily.get(r.day) ?? emptyBucket();
    const subSlot = bySubagent.get(r.curated_id) ?? { ...emptyBucket(), opportunities: 0 };
    const dbsKey = `${r.day}\x1f${r.curated_id}`;
    const dbsSlot = dailyBySubagent.get(dbsKey) ?? {
      ...emptyBucket(),
      day: r.day,
      curatedId: r.curated_id,
    };
    // Pre-pattern rows (analyzer didn't record one) bucket under the
    // sentinel '__none__' so they're still visible in the chart rather
    // than silently dropped. Won't occur on freshly captured data.
    const patternKey = r.pattern ?? '__none__';
    const patSlot = byPattern.get(patternKey) ?? { ...emptyBucket(), opportunities: 0 };
    const tokens = tokenSavings(r);
    // Beneficial gate (see the function doc): a row that helps the user in
    // NEITHER unit is a misfit, visible only in the drill-down list. NULL
    // token rows have tokens === 0, so they pass purely on dollars.
    if (tokens <= 0 && r.savings_usd <= 0) continue;
    // Per-unit clamp: a token-positive row whose dollar estimate is noise
    // (cache-read-dominated turns price near zero) counts its tokens but
    // contributes $0, and vice versa — neither unit view can go negative.
    const tokensContrib = Math.max(0, tokens);
    const usdContrib = Math.max(0, r.savings_usd);
    // Gross hypothetical input = net savings + the digest re-injected into the
    // parent (tokens = hypoInput − digest). NULL rows contribute 0, and a
    // row whose tokens were clamped out of the numerator must stay out of
    // the "% of optimized content" denominator too.
    const grossHypoInput =
      r.hypothetical_total_tokens === null || tokensContrib === 0
        ? 0
        : tokens + getDigestTokens(r.curated_id);
    if (r.is_realized === 1) {
      dailySlot.realized += usdContrib;
      dailySlot.tokensRealized += tokensContrib;
      subSlot.realized += usdContrib;
      subSlot.tokensRealized += tokensContrib;
      dbsSlot.realized += usdContrib;
      dbsSlot.tokensRealized += tokensContrib;
      patSlot.realized += usdContrib;
      patSlot.tokensRealized += tokensContrib;
      totalRealized += usdContrib;
      totalTokensRealized += tokensContrib;
      totalHypoInput += grossHypoInput;
    } else {
      dailySlot.potential += usdContrib;
      dailySlot.tokensPotential += tokensContrib;
      subSlot.potential += usdContrib;
      subSlot.tokensPotential += tokensContrib;
      dbsSlot.potential += usdContrib;
      dbsSlot.tokensPotential += tokensContrib;
      patSlot.potential += usdContrib;
      patSlot.tokensPotential += tokensContrib;
      totalPotential += usdContrib;
      totalTokensPotential += tokensContrib;
    }
    totalOpportunities += 1;
    subSlot.opportunities += 1;
    patSlot.opportunities += 1;
    daily.set(r.day, dailySlot);
    bySubagent.set(r.curated_id, subSlot);
    dailyBySubagent.set(dbsKey, dbsSlot);
    byPattern.set(patternKey, patSlot);
  }

  const installsRow = db
    .prepare('SELECT COUNT(*) AS n FROM subagent_installs WHERE uninstalled_at IS NULL')
    .get() as { n: number };

  // Sort highest combined impact first so the dashboard naturally
  // surfaces the biggest savings (or biggest missed opportunity) at the
  // top of the curated list.
  const bySubagentArr: OptimizationMetricsBySubagent[] = [...bySubagent.entries()]
    .map(([curatedId, v]) => ({
      curatedId,
      savingsRealized: v.realized,
      savingsPotential: v.potential,
      tokensRealized: v.tokensRealized,
      tokensPotential: v.tokensPotential,
      opportunities: v.opportunities,
    }))
    .sort(
      (a, b) => b.savingsRealized + b.savingsPotential - (a.savingsRealized + a.savingsPotential),
    );

  const dailyBySubagentArr = [...dailyBySubagent.values()]
    .map((v) => ({
      day: v.day,
      curatedId: v.curatedId,
      savingsRealized: v.realized,
      savingsPotential: v.potential,
      tokensRealized: v.tokensRealized,
      tokensPotential: v.tokensPotential,
    }))
    .sort((a, b) => {
      const d = a.day.localeCompare(b.day);
      return d !== 0 ? d : a.curatedId.localeCompare(b.curatedId);
    });

  // Highest combined impact first, mirroring `bySubagent` ordering so
  // the chart's left/top bars are always the patterns the user cares
  // about most.
  const byPatternArr = [...byPattern.entries()]
    .map(([pattern, v]) => ({
      pattern,
      opportunities: v.opportunities,
      savingsRealized: v.realized,
      savingsPotential: v.potential,
      tokensRealized: v.tokensRealized,
      tokensPotential: v.tokensPotential,
    }))
    .sort(
      (a, b) => b.savingsRealized + b.savingsPotential - (a.savingsRealized + a.savingsPotential),
    );

  return {
    totals: {
      savingsUsdRealized: totalRealized,
      savingsUsdPotential: totalPotential,
      tokensRealized: totalTokensRealized,
      tokensPotential: totalTokensPotential,
      hypotheticalInputTokens: totalHypoInput,
      opportunities: totalOpportunities,
      installs: installsRow.n,
    },
    daily: [...daily.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, v]) => ({
        day,
        savingsRealized: v.realized,
        savingsPotential: v.potential,
        tokensRealized: v.tokensRealized,
        tokensPotential: v.tokensPotential,
      })),
    bySubagent: bySubagentArr,
    dailyBySubagent: dailyBySubagentArr,
    byPattern: byPatternArr,
  };
}

/**
 * List recent measured rows for ad-hoc inspection. Currently used by
 * tests; kept exported so a future "what triggered this savings number?"
 * UI can drill in.
 */
export function listRecentOptimizationEvents(
  db: Database.Database,
  opts: { kind?: OptimizationEventKind; limit?: number } = {},
): OptimizationEventRow[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
  const rows = (
    opts.kind === undefined
      ? db.prepare('SELECT * FROM optimization_events ORDER BY ts DESC LIMIT ?').all(limit)
      : db
          .prepare('SELECT * FROM optimization_events WHERE kind = ? ORDER BY ts DESC LIMIT ?')
          .all(opts.kind, limit)
  ) as DbOptimizationEventRow[];
  return rows.map(rowToOptimizationEvent);
}

/** Slim summary of a tool_call linked from an optimization_event. We
 *  intentionally don't expose response or input bodies — only the
 *  metadata the dashboard needs to explain "this saving counts because
 *  Sentinel observed these reads/edits." */
export interface ToolCallSummary {
  id: number;
  ts: number;
  toolName: string;
  filePath: string | null;
  responseSizeBytes: number | null;
  denied: boolean;
}

/** Drill-down shape: one optimization_event plus the tool_calls that
 *  drove it, plus a precomputed `realized` flag matching the same join
 *  semantics as `getOptimizationMetrics`. */
export interface OptimizationEventWithSources {
  id: number;
  ts: number;
  accountId: string;
  sessionId: string | null;
  curatedId: string;
  kind: OptimizationEventKind;
  pattern: string | null;
  savingsUsd: number | null;
  actualCostUsd: number | null;
  hypotheticalCostUsd: number | null;
  actualInputTokens: number | null;
  hypotheticalTotalTokens: number | null;
  /** Digest size for this row's curated_id; lets the UI compute the
   *  parent-context tokens framing locally. */
  digestTokens: number;
  realized: boolean;
  sourceCalls: ToolCallSummary[];
}

interface DbOptimizationEventWithRealizedRow extends DbOptimizationEventRow {
  is_realized: number;
  actual_cost_usd: number | null;
  hypothetical_cost_usd: number | null;
  hypothetical_total_tokens: number | null;
}

export interface ListOptimizationEventsResult {
  events: OptimizationEventWithSources[];
  /** Total matching rows ignoring `limit`/`offset`, for client-side
   *  pagination UI. Counted with the same WHERE clause + the realized
   *  filter applied post-query (matching the LEFT JOIN's CASE
   *  semantics), so "Page X of Y" stays accurate when filters narrow
   *  the result set. */
  total: number;
}

/** Half-cent floor for the "regression" filter — matches the UI's
 *  regression-pill threshold so the chip and the pill agree on what
 *  counts as a misfit subagent. Negative because savings = actual − hypo;
 *  rows where the hypothetical path would have cost more than the
 *  inline path read negative. */
const SAVINGS_REGRESSION_THRESHOLD_USD = -0.005;
/** Mirror of the same noise floor on the positive side. The "Potential"
 *  filter excludes rows at or below this dollar value so misfit-warning
 *  rows ("subagent would have cost more") don't surface alongside real
 *  opportunities. */
const SAVINGS_POSITIVE_THRESHOLD_USD = 0.005;

/**
 * Drill-down query for the Optimize dashboard's opportunity list.
 * Joins each optimization_event with subagent_installs (same realized
 * semantics as `getOptimizationMetrics`), then resolves
 * `source_tool_call_ids` into inline `ToolCallSummary[]`s via a single
 * follow-up `SELECT ... WHERE id IN (...)`.
 *
 * Filters:
 *   - `kind` / `curatedId` / `realized` — narrow which rows match
 *   - `regressionsOnly` — pins kind='measured', realized=true, and
 *     savings_usd ≤ -0.005. The "show me my misfit installs" filter.
 *   - `search` — case-insensitive LIKE against curated_id, pattern,
 *      and session_id. File-path search is deferred (would require
 *      joining tool_calls or denormalising paths into this table).
 *   - `window` — absolute `oe.ts` bounds from the Optimize page's range
 *      selector; an empty/omitted window is all-time. Applies to both
 *      the page rows and the pagination `total`.
 *   - `limit` (1–500) and `offset` (≥0) for server-side pagination.
 */
export function listOptimizationEventsWithSources(
  db: Database.Database,
  opts: {
    kind?: OptimizationEventKind;
    curatedId?: string;
    realized?: boolean;
    regressionsOnly?: boolean;
    positiveSavingsOnly?: boolean;
    search?: string;
    window?: MetricsWindow;
    limit?: number;
    offset?: number;
  } = {},
): ListOptimizationEventsResult {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const offset = Math.max(0, opts.offset ?? 0);
  const search = opts.search?.trim() ?? '';

  // The regression filter narrows: it intersects with kind/realized
  // rather than replacing them, so `regressionsOnly: true` together
  // with `realized: false` returns nothing by design.
  const effectiveKind: OptimizationEventKind | undefined = opts.regressionsOnly
    ? 'measured'
    : opts.kind;
  const effectiveRealized = opts.regressionsOnly ? true : opts.realized;

  const conditions: string[] = [];
  const params: Record<string, unknown> = { limit, offset };
  if (effectiveKind !== undefined) {
    conditions.push('oe.kind = @kind');
    params['kind'] = effectiveKind;
  }
  if (opts.curatedId !== undefined) {
    conditions.push('oe.curated_id = @curatedId');
    params['curatedId'] = opts.curatedId;
  }
  if (opts.regressionsOnly) {
    conditions.push('oe.savings_usd <= @regressionThreshold');
    params['regressionThreshold'] = SAVINGS_REGRESSION_THRESHOLD_USD;
  }
  if (opts.positiveSavingsOnly) {
    conditions.push('oe.savings_usd > @positiveThreshold');
    params['positiveThreshold'] = SAVINGS_POSITIVE_THRESHOLD_USD;
  }
  if (search.length > 0) {
    // SQLite's LIKE is case-insensitive on ASCII by default. Apply LOWER
    // explicitly so non-ASCII columns (session ids are uuids — ASCII —
    // but defensive) behave consistently. Single search term LIKE'd
    // against three columns gives a "contains anywhere" UX.
    conditions.push(
      '(LOWER(oe.curated_id) LIKE @search OR LOWER(oe.pattern) LIKE @search OR LOWER(oe.session_id) LIKE @search)',
    );
    params['search'] = `%${search.toLowerCase()}%`;
  }
  // Same half-open bounds convention as getOptimizationMetrics, so the
  // list always counts exactly the rows the savings chart aggregates.
  if (opts.window?.sinceMs !== undefined) {
    conditions.push('oe.ts >= @sinceMs');
    params['sinceMs'] = opts.window.sinceMs;
  }
  if (opts.window?.untilMs !== undefined) {
    conditions.push('oe.ts < @untilMs');
    params['untilMs'] = opts.window.untilMs;
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `
      SELECT
        oe.*,
        CASE
          WHEN si.installed_at IS NOT NULL
            AND si.installed_at <= oe.ts
            AND (si.uninstalled_at IS NULL OR si.uninstalled_at > oe.ts)
          THEN 1 ELSE 0
        END AS is_realized
      FROM optimization_events oe
      LEFT JOIN subagent_installs si ON si.curated_id = oe.curated_id
      ${whereSql}
      ORDER BY oe.ts DESC
      LIMIT @limit OFFSET @offset
    `,
    )
    .all(params) as DbOptimizationEventWithRealizedRow[];

  // Apply the realized filter post-query so the LEFT JOIN's CASE result
  // is what we actually filter on. Doing this in SQL would require a
  // subquery on the synthetic column.
  const filtered =
    effectiveRealized === undefined
      ? rows
      : rows.filter((r) => (r.is_realized === 1) === effectiveRealized);

  // Collect every source_tool_call_id across all rows so we can hydrate
  // the linked tool_calls in a single round-trip.
  const allIds = new Set<number>();
  for (const r of filtered) {
    if (!r.source_tool_call_ids) continue;
    try {
      const ids = JSON.parse(r.source_tool_call_ids) as unknown;
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === 'number') allIds.add(id);
        }
      }
      /* v8 ignore next 3 — defensive against a legacy/malformed JSON blob */
    } catch {
      /* ignore */
    }
  }

  const callsById = new Map<number, ToolCallSummary>();
  if (allIds.size > 0) {
    const placeholders = [...allIds].map(() => '?').join(',');
    const callRows = db
      .prepare(
        `SELECT id, ts, tool_name, file_path, response_size_bytes, denied
           FROM tool_calls
           WHERE id IN (${placeholders})`,
      )
      .all(...allIds) as Array<{
      id: number;
      ts: number;
      tool_name: string;
      file_path: string | null;
      response_size_bytes: number | null;
      denied: number;
    }>;
    for (const c of callRows) {
      callsById.set(c.id, {
        id: c.id,
        ts: c.ts,
        toolName: c.tool_name,
        filePath: c.file_path,
        responseSizeBytes: c.response_size_bytes,
        denied: c.denied === 1,
      });
    }
  }

  const events: OptimizationEventWithSources[] = filtered.map((r) => {
    const sourceIds: number[] = (() => {
      if (!r.source_tool_call_ids) return [];
      try {
        const parsed = JSON.parse(r.source_tool_call_ids) as unknown;
        if (Array.isArray(parsed)) {
          return parsed.filter((x): x is number => typeof x === 'number');
        }
        /* v8 ignore next 3 — defensive against a legacy/malformed JSON blob */
        return [];
      } catch {
        return [];
      }
    })();
    const sourceCalls: ToolCallSummary[] = sourceIds
      .map((id) => callsById.get(id))
      .filter((c): c is ToolCallSummary => c !== undefined);
    return {
      id: r.id,
      ts: r.ts,
      accountId: r.account_id,
      sessionId: r.session_id,
      curatedId: r.curated_id,
      kind: r.kind as OptimizationEventKind,
      pattern: r.pattern,
      savingsUsd: r.savings_usd,
      actualCostUsd: r.actual_cost_usd,
      hypotheticalCostUsd: r.hypothetical_cost_usd,
      actualInputTokens: r.actual_input_tokens,
      hypotheticalTotalTokens: r.hypothetical_total_tokens,
      digestTokens: getDigestTokens(r.curated_id),
      realized: r.is_realized === 1,
      sourceCalls,
    };
  });

  // Compute the total for pagination. When `realized` is unset the
  // count is a single COUNT(*); when set, we need the LEFT JOIN's
  // synthetic flag to count correctly, so we materialise the matching
  // rows' is_realized values and filter in JS — same semantics as the
  // page query above. With a 500-row hard limit on `limit`, the upper
  // bound on the count query is the full optimization_events table
  // size, which the analyzer's 7-day dedup window keeps bounded.
  const countParams: Record<string, unknown> = { ...params };
  delete countParams['limit'];
  delete countParams['offset'];
  let total: number;
  if (effectiveRealized === undefined) {
    const row = db
      .prepare(
        `
        SELECT COUNT(*) AS n
          FROM optimization_events oe
          ${whereSql}
        `,
      )
      .get(countParams) as { n: number };
    total = row.n;
  } else {
    const flagRows = db
      .prepare(
        `
        SELECT
          CASE
            WHEN si.installed_at IS NOT NULL
              AND si.installed_at <= oe.ts
              AND (si.uninstalled_at IS NULL OR si.uninstalled_at > oe.ts)
            THEN 1 ELSE 0
          END AS is_realized
        FROM optimization_events oe
        LEFT JOIN subagent_installs si ON si.curated_id = oe.curated_id
        ${whereSql}
        `,
      )
      .all(countParams) as Array<{ is_realized: number }>;
    total = flagRows.filter((r) => (r.is_realized === 1) === effectiveRealized).length;
  }

  return { events, total };
}

// ─── Optimize feature: subagent_installs ──────────────────────────────────────

export type SubagentInstallSource = 'curated' | 'local';

export interface SubagentInstallRow {
  id: number;
  name: string;
  source: SubagentInstallSource;
  curatedId: string | null;
  gapFingerprint: string | null;
  mdPath: string;
  mdHash: string;
  installedAt: number;
  uninstalledAt: number | null;
  optedOut: boolean;
}

export interface UpsertSubagentInstall {
  name: string;
  source: SubagentInstallSource;
  curatedId: string | null;
  gapFingerprint: string | null;
  mdPath: string;
  mdHash: string;
  installedAt: number;
  optedOut?: boolean;
}

interface DbSubagentInstallRow {
  id: number;
  name: string;
  source: string;
  curated_id: string | null;
  gap_fingerprint: string | null;
  md_path: string;
  md_hash: string;
  installed_at: number;
  uninstalled_at: number | null;
  opted_out: number;
}

function rowToSubagentInstall(row: DbSubagentInstallRow): SubagentInstallRow {
  return {
    id: row.id,
    name: row.name,
    source: row.source as SubagentInstallSource,
    curatedId: row.curated_id,
    gapFingerprint: row.gap_fingerprint,
    mdPath: row.md_path,
    mdHash: row.md_hash,
    installedAt: row.installed_at,
    uninstalledAt: row.uninstalled_at,
    optedOut: row.opted_out === 1,
  };
}

export function upsertSubagentInstall(
  db: Database.Database,
  e: UpsertSubagentInstall,
): SubagentInstallRow {
  db.prepare(
    `
    INSERT INTO subagent_installs (
      name, source, curated_id, gap_fingerprint, md_path, md_hash,
      installed_at, uninstalled_at, opted_out
    ) VALUES (
      @name, @source, @curatedId, @gapFingerprint, @mdPath, @mdHash,
      @installedAt, NULL, @optedOut
    )
    ON CONFLICT(name) DO UPDATE SET
      source          = excluded.source,
      curated_id      = excluded.curated_id,
      gap_fingerprint = excluded.gap_fingerprint,
      md_path         = excluded.md_path,
      md_hash         = excluded.md_hash,
      installed_at    = excluded.installed_at,
      uninstalled_at  = NULL,
      opted_out       = excluded.opted_out
  `,
  ).run({
    name: e.name,
    source: e.source,
    curatedId: e.curatedId,
    gapFingerprint: e.gapFingerprint,
    mdPath: e.mdPath,
    mdHash: e.mdHash,
    installedAt: e.installedAt,
    optedOut: e.optedOut ? 1 : 0,
  });
  const row = db
    .prepare('SELECT * FROM subagent_installs WHERE name = ?')
    .get(e.name) as DbSubagentInstallRow;
  return rowToSubagentInstall(row);
}

export function listSubagentInstalls(
  db: Database.Database,
  opts: { includeUninstalled?: boolean } = {},
): SubagentInstallRow[] {
  const sql = opts.includeUninstalled
    ? 'SELECT * FROM subagent_installs ORDER BY installed_at DESC'
    : 'SELECT * FROM subagent_installs WHERE uninstalled_at IS NULL ORDER BY installed_at DESC';
  const rows = db.prepare(sql).all() as DbSubagentInstallRow[];
  return rows.map(rowToSubagentInstall);
}

export function findSubagentInstallByName(
  db: Database.Database,
  name: string,
): SubagentInstallRow | null {
  const row = db.prepare('SELECT * FROM subagent_installs WHERE name = ?').get(name) as
    | DbSubagentInstallRow
    | undefined;
  return row ? rowToSubagentInstall(row) : null;
}

export function softDeleteSubagentInstall(
  db: Database.Database,
  name: string,
  uninstalledAt: number,
): boolean {
  const result = db
    .prepare(
      'UPDATE subagent_installs SET uninstalled_at = ? WHERE name = ? AND uninstalled_at IS NULL',
    )
    .run(uninstalledAt, name);
  return result.changes > 0;
}

export function setSubagentInstallMdHash(
  db: Database.Database,
  name: string,
  mdHash: string,
): boolean {
  const result = db
    .prepare('UPDATE subagent_installs SET md_hash = ? WHERE name = ?')
    .run(mdHash, name);
  return result.changes > 0;
}
