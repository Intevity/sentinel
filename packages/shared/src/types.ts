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

/** Which chart the Optimize dashboard renders above the curated subagent
 *  list. The user toggles between these via the segmented control in the
 *  dashboard header; the choice is persisted in {@link Settings.optimizeChartView}.
 *
 *   realized    — daily stacked bar of realized vs potential (the original).
 *   bySubagent  — daily stacked bar where each color is a curated subagent.
 *   comparison  — horizontal bars ranking subagents by total savings,
 *                 with a realized/potential split per row.
 *   cumulative  — running-total line chart over the lookback window.
 *   byPattern   — horizontal bars ranking detection heuristics by
 *                 opportunity count.
 *   compression — daily bars of estimated savings from in-flight
 *                 tool_result compression (the other views slice
 *                 subagent savings; this is the compression half of
 *                 the header totals).
 */
export type OptimizeChartView =
  | 'realized'
  | 'bySubagent'
  | 'comparison'
  | 'cumulative'
  | 'byPattern'
  | 'compression';

/** The Optimize tab's time-range presets. `custom` means "use the explicit
 *  start/end the user picked"; `all` means all-time. Persisted in
 *  {@link Settings.optimizeRange}. Which presets the selector actually offers
 *  depends on the page's retention window: see `rangeLadder` in
 *  `range-ladder.ts`. */
export type OptimizeRangePreset =
  | '1d'
  | '1w'
  | '2w'
  | '1m'
  | '2m'
  | '3m'
  | '6m'
  | '1y'
  | 'all'
  | 'custom';

/** Which section of the Optimize page is active. Each of the three
 *  optimization features owns one sub-tab below the sticky savings bar:
 *  curated subagents, in-flight compression, and context (MCP definition
 *  costs + code execution). Persisted in {@link Settings.optimizeSubTab}
 *  so the user's last section survives daemon restarts. */
export type OptimizeSubTab = 'subagents' | 'compression' | 'context';

/**
 * Aggressiveness tier for in-flight tool_result compression.
 *
 *   conservative — lossless-ish cleanup: strip ANSI escapes, collapse blank-
 *                  line runs and repeated adjacent lines, minify insignificant
 *                  JSON whitespace, dedup repeated lines. No information loss.
 *   moderate     — conservative rules plus safe lossy transforms: head/tail
 *                  truncation of very long logs, tabular dedup of large
 *                  arrays-of-objects, collapse of repetitive stack frames.
 *   aggressive   — moderate rules with lower thresholds and heavier trimming.
 *
 * Every rule is deterministic and idempotent so replayed conversation history
 * compresses to identical bytes turn-over-turn, keeping prompt-cache prefixes
 * stable.
 */
export type CompressionLevel = 'conservative' | 'moderate' | 'aggressive';

/**
 * Scope at which Sentinel installs its retrieval MCP server into Claude Code's
 * config. Mirrors Claude Code's own scopes:
 *   user    — all of the user's projects (`~/.claude.json` top-level mcpServers).
 *   local   — one directory, private to the user (`~/.claude.json`
 *             projects[dir].mcpServers).
 *   project — one directory, shared via a `.mcp.json` checked into the repo.
 */
export type McpInstallScope = 'user' | 'local' | 'project';

/** A record of where the retrieval MCP server has been installed, so the UI
 *  can list and uninstall each one. `directory` is null only for `user` scope. */
export interface McpInstallRecord {
  scope: McpInstallScope;
  directory: string | null;
  installedAt: number;
}

/** A native MCP server the user migrated to code execution. The daemon owns
 *  the MCP client connection and Claude calls tools through the loopback
 *  `/code-mode/call` endpoint instead of carrying the server's tool
 *  definitions in every request.
 *
 *  `originalEntry` is the exact JSON value removed from `mcpServers` so
 *  "Switch back" restores it byte-identically. Secrets the entry may carry
 *  (env vars, auth headers) stay inside settings.json (0600 + HMAC sidecar)
 *  and are only ever read by the daemon at connect time; they are never
 *  written into generated workspace files or the skill. */
