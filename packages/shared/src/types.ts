/**
 * Credential blob stored in the OS keychain under "Claude Code-credentials"
 */
export interface ClaudeCodeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix ms timestamp
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
  profile?: Record<string, unknown>;
  tokenAccount?: {
    uuid: string;
    emailAddress: string;
    organizationUuid: string;
  };
}

/**
 * Non-secret account metadata stored in ~/.claude.json under the `oauthAccount` key
 */
export interface OAuthAccount {
  accountUuid: string;
  emailAddress: string;
  organizationUuid: string;
  hasExtraUsageEnabled: boolean;
  billingType: string;
  accountCreatedAt: string; // ISO 8601
  subscriptionCreatedAt: string; // ISO 8601
  displayName: string;
  organizationRole: 'user' | 'admin' | 'owner';
  workspaceRole: string | null;
  organizationName: string;
}

export type PlanType = 'pro' | 'max' | 'team' | 'enterprise';

/**
 * Enriched account record combining OS credential metadata with Sentinel's stored info
 */
export interface AccountInfo {
  /** Sentinel internal key: orgUuid when present, else accountUuid */
  id: string;
  /** Actual Anthropic user UUID — used for Claude Code compatibility */
  accountUuid: string;
  email: string;
  displayName: string;
  orgUuid: string;
  orgName: string;
  planType: PlanType;
  isActive: boolean;
  createdAt: number; // Unix ms
  /** User-picked avatar color as a 7-char hex string (e.g. "#FF9F0A").
   *  Null means "derive the default from the account-id hash gradient". */
  color: string | null;
}

/**
 * A single API usage event from OTEL telemetry, persisted to SQLite
 */
export interface UsageEvent {
  id: number;
  ts: number; // Unix ms
  accountId: string;
  sessionId: string | null;
  model: string;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheRead: number | null;
  cacheCreate: number | null;
  durationMs: number | null;
}

export type OverageTransition = 'entered' | 'exited' | 'disabled';

/**
 * A recorded transition in the overage state machine
 */
export interface OverageEvent {
  id: number;
  ts: number; // Unix ms
  accountId: string;
  transition: OverageTransition;
  status: string | null;
  resetsAt: number | null;
  disabledReason: string | null;
}

export type NotificationType =
  | 'overage_entered'
  | 'account_switched'
  | 'overage_disabled'
  | 'usage_alert'
  | 'security_low'
  | 'security_medium'
  | 'security_high';

/**
 * A notification record stored in SQLite
 */
export interface NotificationRecord {
  id: number;
  ts: number; // Unix ms
  accountId: string | null;
  type: NotificationType;
  title: string;
  body: string;
  acknowledged: boolean;
}

/**
 * In-memory overage state tracked per accountUuid
 */
export interface OverageState {
  isUsingOverage: boolean;
  status: string | null;
  resetsAt: number | null;
  disabledReason: string | null;
  lastUpdated: number; // Unix ms
}

/**
 * Daily usage summary for an account
 */
export interface UsageSummary {
  accountId: string;
  todayCostUsd: number;
  todayTokens: number;
  sessionCount: number;
  byModel: Record<string, { costUsd: number; tokens: number }>;
}

/**
 * Overage credit grant from the Anthropic REST API
 */
export interface OverageCreditGrant {
  available: number;
  eligible: number;
  granted: number;
  amountMinorUnits: number;
  currency: string;
}

/**
 * Shape of ~/.claude.json (partial — only fields Sentinel cares about)
 */
export interface ClaudeState {
  oauthAccount?: OAuthAccount;
  overageCreditGrantCache?: Record<string, OverageCreditGrant>;
  cachedExtraUsageDisabledReason?: string | null;
  hasAvailableSubscription?: boolean;
  [key: string]: unknown;
}

/**
 * One of two mutually exclusive account-switching behaviors.
 *   off         — no automatic switching; user manages accounts manually
 *   round-robin — proxy rotates OAuth tokens per request across accounts,
 *                 tuned by `roundRobinStrategy` (balance or earliest-reset)
 */
export type SwitchingMode = 'off' | 'round-robin';

