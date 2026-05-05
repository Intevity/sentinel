import type {
  OAuthAccount,
  Settings,
  Alert,
  AlertScope,
  BudgetAlertScope,
  PauseReason,
  NotificationRecord,
  MetricsSummary,
  OverageCreditGrant,
  SecurityEvent,
  SecurityKind,
  SecuritySeverity,
  SecurityAllowlistEntry,
  PermissionBypassEntry,
  ClaudeSyncStatus,
  AgentsSyncStatus,
  PendingSecurityBlock,
  PendingBlockSource,
  LogEntry,
  LogLevel,
  PermissionRule,
  PermissionRuleInput,
  AutoModeStatus,
  RequestDetail,
  SecurityBenchmarkResult,
} from './types.js';

// ─── Daemon → App messages ────────────────────────────────────────────────────

export interface OverageEnteredMessage {
  type: 'overage_entered';
  accountId: string;
  resetsAt: number | null;
}

export interface OverageExitedMessage {
  type: 'overage_exited';
  accountId: string;
}

export interface OverageDisabledMessage {
  type: 'overage_disabled';
  accountId: string;
  reason: string;
}

/** Broadcast when an account's Sonnet 7-day utilization crosses the
 *  overage-buffer threshold (default 95%). The next Sonnet request on the
 *  account will draw from the monthly overage budget unless the account is
 *  opted in via `overageEnabledIds`. Fired at most once per Sonnet window
 *  (deduped by reset timestamp). */
export interface SonnetSaturationEnteredMessage {
  type: 'sonnet_saturation_entered';
  accountId: string;
  /** Unix seconds when the Sonnet 7-day window resets. */
  resetsAt: number | null;
  /** Utilization fraction 0-1 at the time the threshold was crossed. */
  utilization: number;
}

/** Counterpart to `sonnet_saturation_entered`. Fires once the Sonnet
 *  window rolls over and utilization falls back below the threshold. */
export interface SonnetSaturationExitedMessage {
  type: 'sonnet_saturation_exited';
  accountId: string;
}

export interface UsageUpdateMessage {
  type: 'usage_update';
  accountId: string;
  todayCostUsd: number;
  todayTokens: number;
}

export interface AccountSwitchedMessage {
  type: 'account_switched';
  to: OAuthAccount;
}

/** Broadcast after per-account metadata is persisted (currently: avatar color).
 *  UI instances listen for this and refetch the accounts list so any color dot
 *  or avatar redraws consistently across open windows. */
export interface AccountUpdatedMessage {
  type: 'account_updated';
  accountId: string;
}

export interface LoginCompleteMessage {
  type: 'login_complete';
  email: string;
  /** Human-readable org name returned by the OAuth profile endpoint. */
  orgName?: string;
  /** True when the authorized org already existed in the DB — i.e. the user
   *  re-authorized an account they already had, rather than adding a new one.
   *  The UI uses this to show guidance for adding a *different* org. */
  reauth?: boolean;
  /** True when this enrollment happened through the silent sibling flow —
   *  no OAuth webview, no user-visible window. Implies the sessionKey is
   *  already mirrored, so the UI should NOT auto-kick the Connect
   *  claude.ai flow after this broadcast (which would pop a window and
   *  defeat the whole point). */
  silent?: boolean;
}

export interface RateLimitsUpdatedMessage {
  type: 'rate_limits_updated';
  accountId: string;
}

/** Fired when the daemon initiates a background probe to fetch fresh
 *  rate-limit headers for an account (on switch or startup). The UI uses
 *  this to show a loading indicator on the Usage view. */
export interface RateLimitsProbingMessage {
  type: 'rate_limits_probing';
  accountId: string;
}

/** Fired when a probe started with `rate_limits_probing` fails or times out
 *  before `rate_limits_updated` could fire. Lets the UI clear its loading
 *  indicator without waiting on a real headers-update broadcast. */
export interface RateLimitsProbeEndedMessage {
  type: 'rate_limits_probe_ended';
  accountId: string;
}

/** Fired when a probe gets a 403 with `error.type === 'permission_error'`
 *  whose message signals that the account's organization has OAuth API
 *  access disabled by admin/billing policy. Distinct from auth-expired:
 *  refreshing or re-authenticating produces the same restricted token, so
 *  the UI must render a non-Reconnect panel ("OAuth access disabled").
 *  Fires alongside `rate_limits_probe_ended` so existing loading-indicator
 *  listeners keep working. */
export interface RateLimitsOauthForbiddenMessage {
  type: 'rate_limits_oauth_forbidden';
  accountId: string;
  /** Verbatim `error.message` from Anthropic's response, surfaced for
   *  logging and potential UI detail rows. */
  message: string;
}

/** Broadcast when settings are written (by any process) so other daemon
 *  subsystems and the UI stay in sync with the latest config. */
export interface SettingsChangedMessage {
  type: 'settings_changed';
  settings: Settings;
}

/** Broadcast when a user-configured usage alert crosses its threshold. The
 *  frontend subscribes and fires a native OS notification.
 *
 *  `scope === 'pool'` indicates a round-robin pool-wide alert; `accountId` is
 *  null in that case and `utilization` is the mean across pool members.
 *  `scope === 'budget'` carries the observed spend + cap as extra fields so
 *  the UI can render specific dollar figures without another round-trip. */
export interface AlertTriggeredMessage {
  type: 'alert_triggered';
  alertId: number;
  /** Null when scope === 'pool' or scope === 'budget' with budgetScope === 'global'. */
  accountId: string | null;
  scope: AlertScope;
  thresholdPct: number;
  /** Actual observed utilization (0..1) at trigger time. For budget-scope
   *  alerts this is `spendUsd / budgetUsd`. */
  utilization: number;
  /** Budget-scope only: the account's (or global) rolling 7-day spend in USD. */
  spendUsd?: number;
  /** Budget-scope only: the user-configured cap the alert was evaluated against. */
  budgetUsd?: number;
  /** Budget-scope only: discriminator between per-account and global alerts. */
  budgetScope?: BudgetAlertScope;
}

/** Broadcast when an automatic or manual token refresh fails because the
 *  stored refresh_token has been revoked or expired. The UI shows a re-auth
 *  banner on the affected account that triggers start_login. */
export interface TokenRefreshFailedMessage {
  type: 'token_refresh_failed';
  accountId: string;
  email: string;
  reason: 'expired' | 'network' | 'unknown';
}

/** Broadcast after a successful token refresh so the UI can update any
 *  "expired" state it was showing and clear the re-auth banner. */
export interface TokenRefreshedMessage {
  type: 'token_refreshed';
  accountId: string;
  /** Unix ms timestamp of the new expiration. */
  expiresAt: number;
}

/** Broadcast when the security scanner records a new finding (or bumps
 *  occurrences on a deduped one). UI refreshes the Security tab and the
 *  Alerts-tab badge. Native OS notifications are fired by the frontend
 *  when severity clears the user's threshold. */