export interface CodeModeMigration {
  /** Server name as it appeared under `mcpServers`. */
  server: string;
  scope: McpInstallScope;
  /** Directory for `local`/`project` scopes; null for `user`. */
  directory: string | null;
  /** The exact config object stashed from `mcpServers[server]`. */
  originalEntry: unknown;
  migratedAt: number;
  /** All-time `__native__` request count observed at migration time. Realized
   *  savings count requests since bridging as the delta from this baseline, so
   *  the figure reads 0 immediately after enabling regardless of how much
   *  same-day pre-migration traffic the day bucket already holds. Optional for
   *  back-compat with migrations recorded before this field existed; absent
   *  baselines are backfilled at daemon start. */
  baselineNativeRequests?: number;
  /** All-time request count for THIS server's definitions at migration time.
   *  Subtracted alongside the native baseline so requests that still carry the
   *  server (e.g. unmigrated per-project entries) don't count as saved. */
  baselineServerRequests?: number;
}

/**
 * Persistent user preferences stored at ~/.sentinel/settings.json.
 */
export interface Settings {
  launchAtLogin: boolean;
  switchingMode: SwitchingMode;
  /** OS system sound name played alongside alert notifications.
   *  `null` means silent. On macOS the name must match a file in
   *  /System/Library/Sounds (e.g. 'Glass', 'Ping'); on Windows a winrt
   *  toast sound name (e.g. 'Default', 'Mail'), with unknown names
   *  mapped to 'Default' at delivery. See ALERT_SOUNDS /
   *  ALERT_SOUNDS_WINDOWS. */
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
  /** Alternate origin for Claude Code API traffic (e.g. a model router like
   *  Herma). When set, the proxy forwards `/v1/messages`, `/v1/complete`,
   *  `/v1/models`, `/v1/count_tokens` to this origin instead of
   *  `https://api.anthropic.com`. Sentinel's own daemon-originated calls
   *  (OAuth profile, usage, run-budget, OAuth) always use the canonical
   *  Anthropic API regardless of this setting. Origin only; trailing path
   *  is stripped on save. `null` (default) routes to the canonical API. */
  alternateApiUrl: string | null;
  /** Sentinel account IDs excluded from round-robin rotation. Empty means
   *  every enrolled account rotates (opt-out model) — preserves the
   *  original "RR just works" behavior and auto-enrolls newly added
   *  accounts. Ignored unless `switchingMode === 'round-robin'`. */
  poolExcludedIds: string[];
  /** Default state of the "Private window" checkbox in the per-account
   *  Re-authenticate banner on the Accounts page. Sticky across cards and
   *  across sessions: toggling on one card persists, so every other expired
   *  card reflects the same value on next render. Default `true` because
   *  the typical reauth failure mode is claude.ai holding a stale session
   *  for a different identity; a fresh cookie jar is the safe default. */
  reauthIncognitoDefault: boolean;
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
  /** @deprecated Superseded by {@link Settings.dataRetentionDays}, which now
   *  governs telemetry, optimize, and compression retention from a single
   *  control. Kept for settings round-trip + one-time migration: on first load
   *  after upgrade, `dataRetentionDays` is seeded from this value when the
   *  newer key is absent. No purge reads this field anymore. */
  telemetryRetentionDays: number;
  /** @deprecated Superseded by the per-feature {@link Settings.optimizeRetentionDays}
   *  and {@link Settings.metricsRetentionDays}. Kept for settings round-trip +
   *  one-time migration: on first load after upgrade, both newer keys are seeded
   *  from this value (clamped into [90, 1095]) when absent. No purge reads this
   *  field anymore. */
  dataRetentionDays: number;
  /** Retention for the Optimize page's data: optimization_events, compression
   *  stats + retrievals, and MCP context-cost rows. Rows older than this are
   *  purged at daemon startup and once/day thereafter. Clamped to [90, 1095]
   *  (3 months to 3 years). Default 365 (1 year). The Optimize page's
   *  range-preset ladder adapts to this window (see `rangeLadder`). */
  optimizeRetentionDays: number;
  /** Retention for the Metrics page's telemetry: usage_events, tool_events,
   *  api_errors, activity_events. Same purge cadence, clamp, and default as
   *  {@link Settings.optimizeRetentionDays}, tuned independently. The Metrics
   *  page's range-preset ladder adapts to this window. The security audit
   *  chain and request log keep their own independent retention so integrity
   *  isn't weakened by these general knobs. */
  metricsRetentionDays: number;

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
  /** When false, the redacted snippet column is dropped on persist —
   *  only mask + hashes remain. Mask + hash are always stored. */
  securityPersistSnippet: boolean;
  /** Snippet window size when `securityPersistSnippet` is on. Applied
   *  uniformly to every detector kind / severity so context shape is
   *  consistent across alerts. See `SECURITY_CONTEXT_WINDOW_CHARS` for
   *  the per-preset char-per-side numbers. */
  securityContextVerbosity: SecurityContextVerbosity;
  /** Rows older than this many days are purged at daemon startup. */
  securityEventRetentionDays: number;
  /** How long a held block waits for an approve click before the proxy
   *  synthesizes the 403. Clamped to [10, 300]. Default 60. Every block
   *  goes through this hold so the user always has a chance to approve. */
  securityApproveHoldSec: number;