/**
 * Sub-strategy for round-robin rotation.
 *   balance        — prefer the account with the lowest unified-5h utilization
 *                    (1% tie band + cursor for fair rotation). Drains the pool
 *                    evenly — the classic round-robin behavior.
 *   earliest-reset — hard-target the non-blocked pool account whose 5-hour
 *                    window resets soonest. Accounts without reset data are
 *                    deprioritized. Maximizes usage of the headroom that is
 *                    about to be reclaimed anyway; rotation resumes only when
 *                    the target blocks or its window rolls over.
 */
export type RoundRobinStrategy = 'balance' | 'earliest-reset';

/**
 * Persistent user preferences stored at ~/.claude-sentinel/settings.json.
 */
export interface Settings {
  launchAtLogin: boolean;
  switchingMode: SwitchingMode;
  /** OS system sound name played alongside alert notifications.
   *  `null` means silent. On macOS the name must match a file in
   *  /System/Library/Sounds (e.g. 'Glass', 'Ping'). See ALERT_SOUNDS. */
  alertSoundName: string | null;
  /** When true, fire a native OS notification on overage `entered` and
   *  `disabled` transitions. `exited` is never surfaced as a banner — the
   *  in-app timeline covers that silent good-news case. */
  overageOsNotify: boolean;
  /** When true, check for a new release on app startup and install it
   *  silently, restarting on success. Defaults to `false` until macOS
   *  signing + notarization lands (Gatekeeper rejects unsigned .app
   *  replacements). Users can still opt in on Windows/Linux immediately. */
  autoUpdate: boolean;
  /** Sentinel account IDs excluded from round-robin rotation. Empty means
   *  every enrolled account rotates (opt-out model) — preserves the
   *  original "RR just works" behavior and auto-enrolls newly added
   *  accounts. Ignored unless `switchingMode === 'round-robin'`. */
  poolExcludedIds: string[];
  /** Sentinel account IDs explicitly allowed to draw on Anthropic's overage
   *  budget when their subscription quota is exhausted. Opt-IN — an account
   *  NOT on this list is treated as "never spend overage". Default [].
   *
   *  Round-robin mode: the `TokenRotator` refuses to pick an account whose
   *  next request would consume overage (5h window saturated with overage
   *  status `allowed`, or overage `in_use === true`) unless the account is
   *  on this list.
   *
   *  `off` mode: the daemon still surfaces the existing `overage_entered`
   *  notification — the user picked that active account themselves. */
  overageEnabledIds: string[];
  /** Per-account weekly (rolling 7-day) spend cap in USD. When set and the
   *  account's cost_usd sum over the trailing 7 days meets or exceeds this
   *  value, Sentinel pauses the account — it becomes unpickable in
   *  round-robin and the proxy returns 503 with a Retry-After header in
   *  `off` mode. Overrides Anthropic's server-side overage grant. Clears on
   *  the next unified-5h rollover if spend has aged out of the window.
   *  0 or missing = no cap. Keyed by Sentinel id (not accountUuid). */
  budgetWeeklyUsdByAccount: Record<string, number>;
  /** Optional global weekly spend cap summed across every enrolled account.
   *  When the summed rolling-7d spend crosses this value, every enrolled
   *  account is paused until its 5h window resets. Null = no global cap. */
  budgetWeeklyUsdGlobal: number | null;
  /** Safety margin keeping round-robin from picking an account whose next
   *  request might spill into Anthropic overage. The rotator excludes any
   *  account whose unified-5h utilization is ≥ (1 − overageBufferPct/100).
   *  Defends against the race where an account at 98% util absorbs a 4%
   *  request and burns 2% overage the user didn't opt into. Integer range
   *  `[0, 50]`. Default 5 (= cut-off at 95% util). 0 = only cut off at
   *  full saturation (legacy pre-buffer behavior). Ignored unless
   *  `switchingMode === 'round-robin'`. */
  overageBufferPct: number;
  /** Which rotation strategy the round-robin token rotator uses.
   *  Ignored unless `switchingMode === 'round-robin'`. Default `'balance'`. */
  roundRobinStrategy: RoundRobinStrategy;
  /** Seconds between background probes of each non-active account's
   *  rate-limit state. Keeps the Usage tab in sync with claude.ai / other
   *  Anthropic surfaces when Claude Code isn't actively driving the
   *  account. Clamped to [60, 3600]. Default 300 (5 min). */
  backgroundProbeIntervalSec: number;
  /** Days to retain telemetry rows (usage_events, tool_events, api_errors,
   *  activity_events). The Metrics tab's largest window is 30d; going longer
   *  preserves history for manual SQL queries. Clamped to [1, 365].
   *  Default 30. Runs at startup and once/day thereafter. */
  telemetryRetentionDays: number;

