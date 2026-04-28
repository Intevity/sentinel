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
 * Sonnet-specific saturation transitions.
 *
 *   entered — utilization on `unified-7d_sonnet` crossed the overage-buffer
 *             threshold (default 95%). The next Sonnet request on this
 *             account will draw from the monthly overage budget unless the
 *             account is opted into overage via `overageEnabledIds`.
 *   exited  — utilization fell back below the threshold (window rollover).
 *
 * Dedup is per reset timestamp on the Sonnet window, so a single
 * saturation episode produces at most one entered + one exited.
 */
export type SonnetSaturationTransition = 'entered' | 'exited';

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

  // ─── Tool permission enforcement ───────────────────────────────────
  /** Master switch for the tool-permissions subsystem. When false, the
   *  rule evaluator short-circuits to allow and no proxy interception runs.
   *  Default `false` — the feature ships dark and users opt in. */
  toolPermissionsEnabled: boolean;
  /** Outcome for tool calls that no rule matches. `allow` = default-open
   *  (only explicit denies block); `deny` = default-closed (user must
   *  explicitly allow each tool they want to run). */
  toolPermissionDefaultAction: PermissionDecision;
  /** When true AND `toolPermissionAutoModeActive` is true, the evaluator
   *  bypasses every rule and allows unconditionally — the user trusts
   *  Claude Code's own auto-mode classifier and doesn't want Sentinel
   *  double-gating. */
  toolPermissionSkipInAutoMode: boolean;
  /** Manual "Claude Code is currently in auto mode" flag. No automatic
   *  detection is possible from the proxy layer (permission mode is a
   *  local Claude Code decision that produces no HTTP signal), so the
   *  user flips this on when they launch Claude Code with auto mode and
   *  flips it off when they're done. */
  toolPermissionAutoModeActive: boolean;

  /** When true, RFC-1918 private network ranges (10/8, 172.16/12,
   *  192.168/16) are added to the always-on default-deny set for web
   *  tools (alongside link-local 169.254/16, IPv6 link-local fe80::/10,
   *  cloud-metadata FQDNs, and localhost). Off by default because users
   *  legitimately fetch from intra-LAN dev servers; the High preset
   *  flips it on. The deny is overridable by an explicit allow rule. */
  denyPrivateNetworkByDefault: boolean;

  /** When true, path-tool rule evaluation calls `fs.realpathSync` on the
   *  target before matching, so a deny rule for `Read(//etc/**)` still
   *  fires when the agent reads a symlink that points into `/etc/`. Adds
   *  one stat per rule check, so it's opt-in. Off by default. The
   *  resolution is best-effort; broken or non-existent links fall back
   *  to the un-resolved input. The pattern is never realpath'd, only
   *  the input. */
  toolPermissionResolveSymlinks: boolean;

  /** Size threshold (MB) above which the scanner takes its deferred
   *  path — the body is scanned off the proxy's hot path so the
   *  request isn't stalled by multi-MB JSON parsing. Raising this
   *  lets larger bodies through the synchronous gate; lowering it
   *  catches smaller payloads too. Clamped 1–16 MB. Default 4 MB
   *  (chosen from request-size telemetry — see `scanner.bench.ts`
   *  and the comment on the default in `settings.ts`). */
  securityOversizedThresholdMb: number;

  /** When true, the scanner runs its full synchronous block-decision
   *  gate even on bodies over the threshold — accepting the per-
   *  request latency cost to gain block-on-oversized coverage. When
   *  false (default), oversized bodies fall through to the deferred
   *  observe-only path and a `scan_deferred_oversized` synthetic
   *  event is recorded. */
  securityScanOversizedSync: boolean;

  /** Suppress the `scan_deferred_oversized` synthetic event entirely
   *  — no DB row, no broadcast, no OS notification. The async scan
   *  still runs; only the informational telemetry is silenced. */
  securityMuteScanDeferred: boolean;

  /** Suppress `scan_truncated` — fires when a response-tap buffer
   *  exceeds its byte budget (response-tap.ts:25). Muting is
   *  informational-only: detection still runs on whatever made it
   *  into the buffer before truncation. */
  securityMuteScanTruncated: boolean;

  /** Suppress `scan_skipped_encoding` — fires when a body arrives in
   *  an unsupported encoding and can't be parsed (detectors.ts:43). */
  securityMuteScanSkipped: boolean;

  /** Most recent scan-benchmark result captured on this machine.
   *  `null` when the user has never run the benchmark — the UI shows
   *  "not tuned yet" and the threshold uses the static default. Once
   *  populated, the UI can surface "last tuned: X ago" and the
   *  recommended threshold from the captured measurements. */
  lastScanBenchmark: SecurityBenchmarkResult | null;

  /** Bi-directional sync between Sentinel's permission_rules table and
   *  Claude Code's `~/.claude/settings.json#/permissions`. When on,
   *  the daemon watches the file for changes and mirrors updates in
   *  both directions within a ~1 s debounce. Rules imported from
   *  Claude Code carry `source: 'claude-code'`; rules authored in
   *  Sentinel keep `source: 'local'` and are pushed to the file. Off
   *  by default — the first enable prompts the user to choose a
   *  merge direction via a modal to avoid data loss. */
  claudeCodeSyncEnabled: boolean;

  /** Minimum severity written to daemon.log and streamed to the in-app Logs
   *  tab. `debug` is opt-in; noisy subsystems emit DEBUG only for deep
   *  troubleshooting. Default `info`. Applied live via `update_settings` —
   *  no daemon restart required. */
  logLevel: LogLevel;

  // ─── Request/response capture (Logs tab) ───────────────────────────
  /** Master on/off for capturing raw Claude API request/response bodies to
   *  the dedicated request-logs SQLite DB. Off by default — captured bodies
   *  include prompts and model output, so users must opt in. Read per-request
   *  by the proxy so the toggle takes effect immediately with no restart. */
  requestLoggingEnabled: boolean;
  /** Days to retain rows in `request_logs`. Purge runs at startup + once/day.
   *  Clamped to `[1, 90]`. Default 7 — bodies are large so a shorter default
   *  than telemetry retention keeps disk usage bounded. */
  requestLogRetentionDays: number;
  /** Per-body cap in KiB. Applied independently to request body and response
   *  body — a 256 KB cap means each side is truncated at 256 KB. Protects
   *  against multi-MB SSE responses filling the DB. Clamped to `[1, 5000]`.
   *  Default 256. */
  requestLogMaxBodyKb: number;
  /** When false, only request bodies are captured; response bodies are skipped.
   *  Useful for users debugging their own prompts without wanting to persist
   *  large model outputs. Default true. */
  requestLogCaptureResponse: boolean;
  /** When true (the default), the `authorization` header is replaced with
   *  `[REDACTED]` before persistence. Static keys (`x-api-key`), proxy
   *  credentials, and cookies are always redacted regardless of this flag. */
  requestLogRedactAuthHeaders: boolean;

  // ─── Prompt caching ────────────────────────────────────────────────
  /** When true, the proxy rewrites every existing `cache_control` block on
   *  outbound `/v1/messages` (and `/v1/messages/count_tokens`) requests to
   *  `{type: 'ephemeral', ttl: '1h'}`. Also appends
   *  `anthropic-beta: extended-cache-ttl-2025-04-11` to the request. Never
   *  inserts new cache breakpoints where the client didn't place one, so we
   *  stay within the 4-breakpoint-per-request API cap automatically. Intended
   *  to give Pro accounts the same 1h prompt-cache behavior as Max/Team.
   *  Note: Anthropic's server may enforce a tier-based TTL downgrade on
   *  subscription OAuth logins; the Cache TTL section of the Usage tab shows
   *  the effective result. Default false. */
  cacheTtlForceOneHour: boolean;

  /** When true, the daemon captures up to the last 10 tool-use messages
   *  per session into an in-memory ring buffer. When a security_event
   *  of severity ≥ medium fires under `block_high` or `block_medium_high`
   *  enforcement, that buffer is snapshotted (with secrets redacted) into
   *  the `incident_replays` table keyed by event id. The Security tab
   *  surfaces a "Replay context" button on events that have a replay row.
   *  Off by default for privacy: capturing message text, even redacted,
   *  is more invasive than recording detector findings alone. */
  securityIncidentReplay: boolean;

  // ─── Onboarding state ──────────────────────────────────────────────
  /** True once the user has either applied a risk-profile preset in the
   *  Security Setup Wizard or explicitly dismissed it. The wizard fires
   *  at most once per install unless the user re-triggers it from
   *  Settings → Security. */
  securitySetupCompleted: boolean;
  /** True once the user has finished or skipped the first-run feature
   *  tour. The tour can always be replayed via the help icon next to
   *  the Sentinel header. */
  tourCompleted: boolean;
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
  /** Present only on proxy-origin entries that have a captured request/response
   *  pair stored in the request-logs DB. Clicking such a row in the Logs UI
   *  expands an inline detail panel that lazy-fetches the full record via
   *  `get_request_detail`. Null/undefined for every other log line. */
  requestId?: string;
}