  /** Per-detector visibility tier. Keyed by `Finding.detectorId`. Missing
   *  or `'active'` is the current behavior: persist + IPC broadcast +
   *  notification, and the finding counts toward the OS-notification
   *  threshold gate. `'informational'` still persists to `security_events`
   *  for audit, but skips the broadcast and the notification row — the UI
   *  surfaces these under a collapsed "Low-signal observations" disclosure.
   *  `'disabled'` short-circuits the detector at scan time: no event row,
   *  no broadcast, no notification.
   *
   *  The `detector_tuning_v1` migration auto-demotes any detector that
   *  fired ≥20 times in the last 30 days with 0 blocks and 0 approvals to
   *  `'informational'` on first run, then surfaces a one-time notification
   *  naming the affected ids. Re-promotion is by the user, in Settings →
   *  Security → Detectors. */
  detectorOverrides: Record<string, DetectorTier>;

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

  // ─── Sprint 9: health gate + webhook ───────────────────────────────
  /** Behaviour when one of the daemon's critical components (DB,
   *  scanner, enforcer) reports unhealthy. `'closed'` synthesizes a
   *  503 to Claude Code so requests fail loudly while degraded;
   *  `'open'` always forwards (explicit fail-open opt-in); `'warn'`
   *  (default) logs a throttled degradation line but still forwards. */
  daemonHealthFailMode: 'closed' | 'open' | 'warn';
  /** Outbound webhook URL POSTed on every security event whose severity
   *  reaches `securityWebhookSeverityFloor`. `null` disables. The
   *  daemon validates the URL is `http(s):` on save. */
  securityWebhookUrl: string | null;
  /** When set, every webhook POST carries an
   *  `X-Sentinel-Signature: sha256=<hex>` header computed as
   *  HMAC-SHA256(secret, body). Empty/null disables signing. */
  securityWebhookSecret: string | null;
  /** Severity floor for the webhook emitter. Events strictly below
   *  this level are skipped. Default `'high'`. */
  securityWebhookSeverityFloor: 'low' | 'medium' | 'high';