  // ─── Security scanning ─────────────────────────────────────────────
  /** Master on/off for the security scanning subsystem. */
  securityScanEnabled: boolean;
  /** How aggressively the outbound scanner acts on findings.
   *  `null` means the user hasn't picked one yet — the UI surfaces a
   *  first-run modal to make the choice explicit. */
  securityEnforcementMode: SecurityEnforcementMode | null;
  /** Category toggles. All gated by the master `securityScanEnabled`. */
  securityScanSecrets: boolean;
  securityScanInjection: boolean;
  securityScanToolUse: boolean;
  /** Severity floor for native OS notifications. `off` silences all. */
  securityOsNotifyThreshold: SecurityOsNotifyThreshold;
  /** When false, the redacted 40-char snippet column is dropped on persist —
   *  only mask + hashes remain. Mask + hash are always stored. */
  securityPersistSnippet: boolean;
  /** Rows older than this many days are purged at daemon startup. */
  securityEventRetentionDays: number;
  /** When true, outbound blocks are held open in the proxy for up to
   *  `securityApproveHoldSec` while the user can approve the request in
   *  the UI. When false, blocks 403 Claude Code immediately (v1.1 behavior). */
  securityBlockHoldEnabled: boolean;
  /** How long a held block waits for an approve click before the proxy
   *  synthesizes the 403. Clamped to [10, 300]. Default 60. */
  securityApproveHoldSec: number;

  /** Minimum severity written to daemon.log and streamed to the in-app Logs
   *  tab. `debug` is opt-in; noisy subsystems emit DEBUG only for deep
   *  troubleshooting. Default `info`. Applied live via `update_settings` —
   *  no daemon restart required. */
  logLevel: LogLevel;
}

/** Structured log entry emitted by the daemon logger and streamed to the
 *  in-app Logs tab. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** Monotonic per-daemon-process sequence number. Lets the UI dedupe
   *  entries that arrive both via the initial history fetch and a
   *  broadcast batch. Resets to 0 on daemon restart; the UI detects a
   *  seq rollback and clears its merge state. */
  seq: number;
  /** Unix ms. */
  timestamp: number;
  level: LogLevel;
  /** Args joined with a single space, matching the existing console.log
   *  monkey-patch output. Error instances contribute `err.stack ?? err.message`. */
  message: string;
  /** Leading `[Tag]` prefix when present — e.g. `OAuth`, `Switch`. Null
   *  when the message doesn't start with a bracketed tag. Bounded to 32
   *  chars so spammy content can't explode the UI's filter chip set. */
  tag: string | null;
}

/** How the outbound scanner reacts to findings.
 *  Tool_use (inbound) is always observed only; we cannot block a response
 *  stream without corrupting the SSE protocol. */
export type SecurityEnforcementMode =
  | 'observe'            // never block; only record + notify
  | 'block_high'         // block outbound when a HIGH finding is present
  | 'block_medium_high'; // block on MEDIUM or HIGH findings

export type SecurityOsNotifyThreshold = 'off' | 'high' | 'medium' | 'low';

/** A detected security incident surfaced by the scanner. One row in the
 *  `security_events` SQLite table. Secrets are NEVER persisted verbatim —
 *  only the masked form plus a hash for dedup. */
