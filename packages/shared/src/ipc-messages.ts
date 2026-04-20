import type {
  OAuthAccount,
  Settings,
  Alert,
  AlertScope,
  BudgetAlertScope,
  NotificationRecord,
  MetricsSummary,
  OverageCreditGrant,
  SecurityEvent,
  SecurityKind,
  SecuritySeverity,
  SecurityAllowlistEntry,
  PendingSecurityBlock,
  LogEntry,
  LogLevel,
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
 *    sentinel_budget         — rolling 7d spend crossed the user-configured cap.
 *    anthropic_overage_disabled — Anthropic flipped overage-status to 'disabled'.
 *
 *  `resetsAt` is the Unix-seconds timestamp at which the unified-5h window
 *  next rolls over (when Sentinel will re-evaluate and potentially
 *  auto-unpause). `null` when no reset info is available yet. */
export interface AccountPausedMessage {
  type: 'account_paused';
  accountId: string;
  reason: 'sentinel_budget' | 'anthropic_overage_disabled';
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
  error: 'missing_key' | 'auth_expired' | 'network' | 'parse' | null;
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

/** Broadcast after the user adds an account and we discover (via
 *  `/api/bootstrap`) that the same claude.ai login carries memberships
 *  in additional chat-capable orgs that Sentinel doesn't yet know
 *  about. Fired once per `set_claude_ai_session_key` when siblings are
 *  present; the UI prompts the user to enroll the remaining orgs via a
 *  fresh OAuth round for each. The list excludes orgs that already
 *  have a Sentinel account row (so re-firing this on a sessionKey
 *  re-set after every sibling is added emits an empty list and the
 *  UI stays quiet). */
export interface AdditionalOrgsAvailableMessage {
  type: 'additional_orgs_available';
  /** Email the sessionKey belongs to — used as the banner heading. */
  email: string;
  /** Chat-capable memberships from `/api/bootstrap` that have no
   *  matching Sentinel account row. Each entry carries its org UUID
   *  and display name so the UI can list them by name. Order mirrors
   *  bootstrap order (claude.ai's own switcher order). */
  orgs: Array<{ orgUuid: string; orgName: string }>;
}

/** Broadcast during a `start_login` flow to hand the computed OAuth
 *  authorize URL off to the UI client. The Tauri app listens for this
 *  and opens the URL inside an embedded WebviewWindow so claude.ai's
 *  cookies (sessionKey included) end up in the shared WKHTTPCookieStore
 *  — the Connect claude.ai flow that auto-triggers once the new
 *  account row appears then captures those cookies without requiring
 *  a second login. Headless clients that don't subscribe can ignore
 *  this; the daemon will have opened the system browser as a fallback
 *  if the broadcast isn't consumed in time. */
export interface OauthAuthorizeUrlMessage {
  type: 'oauth_authorize_url';
  url: string;
  /** When present, the webview should warm up the WKHTTPCookieStore
   *  with `lastActiveOrg=<orgUuidHint>` by GETting
   *  `https://claude.ai/api/organizations/{orgUuidHint}/sync/settings`
   *  from a claude.ai-origin context BEFORE navigating to `url`.
   *  claude.ai's OAuth authorize endpoint keys off that cookie to
   *  decide which org to mint the token for; preseeding it lets the
   *  sibling-enrollment walk skip the org-chooser click. Safe to
   *  omit — behavior without it is the normal "user picks an org"
   *  flow. */
  orgUuidHint?: string;
}

export type DaemonToAppMessage =
  | OverageEnteredMessage
  | OverageExitedMessage
  | OverageDisabledMessage
  | UsageUpdateMessage
  | AccountSwitchedMessage
  | AccountUpdatedMessage
  | LoginCompleteMessage
  | RateLimitsUpdatedMessage
  | RateLimitsProbingMessage
  | RateLimitsProbeEndedMessage
  | SettingsChangedMessage
  | AlertTriggeredMessage
  | TokenRefreshFailedMessage
  | TokenRefreshedMessage
  | SecurityEventDetectedMessage
  | SecurityBlockPendingMessage
  | SecurityBlockResolvedMessage
  | MetricsUpdatedMessage
  | OverageGrantsUpdatedMessage
  | SpendUpdateMessage
  | AccountPausedMessage
  | AccountUnpausedMessage
  | ClaudeAiUsageUpdatedMessage
  | DaemonLogMessage
  | DaemonLogsClearedMessage
  | OauthAuthorizeUrlMessage
  | AdditionalOrgsAvailableMessage;

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
}

/** Server-to-server OAuth enrollment for a sibling org. Requires an
 *  existing Sentinel account with the given email to have a stored
 *  sessionKey — that sessionKey is reused to authenticate the GET to
 *  /oauth/authorize, avoiding a webview entirely. Broadcasts
 *  `login_complete` on success (same shape as browser OAuth). If the
 *  silent path fails (claude.ai returns a challenge, sessionKey
 *  expired, etc.), the daemon falls back to the regular `start_login`
 *  webview flow automatically so the user still gets enrolled. */
export interface SilentSiblingLoginMessage {
  type: 'silent_sibling_login';
  /** Email of the parent account whose sessionKey to reuse. */
  email: string;
  /** Target org UUID to mint the OAuth token for. */
  orgUuidHint: string;
}

/** Ask the daemon which sibling orgs could still be enrolled for each
 *  email that already has a sessionKey. The daemon calls /api/bootstrap
 *  once per email, filters memberships to chat-capable orgs not already
 *  present in Sentinel, and returns the leftovers. The Configuration
 *  page uses this to show "+ Add <orgName>" buttons on grouped rows. */
export interface GetSiblingCandidatesMessage {
  type: 'get_sibling_candidates';
}

/** Response payload for get_sibling_candidates. Keyed by email. Empty
 *  map means every enrolled email has zero unenrolled siblings (or no
 *  email has a sessionKey to enumerate). */
export type SiblingCandidates = Record<
  string,
  Array<{ orgUuid: string; orgName: string }>
>;

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

export interface GetOverageEventsMessage {
  type: 'get_overage_events';
  limit?: number;
  /** View-scope account. When omitted, the handler returns events across
   *  every account so the Overage tab can default to an all-accounts view. */
  accountId?: string;
}

/** Permanently delete overage transition rows. Optional `accountId` scopes
 *  the delete to a single account; omitted wipes every row. */
export interface ClearOverageEventsMessage {
  type: 'clear_overage_events';
  accountId?: string;
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
   *  Implies `scope === 'account'` (or budget:account). Ignored when
   *  scope === 'pool' or budget:global. */
  accountId?: string;
  /** Filter by scope. `'all'` (default) returns every scope; `'account'`,
   *  `'pool'`, and `'budget'` each return only the named scope. */
  scope?: AlertScope | 'all';
}

export interface UpsertAlertMessage {
  type: 'upsert_alert';
  /** Omit to create; provide an existing id to update in place. */
  id?: number;
  /** `'account'` requires a non-null accountId; `'pool'` requires accountId
   *  to be null; `'budget'` requires an accompanying `budgetScope`. Defaults
   *  to `'account'` for backwards compatibility. */
  scope?: AlertScope;
  /** Null when scope === 'pool', or scope === 'budget' with budgetScope === 'global'. */
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

/** Approve a held outbound block. The daemon adds the block's match to
 *  the allowlist (so subsequent identical matches are silently allowed),
 *  releases the request to flow upstream, and broadcasts
 *  `security_block_resolved`. No-op if the pending block has already
 *  timed out or been denied. */
export interface ApproveBlockedRequestMessage {
  type: 'approve_blocked_request';
  pendingId: string;
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
  | 'risky-webfetch'
  | 'tool-use-low-severity'
  | 'pending-block';

export interface DevTriggerSecurityEventMessage {
  type: 'dev_trigger_security_event';
  scenario: SecurityTestScenario;
  /** Account to attribute the synthetic event to. Defaults to 'default'
   *  when omitted so the script works without knowing the active key. */
  accountId?: string;
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

/** Store a claude.ai sessionKey for an account in the OS keychain. The
 *  daemon uses this cookie to fetch real overage spend + limit data from
 *  `https://api.anthropic.com/api/organizations/{org}/usage` — the only
 *  source of truth for those numbers (no OAuth endpoint exists). Passing
 *  an empty string is rejected; use `clear_claude_ai_session_key` to remove. */
export interface SetClaudeAiSessionKeyMessage {
  type: 'set_claude_ai_session_key';
  accountId: string;
  sessionKey: string;
}

/** Remove a stored sessionKey. */
export interface ClearClaudeAiSessionKeyMessage {
  type: 'clear_claude_ai_session_key';
  accountId: string;
}

/** Presence-check the stored sessionKey. Returns `{ hasKey: boolean }`. The
 *  daemon NEVER returns the value itself — that would defeat keychain
 *  storage. The UI uses this to render "set" / "not set" status. */
export interface HasClaudeAiSessionKeyMessage {
  type: 'has_claude_ai_session_key';
  accountId: string;
}

/** Fetch the cached claude.ai usage snapshot for the given account. Returns
 *  null when the daemon has not yet successfully fetched (e.g. key missing
 *  or auth rejected). Numbers are dollars (converted from `minor_units`). */
export interface GetClaudeAiUsageMessage {
  type: 'get_claude_ai_usage';
  accountId: string;
}

/** Force an immediate fetch against the claude.ai usage endpoint. Used on
 *  first sessionKey save so the UI doesn't wait for the periodic poller. */
export interface RefreshClaudeAiUsageMessage {
  type: 'refresh_claude_ai_usage';
  accountId: string;
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
  | SilentSiblingLoginMessage
  | GetSiblingCandidatesMessage
  | CancelLoginMessage
  | RemoveAccountMessage
  | GetRateLimitsMessage
  | GetAllRateLimitsMessage
  | GetOverageEventsMessage
  | ClearOverageEventsMessage
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
  | ApproveBlockedRequestMessage
  | DenyBlockedRequestMessage
  | ListPendingBlocksMessage
  | GetDaemonLogsMessage
  | ClearDaemonLogsMessage
  | GetOverageGrantsMessage
  | RefreshOverageGrantsMessage
  | GetSpendSummaryMessage
  | SetClaudeAiSessionKeyMessage
  | ClearClaudeAiSessionKeyMessage
  | HasClaudeAiSessionKeyMessage
  | GetClaudeAiUsageMessage
  | RefreshClaudeAiUsageMessage
  | DevTriggerSecurityEventMessage;

/** Response payload alias re-exports for convenience in consumers. */
export type { Settings, Alert, NotificationRecord, MetricsSummary, OverageCreditGrant, SecurityEvent, SecurityAllowlistEntry, PendingSecurityBlock, LogEntry, LogLevel };

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