export interface SecurityEventDetectedMessage {
  type: 'security_event_detected';
  accountId: string;
  severity: SecuritySeverity;
  kind: SecurityKind;
  title: string;
  /** True when the outbound request was refused. */
  blocked: boolean;
  /** Primary-key row id of the security_events table entry this
   *  broadcast corresponds to. Used by the OS-notification Details
   *  action to deep-link the user into the Security panel with this
   *  row pre-expanded. Optional for backwards compatibility — older
   *  broadcasters that dedup to an existing row still set it to that
   *  row's id, but historical consumers without the field keep working. */
  eventId?: number;
}

/** Broadcast when a new outbound-block is being held open in the proxy
 *  awaiting the user's approve decision. UI renders a dedicated banner
 *  with a countdown + approve/deny buttons. */
export interface SecurityBlockPendingMessage {
  type: 'security_block_pending';
  pending: PendingSecurityBlock;
}

/** Broadcast when a held block is resolved (approve, deny, or timeout).
 *  UI removes the corresponding banner entry. */
export interface SecurityBlockResolvedMessage {
  type: 'security_block_resolved';
  pendingId: string;
  outcome: 'approve' | 'deny' | 'timeout';
}

/** Broadcast whenever a row is added to or removed from the security
 *  allowlist (the suppressed-matches table driven by "Always allow" on
 *  security events). `useSecurityAllowlist` refetches on this so the
 *  Allowlist section in Settings → Security reflects adds/removes live
 *  regardless of whether the user is currently looking at the section. */
export interface SecurityAllowlistUpdatedMessage {
  type: 'security_allowlist_updated';
}

/** Broadcast when the per-rule input bypass list changes — a row
 *  added by "Always allow this exact input" on a pending banner, or
 *  removed from the Settings UI. Drives live refetch in
 *  `usePermissionBypasses` the same way the allowlist broadcast
 *  drives its hook. */
export interface PermissionBypassesUpdatedMessage {
  type: 'permission_bypasses_updated';
}

/** Broadcast whenever the Claude Code sync engine transitions
 *  (start/stop), finishes a pull or push cycle, or records a new
 *  error. Payload is the full current status so consumers don't have
 *  to track deltas. Fired on every toggle so the UI reflects the
 *  active state without polling. */
export interface ClaudeSyncStatusMessage {
  type: 'claude_sync_status';
  status: ClaudeSyncStatus;
}

/** Broadcast when the Optimize agents-sync engine state changes.
 *  Mirrors `claude_sync_status` for `~/.claude/agents/`. */
export interface AgentsSyncStatusMessage {
  type: 'agents_sync_status';
  status: AgentsSyncStatus;
}

/** Broadcast after a curated subagent is successfully installed via
 *  the install_curated_subagent IPC. The UI's installed-list refetches. */
export interface SubagentInstalledMessage {
  type: 'subagent_installed';
  name: string;
  curatedId: string;
}

/** Broadcast after a subagent is uninstalled via the uninstall_subagent
 *  IPC. */
export interface SubagentUninstalledMessage {
  type: 'subagent_uninstalled';
  name: string;
}

/** Broadcast when the analyzer writes new measured rows. The dashboard
 *  refetches `get_optimization_metrics` so the savings header + chart
 *  reflect the latest analysis pass. Fired at most once per analyzer
 *  tick (every 5 min in production). */
export interface OptimizationMetricsUpdatedMessage {
  type: 'optimization_metrics_updated';
}

/** Broadcast once per OTEL HTTP batch (metrics or logs) after any events
 *  were written to the telemetry tables. The Metrics tab listens for this
 *  and refetches its rollup so dashboards update live as Claude Code emits. */
export interface MetricsUpdatedMessage {
  type: 'metrics_updated';
}

/** Broadcast when the daemon's mirror of `~/.claude.json:overageCreditGrantCache`
 *  reloads — typically after a switch, background usage probe, or explicit
 *  `refresh_overage_grants` request. Carries the full grant map so the UI
 *  can replace its cached copy atomically. Keyed by accountUuid to match
 *  how Claude Code itself keys the grant cache. */
export interface OverageGrantsUpdatedMessage {
  type: 'overage_grants_updated';
  grants: Record<string, OverageCreditGrant>;
}

/** Broadcast whenever the spend tracker recomputes. `perAccount` is keyed
 *  by Sentinel id (AccountInfo.id). A null value means no Anthropic-side
 *  data is available yet for that account (no sessionKey configured, or
 *  fetch failed) — distinct from `0` (known zero spend). `global` sums
 *  only the known numbers; when any entry is null, it's a lower bound. */
export interface SpendUpdateMessage {
  type: 'spend_update';
  perAccount: Record<string, number | null>;
  global: number;
}

/** Broadcast when the daemon pauses an account from further use. Reason
 *  discriminates why so the UI can show specific copy:
 *    sentinel_budget            — rolling 7d spend crossed the user-configured cap.
 *    sentinel_weekly_rate_limit — Anthropic marked the account's unified-7d
 *                                 window as 'blocked'; stays paused until the
 *                                 7-day reset (not the 5-hour reset).
 *    anthropic_overage_disabled — Anthropic flipped overage-status to 'disabled'.
 *
 *  `resetsAt` is the Unix-seconds timestamp at which the relevant window
 *  next rolls over (unified-5h for budget pauses, unified-7d for
 *  weekly-rate-limit pauses). `null` when no reset info is available yet. */
export interface AccountPausedMessage {
  type: 'account_paused';
  accountId: string;
  reason: PauseReason;
  resetsAt: number | null;
}

/** Counterpart to `account_paused`. Fires once the pause clears (spend aged
 *  out of the rolling 7d window after a 5h rollover, or Anthropic
 *  re-enabled overage). */
export interface AccountUnpausedMessage {
  type: 'account_unpaused';
  accountId: string;
}

/** Snapshot of Anthropic-reported usage for one account. Fields mirror the
 *  `/api/organizations/{org}/usage` response payload with minor_units
 *  converted to dollars. `extraUsage` is null when the account has no
 *  overage configured; its numbers are `null` in that case too. */