export interface SecurityEvent {
  id: number;
  ts: number; // first-seen Unix ms
  lastSeenTs: number; // bumped by dedup
  accountId: string;
  sessionId: string | null;
  /** Where the finding came from. Outbound = in the request we were about
   *  to forward. tool_use = in a response the model streamed back. */
  direction: 'outbound' | 'tool_use';
  severity: SecuritySeverity;
  kind: SecurityKind;
  /** Stable id of the detector that fired, e.g. `aws-access-key-v1`. */
  detectorId: string;
  /** 0..1 — the UI hides <0.7 behind a "show weak signals" toggle. */
  confidence: number;
  title: string;
  /** Human-readable rationale shown in the expand panel. */
  reason: string;
  /** e.g. "AKIA…[16 redacted]…AB12" — first 4, last 4, length in middle. */
  matchMask: string | null;
  /** sha256(matched).slice(0,32) — dedup primary key component. */
  matchHash: string;
  /** sha256(40-char window around the match).slice(0,32). */
  contextHash: string | null;
  /** 40 chars around the match with the secret itself replaced by
   *  `[REDACTED:kind]`. Null when `securityPersistSnippet` is off. */
  snippet: string | null;
  /** File path, tool name, or block index — whatever tells the user
   *  "which part of my prompt/response triggered this". */
  sourceHint: string | null;
  /** Detector-specific extra fields (JSON-encoded in SQLite). */
  details: Record<string, unknown> | null;
  /** Number of times this same finding has been seen in the dedup window. */
  occurrences: number;
  /** True when the request was refused (block-mode). Informational —
   *  Claude Code sees a 403 in this case. */
  blocked: boolean;
  /** True when the user approved a pending block for this finding. The row
   *  also stays in the DB and is mirrored into the allowlist so subsequent
   *  matches are silently suppressed. */
  approved: boolean;
  acknowledged: boolean;
  /** Where the matching text lived in the request body. Drives the
   *  block decision — only `file-read` and `tool-use` can block on
   *  secret/PII findings. Everything else is observe-only. See
   *  packages/daemon/src/security/detectors.ts:classifyProvenance. */
  provenance: FindingProvenance;
}

/** Provenance categories for security findings. Blocking for secret/PII
 *  is restricted to `file-read` (Read tool_result or Write file_path)
 *  and `tool-use` (risky Bash/Write/WebFetch commands). Everything else
 *  persists as observe-only so the user still sees it in the Security
 *  tab without getting 403'd on conversation text. */
export type FindingProvenance =
  | 'file-read'
  | 'tool-use'
  | 'conversation'
  | 'system-prompt'
  | 'telemetry';

/** Snapshot of a blocked outbound request held by the proxy pending the
 *  user's approve decision. Surfaced to the frontend via broadcast so the
 *  in-app banner can render a live countdown. */
export interface PendingSecurityBlock {
  pendingId: string;
  accountId: string;
  severity: SecuritySeverity;
  /** Short human-readable title — e.g. "GitHub personal token". */
  title: string;
  /** Human-readable reason string the proxy would embed in the 403. */
  blockReason: string;
  /** Masked form of the matched string for display (never the raw value). */
  matchMask: string | null;
  detectorId: string;
  /** Unix ms at which the hold expires; drives client-side countdowns. */
  expiresAt: number;
}

export type SecuritySeverity = 'low' | 'medium' | 'high';

/** A user-suppressed (match_hash, detector_id) pair. Any future finding
 *  with the same identity is dropped before persistence + broadcast. */
export interface SecurityAllowlistEntry {
  id: number;
  matchHash: string;
  detectorId: string;
  /** Copied from the originating event for display purposes. */
  matchMask: string | null;
  /** Detector title, e.g. "AWS access key". */
  title: string | null;
  /** Optional user note captured at add-time. */
  note: string | null;
  createdAt: number;
}

export type SecurityKind =
  | 'secret'
  | 'pii'
  | 'prompt_injection'
  | 'risky_bash'
  | 'risky_write'
  | 'risky_webfetch'
  | 'scan_truncated'
  | 'scan_skipped_encoding'
  | 'scan_deferred_oversized';

/** Sound choices exposed in Settings. Values map to macOS system sounds;
 *  `null` means no sound. Other platforms will ignore unknown names silently. */
export const ALERT_SOUNDS: ReadonlyArray<{ label: string; value: string | null }> = [
  { label: 'None',      value: null        },
  { label: 'Basso',     value: 'Basso'     },
  { label: 'Blow',      value: 'Blow'      },
  { label: 'Bottle',    value: 'Bottle'    },
  { label: 'Frog',      value: 'Frog'      },
  { label: 'Funk',      value: 'Funk'      },
  { label: 'Glass',     value: 'Glass'     },
  { label: 'Hero',      value: 'Hero'      },
  { label: 'Morse',     value: 'Morse'     },
  { label: 'Ping',      value: 'Ping'      },
  { label: 'Pop',       value: 'Pop'       },
  { label: 'Purr',      value: 'Purr'      },
  { label: 'Sosumi',    value: 'Sosumi'    },
  { label: 'Submarine', value: 'Submarine' },
  { label: 'Tink',      value: 'Tink'      },
];