/** Full captured detail for a single proxied request/response pair, backed by
 *  the dedicated request-logs SQLite DB. Fetched on-demand when the user
 *  expands a row in the Logs UI. Bodies are already truncated (per
 *  `requestLogMaxBodyKb`) by the time they land here. */
export interface RequestDetail {
  requestId: string;
  /** Unix ms — request start. */
  timestamp: number;
  /** Wall-clock duration between upstream connect and response end. Null when
   *  the request errored before a response arrived. */
  durationMs: number | null;
  method: string;
  /** URL path only (query string included). No host — the proxy only talks to
   *  api.anthropic.com. */
  urlPath: string;
  statusCode: number | null;
  isSse: boolean;
  request: {
    headers: Record<string, string>;
    /** UTF-8 decoded body with replacement chars for invalid sequences. */
    body: string;
    bodyTruncated: boolean;
    /** Original body size in bytes before any truncation. */
    bodySize: number;
  };
  response: {
    headers: Record<string, string>;
    body: string;
    bodyTruncated: boolean;
    bodySize: number;
  } | null;
  errorMessage: string | null;
}

/** How the outbound scanner reacts to findings.
 *  Tool_use (inbound) is always observed only; we cannot block a response
 *  stream without corrupting the SSE protocol. */
export type SecurityEnforcementMode =
  | 'observe' // never block; only record + notify
  | 'block_high' // block outbound when a HIGH finding is present
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