export interface ClaudeAiUsageSnapshot {
  /** 0-1 fraction of the 5-hour window consumed (already divided by 100). */
  fiveHourUtilization: number | null;
  fiveHourResetsAt: string | null;
  sevenDayUtilization: number | null;
  sevenDayResetsAt: string | null;
  sevenDaySonnetUtilization: number | null;
  sevenDaySonnetResetsAt: string | null;
  /** Null when overage is not configured on the account. Scope is
   *  ORG-WIDE for team plans — `usedUsd` is the team's combined
   *  overage spend across every member, not the viewer's personal
   *  figure. For a personal breakdown on team accounts see
   *  `perUserBudget` below. */
  extraUsage: {
    isEnabled: boolean;
    /** Dollar value of the monthly overage cap (e.g. 100.00). Null for
     *  team plans where the cap is admin-only. */
    limitUsd: number;
    /** Dollar value consumed in the current period (e.g. 77.22).
     *  Org-wide for team plans. */
    usedUsd: number;
    /** Percent used (0-100). */
    utilizationPct: number;
    currency: string;
  } | null;
  /** Team-plan-only: the VIEWING member's personal budget (configured
   *  by the team admin via claude.ai's /settings/usage page) and their
   *  personal spend so far. Populated from
   *  `/v1/code/routines/run-budget` — the endpoint returns 403/404 for
   *  non-team plans, in which case this stays null. When present it
   *  should be preferred over `extraUsage.usedUsd` for member-facing
   *  spend displays, since extraUsage is aggregated across the whole
   *  team. */
  perUserBudget: {
    /** Member's personal cap in dollars. Null when the admin hasn't
     *  configured a personal budget for this member — render UI should
     *  then fall back to showing the team-wide extraUsage figures. */
    limitUsd: number | null;
    /** Member's personal spend in dollars to date in the current
     *  window. Should always be a number when perUserBudget exists. */
    usedUsd: number | null;
  } | null;
  /** Unix ms when the daemon successfully fetched this snapshot. */
  fetchedAt: number;
}

/** Broadcast after every successful or failed fetch of the claude.ai usage
 *  endpoint. `snapshot` is null when the fetch failed. `error` carries a
 *  discriminator so the UI can render "Paste your sessionKey" vs
 *  "sessionKey expired" vs "network" without the secret leaking. */
export interface ClaudeAiUsageUpdatedMessage {
  type: 'claude_ai_usage_updated';
  accountId: string;
  snapshot: ClaudeAiUsageSnapshot | null;
  error: 'missing_key' | 'auth_expired' | 'oauth_forbidden' | 'network' | 'parse' | null;
}

/** Batch of new daemon log entries pushed to any connected client. Coalesced
 *  at 100ms or 50 entries (whichever comes first) to bound IPC volume when
 *  DEBUG is enabled on a chatty subsystem. */
export interface DaemonLogMessage {
  type: 'daemon_log';
  entries: LogEntry[];
}

/** Broadcast after a successful `clear_daemon_logs` so every connected UI
 *  resets its in-memory buffer in lock-step. */
export interface DaemonLogsClearedMessage {
  type: 'daemon_logs_cleared';
}

/** Broadcast after a successful `clear_request_logs` so every connected UI
 *  invalidates its detail cache in lock-step. Carries the deleted row count
 *  as feedback for the triggering client; other clients just use it as a
 *  cache-bust signal. */
export interface RequestLogsClearedMessage {
  type: 'request_logs_cleared';
  deleted: number;
}

/** Test-only broadcast emitted by `start_login` when the daemon env has
 *  `CLAUDE_SENTINEL_TEST_OAUTH_ECHO=1`. Carries the authorize URL the
 *  daemon would normally hand off to a browser launcher, so the E2E
 *  harness can extract the PKCE `state` and POST a synthetic callback
 *  to the daemon's loopback callback server. Never fires in production
 *  (the env var is off); listed in the union so the test-side type
 *  narrows cleanly through `onDaemonMessage`. */
export interface TestOAuthUrlOpenedMessage {
  type: 'test_oauth_url_opened';
  url: string;
}

/** Sprint 8 audit log integrity: the daemon's chain walker found a
 *  break in `security_events` (a row whose `payload_hash` doesn't match
 *  what the chain says it should be, OR a row whose `prev_hash` doesn't
 *  point to the previous row's `payload_hash`). Emitted on startup and
 *  every 24h. Surfaces in the UI as a permanent banner: integrity-broken
 *  audit logs cannot be silently re-keyed without notifying the user. */
export interface AuditLogTamperedMessage {
  type: 'audit_log_tampered';
  /** Row id of the first chain break. For tooling: the verifier walks
   *  oldest → newest and stops at the first mismatch, so this is the
   *  earliest broken row. */
  brokenAtRowId: number;
  /** Human-readable description of what mismatched, e.g.
   *  "payload_hash mismatch" or "prev_hash does not link to id 17". */
  reason: string;
}

/** Sprint 2 anti-tamper: the daemon detected that `settings.json` (or its
 *  sidecar `settings.json.sig`) was modified by something other than the
 *  daemon itself. Emitted on startup and on every reload that fails the
 *  HMAC / mode check; the daemon falls back to DEFAULT_SETTINGS so the
 *  user's last-known-good settings are NOT honoured. UI surfaces this as
 *  a banner so the user knows their config was reset. */
export interface SettingsTamperDetectedMessage {
  type: 'settings_tamper_detected';
  /** Why the integrity check failed. `loose_mode` = settings.json had
   *  group/other permission bits; `missing_sig` = sidecar absent;
   *  `sig_mismatch` = HMAC did not verify. */
  reason: 'loose_mode' | 'missing_sig' | 'sig_mismatch';
  /** Absolute path of the file that failed the check (settings.json,
   *  not the sidecar; the user thinks of the JSON as the file they own). */
  path: string;
}

export type DaemonToAppMessage =
  | OverageEnteredMessage
  | OverageExitedMessage
  | OverageDisabledMessage
  | SonnetSaturationEnteredMessage
  | SonnetSaturationExitedMessage
  | UsageUpdateMessage
  | AccountSwitchedMessage
  | AccountUpdatedMessage
  | LoginCompleteMessage
  | RateLimitsUpdatedMessage
  | RateLimitsProbingMessage
  | RateLimitsProbeEndedMessage
  | RateLimitsOauthForbiddenMessage
  | SettingsChangedMessage
  | AlertTriggeredMessage
  | TokenRefreshFailedMessage
  | TokenRefreshedMessage
  | SecurityEventDetectedMessage
  | SecurityBlockPendingMessage
  | SecurityBlockResolvedMessage
  | SecurityAllowlistUpdatedMessage
  | PermissionBypassesUpdatedMessage
  | ClaudeSyncStatusMessage
  | AgentsSyncStatusMessage
  | SubagentInstalledMessage
  | SubagentUninstalledMessage
  | OptimizationMetricsUpdatedMessage
  | MetricsUpdatedMessage
  | OverageGrantsUpdatedMessage
  | SpendUpdateMessage
  | AccountPausedMessage
  | AccountUnpausedMessage
  | ClaudeAiUsageUpdatedMessage
  | DaemonLogMessage
  | DaemonLogsClearedMessage
  | RequestLogsClearedMessage
  | PermissionRulesChangedMessage
  | PermissionsStatusMessage
  | SettingsTamperDetectedMessage
  | AuditLogTamperedMessage
  | TestOAuthUrlOpenedMessage;

// ─── App → Daemon messages ────────────────────────────────────────────────────