/**
 * Scope for a user-configured usage alert.
 *   account — bound to a single Sentinel account key; fires on that account's
 *             unified-5h utilization.
 *   pool    — round-robin only; fires on the mean unified-5h utilization
 *             across every pool member (accounts not in `poolExcludedIds`).
 *   budget  — fires on rolling 7-day spend vs. the user-configured Sentinel
 *             budget. `budgetScope: 'account'` compares against
 *             `Settings.budgetWeeklyUsdByAccount[accountId]`; `'global'`
 *             compares summed spend against `budgetWeeklyUsdGlobal`.
 *             Re-arms on ISO-week rollover rather than 5h-window reset.
 */
export type AlertScope = 'account' | 'pool' | 'budget';

/**
 * Sub-scope for `scope: 'budget'` alerts. `'account'` binds the alert to a
 * specific Sentinel account id. `'global'` tracks the sum across every
 * enrolled account (accountId is null). Ignored for non-budget scopes.
 */
export type BudgetAlertScope = 'account' | 'global';

/**
 * User-configured usage alert. Fires a native OS notification when the
 * relevant utilization (per-account or pooled) crosses thresholdPct.
 * Re-firing is gated by lastTriggeredResetTs so each alert fires at most
 * once per 5-hour window.
 *
 * For `scope === 'pool'`, `accountId` is null and the reset gate uses the
 * minimum `reset` timestamp across pool members — the alert re-arms as soon
 * as any pool account's window rolls over.
 *
 * For `scope === 'budget'`, `budgetScope` discriminates per-account vs. global
 * and `lastTriggeredResetTs` stores the ISO-week-start timestamp so the alert
 * re-arms at most once per calendar week rather than every 5-hour rollover.
 */
export interface Alert {
  id: number;
  scope: AlertScope;
  /** Null when scope === 'pool', or when scope === 'budget' with
   *  budgetScope === 'global'. */
  accountId: string | null;
  thresholdPct: number;
  enabled: boolean;
  lastTriggeredResetTs: number | null;
  createdAt: number;
  /** Only set when scope === 'budget'. Undefined otherwise. */
  budgetScope?: BudgetAlertScope;
}

/**
 * Overage response headers from api.anthropic.com.
 *
 * The live Anthropic API emits `overage-status: 'allowed'` whenever overage
 * is available to tap, and sets a separate `overage-in-use` header on
 * responses that actually drew from the overage budget. `overage-status:
 * 'disabled'` is used when overage is turned off (weekly budget exhausted
 * or user-disabled). `inUse` is the authoritative "currently consuming
 * overage" signal; `status` drives the disabled transition.
 */
export interface OverageHeaders {
  status: string | null; // 'allowed' | 'disabled' | null
  resetsAt: number | null; // Unix timestamp
  disabledReason: string | null;
  inUse: boolean | null;
}

/**
 * A single rate limit window parsed from anthropic-ratelimit-* response headers.
 *
 * Subscription plans (Pro/Max/Team) use utilization (0–1 fraction) with no
 * absolute counts. API-key plans use limit + remaining instead.
 */
export interface RateLimitWindow {
  /** e.g. "unified-5h", "unified-7d", "unified-7d_sonnet", "tokens", "requests" */
  name: string;
  /** "allowed" | "blocked" | null */
  status: string | null;
  /** Fraction 0.0–1.0 of the window consumed (subscription plans) */
  utilization: number | null;
  /** Absolute cap (API-key plans only) */
  limit: number | null;
  /** Remaining count (API-key plans only) */
  remaining: number | null;
  /** Unix timestamp (seconds) when this window resets */
  reset: number | null;
  /** True while the response headers signal this window is actively being
   *  consumed — currently only emitted by Anthropic for `unified-overage`
   *  (header `anthropic-ratelimit-unified-overage-in-use`). Null/undefined
   *  if the header was never observed on this account. Optional for
   *  back-compat with persisted rows written before the column existed. */
  inUse?: boolean | null;
  lastUpdated: number; // Unix ms
}