  // ─── Optimize feature ──────────────────────────────────────────────
  /** Master kill switch for the in-proxy tool-call extractor. When false,
   *  no tool_use blocks are parsed from SSE responses, no rows land in
   *  `tool_calls`, and the analyzer becomes a no-op. Default true; the
   *  toggle exists so beta users can disable capture without uninstalling
   *  if a perf or privacy concern surfaces. Removable in v1.1 once
   *  stable. */
  optimizeCaptureEnabled: boolean;
  /** When false, the analyzer still runs but produces no `recommended`
   *  optimization_events. Lets users keep the savings dashboard live
   *  without getting nudged to install. Default true. */
  optimizeAutoRecommend: boolean;
  /** When true, individual sub-$0.10 opportunities surface in the
   *  recommendation list. Otherwise they aggregate into a "micro-
   *  opportunities" bucket on the chart. Default false. */
  optimizeShowMicroOpportunities: boolean;
  /** Display units for the Optimize tab's savings numbers. Defaults to
   *  'tokens' since most Claude Code users are on subscriptions where
   *  dollars don't map to billable activity; the cost view is still
   *  available for direct-API users. Persisted so the choice survives
   *  daemon restarts. */
  optimizeUnits: 'tokens' | 'cost';
  /** Which chart the Optimize tab shows above the curated subagent list.
   *  Defaults to 'realized' (the original stacked realized/potential
   *  daily bar). Persisted so the user's last selection survives
   *  daemon restarts. See the chart components under
   *  `packages/app/src/components/optimize/charts/` for what each id
   *  renders. */
  optimizeChartView: OptimizeChartView;
  /** Selected time range for the Optimize tab's metrics. `custom` defers to
   *  client-held start/end dates (not persisted). Defaults to 'all'. Persisted
   *  so the user's last range survives daemon restarts. */
  optimizeRange: OptimizeRangePreset;
  /** Selected time range for the Metrics tab. Same presets and semantics as
   *  {@link Settings.optimizeRange} (the two pages share one selector
   *  component) but persisted independently so each page remembers its own
   *  range. Defaults to '1w', matching the old 7-day period selector. */
  metricsRange: OptimizeRangePreset;
  /** Active sub-tab on the Optimize page (subagents / compression /
   *  context). Defaults to 'subagents'. Persisted so the user's last
   *  section survives daemon restarts. */
  optimizeSubTab: OptimizeSubTab;

  // ─── tool_result compression ───────────────────────────────────────
  /** Master switch for in-flight tool_result compression. Opt-in; default
   *  false. When on, the proxy deterministically compresses tool_result
   *  text before forwarding `/v1/messages` upstream, reducing input tokens.
   *  Read fresh per-request, so toggling takes effect with no daemon
   *  restart. */
  compressionEnabled: boolean;
  /** Aggressiveness tier. `'conservative'` is lossless-ish and the default;
   *  `'moderate'` and `'aggressive'` add progressively heavier lossy
   *  transforms. See `CompressionLevel`. */
  compressionLevel: CompressionLevel;
  /** Request bodies larger than this (in KB) are forwarded uncompressed —
   *  a safety cap bounding the parse + re-stringify cost. Clamped to
   *  [16, 16384]. Default 4096 (4 MB), matching the request-size telemetry
   *  that informed `securityOversizedThresholdMb`. */
  compressionMaxBodyKb: number;
  /** Reversible compression (CCR). When true, the lossy tiers keep the elided
   *  original keyed by a content hash and emit a marker pointing at the
   *  `mcp__sentinel__retrieve` tool, so the model can fetch the full text on
   *  demand. Default false. Only meaningful once the retrieval MCP server is
   *  installed (see `compressionRetrievalInstalls`); markers degrade
   *  gracefully (head/tail content remains) where the tool is absent. */
  compressionRetrievalEnabled: boolean;
  /** Where the retrieval MCP server has been installed into Claude Code's
   *  config. Used by the Optimize page to show status and offer uninstall.
   *  Empty by default. */
  compressionRetrievalInstalls: McpInstallRecord[];

  // ─── MCP code execution (code mode) ────────────────────────────────
  /** Master switch for the code-mode bridge endpoint (`/code-mode/call`).
   *  Off by default; flipped on automatically when the first server is
   *  migrated and back off when the last one reverts. When false the
   *  endpoint refuses every call regardless of recorded migrations. */
  codeModeEnabled: boolean;
  /** Native MCP servers migrated to code execution. Doubles as the
   *  bridge's server allowlist: the daemon only ever connects to servers
   *  recorded here, so the endpoint cannot be used to spawn arbitrary
   *  configured servers. */
  codeModeMigrations: CodeModeMigration[];
  /** True once the sentinel-code-mode skill exists under
   *  `~/.claude/skills/`. Tracked so revert can clean it up when the
   *  last migration is removed. */
  codeModeSkillInstalled: boolean;
  /** Servers disabled via the plain "Disable" action (no bridging), with
   *  their stashed entries so Enable restores byte-identically. Same record
   *  shape as a migration but deliberately a separate list: entries here
   *  are NOT part of the bridge allowlist and are never connectable. */
  mcpDisabledStashes: CodeModeMigration[];