/** Provenance categories for security findings.
 *
 *  Blocking for `secret`/`pii` kinds is restricted to `file-read` (Read
 *  tool_result or Write file_path) and `tool-use` (risky Bash/Write/WebFetch
 *  commands). Everything else persists as observe-only so the user still
 *  sees it in the Security tab without getting 403'd on conversation text.
 *
 *  Blocking for `prompt_injection` kind additionally covers `tool-result`
 *  (attacker-supplied content embedded in WebFetch/Read/Bash output, no
 *  recoverable file_path) and `mcp-description` (poisoned `tools[].description`
 *  text advertised to the agent). See Sprint 7 for the rationale. */
export type FindingProvenance =
  | 'file-read'
  | 'tool-use'
  | 'tool-result'
  | 'mcp-description'
  | 'conversation'
  | 'system-prompt'
  | 'telemetry';

/** What subsystem produced this pending block.
 *  - `scanner` — the secrets/prompt-injection scanner caught content in an
 *    outbound request body. Approve forwards the held request; Deny synthesizes a 403.
 *  - `permissions_strip` — a whole-tool deny rule matched a tool in the
 *    outbound `tools` array. Approve forwards the body with the tool intact
 *    (and allowlists the rule); Deny strips the tool.
 *  - `permissions_tool_use` — a tool_use block mid-SSE-stream matched a deny
 *    rule. Approve flushes the tool_use through (and allowlists the rule);
 *    Deny substitutes a synthetic block-reason text block. */
export type PendingBlockSource = 'scanner' | 'permissions_strip' | 'permissions_tool_use';

/** Snapshot of a blocked outbound request (or held tool_use) pending the
 *  user's approve decision. Surfaced to the frontend via broadcast so the
 *  in-app banner can render a live countdown. */
