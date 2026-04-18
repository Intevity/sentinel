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
  | 'all_accounts_exhausted';

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
 * One of three mutually exclusive account-switching behaviors.
 *   off         — no automatic switching; user manages accounts manually
 *   auto-switch — swap the active account once usage crosses a threshold
 *   round-robin — proxy rotates OAuth tokens per request across accounts
 */
export type SwitchingMode = 'off' | 'auto-switch' | 'round-robin';

/**
 * Persistent user preferences stored at ~/.claude-sentinel/settings.json.
 */
export interface Settings {
  launchAtLogin: boolean;
  switchingMode: SwitchingMode;
  /** Integer 1..99 — % of unified-5h window at which auto-switch fires. */
  autoSwitchThresholdPct: number;
  /** OS system sound name played alongside alert notifications.
   *  `null` means silent. On macOS the name must match a file in
   *  /System/Library/Sounds (e.g. 'Glass', 'Ping'). See ALERT_SOUNDS. */
  alertSoundName: string | null;
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
}

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
 * User-configured usage alert tied to a specific Claude account.
 * Fires a native OS notification when the unified-5h window's utilization
 * crosses thresholdPct. Re-firing is gated by lastTriggeredResetTs so each
 * alert fires at most once per 5-hour window.
 */
export interface Alert {
  id: number;
  accountId: string;
  thresholdPct: number;
  enabled: boolean;
  lastTriggeredResetTs: number | null;
  createdAt: number;
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
  skills: SkillUsage[];
  plugins: PluginInstall[];
}