  // ─── External OTEL forwarding ──────────────────────────────────────
  /** Master switch for forwarding the OTLP/HTTP request bodies that
   *  Sentinel receives from Claude Code (at `/v1/metrics` and
   *  `/v1/logs`) to a user-configured external observability backend
   *  (e.g. SigNoz Cloud). Off by default; even with a URL and secret
   *  configured, no traffic egresses until this is on. The receiver
   *  keeps parsing and persisting locally either way, so the Metrics,
   *  Optimize, and Spend tabs are unaffected. */
  otelForwardingEnabled: boolean;
  /** When true, `/v1/metrics` POST bodies are relayed. Independent so
   *  users can forward only logs (or only metrics) without splitting
   *  Claude Code's OTEL config. Gated by `otelForwardingEnabled`. */
  otelForwardMetrics: boolean;
  /** When true, `/v1/logs` POST bodies are relayed. Gated by
   *  `otelForwardingEnabled`. */
  otelForwardLogs: boolean;
  /** When true, Sentinel emits its own derived signals (cache TTL
   *  breakdown, per-account 5h usage, rotation events, security
   *  events, proxy traffic counters) on a 30s cadence to the same
   *  external endpoint. Tagged with `service.name=sentinel` so
   *  dashboards can split them from Claude Code's own metrics
   *  (`service.name=claude-code`). Gated by `otelForwardingEnabled`. */
  otelEmitSentinelMetrics: boolean;
  /** OTLP/HTTP base endpoint. The forwarder appends `/v1/metrics` or
   *  `/v1/logs` to this when relaying, so configure the base only.
   *  Stored with no trailing slash. Must be `https:`; `http:` is
   *  accepted only when the host is `localhost`/`127.0.0.1`/`::1`
   *  to keep production users on TLS by default. `null` (default)
   *  disables forwarding regardless of the toggles above. */
  otelExporterEndpoint: string | null;
  /** Name of the auth header that carries the user's secret on every
   *  forwarded request. Examples: `signoz-ingestion-key`,
   *  `authorization`, `x-honeycomb-team`. Validated as a valid HTTP
   *  header name (RFC 7230 token). The secret VALUE itself is stored
   *  in the OS keychain (service `Sentinel-otel-exporter`,
   *  account `default`), never in this file. Default
   *  `'signoz-ingestion-key'`; `null` means the field has been cleared,
   *  so no auth header is attached — for backends that need no auth (the
   *  auth header is only sent when both this name and a secret are set). */
  otelExporterHeaderName: string | null;
  /** Stable per-install UUID emitted as `service.instance.id` on every
   *  Sentinel-originated OTEL payload. Generated once on first launch
   *  (via `crypto.randomUUID()`) and persisted in settings.json so it
   *  survives daemon restarts. An empty string or a value that doesn't
   *  match the UUID v4 shape is regenerated on the next `loadSettings()`
   *  pass, so existing installs auto-populate without a migration step.
   *  Lets dashboards on a shared SigNoz tenant disambiguate per-install
   *  even when team members share a hostname. */
  otelServiceInstanceId: string;

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

  // ─── Appearance ────────────────────────────────────────────────────
  /** Color theme preference. `'system'` follows the OS via
   *  `prefers-color-scheme`; `'light'` and `'dark'` pin the theme
   *  regardless of OS setting. Default `'system'`. */
  theme: ThemePreference;
}

/** User-selectable color theme. `'system'` defers to the OS via
 *  `prefers-color-scheme`. */
export type ThemePreference = 'light' | 'dark' | 'system';

/** Runtime status for the external OTEL forwarder. Returned by the IPC
 *  `get_otel_exporter_status` request and broadcast on every secret
 *  write/clear and at counter milestones. The secret value itself is
 *  never included. */