export interface PendingSecurityBlock {
  pendingId: string;
  accountId: string;
  severity: SecuritySeverity;
  /** Short human-readable title — e.g. "GitHub personal token" or
   *  "Tool blocked: Bash(rm -rf *)". */
  title: string;
  /** Human-readable reason string the proxy would embed in the 403 / synthetic
   *  text block. */
  blockReason: string;
  /** Masked form of the matched string for display (never the raw value).
   *  For permission blocks this is typically the rule's raw text, e.g.
   *  "Bash(rm -rf *)". */
  matchMask: string | null;
  detectorId: string;
  /** Unix ms at which the hold expires; drives client-side countdowns. */
  expiresAt: number;
  /** Which subsystem produced this pending entry. Defaults to `scanner` for
   *  backwards compatibility when older clients miss this field. */
  source?: PendingBlockSource;
  /** Present only for permission-block sources. The tool name that was
   *  blocked (e.g. "Bash"); the banner surfaces this alongside the rule raw. */
  toolName?: string;
  /** Present only for `permissions_tool_use` blocks, where we have a
   *  parsed tool_use input. Map of recognised scalar fields (e.g.
   *  `command`, `url`, `file_path`) to their string values, each
   *  truncated daemon-side to {@link TOOL_INPUT_FIELD_MAX_CHARS}. The
   *  banner renders these as labelled monospace rows so the user can
   *  see exactly what Claude was about to invoke before approving. The
   *  `permissions_strip` path has no specific input, and `scanner`
   *  blocks have no toolInput, so the field is absent for both. */
  toolInputFields?: Record<string, string>;
}

/** Per-field character cap for {@link PendingSecurityBlock.toolInputFields}.
 *  Truncated daemon-side before broadcast, with `…` suffix when applied. */
export const TOOL_INPUT_FIELD_MAX_CHARS = 500;

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

/** Single-size measurement from the in-process scan benchmark. The
 *  benchmark runs the scanner's synchronous path against synthetic
 *  bodies at each size in the Settings slider's range and records
 *  mean + p99 ms so the UI can pick an appropriate threshold from
 *  evidence instead of a baked-in default. */
export interface ScanBenchmarkSample {
  /** Body size in megabytes — always one of the slider values
   *  `[1, 2, 4, 8, 16]`. */
  sizeMb: number;
  /** Arithmetic mean of measured scan durations, in milliseconds. */
  meanMs: number;
  /** 99th-percentile scan duration, in milliseconds. Drives the
   *  recommendation (p99 ≤ budget → this size is safe to scan
   *  synchronously). */
  p99Ms: number;
}

/** The full result of a user-initiated scan benchmark. Persisted on
 *  Settings so the UI can display "last tuned: X ago" and drive the
 *  threshold slider label. */
export interface SecurityBenchmarkResult {
  /** Unix ms the bench finished. */
  ranAt: number;
  /** `${platform}-${arch}` captured via `os.platform()` + `os.arch()`.
   *  Shown in the UI so users with multiple machines can tell which
   *  one the tuning applies to. */
  platform: string;
  /** One row per measured size. Ordered by sizeMb ascending. */
  results: ScanBenchmarkSample[];
  /** Largest size whose p99 ≤ 50 ms, clamped to `[1, 16]`. Used by
   *  the "Apply recommendation" button to set
   *  `securityOversizedThresholdMb` in one click. */
  recommendedMb: number;
}

/** Runtime status of the Claude Code auto-sync engine. Broadcast to
 *  the UI via `claude_sync_status` so the Settings subsection can
 *  render a live "last imported / last exported / error" summary
 *  without polling. All fields are null before the engine has had a
 *  chance to run the first sync cycle. */
export interface ClaudeSyncStatus {
  /** True when `claudeCodeSyncEnabled` is on AND the watcher is
   *  actually attached to `~/.claude/settings.json`. False during
   *  startup, after a disable, or if watcher attach failed. */
  active: boolean;
  /** Unix ms of the last successful pull (file → Sentinel). */
  lastPulledAt: number | null;
  /** Unix ms of the last successful push (Sentinel → file). */
  lastPushedAt: number | null;
  /** Most recent error message from either direction, or null if the
   *  last run of either direction succeeded. The UI surfaces this as
   *  a red status row so sync failures aren't silent. */
  lastError: string | null;
}