// ─── Metrics dashboard ────────────────────────────────────────────────────────

/** Per-day per-model tokens + cost breakdown. Powers the Tokens and Cost charts. */
export interface MetricsByDayModel {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface CacheHitRate {
  cacheRead: number;
  input: number;
  /** cacheRead / (input + cacheRead), 0..1. 0 when both are 0. */
  rate: number;
}

export interface ToolStat {
  toolName: string;
  calls: number;
  successRate: number; // 0..1
  p50Ms: number;
  p95Ms: number;
  /** Most common error message for failed invocations, or null when no failures. */
  topError: string | null;
}

export interface EditAcceptRate {
  accepts: number;
  rejects: number;
  /** accepts / (accepts + rejects), 0..1. 0 when no decisions recorded. */
  rate: number;
}

/**
 * Accept/reject breakdown for `tool_decision` OTEL events — fires when the
 * user approves/denies a tool-permission prompt. Covers ALL tools (Bash,
 * Read, Write, WebFetch, MCP, etc.), distinct from EditAcceptRate which is
 * limited to the Edit / Write / NotebookEdit metric.
 */
export interface ToolDecisionBreakdown {
  overall: EditAcceptRate;
  /** Per-tool accept/reject. Example: { "Bash": { accepts: 12, rejects: 2, rate: 0.857 } }. */
  byTool: Record<string, EditAcceptRate>;
  /** By decision source: config / hook / user_permanent / user_temporary / user_abort / user_reject. */
  bySource: Record<string, EditAcceptRate>;
}

/**
 * Per-day rollup of `user_prompt` OTEL events — one event per prompt the
 * user submits in Claude Code. `value` on the activity row stores prompt
 * character length (body is redacted unless OTEL_LOG_USER_PROMPTS=1).
 */
export interface PromptStats {
  /** Total prompts submitted over the period. */
  total: number;
  /** Mean prompt length in characters (across prompts that reported length). */
  avgLength: number;
  /** { "YYYY-MM-DD": { count, avgLength } } — empty when no prompts fell on a day. */
  perDay: Record<string, { count: number; avgLength: number }>;
}

export interface SkillUsage {
  name: string;
  count: number;
  plugin: string | null;
}

export interface PluginInstall {
  name: string;
  version: string | null;
  marketplace: string | null;
  installedAt: number; // Unix ms
}

/**
 * Rollup of every OTEL-sourced signal surfaced by the Metrics tab for the
 * active account over the requested period. Fetched via the
 * `get_metrics_summary` IPC so the UI makes one round trip per period change.
 */
export interface MetricsSummary {
  days: number;
  accountId: string;
  /** { "YYYY-MM-DD": { "claude-sonnet-4-6": { costUsd, inputTokens, ... } } } */
  byDayModel: Record<string, Record<string, MetricsByDayModel>>;
  /** Keyed by model name. */
  cacheHitRate: Record<string, CacheHitRate>;
  errors: {
    /** { "YYYY-MM-DD": { "429": 3, "500": 1 } } */
    byDay: Record<string, Record<string, number>>;
    /** Count of errors where `attempt > CLAUDE_CODE_MAX_RETRIES` (default 10). */
    retryExhaustedCount: number;
  };
  tools: ToolStat[];
  activity: {
    sessionsPerDay: Record<string, number>;
    commitsPerDay: Record<string, number>;
    prsPerDay: Record<string, number>;
    linesPerDay: Record<string, { added: number; removed: number }>;
    /** Seconds of active time per day, split by source. */
    activeTimePerDay: Record<string, { user: number; cli: number }>;
  };
  editAcceptRate: {
    overall: EditAcceptRate;
    byLanguage: Record<string, EditAcceptRate>;
  };
  /** Accept/reject stats for ALL tools from `tool_decision` OTEL events.
   *  Empty when no permission prompts were shown. */
  toolDecisions: ToolDecisionBreakdown;
  /** Prompts submitted per day (from `user_prompt` OTEL events). */
  prompts: PromptStats;
  skills: SkillUsage[];
  plugins: PluginInstall[];
}