export interface OtelForwarderStatus {
  /** True when a non-empty secret is present in the keychain. A secret
   *  is optional — no-auth backends forward without one — so this is
   *  surfaced for display but is no longer required for `ready`. */
  secretConfigured: boolean;
  /** True when forwarding is ready to egress: master toggle on and an
   *  endpoint set. A secret is NOT required (no-auth backends forward
   *  without one). Renders the green "ready" affordance in the Settings
   *  UI. */
  ready: boolean;
  /** Number of relayed requests that received a 2xx response, since
   *  daemon start. */
  sent: number;
  /** Number of requests dropped because the in-flight cap was full. */
  dropped: number;
  /** Number of relayed requests that errored or returned a non-2xx
   *  response. */
  failed: number;
  /** Unix ms of the most recent successful forward, or null. */
  lastForwardOkAt: number | null;
  /** Brief description of the most recent failure. Null after any
   *  subsequent success. */
  lastForwardErr: string | null;
  /** Current in-flight count (0 when idle). */
  inFlight: number;
}

/** Result of the `test_otel_exporter` IPC. */
export interface OtelExporterTestResult {
  ok: boolean;
  status: number | null;
  message: string;
}

/** Result of inspecting `~/.claude/settings.json` for Sentinel's OTEL
 *  wiring. Drives the Metrics-tab banner that surfaces "metrics aren't
 *  flowing" and offers Re-patch / Promote actions.
 *
 *  - `ok`               — endpoint points at Sentinel and telemetry is enabled.
 *  - `foreign-endpoint` — another tool overwrote `OTEL_EXPORTER_OTLP_ENDPOINT`
 *                          or its signal-specific siblings; metrics are flowing
 *                          somewhere else.
 *  - `telemetry-disabled` — `CLAUDE_CODE_ENABLE_TELEMETRY` missing or `"0"`.
 *  - `no-settings-file` — `~/.claude/settings.json` is absent. */
export type OtelDriftState = 'ok' | 'foreign-endpoint' | 'telemetry-disabled' | 'no-settings-file';

/** Parsed-but-redacted preview of what a Promote action will move into
 *  Sentinel's external OTEL forwarder. Surfaced in the confirmation modal
 *  so the user can review before confirming. Secret values are NEVER sent
 *  to the UI in full — only a `head…tail` mask for sanity-check. */
export interface OtelDriftPromotePreview {
  /** Foreign endpoint URL Sentinel will adopt as `otelExporterEndpoint`. */
  endpoint: string;
  /** Header name picked by the auth-heuristic. Null when the foreign
   *  config carries no recognisable auth header — UI should warn that
   *  the user may need to paste the secret manually. */
  headerName: string | null;
  /** Masked preview of the header value, e.g. `abcd…wxyz`. Null when
   *  `headerName` is null. */
  headerValueMasked: string | null;
  /** Pre-existing `otelExporterEndpoint` value in Sentinel's settings
   *  that Promote will overwrite, when non-null. UI surfaces this as a
   *  "Replaces existing forwarding to: …" warning. */
  replacesExisting: string | null;
}

/** Snapshot of Claude Code's current OTEL settings + Sentinel's
 *  interpretation. Broadcast as `otel_drift_state` and returned from the
 *  `get_otel_drift_state` IPC. */