/** A user-approved per-rule input bypass. When the permissions
 *  evaluator encounters a matching deny rule, it checks the bypass
 *  table and returns 'allow' if (ruleId, inputHash) is present —
 *  letting that one specific input through while the rule stays
 *  active for everything else. Populated via the "Always allow this
 *  exact input" checkbox on a pending tool_use banner. */
export interface PermissionBypassEntry {
  id: number;
  /** FK to `PermissionRule.id` — the deny rule this bypass cancels. */
  ruleId: string;
  /** Denormalised for UI display so the Settings list doesn't need to
   *  join back to permission_rules on every render. */
  toolName: string;
  /** SHA-256 hex digest of the canonicalised tool_input JSON. */
  inputHash: string;
  /** Short human-readable label, e.g. "rm -rf /tmp/demo". */
  mask: string;
  /** Optional user note — unused for now, reserved for future UI. */
  note: string | null;
  createdAt: number;
}

export type SecurityKind =
  | 'secret'
  | 'pii'
  | 'prompt_injection'
  | 'risky_bash'
  | 'risky_write'
  | 'risky_read'
  | 'risky_webfetch'
  | 'scan_truncated'
  | 'scan_skipped_encoding'
  | 'scan_deferred_oversized'
  | 'tool_permission_blocked';

// ─── Tool permission rules ────────────────────────────────────────────────────

/** Decision that a matched rule declares.
 *   allow — the tool call passes unchanged.
 *   deny  — the tool call is blocked; the proxy either strips the tool
 *           from the outbound request (whole-tool denies) or substitutes
 *           a synthetic text block into the SSE stream (sub-command denies).
 *   ask   — the tool call triggers the pending-block flow unconditionally,
 *           regardless of the global block-hold setting. Mirrors Claude
 *           Code's `permissions.ask` array so imported-from-settings.json
 *           rules round-trip with fidelity. Without a hold hook wired
 *           (e.g. legacy sync call sites), 'ask' degrades to 'deny'.
 */
export type PermissionDecision = 'allow' | 'deny' | 'ask';

/** Where a PermissionRule came from. Drives the bi-directional sync
 *  reconciliation: rules with `source: 'claude-code'` are deleted
 *  from Sentinel when they vanish from Claude Code's settings.json;
 *  `source: 'local'` rules are authoritative on the Sentinel side.
 *  Older rows without the column migrate to 'local' by default. */
export type PermissionRuleSource = 'local' | 'claude-code';

/**
 * A user-configured permission rule evaluated by the daemon proxy against
 * every outbound tool definition and incoming `tool_use` block. Independent
 * of Claude Code's own `~/.claude/settings.json` permissions — this is a
 * second enforcement layer with its own rule set.
 *
 * Serialized form mirrors Claude Code's native syntax — e.g.
 *   Bash                   — whole-tool rule (pattern === null)
 *   Bash(npm *)            — sub-command rule with a pattern specifier
 *   Bash(rm -rf *)         — wildcard after space enforces a word boundary
 *   Read(//Users/jeff/**)  — absolute path (double slash)
 *   Read(/src/**)          — relative to project root (single leading slash)
 *   Read(~/*.pdf)          — home directory glob
 *   WebFetch(domain:example.com) — exact + subdomain match
 *   mcp__github__*         — all tools under an MCP server
 */
export interface PermissionRule {
  /** UUID. */
  id: string;
  decision: PermissionDecision;
  /** Tool name (e.g. 'Bash', 'Read', 'WebFetch', 'mcp__github__create_issue'),
   *  `mcp__<server>__*` for per-server wildcards, or `*` for any tool. */
  tool: string;
  /** The specifier inside parentheses. `null` means the rule matches every
   *  invocation of `tool` regardless of arguments. */
  pattern: string | null;
  /** Canonical `Tool` or `Tool(pattern)` form — stored denormalized so the
   *  UI can round-trip between form mode and raw mode without reconstruction. */
  raw: string;
  /** Optional free-text user note shown alongside the rule in the UI. */
  note: string | null;
  enabled: boolean;
  /** Lower numbers evaluate earlier within each decision tier. Ties break
   *  on `createdAt`. */
  priority: number;
  createdAt: number;
  /** Origin. Drives the bi-directional Claude Code sync reconciliation.
   *  Defaults to 'local' for hand-authored rules. */
  source: PermissionRuleSource;
}

