import React, { useEffect, useRef, useState, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { motion } from 'motion/react';
import { sendToSentinel } from '../lib/ipc.js';
import type {
  RateLimitWindow,
  OAuthAccount,
  AccountInfo,
  ClaudeAiUsageSnapshot,
  PauseReason,
} from '@claude-sentinel/shared';
import { useSettings } from '../hooks/useSettings.js';
import {
  useAllRateLimits,
  fiveHourUtilization,
  fiveHourResetAt,
  weeklyUtilization,
  weeklyResetAt,
  weeklySonnetUtilization,
  weeklySonnetResetAt,
} from '../hooks/useAllRateLimits.js';
import { useClaudeAiUsage } from '../hooks/useClaudeAiUsage.js';
import { usePausedAccounts, type PausedState } from '../hooks/usePausedAccounts.js';
import { DUR, EASE_OUT } from '../lib/motion.js';
import InfoTooltip, { InfoTooltipRich } from './InfoTooltip.js';
import ResetCountdown from './ResetCountdown.js';

/** Why the Usage percentages can differ from claude.ai by up to 1 point —
 *  shown in an InfoTooltip next to the "Usage" header. */
const USAGE_VARIANCE_NOTE =
  "Usage values may differ from claude.ai by up to 1%. Anthropic's rate-limit headers expose utilization truncated to two decimals, while claude.ai renders the higher-precision internal value; rounding produces a small, expected gap.";

// Human-readable labels for known rate-limit window names
const WINDOW_META: Record<string, { label: string; order: number }> = {
  'unified-5h': { label: '5-Hour Window', order: 0 },
  'unified-7d': { label: 'Weekly: All Models', order: 1 },
  'unified-7d_sonnet': { label: 'Weekly: Sonnet', order: 2 },
  'unified-overage': { label: 'Overage Budget', order: 3 },
};

// Windows that carry no useful display data (metadata / redundant)
const HIDDEN_WINDOWS = new Set(['unified', 'unified-status']);

function windowLabel(name: string): string {
  return (
    WINDOW_META[name]?.label ??
    name
      .split(/[-_]/)
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join(' ')
  );
}

function windowOrder(name: string): number {
  return WINDOW_META[name]?.order ?? 99;
}

interface ProgressRowProps {
  window: RateLimitWindow;
}

function ProgressRow({ window: w }: ProgressRowProps): React.ReactElement {
  // Subscription plans: use utilization directly.
  // API-key plans: compute from limit/remaining.
  //
  // Rounding note: Anthropic's utilization header is truncated to 2 decimals
  // (e.g. "0.44" for internal 0.44x). claude.ai rounds the higher-precision
  // internal value — so plain round on the header is our closest match. An
  // earlier floor+1 overshot by one for values whose hidden precision is low
  // in the bucket (e.g. header 0.53 from internal 0.531 → claude.ai 53,
  // floor+1 → 54). Zero / saturated cases stay pinned.
  const subscriptionPct = (u: number): number => {
    if (u <= 0) return 0;
    if (u >= 1) return 100;
    return Math.min(100, Math.round(u * 100));
  };
  const pct =
    w.utilization != null
      ? subscriptionPct(w.utilization)
      : w.limit != null && w.remaining != null
        ? Math.min(100, Math.round(((w.limit - w.remaining) / w.limit) * 100))
        : null;

  const blocked = w.status === 'blocked';
  const overageActive = w.inUse === true;

  const barColor = blocked
    ? 'bg-ios-red'
    : pct == null
      ? 'bg-[#8E8E93]'
      : pct >= 90
        ? 'bg-ios-red'
        : pct >= 70
          ? 'bg-ios-orange'
          : /* default */ 'bg-ios-blue';

  const pctColor = blocked
    ? 'text-ios-red'
    : pct == null
      ? 'text-[#8E8E93]'
      : pct >= 90
        ? 'text-ios-red'
        : pct >= 70
          ? 'text-ios-orange'
          : /* default */ 'text-ios-blue';

  return (
    <div className="space-y-1.5">
      {/* Label row */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-black dark:text-white">
          {windowLabel(w.name)}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {overageActive && (
            <span className="text-[10px] font-semibold text-ios-red bg-ios-red/10 px-1.5 py-0.5 rounded-full">
              Overage active
            </span>
          )}
          {blocked && (
            <span className="text-[10px] font-semibold text-ios-red bg-ios-red/10 px-1.5 py-0.5 rounded-full">
              Blocked
            </span>
          )}
          {pct != null && (
            <span className={`text-[11px] font-bold tabular-nums ${pctColor}`}>{pct}%</span>
          )}
          {w.reset != null && w.reset > 0 && <ResetCountdown epochSec={w.reset} variant="inline" />}
        </div>
      </div>

      {/* Progress bar — always render when we have a percent (including 0%)
          so the track is visually consistent across every window. Blocked
          rows render a full-width red bar as intentional visual feedback. */}
      {(blocked || pct != null) && (
        <div className="h-[6px] rounded-full bg-black/[0.08] dark:bg-white/[0.10] overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${barColor}`}
            initial={{ width: 0 }}
            animate={{ width: `${blocked ? 100 : (pct ?? 0)}%` }}
            transition={{ duration: DUR.bar, ease: EASE_OUT }}
          />
        </div>
      )}

      {/* Detail line: API-key plans show counts; subscription plans show utilization fraction */}
      {w.limit != null && w.remaining != null ? (
        <p className="text-[10px] text-[#8E8E93] tabular-nums">
          {(w.limit - w.remaining).toLocaleString()} used · {w.remaining.toLocaleString()} remaining
          · {w.limit.toLocaleString()} limit
        </p>
      ) : w.utilization != null ? (
        <p className="text-[10px] text-[#8E8E93]">
          {(w.utilization * 100).toFixed(1)}% of quota consumed
        </p>
      ) : null}
    </div>
  );
}

/** Format a dollar amount as "$X.YZ". Negative / NaN falls back to "$0.00". */
function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '$0.00';
  return `$${n.toFixed(2)}`;
}

interface OverageMeterRowProps {
  /** The unified-overage RateLimitWindow. We reuse its reset timestamp and
   *  `inUse` flag; the numeric dollar values themselves come from the
   *  claude.ai usage endpoint (ClaudeAiUsageSnapshot.extraUsage). */
  window: RateLimitWindow;
  /** Anthropic's usage snapshot for the viewed account. `null` when the
   *  first fetch hasn't landed yet or the account has no stored OAuth
   *  credential. */
  usage: ClaudeAiUsageSnapshot | null;
  /** Error discriminator from the latest fetch, or null on success. Drives
   *  the "Reconnect" CTA copy when the token's gone bad. */
  usageError: 'missing_key' | 'auth_expired' | 'oauth_forbidden' | 'network' | 'parse' | null;
  /** User-configured Sentinel cap for the viewed account, or null if none
   *  is set. When null, the Sentinel sub-bar is suppressed. */
  sentinelCapUsd: number | null;
  /** Sentinel account id — used to route the Reconnect CTA to the right
   *  account via `start_login`. */
  accountId: string | null;
  /** Paused-state metadata for the viewed account (null when not paused). */
  pauseState: PausedState | null;
  /** Account plan type (as stored in the Sentinel account registry).
   *  Gates team-only rendering paths: for team plans the org-wide
   *  `extraUsage.usedUsd` number is NOT a personal spend figure, so
   *  we only ever render `perUserBudget` and prompt the user to ask
   *  their admin if per-user budget is unconfigured. All non-team
   *  values use the individual-plan render path. */
  planType: string;
}

/**
 * Overage meter composite. Renders up to two stacked bars:
 *   - "Anthropic budget": dollar spend vs. the Anthropic-configured monthly
 *     limit. Sourced from claude.ai's /api/organizations/{org}/usage
 *     endpoint (the ONLY source of these numbers — no OAuth equivalent).
 *   - "Sentinel cap": the user-set lower ceiling, if configured. Progress
 *     is the same spend number compared against the local cap.
 *
 * When neither is available (no sessionKey / no local cap), falls back to
 * the plain ProgressRow so accounts without overage data still render
 * something meaningful from rate-limit headers alone.
 */
function OverageMeterRow({
  window: w,
  usage,
  usageError,
  sentinelCapUsd,
  accountId,
  pauseState,
  planType,
}: OverageMeterRowProps): React.ReactElement {
  const extra = usage?.extraUsage ?? null;
  const perUser = usage?.perUserBudget ?? null;

  // Distinct render modes:
  //
  //   'team-per-user'   — team account WITH an admin-configured
  //                       per-user budget. Show member's personal
  //                       cap + spend.
  //   'team-needs-admin'— team account WITHOUT a per-user budget.
  //                       extra_usage.used_credits here is a credit
  //                       counter, not an actual spend number (and
  //                       extra_usage.utilization is null for teams),
  //                       so we intentionally show NOTHING numeric
  //                       and nudge the user to ask their admin to
  //                       enable the feature.
  //   'individual'      — Max/Pro. extra_usage.used_credits does
  //                       equal dollar spend here because a monthly_
  //                       limit is set; standard bar render.
  //   'disabled'        — no overage configured at all; degrade to
  //                       rate-limit-only ProgressRow.
  const isTeam = planType === 'team';
  const teamPerUserValid =
    isTeam &&
    perUser != null &&
    perUser.limitUsd != null &&
    perUser.limitUsd > 0 &&
    perUser.usedUsd != null;
  const individualAnthropicValid = !isTeam && !!extra && extra.isEnabled && extra.limitUsd > 0;
  const individualOverageDisabled = !isTeam && !!extra && !extra.isEnabled;
  const teamNeedsAdmin = isTeam && !teamPerUserValid && !!extra && extra.isEnabled;

  const anthUsedPrimary = teamPerUserValid ? (perUser!.usedUsd ?? 0) : (extra?.usedUsd ?? 0);
  const anthTotalPrimary = teamPerUserValid ? (perUser!.limitUsd ?? 0) : (extra?.limitUsd ?? 0);

  const showAnthropic = teamPerUserValid || individualAnthropicValid;
  const showSentinel = sentinelCapUsd != null && sentinelCapUsd > 0 && !!extra && !isTeam;

  // No overage data yet → three render paths:
  //
  // (a) `oauth_forbidden`: the account's organization has OAuth API
  //     access disabled by admin/billing policy. Re-authentication
  //     produces the same restricted token, so there's no Reconnect
  //     button. Copy explains the state and tells the user to ask
  //     their admin. (Surfaces a distinct 403 `permission_error`
  //     response the daemon routes out of the generic auth_expired
  //     bucket.)
  //
  // (b) `missing_key` / `auth_expired`: the account's OAuth token is
  //     missing or rejected. Auto-refresh usually fixes auth_expired
  //     within seconds; persistent failures mean the refresh token
  //     itself is dead. Surface a Reconnect CTA that reruns OAuth so
  //     the user ends up with a fresh credential without hunting
  //     through Settings.
  //
  // (c) Any other state (network error, snapshot still loading, or
  //     connected but without overage enabled): fall back to the plain
  //     ProgressRow so at least the rate-limit util% the proxy sees
  //     still shows something. The dollar overlay is skipped.
  if (!showAnthropic && !showSentinel) {
    if (usageError === 'oauth_forbidden') {
      return (
        <div className="rounded-xl bg-ios-orange/[0.08] dark:bg-ios-orange/[0.12] border border-ios-orange/20 p-3">
          <p className="text-[12px] font-semibold text-black dark:text-white leading-tight">
            OAuth access disabled
          </p>
          <p className="text-[11px] text-[#8E8E93] leading-snug mt-0.5">
            Your organization&apos;s admin has disabled OAuth API access for this account. Sentinel
            can&apos;t read usage until it&apos;s re-enabled; re-authenticating won&apos;t help.
          </p>
        </div>
      );
    }
    if ((usageError === 'missing_key' || usageError === 'auth_expired') && accountId) {
      return (
        <div className="rounded-xl bg-ios-blue/[0.08] dark:bg-ios-blue/[0.12] border border-ios-blue/20 p-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-semibold text-black dark:text-white leading-tight">
              {usageError === 'auth_expired' ? 'Sign-in expired' : 'Sign-in required'}
            </p>
            <p className="text-[11px] text-[#8E8E93] leading-snug mt-0.5">
              Reconnect to refresh your subscription usage and overage spend.
            </p>
          </div>
          <button
            onClick={() => void sendToSentinel({ type: 'start_login' }).catch(() => undefined)}
            className="shrink-0 text-[11px] font-semibold text-white bg-ios-blue hover:brightness-110 px-3 py-1.5 rounded-full transition"
          >
            Reconnect
          </button>
        </div>
      );
    }
    if (teamNeedsAdmin) {
      return (
        <div className="space-y-2">
          <ProgressRow window={w} />
          <div className="rounded-xl bg-ios-orange/[0.08] dark:bg-ios-orange/[0.12] border border-ios-orange/20 p-3">
            <p className="text-[12px] font-semibold text-black dark:text-white leading-tight">
              Team spend tracking unavailable
            </p>
            <p className="text-[11px] text-[#8E8E93] leading-snug mt-0.5">
              claude.ai reports only a team-wide credit counter for this account and doesn't expose
              personal spend to non-admins. Ask your org admin to enable per-user budgets in
              claude.ai → Settings → Usage to unlock dollar tracking and Sentinel caps for your
              seat.
            </p>
          </div>
        </div>
      );
    }
    if (individualOverageDisabled) {
      return (
        <div className="space-y-2">
          <ProgressRow window={w} />
          <div className="rounded-xl bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.06] dark:border-white/[0.08] p-3">
            <p className="text-[12px] font-semibold text-black dark:text-white leading-tight">
              Extra usage is disabled
            </p>
            <p className="text-[11px] text-[#8E8E93] leading-snug mt-0.5">
              Requests will be blocked once you hit your subscription&apos;s rate limit. Enable on
              claude.ai &rarr; Settings &rarr; Usage to add a monthly overage budget.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-2">
        <ProgressRow window={w} />
      </div>
    );
  }

  const anthUsed = anthUsedPrimary;
  const anthTotal = anthTotalPrimary;
  const anthPct = anthTotal > 0 ? Math.min(100, Math.round((anthUsed / anthTotal) * 100)) : 0;
  const anthBarColor =
    anthPct >= 90 ? 'bg-ios-red' : anthPct >= 70 ? 'bg-ios-orange' : 'bg-ios-blue';

  const sentPct =
    showSentinel && sentinelCapUsd! > 0
      ? Math.min(100, Math.round((anthUsed / sentinelCapUsd!) * 100))
      : 0;
  const sentBarColor =
    sentPct >= 100
      ? 'bg-ios-red'
      : sentPct >= 90
        ? 'bg-ios-red'
        : sentPct >= 70
          ? 'bg-ios-orange'
          : 'bg-ios-blue';

  const overageActive = w.inUse === true;

  return (
    <div className="space-y-2">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-black dark:text-white">Overage Budget</span>
        <div className="flex items-center gap-2 shrink-0">
          {overageActive && (
            <span className="text-[10px] font-semibold text-ios-red bg-ios-red/10 px-1.5 py-0.5 rounded-full">
              Overage active
            </span>
          )}
          {pauseState && (
            <span className="text-[10px] font-semibold text-ios-red bg-ios-red/10 px-1.5 py-0.5 rounded-full">
              Paused
            </span>
          )}
          {w.reset != null && w.reset > 0 && !pauseState && (
            <ResetCountdown epochSec={w.reset} variant="inline" />
          )}
          {pauseState && pauseState.resetsAt != null && (
            <ResetCountdown epochSec={pauseState.resetsAt} variant="inline" label="resumes in" />
          )}
        </div>
      </div>

      {usageError === 'auth_expired' && accountId && (
        <button
          onClick={() => void sendToSentinel({ type: 'start_login' }).catch(() => undefined)}
          className="w-full text-left text-[11px] text-ios-orange hover:underline"
        >
          Sign-in expired. Reconnect to refresh numbers →
        </button>
      )}

      {/* Anthropic sub-bar — labeled based on which scope the numbers
          came from. Per-user budget (admin-configured via claude.ai's
          settings/usage page) is prioritized when present; otherwise
          we fall back to the team-wide extra_usage.used_credits, made
          explicit in the label so the member doesn't misread it as
          personal spend. */}
      {showAnthropic && (
        <div className="space-y-1">
          <div className="flex items-baseline justify-between text-[11px]">
            <span className="text-[#8E8E93]">
              {teamPerUserValid ? 'Your personal budget' : 'Anthropic grant'}
            </span>
            <span className="tabular-nums text-black dark:text-white font-medium">
              {fmtUsd(anthUsed)}{' '}
              <span className="text-[#8E8E93] font-normal">/ {fmtUsd(anthTotal)}</span>
            </span>
          </div>
          <div className="h-[6px] rounded-full bg-black/[0.08] dark:bg-white/[0.10] overflow-hidden">
            <motion.div
              className={`h-full rounded-full ${anthBarColor}`}
              initial={{ width: 0 }}
              animate={{ width: `${anthPct}%` }}
              transition={{ duration: DUR.bar, ease: EASE_OUT }}
            />
          </div>
        </div>
      )}

      {/* Sentinel sub-bar */}
      {showSentinel && (
        <div className="space-y-1">
          <div className="flex items-baseline justify-between text-[11px]">
            <span className="text-[#8E8E93]">Sentinel cap</span>
            <span className="tabular-nums text-black dark:text-white font-medium">
              {fmtUsd(anthUsed)}{' '}
              <span className="text-[#8E8E93] font-normal">/ {fmtUsd(sentinelCapUsd!)}</span>
            </span>
          </div>
          <div className="h-[6px] rounded-full bg-black/[0.08] dark:bg-white/[0.10] overflow-hidden">
            <motion.div
              className={`h-full rounded-full ${sentBarColor}`}
              initial={{ width: 0 }}
              animate={{ width: `${sentPct}%` }}
              transition={{ duration: DUR.bar, ease: EASE_OUT }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Synthesize a minimal OAuthAccount from an AccountInfo row. Only fills the
 * fields the Sonnet-quota synthesis below reads (`billingType`,
 * `hasExtraUsageEnabled`). Used when the per-tab picker selects a non-active
 * account so Usage can still decide whether to render the Sonnet row at 0%.
 */
function accountInfoToOAuthLike(acct: AccountInfo | undefined): OAuthAccount | null {
  if (!acct) return null;
  const isMax = acct.planType === 'max' || acct.planType === 'enterprise';
  const isTeamOrEnt = acct.planType === 'team' || acct.planType === 'enterprise';
  return {
    accountUuid: acct.accountUuid,
    emailAddress: acct.email,
    organizationUuid: acct.orgUuid,
    hasExtraUsageEnabled: isMax,
    billingType: acct.planType,
    accountCreatedAt: new Date(acct.createdAt).toISOString(),
    subscriptionCreatedAt: new Date(acct.createdAt).toISOString(),
    displayName: acct.displayName,
    organizationRole: 'user',
    workspaceRole: isTeamOrEnt ? 'member' : null,
    organizationName: acct.orgName,
  };
}

interface UsageViewProps {
  /** Incremented by useDaemon whenever rate_limits_updated arrives from the daemon.
   *  Adding it as a dep causes this component to re-fetch automatically. */
  rateLimitsVersion: number;
  /** True while the daemon is probing Anthropic for fresh rate-limit headers
   *  (fires on account switch and startup). When true, the Refresh button spins
   *  and a "Refreshing…" note renders so the user knows the displayed numbers
   *  may be stale and are about to update. */
  isProbing?: boolean;
  /** The account whose windows are being rendered. Used to decide which
   *  windows to always show even when Anthropic has not yet returned headers
   *  for them — Max seat holders have a separate Sonnet quota that the API
   *  omits from rate-limit headers until Sonnet usage actually starts, but
   *  the user still wants to see it (at 0%) in the UI. */
  activeAccount: OAuthAccount | null;
  /** Every known account. Piped in from App.tsx (useDaemon) so the round-robin
   *  pool view can render a row per account without spinning up a second copy
   *  of useAccounts (which doesn't auto-fetch on mount). */
  accounts: AccountInfo[];
  /** View-scope override from the per-tab AccountViewPicker. Behavior:
   *   - `undefined`: default (follows the active account in single-account mode,
   *                  renders the pool view in round-robin mode)
   *   - `'__pool__'`: force pool view regardless of mode
   *   - any other string: treat as a specific accountId to inspect, rendering
   *                       the single-account view even in round-robin mode */
  viewAccountId?: string | undefined;
}

export default function UsageView(props: UsageViewProps): React.ReactElement {
  const { settings } = useSettings();
  const isRoundRobin = settings?.switchingMode === 'round-robin';
  const { viewAccountId } = props;

  // Explicit pool selection always wins.
  if (viewAccountId === '__pool__') {
    return <RoundRobinUsageView accounts={props.accounts} />;
  }
  // In RR mode with no explicit pick, default to the pool. An explicit
  // account id (non-pool) falls through to the single-account view below so
  // the user can drill into any account even while rotation is on.
  if (isRoundRobin && viewAccountId === undefined) {
    return <RoundRobinUsageView accounts={props.accounts} />;
  }
  return <SingleAccountUsageView {...props} />;
}

function SingleAccountUsageView({
  rateLimitsVersion,
  isProbing,
  activeAccount,
  viewAccountId,
  accounts,
}: UsageViewProps): React.ReactElement {
  const [windows, setWindows] = useState<RateLimitWindow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const { settings } = useSettings();
  const paused = usePausedAccounts();

  const busy = loading || Boolean(isProbing);

  // When the user picks a non-active account via the per-tab picker, we need
  // the OAuthAccount-shaped record for that selection so the Sonnet-quota
  // synthesis (below) can read billingType / hasExtraUsageEnabled. Fall back
  // to the actual active account when no pick is made.
  const viewAccount: OAuthAccount | null = viewAccountId
    ? (accountInfoToOAuthLike(accounts.find((a) => a.id === viewAccountId)) ?? activeAccount)
    : activeAccount;

  // Resolve Sentinel id for the viewed account so we can scope settings
  // lookups + pause-state + live usage subscription.
  const viewAccountKey =
    viewAccountId ??
    (activeAccount
      ? accounts.find((a) => a.accountUuid === activeAccount.accountUuid)?.id
      : undefined);
  const { snapshot: claudeAiUsage, error: claudeAiUsageError } = useClaudeAiUsage(viewAccountKey);
  const sentinelCap: number | null = viewAccountKey
    ? (settings?.budgetWeeklyUsdByAccount[viewAccountKey] ??
      settings?.budgetWeeklyUsdGlobal ??
      null)
    : null;
  const viewPauseState = viewAccountKey ? (paused[viewAccountKey] ?? null) : null;

  // Returns { ok, error? } so the refresh-button handler can surface
  // success/failure without racing the error-state render.
  const fetchRateLimits = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    setLoading(true);
    setError(null);
    try {
      const res = await sendToSentinel<RateLimitWindow[]>(
        viewAccountId
          ? { type: 'get_rate_limits', accountId: viewAccountId }
          : { type: 'get_rate_limits' },
      );
      setWindows(res.data ?? []);
      setLastUpdated(Date.now());
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load rate limits';
      setError(msg);
      return { ok: false, error: msg };
    } finally {
      setLoading(false);
    }
  }, [viewAccountId]);

  const [refreshStatus, setRefreshStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(
    null,
  );
  const refreshStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleRefreshClick = useCallback(async (): Promise<void> => {
    const result = await fetchRateLimits();
    if (refreshStatusTimerRef.current) clearTimeout(refreshStatusTimerRef.current);
    setRefreshStatus(
      result.ok ? { kind: 'ok', text: 'Updated' } : { kind: 'err', text: result.error ?? 'Failed' },
    );
    refreshStatusTimerRef.current = setTimeout(() => setRefreshStatus(null), 3000);
  }, [fetchRateLimits]);

  // Re-fetch on mount and whenever the daemon reports new rate-limit data.
  // rateLimitsVersion is bumped by useDaemon (always-mounted) on rate_limits_updated
  // broadcasts, so this fires even if the user was on a different tab when the
  // broadcast arrived.
  useEffect(() => {
    void fetchRateLimits();
  }, [fetchRateLimits, rateLimitsVersion]);

  // Show windows that have meaningful data, sorted by priority, excluding noise.
  // For accounts that carry a separate Sonnet quota (Max / Team / Enterprise),
  // ensure the `unified-7d_sonnet` row is present alongside real data —
  // Anthropic omits it from response headers until the user actually consumes
  // Sonnet, but when we have other windows the user still wants to see the 0%
  // row rather than have it silently disappear.
  //
  // Important: only synthesize the Sonnet placeholder when `windows` already
  // has real data. If the list is empty (fresh account, no calls yet) a lone
  // "Weekly: Sonnet 0%" row reads as misleading "sole usage" instead of the
  // truthful "no data" empty state.
  //
  // Signal priority for whether a Sonnet quota exists at all:
  //   1. Observed `unified-7d` header (definitive: the account has weekly quotas).
  //   2. Plan type (falls back when no API calls have been made yet — Max's
  //      `hasExtraUsageEnabled` flag, or a team/enterprise billingType).
  const synthesized: RateLimitWindow[] = [...windows];
  const weekly = synthesized.find((w) => w.name === 'unified-7d');
  const billing = viewAccount?.billingType;
  const hasSonnetQuota =
    weekly != null ||
    viewAccount?.hasExtraUsageEnabled === true ||
    billing === 'team' ||
    billing === 'enterprise' ||
    billing === 'max';
  const hasRealData = windows.some(
    (w) => !HIDDEN_WINDOWS.has(w.name) && (w.utilization != null || w.limit != null),
  );
  if (hasRealData && hasSonnetQuota && !synthesized.some((w) => w.name === 'unified-7d_sonnet')) {
    synthesized.push({
      name: 'unified-7d_sonnet',
      status: 'allowed',
      utilization: 0,
      limit: null,
      remaining: null,
      reset: weekly?.reset ?? null,
      lastUpdated: Date.now(),
    });
  }
  const displayWindows = synthesized
    .filter((w) => !HIDDEN_WINDOWS.has(w.name) && (w.utilization != null || w.limit != null))
    .sort((a, b) => windowOrder(a.name) - windowOrder(b.name));

  return (
    <div className="space-y-3 pt-1">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <span className="section-label">Usage</span>
          <InfoTooltip text={USAGE_VARIANCE_NOTE} placement="bottom" />
        </div>
        <div className="flex items-center gap-2">
          {isProbing && <span className="text-[10px] text-ios-blue font-medium">Refreshing…</span>}
          {!isProbing && refreshStatus && (
            <span
              className={`text-[10px] font-medium ${refreshStatus.kind === 'ok' ? 'text-ios-green' : 'text-ios-red'}`}
            >
              {refreshStatus.text}
            </span>
          )}
          <button
            onClick={() => void handleRefreshClick()}
            disabled={busy}
            className="text-[#8E8E93] hover:text-ios-blue disabled:opacity-40 transition-colors active:scale-90"
            title="Refresh"
          >
            <RefreshCw size={13} strokeWidth={2.5} className={busy ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl bg-ios-red/10 dark:bg-ios-red/15 px-4 py-3">
          <p className="text-[12px] text-ios-red">{error}</p>
        </div>
      )}

      {/* Org-level OAuth-disabled policy: rate-limit probe returns 403 so
          `displayWindows` stays empty. The normal "No data yet" empty state
          misleads here (it invites the user to click Refresh, which will
          keep failing), so render a distinct explanatory panel instead. */}
      {!busy &&
        displayWindows.length === 0 &&
        !error &&
        claudeAiUsageError === 'oauth_forbidden' && (
          <div className="glass-card px-4 py-5">
            <p className="text-[13px] font-semibold text-black dark:text-white leading-tight">
              OAuth access disabled
            </p>
            <p className="text-[11px] text-[#8E8E93] mt-1.5 leading-relaxed">
              Your organization&apos;s admin has disabled OAuth API access for this account.
              Sentinel can&apos;t read usage or rate limits until it&apos;s re-enabled.
              Re-authenticating won&apos;t help; ask your admin to enable OAuth API access for the
              organization.
            </p>
          </div>
        )}

      {!busy &&
        displayWindows.length === 0 &&
        !error &&
        claudeAiUsageError !== 'oauth_forbidden' && (
          <div className="glass-card px-4 py-10 text-center">
            <p className="text-[13px] font-medium text-black dark:text-white">No data yet</p>
            <p className="text-[11px] text-[#8E8E93] mt-1 leading-relaxed">
              Rate limit data appears after your first API call through Sentinel,
              <br />
              or tap Refresh to probe claude.ai now.
            </p>
            <button
              onClick={() => void handleRefreshClick()}
              disabled={busy}
              className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-semibold text-white
                       bg-ios-blue hover:opacity-90 active:scale-95 disabled:opacity-40
                       px-3 py-1.5 rounded-full transition-all duration-150"
            >
              <RefreshCw size={11} strokeWidth={2.5} className={busy ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        )}

      {busy && displayWindows.length === 0 && !error && (
        <div className="glass-card px-4 py-10 text-center">
          <RefreshCw
            size={16}
            strokeWidth={2.5}
            className="animate-spin text-ios-blue mx-auto mb-2"
          />
          <p className="text-[12px] text-[#8E8E93]">Fetching rate limits…</p>
        </div>
      )}

      {displayWindows.length > 0 && (
        <div className="glass-card px-4 py-4 space-y-5">
          {displayWindows.map((w) =>
            w.name === 'unified-overage' ? (
              <OverageMeterRow
                key={w.name}
                window={w}
                usage={claudeAiUsage}
                usageError={claudeAiUsageError}
                sentinelCapUsd={sentinelCap}
                accountId={viewAccountKey ?? null}
                pauseState={viewPauseState}
                planType={accounts.find((a) => a.id === viewAccountKey)?.planType ?? 'unknown'}
              />
            ) : (
              <ProgressRow key={w.name} window={w} />
            ),
          )}
        </div>
      )}

      {lastUpdated != null && displayWindows.length > 0 && (
        <p className="text-[10px] text-[#8E8E93] text-center">
          Updated {new Date(lastUpdated).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

// Utilization (0..1) → display percent. null passes through as null.
function utilToPct(util: number | null): number | null {
  if (util == null) return null;
  if (util <= 0) return 0;
  if (util >= 1) return 100;
  return Math.min(100, Math.round(util * 100));
}

// Short, lowercase phrase for each pause cause. Used in the auto-excluded
// caption tooltip so the user can see *why* an account was filtered out
// (vs. the manual "Excluded" badge, which is always user-driven).
function pauseReasonLabel(reason: PauseReason): string {
  switch (reason) {
    case 'sentinel_weekly_rate_limit':
      return 'weekly limit';
    case 'sentinel_budget':
      return 'budget cap';
    case 'anthropic_overage_disabled':
      return 'overage disabled';
  }
}

// Threshold ladder shared by every round-robin meter (bar + pct text color).
function meterColors(pct: number | null): { bar: string; text: string } {
  if (pct == null) return { bar: 'bg-[#8E8E93]', text: 'text-[#8E8E93]' };
  if (pct >= 90) return { bar: 'bg-ios-red', text: 'text-ios-red' };
  if (pct >= 70) return { bar: 'bg-ios-orange', text: 'text-ios-orange' };
  return { bar: 'bg-ios-blue', text: 'text-ios-blue' };
}

/** One meter inside the Pool Usage card: label, right-aligned "NN% avg" +
 *  "N of M" counter, and a progress bar for the average. `utils` is the list
 *  of pool-member utilizations with unknowns already filtered out;
 *  `totalAccounts` is the denominator (pool size, excluding out-of-pool
 *  accounts) so the counter reflects "how many of the rotating accounts
 *  reported data for this window." */
function PoolMeterBlock({
  label,
  utils,
  totalAccounts,
}: {
  label: string;
  utils: number[];
  totalAccounts: number;
}): React.ReactElement {
  // Clamp each util to [0, 1] before averaging so an account in overage
  // (util > 1) doesn't inflate the pool past what the per-account rows show
  // — utilToPct caps individual meters at 100%, and the pool average must
  // match that visible reality.
  const avg =
    utils.length === 0
      ? null
      : Math.min(
          100,
          Math.round(
            (utils.reduce((a, b) => a + Math.max(0, Math.min(1, b)), 0) / utils.length) * 100,
          ),
        );
  const colors = meterColors(avg);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-black dark:text-white">{label}</span>
        <div className="flex items-center gap-2 shrink-0">
          {avg != null && (
            <span className={`text-[11px] font-bold tabular-nums ${colors.text}`}>{avg}% avg</span>
          )}
          <span className="text-[10px] text-[#8E8E93]">
            {utils.length} of {totalAccounts}
          </span>
        </div>
      </div>
      {avg != null && (
        <div className="h-[6px] rounded-full bg-black/[0.08] dark:bg-white/[0.10] overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${colors.bar}`}
            initial={{ width: 0 }}
            animate={{ width: `${avg}%` }}
            transition={{ duration: DUR.bar, ease: EASE_OUT }}
          />
        </div>
      )}
    </div>
  );
}

/** One row in a per-account round-robin card: account label, reset pill,
 *  percent, and a bar. Null `util` renders "–" + no bar + no pill. Excluded
 *  accounts are dimmed and tagged with an "Excluded" pill. */
function PoolAccountRow({
  account,
  util,
  resetAt,
  inPool,
}: {
  account: AccountInfo;
  util: number | null;
  resetAt: number | null;
  inPool: boolean;
}): React.ReactElement {
  const pct = utilToPct(util);
  const colors = meterColors(pct);
  const label = account.displayName || account.email;
  const sub = account.orgName || (account.displayName ? account.email : null);
  const hasReset = resetAt != null && resetAt > 0;
  return (
    <div className={`space-y-1.5 ${inPool ? '' : 'opacity-50'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-[12px] font-semibold text-black dark:text-white truncate leading-snug">
              {label}
            </p>
            {!inPool && (
              <span className="text-[9px] font-semibold text-[#8E8E93] bg-[#8E8E93]/15 px-1.5 py-0.5 rounded-full uppercase tracking-wider flex-shrink-0">
                Excluded
              </span>
            )}
          </div>
          {sub && <p className="text-[10px] text-[#8E8E93] truncate leading-snug">{sub}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasReset && <ResetCountdown epochSec={resetAt} variant="pill" />}
          <span className={`text-[11px] font-bold tabular-nums ${colors.text}`}>
            {pct == null ? '–' : `${pct}%`}
          </span>
        </div>
      </div>
      {pct != null && (
        <div className="h-[6px] rounded-full bg-black/[0.08] dark:bg-white/[0.10] overflow-hidden">
          <motion.div
            className={`h-full rounded-full ${colors.bar}`}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: DUR.bar, ease: EASE_OUT }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Round-robin mode pool view.
 *
 * When the proxy rotates tokens per-request, the "active account" concept
 * loses meaning for Usage — every request's response headers belong to a
 * different account, so the single-account view thrashes. Instead we render:
 *   1. A "Pool Usage" card with three pool-average meters (5h, weekly, sonnet)
 *   2. Per-account card for 5-Hour Window
 *   3. Per-account card for Weekly: All Models
 *   4. Per-account card for Weekly: Sonnet
 *
 * Data flows through useAllRateLimits (which listens to rate_limits_updated /
 * account_switched / login_complete broadcasts) and useAccounts (for labels).
 * We never call `get_rate_limits` here — that endpoint is scoped to the
 * single active account and would be stale for everything else in the pool.
 */
function RoundRobinUsageView({ accounts }: { accounts: AccountInfo[] }): React.ReactElement {
  const { byAccount, refetch } = useAllRateLimits();
  const { settings } = useSettings();
  const paused = usePausedAccounts();
  const [poolRefreshStatus, setPoolRefreshStatus] = useState<{
    kind: 'ok' | 'err';
    text: string;
  } | null>(null);
  const poolRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePoolRefreshClick = useCallback(async (): Promise<void> => {
    const result = await refetch();
    if (poolRefreshTimerRef.current) clearTimeout(poolRefreshTimerRef.current);
    setPoolRefreshStatus(
      result.ok ? { kind: 'ok', text: 'Updated' } : { kind: 'err', text: result.error ?? 'Failed' },
    );
    poolRefreshTimerRef.current = setTimeout(() => setPoolRefreshStatus(null), 3000);
  }, [refetch]);
  // Manually-excluded accounts are sitting out of rotation, so they shouldn't
  // contribute to the pool averages — the meters should reflect what's
  // actually rotating. Per-account rows still render them (dimmed) so
  // the user can still see their usage.
  const excludedIds = new Set(settings?.poolExcludedIds ?? []);

  // Paused accounts (weekly cap / budget cap / overage disabled) are also
  // not rotating: the TokenRotator already skips them, so including their
  // 100%-style utilization in the pool average dragged the meters and the
  // tray % up against accounts the user can't actually use. Filter them
  // alongside manual exclusions so the displayed pool reflects the live
  // working set.
  const isAutoExcluded = (id: string): boolean => id in paused;

  // Precompute every window we render per account in a single pass so the
  // three per-account cards share the same row identities for React keys.
  const rows = accounts.map((acct) => {
    const w = byAccount[acct.id];
    return {
      account: acct,
      inPool: !excludedIds.has(acct.id) && !isAutoExcluded(acct.id),
      fiveH: { util: fiveHourUtilization(w), resetAt: fiveHourResetAt(w) },
      weekly: { util: weeklyUtilization(w), resetAt: weeklyResetAt(w) },
      sonnet: { util: weeklySonnetUtilization(w), resetAt: weeklySonnetResetAt(w) },
    };
  });

  const poolRows = rows.filter((r) => r.inPool);
  const poolSize = poolRows.length;
  const fiveHUtils = poolRows.map((r) => r.fiveH.util).filter((u): u is number => u != null);
  const weeklyUtils = poolRows.map((r) => r.weekly.util).filter((u): u is number => u != null);
  const sonnetUtils = poolRows.map((r) => r.sonnet.util).filter((u): u is number => u != null);

  // Accounts auto-excluded *only* because they're paused (not via the manual
  // poolExcludedIds setting). Manually-excluded accounts already render the
  // "Excluded" badge in their per-account row; surfacing them again here
  // would double-count them in the caption.
  const autoExcludedRows = rows.filter(
    (r) => !excludedIds.has(r.account.id) && isAutoExcluded(r.account.id),
  );

  return (
    <div className="space-y-3 pt-1">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="section-label">Usage</span>
          <span className="text-[9px] font-semibold text-ios-blue bg-ios-blue/10 px-1.5 py-0.5 rounded-full uppercase tracking-wider">
            Round-robin
          </span>
          <InfoTooltip text={USAGE_VARIANCE_NOTE} placement="bottom" />
        </div>
        <div className="flex items-center gap-2">
          {poolRefreshStatus && (
            <span
              className={`text-[10px] font-medium ${poolRefreshStatus.kind === 'ok' ? 'text-ios-green' : 'text-ios-red'}`}
            >
              {poolRefreshStatus.text}
            </span>
          )}
          <button
            onClick={() => void handlePoolRefreshClick()}
            className="text-[#8E8E93] hover:text-ios-blue transition-colors active:scale-90"
            title="Refresh"
          >
            <RefreshCw size={13} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="glass-card px-4 py-10 text-center">
          <p className="text-[12px] text-[#8E8E93]">No accounts configured.</p>
        </div>
      ) : (
        <>
          {/* Pool averages */}
          <div className="glass-card px-4 py-4 space-y-3">
            <span className="text-[12px] font-semibold text-black dark:text-white">Pool Usage</span>
            <PoolMeterBlock
              label={windowLabel('unified-5h')}
              utils={fiveHUtils}
              totalAccounts={poolSize}
            />
            <PoolMeterBlock
              label={windowLabel('unified-7d')}
              utils={weeklyUtils}
              totalAccounts={poolSize}
            />
            <PoolMeterBlock
              label={windowLabel('unified-7d_sonnet')}
              utils={sonnetUtils}
              totalAccounts={poolSize}
            />
            <p className="text-[10px] text-[#8E8E93] leading-snug">
              Averages across every account in the round-robin pool. Accounts with no data yet for a
              given window are excluded from that window&apos;s average.
            </p>
            {autoExcludedRows.length > 0 && (
              <div className="flex items-start gap-1.5">
                <p className="text-[10px] text-[#8E8E93] leading-snug">
                  {autoExcludedRows.length === 1
                    ? '1 account auto-excluded (paused).'
                    : `${autoExcludedRows.length} accounts auto-excluded (paused).`}
                </p>
                <InfoTooltipRich placement="top">
                  <p className="font-semibold mb-1">Excluded from pool average</p>
                  <ul className="space-y-0.5">
                    {autoExcludedRows.map((r) => {
                      const state = paused[r.account.id] as PausedState;
                      return (
                        <li key={r.account.id}>
                          {r.account.email} ({pauseReasonLabel(state.reason)})
                        </li>
                      );
                    })}
                  </ul>
                </InfoTooltipRich>
              </div>
            )}
          </div>

          {/* Per-account: 5-Hour Window */}
          <div className="glass-card px-4 py-4 space-y-4">
            <span className="text-[12px] font-semibold text-black dark:text-white">
              {windowLabel('unified-5h')}
            </span>
            {rows.map(({ account, inPool, fiveH }) => (
              <PoolAccountRow
                key={`${account.id}:5h`}
                account={account}
                util={fiveH.util}
                resetAt={fiveH.resetAt}
                inPool={inPool}
              />
            ))}
          </div>

          {/* Per-account: Weekly: All Models */}
          <div className="glass-card px-4 py-4 space-y-4">
            <span className="text-[12px] font-semibold text-black dark:text-white">
              {windowLabel('unified-7d')}
            </span>
            {rows.map(({ account, inPool, weekly }) => (
              <PoolAccountRow
                key={`${account.id}:weekly`}
                account={account}
                util={weekly.util}
                resetAt={weekly.resetAt}
                inPool={inPool}
              />
            ))}
          </div>

          {/* Per-account: Weekly: Sonnet */}
          <div className="glass-card px-4 py-4 space-y-4">
            <span className="text-[12px] font-semibold text-black dark:text-white">
              {windowLabel('unified-7d_sonnet')}
            </span>
            {rows.map(({ account, inPool, sonnet }) => (
              <PoolAccountRow
                key={`${account.id}:sonnet`}
                account={account}
                util={sonnet.util}
                resetAt={sonnet.resetAt}
                inPool={inPool}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