export interface OtelDriftDetails {
  state: OtelDriftState;
  /** Observed env-var values. Either string or null per key. */
  actual: {
    endpoint: string | null;
    metricsEndpoint: string | null;
    logsEndpoint: string | null;
    telemetryEnabled: boolean;
    protocol: string | null;
    headers: string | null;
  };
  /** True when state === 'foreign-endpoint' and the endpoint URL passes
   *  the same HTTPS-or-loopback check used by the forwarder's URL
   *  coercion. Re-patch is always available; Promote requires this. */
  canPromote: boolean;
  /** Populated when canPromote is true. Drives the confirmation modal. */
  promotePreview: OtelDriftPromotePreview | null;
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

/** Lightweight metadata-only view of a captured proxy request, intentionally
 *  excluding `request_headers` / `response_headers` / bodies so consumers
 *  that batch-fetch many rows (e.g. bug-report enrichment) never see
 *  request payloads. Use {@link RequestDetail} when bodies are required. */
export interface LogRequestSummary {
  requestId: string;
  method: string;
  urlPath: string;
  statusCode: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  isSse: boolean;
}

/** How the outbound scanner reacts to findings.
 *  Tool_use (inbound) is always observed only; we cannot block a response
 *  stream without corrupting the SSE protocol. */
export type SecurityEnforcementMode =
  | 'observe' // never block; only record + notify
  | 'block_high' // block outbound when a HIGH finding is present
  | 'block_medium_high'; // block on MEDIUM or HIGH findings

export type SecurityOsNotifyThreshold = 'off' | 'high' | 'medium' | 'low';

/** Per-detector visibility tier (see `Settings.detectorOverrides`).
 *  `'active'`        : current behavior; persist + broadcast + notify.
 *  `'informational'` : persist only; UI surfaces under "Low-signal observations".
 *  `'disabled'`      : skip the detector entirely; no event row produced.
 *
 *  Blocking is independent of this tier: high-confidence findings (≥0.9)
 *  still pass through the existing block-decision path. The tier only
 *  controls user-visible noise (and, for `'disabled'`, CPU). */
export type DetectorTier = 'active' | 'informational' | 'disabled';

export const VALID_DETECTOR_TIERS: readonly DetectorTier[] = [
  'active',
  'informational',
  'disabled',
];

/** How much context the scanner captures around a finding. Maps to a
 *  symmetric char-window applied uniformly across detector kinds and
 *  severities so a high-severity secret and a low-severity pattern
 *  carry the same shape of evidence. `compact` = 40 chars per side
 *  (legacy secret-snippet behavior), `standard` = 200 chars per side
 *  (legacy pattern-snippet behavior, our new default), `verbose` =
 *  800 chars per side for forensic investigation. The verbosity knob
 *  is independent of `securityPersistSnippet`: that boolean is the
 *  master on/off; this picks the size when it's on. */
export type SecurityContextVerbosity = 'compact' | 'standard' | 'verbose';

/** Resolved char-per-side window for a given verbosity preset. Single
 *  source of truth so detectors, scanner, and tests agree. */
export const SECURITY_CONTEXT_WINDOW_CHARS: Record<SecurityContextVerbosity, number> = {
  compact: 40,
  standard: 200,
  verbose: 800,
};

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
  /** Two formats:
   *  - Sensitive (secret/PII/unicode-tag/base64): `"AKIA…[16 redacted]…AB12"`
   *    via `maskSecret()` — first 4, last 4, length in middle.
   *  - Non-secret pattern findings (text-pattern prompt-injection rules):
   *    the literal matched phrase verbatim (e.g. `"execute this"`), since
   *    the match itself is the threat signal and not sensitive. */
  matchMask: string | null;
  /** sha256(matched).slice(0,32) — dedup primary key component. */
  matchHash: string;
  /** sha256(40-char window around the match).slice(0,32). */
  contextHash: string | null;
  /** Two formats:
   *  - Sensitive findings: 40 chars each side with the match replaced by
   *    `[REDACTED:kind]` (`buildSnippet`).
   *  - Non-secret pattern findings: ~200 chars each side, trimmed to the
   *    nearest sentence boundary, with the literal match wrapped in `«…»`
   *    so the UI can render it highlighted (`buildPatternSnippet`).
   *  Null when `securityPersistSnippet` is off. */
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
  /** How a held request was settled. Null for observe-only findings
   *  that never held the request. The StatusPill on the Security tab
   *  uses this to label timed-out denies separately from user denies
   *  and to show "Allowed by you" when the user approved the hold. */
  resolution: SecurityEventResolution | null;
}

/** Settlement signal for a held permissions/scanner block. Null on the
 *  row means the event was observe-only and never held. */