/** Input shape for upsert_permission_rule. Omit `id` to create a new rule. */
export interface PermissionRuleInput {
  id?: string;
  decision: PermissionDecision;
  tool: string;
  pattern: string | null;
  raw: string;
  note?: string | null;
  enabled?: boolean;
  priority?: number;
  /** Defaults to 'local' when omitted. The sync engine passes
   *  'claude-code' when importing from settings.json. */
  source?: PermissionRuleSource;
}

/**
 * Per-session snapshot included in {@link AutoModeStatus.sessions}. The
 * daemon tracks one entry per Claude Code `session_id` seen on the proxy
 * (extracted from `metadata.user_id` on each `/v1/messages` request).
 */
export interface ActiveClaudeSession {
  sessionId: string;
  accountUuid: string | null;
  /** True if the most recent request from this session carried auto-mode
   *  beta flags. Flips to false on a non-auto request without ending the
   *  session. */
  autoMode: boolean;
  /** Unix ms of the last request observed from this session. */
  lastSeenAt: number;
}

/**
 * Live auto-mode status surfaced to the UI. The daemon computes `active` by
 * combining:
 *   - the manual settings toggle (`toolPermissionAutoModeActive`), AND
 *   - header-based detection of Claude Code's `afk-mode` / `advisor-tool`
 *     beta flags on `/v1/messages` requests (with a ~60 s freshness window), AND
 *   - per-session tracking that persists a session's mode until either the
 *     next non-auto request downgrades it or the Claude Code process exits
 *     (detected via cross-platform process scan).
 *
 * Used by the Security tab to render a "Sentinel is standing down" banner
 * when auto mode is active — with accurate counts when the user is running
 * multiple Claude Code sessions in parallel.
 */
export interface AutoModeStatus {
  active: boolean;
  /** What triggered `active`. `null` when `active === false`. */
  source: 'manual' | 'headers' | null;
  /** Unix ms of the most recent header-based detection. Null when we've
   *  never seen one during this daemon session. Useful for showing
   *  "detected 3s ago" style timestamps. */
  lastDetectedAt: number | null;
  /** Total number of Claude Code sessions currently tracked (recently seen
   *  on the proxy and not yet pruned by the process scan). */
  activeSessions: number;
  /** Subset of `activeSessions` whose latest request carried auto-mode
   *  beta flags. `active === true` requires `autoModeSessions > 0` OR the
   *  manual override OR the legacy freshness window. */
  autoModeSessions: number;
  /** Count of `claude-code` OS processes observed on the last process
   *  scan. `null` when the scan has never run or always fails on this host
   *  (locked-down Windows, sandboxed runtime, etc.) — the UI then degrades
   *  gracefully to time-based freshness only. */
  processCount: number | null;
  /** Full session breakdown for the UI's expandable details view. Ordered
   *  most-recent first. Empty when no sessions are tracked. */
  sessions: ActiveClaudeSession[];
}

/** Sound choices exposed in Settings. Values map to macOS system sounds;
 *  `null` means no sound. Other platforms will ignore unknown names silently. */
export const ALERT_SOUNDS: ReadonlyArray<{ label: string; value: string | null }> = [
  { label: 'None', value: null },
  { label: 'Basso', value: 'Basso' },
  { label: 'Blow', value: 'Blow' },
  { label: 'Bottle', value: 'Bottle' },
  { label: 'Frog', value: 'Frog' },
  { label: 'Funk', value: 'Funk' },
  { label: 'Glass', value: 'Glass' },
  { label: 'Hero', value: 'Hero' },
  { label: 'Morse', value: 'Morse' },
  { label: 'Ping', value: 'Ping' },
  { label: 'Pop', value: 'Pop' },
  { label: 'Purr', value: 'Purr' },
  { label: 'Sosumi', value: 'Sosumi' },
  { label: 'Submarine', value: 'Submarine' },
  { label: 'Tink', value: 'Tink' },
];