export interface GetAccountsMessage {
  type: 'get_accounts';
}

export interface GetCredentialsMessage {
  type: 'get_credentials';
  email: string;
}

export interface StoreCredentialsMessage {
  type: 'store_credentials';
  email: string;
  blob: string;
}

export interface GetUsageSummaryMessage {
  type: 'get_usage_summary';
  days: number;
}

/**
 * Fetch the full Metrics tab rollup for the active account across the
 * requested window. Returns a MetricsSummary (see types.ts) containing every
 * OTEL-sourced signal the dashboard renders, in one round trip.
 */
export interface GetMetricsSummaryMessage {
  type: 'get_metrics_summary';
  days: number;
  /** View-scope account key. When omitted the handler falls back to the
   *  currently active account so existing callers keep working; the UI's
   *  per-tab picker passes an explicit id to inspect non-active accounts. */
  accountId?: string;
  /** Aggregate rollup across a set of sentinel keys. When provided, takes
   *  precedence over `accountId` and the active-account fallback. The daemon
   *  does not interpret membership (pool vs. all) — the frontend decides. */
  accountIds?: string[];
  /** Optional context about what `accountIds` represents, echoed back in the
   *  response's `scope` so the UI can render an accurate label. */
  scopeKind?: 'pool' | 'all';
  scopeLabel?: string;
}

export interface AcknowledgeNotificationMessage {
  type: 'acknowledge_notification';
  id: number;
}

export interface AcknowledgeAllNotificationsMessage {
  type: 'acknowledge_all_notifications';
  /** When set, only notifications scoped to this account or global
   *  (account_id IS NULL) are acknowledged. Omit to ack everything. */
  accountId?: string;
}

export interface SwitchAccountMessage {
  type: 'switch_account';
  /** Account UUID — preferred lookup key. Falls back to email if blank. */
  accountId: string;
  email: string;
}

export interface RefreshAccountsMessage {
  type: 'refresh_accounts';
}

export interface StartLoginMessage {
  type: 'start_login';
  /** When present, hint claude.ai's OAuth authorize page to
   *  preselect this organization so the user doesn't have to click
   *  through the org chooser. Used by the sibling-enrollment walk
   *  where we already know which sibling org is being added. No
   *  effect if claude.ai ignores the hint (the user still gets the
   *  chooser as a fallback). */
  orgUuidHint?: string;
  /** Open the OAuth URL in a private/incognito browser window. Set
   *  this when the user is adding a DIFFERENT email/identity than any
   *  existing Sentinel account — claude.ai's "switch accounts" link
   *  on the OAuth consent page drops OAuth state (same bug as Claude
   *  Code CLI), so a fresh cookie jar is the only reliable way to
   *  switch identities mid-flow. The UI exposes this as an opt-in
   *  checkbox on the Add Account confirmation sheet. */
  incognito?: boolean;
}

export interface CancelLoginMessage {
  type: 'cancel_login';
}

export interface RemoveAccountMessage {
  type: 'remove_account';
  /** Sentinel key (id) of the account to remove */
  accountId: string;
  /** When true, also delete all usage, rate-limit, overage, and notification data for this account. */
  deleteData?: boolean;
}

export interface GetRateLimitsMessage {
  type: 'get_rate_limits';
  /** View-scope account key. Omit to get the current active account's
   *  windows (legacy behavior). The per-tab picker on Usage passes an
   *  explicit id to view any enrolled account without switching the proxy. */
  accountId?: string;
}

export interface GetAllRateLimitsMessage {
  type: 'get_all_rate_limits';
}

/** Optimize feature: list active subagent installs (curated + local).
 *  The dashboard renders this. Uninstalled rows are excluded by default. */
export interface ListInstalledSubagentsMessage {
  type: 'list_installed_subagents';
}

/** Optimize feature: install a curated subagent by id. Writes
 *  `~/.claude/agents/<id>.md` and inserts/upserts a curated row. */
export interface InstallCuratedSubagentMessage {
  type: 'install_curated_subagent';
  curatedId: string;
}

/** Optimize feature: uninstall a subagent by name (frontmatter `name` =
 *  filename stem). Removes the .md file and soft-deletes the DB row. */
export interface UninstallSubagentMessage {
  type: 'uninstall_subagent';
  name: string;
}

/** Optimize feature: list the curated library entries shipping with
 *  this daemon build. The dashboard's "Available curated subagents"
 *  section renders this. */
export interface GetCuratedLibraryMessage {
  type: 'get_curated_library';
}

/** Optimize feature: list optimization opportunities (curated_id ×
 *  pattern × session) discovered by the analyzer and not yet
 *  installed/dismissed by the user. */
export interface GetOptimizationOpportunitiesMessage {
  type: 'get_optimization_opportunities';
}

/** Optimize feature: aggregate savings metrics for the dashboard chart.
 *  `days` selects the lookback window; UI defaults to 7. */
export interface GetOptimizationMetricsMessage {
  type: 'get_optimization_metrics';
  days: number;
}

/** Per-subagent attribution row for {@link OptimizationMetrics.bySubagent}.
 *  Each measured opportunity carries a `curated_id`, so totals can be
 *  split per recommended subagent. The dashboard renders one badge per
 *  list row; the units toggle in the header switches it between cost
 *  and tokens. */
export interface OptimizationMetricsBySubagent {
  curatedId: string;
  savingsRealized: number;
  savingsPotential: number;
  /** Parent-context-tokens savings: how many fewer input tokens flow
   *  into the parent conversation when the subagent absorbs the read.
   *  Computed as `hypoInputTokens − digestTokens`. Always positive
   *  when the file is bigger than the digest. */
  tokensRealized: number;
  tokensPotential: number;
  opportunities: number;
}

/** Response shape for {@link GetOptimizationMetricsMessage}. The
 *  realized/potential split is decided at query time (LEFT JOIN against
 *  `subagent_installs.installed_at/uninstalled_at`), so installing a
 *  subagent retroactively promotes its prior opportunities from
 *  potential to realized — see `db.getOptimizationMetrics`. */
export interface OptimizationMetrics {
  totals: {
    savingsUsdRealized: number;
    savingsUsdPotential: number;
    /** Parent-context-tokens savings across all measured rows. Sums
     *  `hypoInputTokens − digestTokens` per row — the answer to
     *  "how much context did the subagent save me?" */
    tokensRealized: number;
    tokensPotential: number;
    opportunities: number;
    installs: number;
  };
  daily: Array<{
    day: string;
    savingsRealized: number;
    savingsPotential: number;
    tokensRealized: number;
    tokensPotential: number;
  }>;
  /** Per-curated-id breakdown, sorted by `savingsRealized + savingsPotential`
   *  desc so the dashboard reads the highest-impact rows first. */
  bySubagent: OptimizationMetricsBySubagent[];
}