export type SecurityEventResolution = 'user_approve' | 'user_deny' | 'timeout';

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
  /** Sprint 9: where the matched permission rule came from, surfaced in
   *  the banner so the user can tell "I added this last week" from "the
   *  Medium preset added this for me". Present only for permission
   *  blocks with a real DB-backed rule (permissions_tool_use,
   *  permissions_strip); scanner blocks and synthetic rules omit it. */
  provenance?: {
    /** Unix ms — `permission_rules.created_at`. */
    createdAt: number;
    /** Mirrors `permission_rules.source` so the banner can render
     *  "added by you" vs "imported from Claude Code". */
    source: 'local' | 'claude-code';
    /** FK to `permission_rules.id`. Lets the rule-editor "Edit rule"
     *  jump scroll into the matching row. */
    ruleId: string;
  };
  /** Sprint 9: count of approves the user has issued for this exact
   *  pattern in this session within the last 5 minutes. When ≥ 5 the
   *  banner surfaces a "consider editing the rule" pill so the user
   *  isn't grinding through repeated prompts. Absent when the daemon
   *  cannot attribute the request to a session (no parseable
   *  metadata.user_id). */
  recentApproveCount?: number;
  /** Highlighted context window around the match: ~200 chars on each
   *  side trimmed to a sentence boundary, with the matched substring
   *  wrapped in `«…»` markers. Present when the underlying finding is a
   *  pattern detection that opted into context preservation (e.g.
   *  prompt-injection markers like `[INST]`). Absent for permission
   *  blocks and secret detections, which carry their context via
   *  `matchMask` / `toolInputFields` instead. Pending entries are
   *  in-memory only, so this field is independent of the
   *  `securityPersistSnippet` setting that governs DB persistence —
   *  the snippet is the same content the user is being asked to
   *  approve, so withholding it from the decision UI would be
   *  counterproductive. */
  snippet?: string | null;
  /** Where in the request/response the match was located, e.g.
   *  `messages[3].tool_result[0].content` or a filesystem path. Helps
   *  the user trace which tool returned the suspicious content.
   *  Mirrors {@link SecurityEvent.sourceHint}. */
  sourceHint?: string | null;
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
/** Runtime status of the Optimize agents-sync engine. Mirrors
 *  ClaudeSyncStatus but for `~/.claude/agents/`. Broadcast via
 *  `agents_sync_status`. */
export interface AgentsSyncStatus {
  /** True when the watcher is attached to `~/.claude/agents/`. */
  active: boolean;
  /** Unix ms of the last successful pull (dir → DB). */
  lastPulledAt: number | null;
  /** Unix ms of the last successful push (DB → dir). */
  lastPushedAt: number | null;
  /** Last error message; null when the previous cycle succeeded. */
  lastError: string | null;
}

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
  /** Sprint 9 per-project rule scoping. Path glob (e.g.
   *  `~/work/prod/**`) the request's working directory must match for
   *  this rule to fire. `null` = global (matches every cwd; legacy
   *  default). When the daemon cannot extract a cwd from the request,
   *  scoped rules are skipped — the rule editor's UI explains this. */
  projectScope: string | null;
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
  /** Optional path glob; `null` means global. */
  projectScope?: string | null;
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

/** Sound choices exposed in Settings on macOS. Values map to macOS system
 *  sounds (files under /System/Library/Sounds); `null` means no sound. These
 *  are OS sounds, not bundled with Sentinel — Windows shows
 *  ALERT_SOUNDS_WINDOWS instead. */
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

/** Sound choices exposed in Settings on Windows. Values are the winrt toast
 *  audio event names tauri-winrt-notification accepts; the looping Alarm and
 *  Call variants are deliberately omitted because they repeat until the toast
 *  is dismissed, which is wrong for a usage alert. `null` means no sound (a
 *  winrt toast without audio renders silent). Unknown names — e.g. a stored
 *  macOS name like 'Glass' from before this split — fall back to 'Default'
 *  at delivery (see display_alert_notification in notify.rs). */
export const ALERT_SOUNDS_WINDOWS: ReadonlyArray<{ label: string; value: string | null }> = [
  { label: 'None', value: null },
  { label: 'Default', value: 'Default' },
  { label: 'IM', value: 'IM' },
  { label: 'Mail', value: 'Mail' },
  { label: 'Reminder', value: 'Reminder' },
  { label: 'SMS', value: 'SMS' },
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