/**
 * Scope for a user-configured usage alert.
 *   account        — bound to a single Sentinel account key; fires on that
 *                    account's unified-5h utilization.
 *   account-sonnet — bound to a single Sentinel account key; fires on that
 *                    account's unified-7d_sonnet utilization (Sonnet's
 *                    weekly pool on Max plans). Distinct from `account` so
 *                    a user can configure 5-hour and Sonnet 7-day
 *                    thresholds independently on the same account.
 *   account-weekly — bound to a single Sentinel account key; fires on that
 *                    account's unified-7d utilization (the general weekly
 *                    quota that caps Opus and other non-Sonnet models).
 *                    Parallel to `account-sonnet` but reads the general
 *                    7-day window; users frequently want distinct
 *                    thresholds for the two weekly quotas.
 *   pool           — round-robin only; fires on the mean unified-5h
 *                    utilization across every pool member (accounts not
 *                    in `poolExcludedIds`).
 *   pool-weekly    — round-robin only; fires on the mean unified-7d
 *                    utilization across every pool member. Catches the
 *                    case where every pool account is drifting toward
 *                    weekly cap simultaneously so rotation alone can't
 *                    save you.
 *   budget         — fires on rolling 7-day spend vs. the user-configured
 *                    Sentinel budget. `budgetScope: 'account'` compares
 *                    against `Settings.budgetWeeklyUsdByAccount[accountId]`;
 *                    `'global'` compares summed spend against
 *                    `budgetWeeklyUsdGlobal`. Re-arms on ISO-week rollover
 *                    rather than 5h-window reset.
 */
export type AlertScope =
  | 'account'
  | 'account-sonnet'
  | 'account-weekly'
  | 'pool'
  | 'pool-weekly'
  | 'budget';

/** Reason an account was paused by the daemon. Embedded in
 *  `AccountPausedMessage` so the UI and proxy can render cause-specific
 *  copy and pick the correct reset window for Retry-After.
 *
 *    sentinel_budget             — rolling 7d spend crossed the
 *                                  user-configured dollar cap. Resumes
 *                                  on the next unified-5h reset.
 *    sentinel_weekly_rate_limit  — Anthropic set unified-7d status to
 *                                  'blocked' on this account. Resumes
 *                                  on the unified-7d reset (days away,
 *                                  not hours).
 *    anthropic_overage_disabled  — Anthropic flipped overage-status to
 *                                  'disabled'. Not time-based; clears
 *                                  when Anthropic re-enables overage.
 */
export type PauseReason =
  | 'sentinel_budget'
  | 'sentinel_weekly_rate_limit'
  | 'anthropic_overage_disabled';

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

/**
 * Per-day and per-session rollup of ephemeral prompt-cache usage, sourced
 * from the proxy (not OTEL). Captures both the client's cache_control
 * markers and upstream's actual per-TTL token writes so the Metrics tab
 * can show what was asked for side by side with what landed. Costs are
 * precomputed at write-time using fixed multipliers (5m write 1.25x,
 * 1h write 2.0x, read 0.1x) against a base input $/MTok table.
 */
export interface CacheTtlDayRow {
  /** Count of request blocks tagged `{type: 'ephemeral'}` (5m default). */
  reqMarkers5m: number;
  /** Count of request blocks tagged `{type: 'ephemeral', ttl: '1h'}`. */
  reqMarkers1h: number;
  create5m: number;
  create1h: number;
  /** Cache read tokens. Anthropic does not break reads down by TTL. */
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
  /** Representative (most recent) model seen for this session. */
  model: string;
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
  /** Sentinel key of the single account queried, or one of `__pool__` /
   *  `__all__` for aggregate views. Use `scope` for structured membership. */
  accountId: string;
  /** Describes whether this rollup is a single account or an aggregate across
   *  multiple accounts. Absent or `{ kind: 'account' }` matches the legacy
   *  single-account response. */
  scope?:
    | { kind: 'account'; id: string }
    | { kind: 'pool'; label: string; memberCount: number }
    | { kind: 'all'; label: string; memberCount: number };
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
  /** Proxy-sourced cache-TTL rollup: { byDayModel, bySession }.
   *  byDayModel shape: { "YYYY-MM-DD": { "claude-sonnet-4-6": CacheTtlDayRow } }.
   *  bySession is most-recently-seen first, capped server-side. */
  cacheTtl: {
    byDayModel: Record<string, Record<string, CacheTtlDayRow>>;
    bySession: CacheTtlSessionRow[];
  };
}