/** Optimize feature: trigger a one-shot analyzer pass. Used by the
 *  "Refresh recommendations" button in the dashboard. */
export interface RunOptimizationAnalysisMessage {
  type: 'run_optimization_analysis';
}

/** Optimize feature: dismiss an opportunity so the analyzer suppresses
 *  it from future recommendations. Persists via an `optimization_events`
 *  row with kind='dismissed'. */
export interface DismissOptimizationMessage {
  type: 'dismiss_optimization';
  curatedId: string;
  pattern: string;
}

/** Optimize feature: drill-down into individual analyzed opportunities.
 *  Powers the "what triggered this savings number?" UI under the
 *  Optimize dashboard's chart. Filters narrow to a specific kind /
 *  curated_id / realized state; `search` LIKEs against curated_id,
 *  pattern, and session_id (file-path search is deferred). `limit`
 *  defaults to 100 (max 500); `offset` defaults to 0.
 *
 *  `regressionsOnly` is the "show me the misfit subagents" filter: it
 *  pins kind='measured' + realized=true and additionally requires
 *  savings_usd ≤ a small negative threshold, matching the UI's
 *  regression pill. Composes with `search` and `curatedId` if present;
 *  passing `regressionsOnly: true` together with conflicting
 *  `kind`/`realized` overrides yields no rows by design. */
export interface ListOptimizationEventsMessage {
  type: 'list_optimization_events';
  kind?: 'measured' | 'recommended' | 'installed' | 'dismissed';
  curatedId?: string;
  realized?: boolean;
  regressionsOnly?: boolean;
  /** When true, the daemon excludes rows whose `savings_usd` is at or
   *  below the cost noise floor (~$0.005). Used by the "Potential"
   *  filter so misfit-warning rows (subagent would have cost more)
   *  don't surface as opportunities. */
  positiveSavingsOnly?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

/** Slim summary of a tool_call linked from an optimization_event row.
 *  Mirrors `ToolCallSummary` from the daemon DB layer; we redefine here
 *  so consumers don't import daemon-private types. */
export interface OptimizationEventSourceCall {
  id: number;
  ts: number;
  toolName: string;
  filePath: string | null;
  responseSizeBytes: number | null;
  denied: boolean;
}

/** Drill-down record for the Optimize dashboard's opportunity list. */
export interface OptimizationEventRecord {
  id: number;
  ts: number;
  accountId: string;
  sessionId: string | null;
  curatedId: string;
  kind: 'measured' | 'recommended' | 'installed' | 'dismissed';
  pattern: string | null;
  savingsUsd: number | null;
  actualCostUsd: number | null;
  hypotheticalCostUsd: number | null;
  /** Input tokens attributed to this opportunity on the actual path. */
  actualInputTokens: number | null;
  /** Input tokens the hypothetical (subagent) path would have spent
   *  (file read + digest replay). Null on pre-migration rows; the UI
   *  shows "—" for those. */
  hypotheticalTotalTokens: number | null;
  /** Digest size for this row's curated_id, in input tokens. Lets the
   *  UI compute the parent-context framing locally without re-deriving
   *  digest sizes per curated_id. Server-supplied so a future curated
   *  library version doesn't require a UI redeploy. */
  digestTokens: number;
  /** True when the curated subagent was installed at the opportunity's
   *  timestamp (matches `getOptimizationMetrics` realized semantics). */
  realized: boolean;
  /** Tool calls that drove the detection. May be a subset of the stored
   *  IDs if the underlying tool_calls rows were pruned. */
  sourceCalls: OptimizationEventSourceCall[];
}

/** Optimize feature: read-only snapshot of the agents-sync engine. */
export interface GetAgentsSyncStatusMessage {
  type: 'get_agents_sync_status';
}

/** Optimize feature: snapshot of every surface that contributes to
 *  Claude Code's per-request context. Lets users see at a glance which
 *  MCP servers, CLAUDE.md files, memory directories, plugins, and
 *  subagents are inflating their token cost. Read-only for v1; the
 *  disable controls are deferred to a follow-up. */
export interface GetContextInventoryMessage {
  type: 'get_context_inventory';
}

/** One MCP server's contribution to context. Both currently-enabled
 *  and explicitly-disabled servers are reported (the latter marked
 *  `enabled: false`) so users see the full picture, including stuff
 *  they already disabled. `recent7d` aggregates `tool_calls` over the
 *  last seven days, attributing rows whose `tool_name` starts with
 *  `mcp__<server>__`. */
export interface ContextInventoryMcpServer {
  /** Absolute project path the server is configured under. */
  project: string;
  name: string;
  enabled: boolean;
  recent7d: {
    calls: number;
    bytesIn: number;
    bytesOut: number;
    estimatedTokens: number;
  };
}

export interface ContextInventoryClaudeMd {
  path: string;
  sizeBytes: number;
  scope: 'global' | 'project';
}

export interface ContextInventoryMemoryDir {
  projectId: string;
  fileCount: number;
  totalBytes: number;
}

export interface ContextInventoryPlugin {
  name: string;
}

export interface ContextInventorySubagent {
  name: string;
  source: 'curated' | 'local';
}

/** Aggregate response shape for {@link GetContextInventoryMessage}. */
export interface ContextInventory {
  mcpServers: ContextInventoryMcpServer[];
  claudeMdFiles: ContextInventoryClaudeMd[];
  memoryDirs: ContextInventoryMemoryDir[];
  plugins: ContextInventoryPlugin[];
  globalSubagents: ContextInventorySubagent[];
}

export interface GetRemovedAccountsMessage {
  type: 'get_removed_accounts';
}

export interface PurgeAccountMessage {
  type: 'purge_account';
  /** Sentinel key (id) of the account to permanently delete (data + row). */
  accountId: string;
}

export interface GetDaemonStatusMessage {
  type: 'get_daemon_status';
}

/** Response payload for `get_daemon_status` — process-level info shown in the
 *  UI's overflow menu (pid, uptime). */
export interface DaemonProcessStatus {
  pid: number;
  /** Daemon process uptime in milliseconds. */
  uptimeMs: number;
  /** Unix ms timestamp when the daemon process started. */
  startedAt: number;
}

/** Ask the daemon to shut itself down cleanly. Used by "Quit Sentinel" in the
 *  UI so both the app and the daemon stop together. */
export interface ShutdownDaemonMessage {
  type: 'shutdown_daemon';
}

/** Wipe every Sentinel-owned credential from the OS keychain. The caller is
 *  expected to also delete the SQLite DB (via Rust-side deactivate_sentinel
 *  with delete_data=true) and then shut the daemon down. */
export interface PurgeAllDataMessage {
  type: 'purge_all_data';
}

export interface GetSettingsMessage {
  type: 'get_settings';
}

export interface UpdateSettingsMessage {
  type: 'update_settings';
  settings: Partial<Settings>;
}

/** Update per-account metadata. Currently only the user-picked avatar color,
 *  but structured with optional fields so future per-account prefs can be
 *  added without a new message type. A field left `undefined` is not
 *  changed; passing `null` explicitly clears the stored value (e.g. resets
 *  the color back to the hash-derived default). */
export interface UpdateAccountMessage {
  type: 'update_account';
  /** Sentinel id (see `AccountInfo.id`). */
  accountId: string;
  /** 7-char hex string like "#FF9F0A", or null to reset. */
  color?: string | null;
}

export interface ListAlertsMessage {
  type: 'list_alerts';
  /** When provided, only alerts bound to this Sentinel account key are returned.
   *  Implies an account-bound scope (`account`, `account-sonnet`,
   *  `account-weekly`, or `budget:account`). Ignored when scope is
   *  `pool`, `pool-weekly`, or `budget:global`. */
  accountId?: string;
  /** Filter by scope. `'all'` (default) returns every scope; any specific
   *  scope value returns only rows in that scope. */
  scope?: AlertScope | 'all';
}

export interface UpsertAlertMessage {
  type: 'upsert_alert';
  /** Omit to create; provide an existing id to update in place. */
  id?: number;
  /** Scope-dependent accountId validation:
   *    - `account`, `account-sonnet`, `account-weekly` require non-null accountId
   *    - `pool`, `pool-weekly` require accountId to be null
   *    - `budget` requires an accompanying `budgetScope`
   *  Defaults to `'account'` for backwards compatibility. */
  scope?: AlertScope;
  /** Null for pool scopes (`pool`, `pool-weekly`) and `budget:global`. */
  accountId: string | null;
  thresholdPct: number;
  enabled: boolean;
  /** Required when scope === 'budget'. 'account' binds the alert to the
   *  per-account weekly cap; 'global' binds to the global cap. */
  budgetScope?: BudgetAlertScope;
}

export interface DeleteAlertMessage {
  type: 'delete_alert';
  id: number;
}

export interface GetNotificationsMessage {
  type: 'get_notifications';
  limit?: number;
}

/** Request a manual OAuth token refresh for a specific account. The daemon
 *  uses the stored refresh_token to obtain a fresh access token and writes
 *  the updated credential back to the keychain. Returns the new expiration
 *  time on success or an error message if the refresh fails. */
export interface RefreshTokenMessage {
  type: 'refresh_token';
  accountId: string;
}

/** Fetch recent security events for the Security tab.
 *  Returns a `SecurityEvent[]`, newest first. */
export interface GetSecurityEventsMessage {
  type: 'get_security_events';
  /** Cap the response size. Default 200. */
  limit?: number;
  /** When set, only events for this Sentinel account key are returned. */
  accountId?: string;
  /** When false (default), weak signals (confidence < 0.7) are excluded. */
  includeWeakSignals?: boolean;
}

/** Mark a single security event as acknowledged. */
export interface AcknowledgeSecurityEventMessage {
  type: 'acknowledge_security_event';
  id: number;
}

/** Mark every security event as acknowledged, optionally scoped to an account. */
export interface AcknowledgeAllSecurityEventsMessage {
  type: 'acknowledge_all_security_events';
  accountId?: string;
}

/** Permanently delete every security event row (optionally scoped by account).
 *  Also acknowledges + deletes the mirrored notifications so badges clear. */
export interface ClearSecurityEventsMessage {
  type: 'clear_security_events';
  accountId?: string;
}

/** List every (match_hash, detector_id) pair the user has allowlisted. */
export interface GetSecurityAllowlistMessage {
  type: 'get_security_allowlist';
}

/** Add a new entry to the allowlist. Two input modes:
 *  - When `eventId` is provided, the daemon reads match_hash/detector_id
 *    and display fields from the referenced security_events row.
 *  - Otherwise the caller supplies the raw identity + optional display. */
export interface AddSecurityAllowlistMessage {
  type: 'add_to_security_allowlist';
  eventId?: number;
  matchHash?: string;
  detectorId?: string;
  matchMask?: string | null;
  title?: string | null;
  note?: string | null;
}

export interface RemoveSecurityAllowlistMessage {
  type: 'remove_from_security_allowlist';
  id: number;
}

/** List all rows in the per-rule input bypass table for the
 *  Settings → Tool Permissions UI. No filters — the table is small by
 *  design (user-curated allow-through), so returning the full set
 *  keeps the hook simple. */
export interface GetPermissionBypassesMessage {
  type: 'get_permission_bypasses';
}

/** Remove a single bypass row. The Settings list's per-row trash
 *  icon is the only producer today — approval-time inserts happen
 *  inside `approve_blocked_request` via the new `addBypass` flag. */
export interface RemovePermissionBypassMessage {
  type: 'remove_permission_bypass';
  id: number;
}

/** Sprint 8 forensics: fetch the captured tool-use messages for a
 *  security event id. Returns null when no replay was captured for
 *  that event (default — replay is opt-in via `securityIncidentReplay`). */
export interface GetIncidentReplayMessage {
  type: 'get_incident_replay';
  eventId: number;
}

/** Sprint 8 forensics: produce a self-contained signed snapshot of the
 *  full audit log (security_events + chain summary rows) for offline
 *  analysis. Optional filters scope the export. The integrity tip hash
 *  is included so a downstream verifier can confirm chain continuity. */
export interface ExportAuditLogSignedMessage {
  type: 'export_audit_log_signed';
  /** When set, only events for this account id. Summary rows are scoped
   *  globally; downstream tools can ignore them when filtering. */
  accountId?: string;
  /** Lower bound on event timestamp (ms epoch). Inclusive. */
  sinceTs?: number;
}

/** Force a one-shot pull from Claude Code's settings.json into
 *  Sentinel. Used by the Settings "Import now" button when the user
 *  wants to reconcile without toggling the engine on/off. Applies
 *  reconciliation identical to the watcher-driven pull. */
export interface ClaudeSyncPullMessage {
  type: 'claude_sync_pull';
  /** Direction for the very first pull after enabling sync: 'merge'
   *  keeps both sets, 'import' overwrites matching Sentinel rules
   *  with Claude Code's, 'export' ignores the file this one time and
   *  forces a push. Only honoured by first-enable; subsequent
   *  manual pulls always merge. */
  mode?: 'merge' | 'import' | 'export';
}

/** Force a one-shot push from Sentinel's rules DB out to Claude
 *  Code's settings.json. Used by the Settings "Export now" button. */
export interface ClaudeSyncPushMessage {
  type: 'claude_sync_push';
}

/** Trigger the scanner's in-process microbenchmark. The daemon
 *  spins up a throwaway scanner, runs synthetic bodies at
 *  `[1, 2, 4, 8, 16]` MB through the synchronous path, and returns
 *  per-size timings plus a recommended threshold. Blocking in terms
 *  of the IPC response — takes several seconds on typical hardware.
 *  Also persists the result to `Settings.lastScanBenchmark` so other
 *  UI surfaces can read it without re-running. */
export interface RunScanBenchmarkMessage {
  type: 'run_scan_benchmark';
}

/** Read the current sync status without waiting for the next
 *  broadcast. Useful on UI mount so the subsection doesn't render a
 *  flash of "(unknown)". */
export interface GetClaudeSyncStatusMessage {
  type: 'get_claude_sync_status';
}

/** Approve a held outbound block. The daemon adds the block's match to
 *  the allowlist (so subsequent identical matches are silently allowed),
 *  releases the request to flow upstream, and broadcasts
 *  `security_block_resolved`. No-op if the pending block has already
 *  timed out or been denied.
 *
 *  When `addBypass: true` on a `permissions_tool_use` pending entry,
 *  the daemon also inserts a `permission_bypass` row so future
 *  identical calls to the same tool + input short-circuit the rule.
 *  Ignored for scanner pending blocks and for `permissions_strip`
 *  (which doesn't have a tool input to key on).
 *
 *  Sprint 9: `mode` lets the user pick how durable the approval is.
 *    'once'    — current default; resolves the held block only.
 *    'session' — also inserts a row in `session_approval_grants` so
 *                future matching tool_uses in the SAME session_id
 *                skip the banner. Expires after 12h.
 *    'always'  — equivalent to legacy `addBypass: true`; inserts a
 *                permission_bypass row.
 *  Unset / unknown values are treated as `'once'` for backwards
 *  compatibility with older app builds. */
export interface ApproveBlockedRequestMessage {
  type: 'approve_blocked_request';
  pendingId: string;
  addBypass?: boolean;
  mode?: 'once' | 'session' | 'always';
}

/** Deny a held outbound block. The daemon synthesizes the 403 and
 *  broadcasts `security_block_resolved`. No-op on an unknown id. */
export interface DenyBlockedRequestMessage {
  type: 'deny_blocked_request';
  pendingId: string;
}

/** Fetch every currently-held pending block. Used on UI reconnect
 *  (e.g. the app was reopened mid-hold) so the banner can re-render. */
export interface ListPendingBlocksMessage {
  type: 'list_pending_blocks';
}

/** Fetch the daemon's in-memory log ring buffer. The UI calls this on mount
 *  to seed the Logs tab, then relies on `daemon_log` broadcasts for live
 *  updates. `limit` caps the returned slice; default matches the full ring
 *  buffer (2000 entries). */
export interface GetDaemonLogsMessage {
  type: 'get_daemon_logs';
  limit?: number;
}

/** Truncate daemon.log, empty the ring buffer, and broadcast
 *  `daemon_logs_cleared` so every UI instance resets in sync. */
export interface ClearDaemonLogsMessage {
  type: 'clear_daemon_logs';
}

/** Fetch the full captured request/response detail for a single proxied
 *  call. Response payload is `RequestDetail | null` — null when the id is
 *  unknown (e.g. the row was purged by retention, or the user cleared logs). */
export interface GetRequestDetailMessage {
  type: 'get_request_detail';
  requestId: string;
}

/** Delete every row in the request-logs DB and broadcast
 *  `request_logs_cleared`. Response payload is `{ deleted: number }`. */
export interface ClearRequestLogsMessage {
  type: 'clear_request_logs';
}

/** Synthesize a security finding through the normal persist + broadcast
 *  path. Used by `scripts/security-test.mjs` to exercise the UI without
 *  having to actually elicit a model response or leak a real secret.
 *
 *  Safe to leave always-on: only produces synthetic findings from a
 *  hardcoded scenario set, does not leak data, and the IPC socket is
 *  scoped to the local user. */
export type SecurityTestScenario =
  | 'risky-bash'
  | 'risky-write'
  | 'risky-write-medium'
  | 'risky-webfetch'
  | 'tool-use-low-severity'
  | 'pending-block'
  | 'secret-anthropic'
  | 'secret-openai'
  | 'secret-github-pat'
  | 'secret-private-key'
  | 'scan-truncated'
  | 'scan-skipped-encoding'
  | 'scan-deferred-oversized'
  | 'permissions-strip'
  | 'permissions-tool-use-block'
  | 'permissions-tool-use-pending';

export interface DevTriggerSecurityEventMessage {
  type: 'dev_trigger_security_event';
  scenario: SecurityTestScenario;
  /** Account to attribute the synthetic event to. Defaults to 'default'
   *  when omitted so the script works without knowing the active key. */
  accountId?: string;
}

/** Synthesize a non-security alert (usage / overage / spend / account lifecycle)
 *  through the normal persist + broadcast path. Used by
 *  `scripts/alerts-test.mjs` to exercise the Alerts tab and OS notifications
 *  without needing to move real usage/spend across thresholds. Synthetic
 *  triggers do NOT mutate real alert-row `last_triggered_reset_ts` or the
 *  SpendTracker's paused set — safe to run repeatedly. */
export type AlertTestScenario =
  | 'usage-account'
  | 'usage-pool'
  | 'usage-budget'
  | 'overage-entered'
  | 'overage-disabled'
  | 'account-switched'
  | 'account-paused'
  | 'account-unpaused';

export interface DevTriggerAlertEventMessage {
  type: 'dev_trigger_alert_event';
  scenario: AlertTestScenario;
  /** Account to attribute the synthetic event to. Defaults to the active
   *  account or 'default' when omitted. Ignored for pool-scope scenarios. */
  accountId?: string;
}

/** List every tool-permission rule in priority order. Response is
 *  `PermissionRule[]`. */
export interface ListPermissionRulesMessage {
  type: 'list_permission_rules';
}

/** Create or update a tool-permission rule. Omit `id` on input to create.
 *  Response is the persisted `PermissionRule`. */
export interface UpsertPermissionRuleMessage {
  type: 'upsert_permission_rule';
  rule: PermissionRuleInput;
}

export interface DeletePermissionRuleMessage {
  type: 'delete_permission_rule';
  id: string;
}

/** Broadcast after any rule mutation (create/update/delete/reorder). Carries
 *  the full new list so every connected UI can atomically re-render the
 *  editor without an extra round-trip. */
export interface PermissionRulesChangedMessage {
  type: 'permission_rules_changed';
  rules: PermissionRule[];
}

/** Fetch the current auto-mode status. Response payload is `AutoModeStatus`.
 *  Used by the Security tab on mount to seed its indicator before any
 *  broadcasts have fired. */
export interface GetPermissionsStatusMessage {
  type: 'get_permissions_status';
}

/** Broadcast when auto-mode status transitions (activated or deactivated, or
 *  the trigger source changes). The UI's Security-tab indicator listens and
 *  animates accordingly. The enforcer only emits on edges — no spam per
 *  request. */
export interface PermissionsStatusMessage {
  type: 'permissions_status';
  status: AutoModeStatus;
}

/** Fetch the daemon's mirror of `~/.claude.json:overageCreditGrantCache`.
 *  Response payload is `Record<accountUuid, OverageCreditGrant>`. Empty
 *  object when Claude Code hasn't populated the cache yet. */
export interface GetOverageGrantsMessage {
  type: 'get_overage_grants';
}

/** Force the daemon to re-read `~/.claude.json`'s grant cache and broadcast
 *  `overage_grants_updated`. Takes no arguments — returns the freshly-loaded
 *  map as the response as well so callers don't need to wait for the
 *  broadcast round-trip. */
export interface RefreshOverageGrantsMessage {
  type: 'refresh_overage_grants';
}

/** Fetch the daemon's latest rolling 7-day spend summary. Response payload
 *  shape matches `SpendUpdateMessage` (minus the `type` field). */
export interface GetSpendSummaryMessage {
  type: 'get_spend_summary';
}

/** Fetch the cached claude.ai usage snapshot for the given account. Returns
 *  null when the daemon has not yet successfully fetched (e.g. key missing
 *  or auth rejected). Numbers are dollars (converted from `minor_units`). */
export interface GetClaudeAiUsageMessage {
  type: 'get_claude_ai_usage';
  accountId: string;
}

/** Force an immediate fetch against the claude.ai usage endpoint. Used on
 *  account add so the UI doesn't wait for the periodic poller. Also
 *  fired by the Accounts tab on mount/focus as a free auth-liveness
 *  probe: a 401 here triggers the inline force-refresh cascade, so
 *  dead tokens surface as the yellow Re-authenticate banner without
 *  waiting for the periodic poll. */
export interface RefreshClaudeAiUsageMessage {
  type: 'refresh_claude_ai_usage';
  accountId: string;
}

/** Fire a minimal /v1/messages probe (max_tokens: 1 on Haiku 4.5) through
 *  the local proxy to force-refresh the `unified-5h-reset` header for a
 *  given account. Separated from `refresh_claude_ai_usage` because the
 *  probe costs ~1 Haiku token per call, so we only fire it on explicit
 *  user action (Refresh button) not on passive mount/focus paths. */
export interface ProbeRateLimitsMessage {
  type: 'probe_rate_limits';
  accountId: string;
}

/** Fetch the daemon's SpendTracker-paused set with each entry's reason +
 *  resets-at. Response payload is `Array<{ accountId, reason, resetsAt }>`.
 *  Used by `usePausedAccounts` on mount so the Accounts-page paused badge
 *  renders on first paint instead of waiting for the next `account_paused`
 *  broadcast (which only fires on state transitions, never for pauses
 *  carried across daemon restarts). */
export interface GetPausedAccountsMessage {
  type: 'get_paused_accounts';
}

/** Sprint 9: list distinct recent working directories observed on the
 *  proxy across the last 20 sessions, deduped, most-recent first. Used
 *  by the rule-editor's project_scope autocomplete so users don't have
 *  to type the path themselves. Response payload is `string[]`. */
export interface ListRecentWorkingDirsMessage {
  type: 'list_recent_working_dirs';
}

export type AppToDaemonMessage =
  | GetAccountsMessage
  | GetCredentialsMessage
  | StoreCredentialsMessage
  | GetUsageSummaryMessage
  | GetMetricsSummaryMessage
  | AcknowledgeNotificationMessage
  | AcknowledgeAllNotificationsMessage
  | SwitchAccountMessage
  | RefreshAccountsMessage
  | StartLoginMessage
  | CancelLoginMessage
  | RemoveAccountMessage
  | GetRateLimitsMessage
  | GetAllRateLimitsMessage
  | ListInstalledSubagentsMessage
  | InstallCuratedSubagentMessage
  | UninstallSubagentMessage
  | GetCuratedLibraryMessage
  | GetOptimizationOpportunitiesMessage
  | GetOptimizationMetricsMessage
  | RunOptimizationAnalysisMessage
  | DismissOptimizationMessage
  | ListOptimizationEventsMessage
  | GetContextInventoryMessage
  | GetAgentsSyncStatusMessage
  | GetRemovedAccountsMessage
  | PurgeAccountMessage
  | GetDaemonStatusMessage
  | ShutdownDaemonMessage
  | PurgeAllDataMessage
  | GetSettingsMessage
  | UpdateSettingsMessage
  | UpdateAccountMessage
  | ListAlertsMessage
  | UpsertAlertMessage
  | DeleteAlertMessage
  | GetNotificationsMessage
  | RefreshTokenMessage
  | GetSecurityEventsMessage
  | AcknowledgeSecurityEventMessage
  | AcknowledgeAllSecurityEventsMessage
  | ClearSecurityEventsMessage
  | GetSecurityAllowlistMessage
  | AddSecurityAllowlistMessage
  | RemoveSecurityAllowlistMessage
  | GetPermissionBypassesMessage
  | RemovePermissionBypassMessage
  | GetIncidentReplayMessage
  | ExportAuditLogSignedMessage
  | RunScanBenchmarkMessage
  | ClaudeSyncPullMessage
  | ClaudeSyncPushMessage
  | GetClaudeSyncStatusMessage
  | ApproveBlockedRequestMessage
  | DenyBlockedRequestMessage
  | ListPendingBlocksMessage
  | GetDaemonLogsMessage
  | ClearDaemonLogsMessage
  | GetRequestDetailMessage
  | ClearRequestLogsMessage
  | GetOverageGrantsMessage
  | RefreshOverageGrantsMessage
  | GetSpendSummaryMessage
  | GetClaudeAiUsageMessage
  | RefreshClaudeAiUsageMessage
  | ProbeRateLimitsMessage
  | GetPausedAccountsMessage
  | DevTriggerSecurityEventMessage
  | DevTriggerAlertEventMessage
  | ListPermissionRulesMessage
  | UpsertPermissionRuleMessage
  | DeletePermissionRuleMessage
  | GetPermissionsStatusMessage
  | ListRecentWorkingDirsMessage;

/** Response payload alias re-exports for convenience in consumers. */
export type {
  Settings,
  Alert,
  NotificationRecord,
  MetricsSummary,
  OverageCreditGrant,
  SecurityEvent,
  SecurityAllowlistEntry,
  PermissionBypassEntry,
  ClaudeSyncStatus,
  AgentsSyncStatus,
  PendingSecurityBlock,
  PendingBlockSource,
  LogEntry,
  LogLevel,
  PermissionRule,
  PermissionRuleInput,
  AutoModeStatus,
  RequestDetail,
  SecurityBenchmarkResult,
};

// ─── All IPC messages ─────────────────────────────────────────────────────────

export type IpcMessage = DaemonToAppMessage | AppToDaemonMessage;

/**
 * Typed response envelope for request/response IPC interactions
 */
export interface IpcResponse<T = unknown> {
  requestType: string;
  success: boolean;
  data?: T;
  error?: string;
}
