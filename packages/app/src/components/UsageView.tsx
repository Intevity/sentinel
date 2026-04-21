import React, { useEffect, useRef, useState, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { motion } from 'motion/react';
import { invoke } from '@tauri-apps/api/core';
import { sendToSentinel } from '../lib/ipc.js';
import type {
  RateLimitWindow,
  OAuthAccount,
  AccountInfo,
  ClaudeAiUsageSnapshot,
} from '@claude-sentinel/shared';
import { useSettings } from '../hooks/useSettings.js';
import {
  useAllRateLimits,
  fiveHourUtilization,
  fiveHourResetAt,
} from '../hooks/useAllRateLimits.js';
import { useClaudeAiUsage } from '../hooks/useClaudeAiUsage.js';
import { usePausedAccounts, type PausedState } from '../hooks/usePausedAccounts.js';
import { DUR, EASE_OUT } from '../lib/motion.js';
import InfoTooltip from './InfoTooltip.js';
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

      {/* Progress bar — suppressed at 0% to avoid rendering an empty track
          that reads as an orphan pill (most noticeable on the synthesized
          Sonnet row at the bottom of the card). Blocked rows still render
          the full-width red bar since that's intentional visual feedback. */}
      {(blocked || (pct != null && pct > 0)) && (
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
  /** Anthropic's usage snapshot for the viewed account. `null` when no
   *  sessionKey is configured yet or the first fetch hasn't landed. */
  usage: ClaudeAiUsageSnapshot | null;
  /** Error discriminator from the latest fetch, or null on success. Drives
   *  the "Connect claude.ai" CTA vs "Reconnect" vs "Retry" copy. */
  usageError: 'missing_key' | 'auth_expired' | 'network' | 'parse' | null;
  /** User-configured Sentinel cap for the viewed account, or null if none
   *  is set. When null, the Sentinel sub-bar is suppressed. */
  sentinelCapUsd: number | null;
  /** Sentinel account id — passed to `start_claude_ai_login` when the CTA
   *  is clicked. */
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
  const teamNeedsAdmin = isTeam && !teamPerUserValid && !!extra && extra.isEnabled;

  const anthUsedPrimary = teamPerUserValid ? (perUser!.usedUsd ?? 0) : (extra?.usedUsd ?? 0);
  const anthTotalPrimary = teamPerUserValid ? (perUser!.limitUsd ?? 0) : (extra?.limitUsd ?? 0);

  const showAnthropic = teamPerUserValid || individualAnthropicValid;
  const showSentinel = sentinelCapUsd != null && sentinelCapUsd > 0 && !!extra && !isTeam;

  // No sessionKey and no cap → two render paths:
  //
  // (a) Genuinely no sessionKey yet (`missing_key`): the per-window util%
  //     we'd otherwise render here is a rate-limit number that reads as
  //     "0 / 100% usage" to a user who hasn't told Sentinel about their
  //     claude.ai cookie. That framing is misleading — the overage
  //     section is about dollar spend, not rate-limit buckets, and we
  //     have no dollar data until the user connects. Swap the meter for
  //     a prominent CTA that makes the action obvious.
  //
  // (b) Any other state (network error, snapshot still loading, or
  //     connected but without overage enabled): fall back to the plain
  //     ProgressRow so at least the rate-limit util% the proxy sees
  //     still shows something. The dollar overlay is skipped.
  if (!showAnthropic && !showSentinel) {
    if (usageError === 'missing_key' && accountId) {
      return (
        <div className="rounded-xl bg-ios-blue/[0.08] dark:bg-ios-blue/[0.12] border border-ios-blue/20 p-3 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-semibold text-black dark:text-white leading-tight">
              Connect claude.ai to track overage spend
            </p>
            <p className="text-[11px] text-[#8E8E93] leading-snug mt-0.5">
              Dollar-denominated usage + weekly caps unlock once your session cookie is captured.
            </p>
          </div>
          <button
            onClick={() =>
              void invoke('start_claude_ai_login', { accountId }).catch(() => undefined)
            }
            className="shrink-0 text-[11px] font-semibold text-white bg-ios-blue hover:brightness-110 px-3 py-1.5 rounded-full transition"
          >
            Connect
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
          onClick={() => void invoke('start_claude_ai_login', { accountId }).catch(() => undefined)}
          className="w-full text-left text-[11px] text-ios-orange hover:underline"
        >
          Your claude.ai session expired. Reconnect to refresh numbers →
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
  // always ensure the `unified-7d_sonnet` row is present — Anthropic omits it
  // from response headers until the user actually consumes Sonnet, but the user
  // has asked to see the 0% state rather than have the row silently disappear.
  //
  // Signal priority:
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
  if (hasSonnetQuota && !synthesized.some((w) => w.name === 'unified-7d_sonnet')) {
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

      {!busy && displayWindows.length === 0 && !error && (
        <div className="glass-card px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-black dark:text-white">No data yet</p>
          <p className="text-[11px] text-[#8E8E93] mt-1 leading-relaxed">
            Rate limit data appears after your first API call through Sentinel.
          </p>
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

/**
 * Round-robin mode pool view.
 *
 * When the proxy rotates tokens per-request, the "active account" concept
 * loses meaning for Usage — every request's response headers belong to a
 * different account, so the single-account view thrashes. Instead we render:
 *   1. A "Pool 5h" average meter across every known account
 *   2. A list of every account with its own 5h bar
 *
 * Data flows through useAllRateLimits (which listens to rate_limits_updated /
 * account_switched / login_complete broadcasts) and useAccounts (for labels).
 * We never call `get_rate_limits` here — that endpoint is scoped to the
 * single active account and would be stale for everything else in the pool.
 */
function RoundRobinUsageView({ accounts }: { accounts: AccountInfo[] }): React.ReactElement {
  const { byAccount, refetch } = useAllRateLimits();
  const { settings } = useSettings();
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
  // Excluded accounts are sitting out of rotation, so they shouldn't
  // contribute to the pool average — the meter should reflect what's
  // actually rotating. Per-account rows still render them (dimmed) so
  // the user can still see their usage.
  const excludedIds = new Set(settings?.poolExcludedIds ?? []);

  const rows = accounts.map((acct) => ({
    account: acct,
    util: fiveHourUtilization(byAccount[acct.id]),
    resetAt: fiveHourResetAt(byAccount[acct.id]),
    inPool: !excludedIds.has(acct.id),
  }));

  const poolRows = rows.filter((r) => r.inPool);
  const knownUtils = poolRows.map((r) => r.util).filter((u): u is number => u != null);
  const poolPct =
    knownUtils.length === 0
      ? null
      : Math.min(
          100,
          Math.round((knownUtils.reduce((a, b) => a + b, 0) / knownUtils.length) * 100),
        );

  const poolColor =
    poolPct == null
      ? 'bg-[#8E8E93]'
      : poolPct >= 90
        ? 'bg-ios-red'
        : poolPct >= 70
          ? 'bg-ios-orange'
          : /* default */ 'bg-ios-blue';
  const poolPctColor =
    poolPct == null
      ? 'text-[#8E8E93]'
      : poolPct >= 90
        ? 'text-ios-red'
        : poolPct >= 70
          ? 'text-ios-orange'
          : /* default */ 'text-ios-blue';

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

      {/* Pool meter */}
      <div className="glass-card px-4 py-4 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-semibold text-black dark:text-white">Pool 5h</span>
          <div className="flex items-center gap-2 shrink-0">
            {poolPct != null && (
              <span className={`text-[11px] font-bold tabular-nums ${poolPctColor}`}>
                {poolPct}% avg
              </span>
            )}
            <span className="text-[10px] text-[#8E8E93]">
              {knownUtils.length} of {poolRows.length}
            </span>
          </div>
        </div>
        {poolPct != null && poolPct > 0 && (
          <div className="h-[6px] rounded-full bg-black/[0.08] dark:bg-white/[0.10] overflow-hidden">
            <motion.div
              className={`h-full rounded-full ${poolColor}`}
              initial={{ width: 0 }}
              animate={{ width: `${poolPct}%` }}
              transition={{ duration: DUR.bar, ease: EASE_OUT }}
            />
          </div>
        )}
        <p className="text-[10px] text-[#8E8E93] leading-snug">
          Average 5-hour utilization across every account in the round-robin pool. Accounts with no
          data yet are excluded from the average.
        </p>
      </div>

      {/* Per-account rows */}
      {accounts.length === 0 ? (
        <div className="glass-card px-4 py-10 text-center">
          <p className="text-[12px] text-[#8E8E93]">No accounts configured.</p>
        </div>
      ) : (
        <div className="glass-card px-4 py-4 space-y-4">
          {rows.map(({ account, util, resetAt, inPool }) => {
            const pct =
              util == null
                ? null
                : util <= 0
                  ? 0
                  : util >= 1
                    ? 100
                    : Math.min(100, Math.round(util * 100));
            const barColor =
              pct == null
                ? 'bg-[#8E8E93]'
                : pct >= 90
                  ? 'bg-ios-red'
                  : pct >= 70
                    ? 'bg-ios-orange'
                    : /* default */ 'bg-ios-blue';
            const pctColor =
              pct == null
                ? 'text-[#8E8E93]'
                : pct >= 90
                  ? 'text-ios-red'
                  : pct >= 70
                    ? 'text-ios-orange'
                    : /* default */ 'text-ios-blue';
            const label = account.displayName || account.email;
            const sub = account.orgName || (account.displayName ? account.email : null);
            const hasReset = resetAt != null && resetAt > 0;
            return (
              <div key={account.id} className={`space-y-1.5 ${inPool ? '' : 'opacity-50'}`}>
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
                    {sub && (
                      <p className="text-[10px] text-[#8E8E93] truncate leading-snug">{sub}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {hasReset && <ResetCountdown epochSec={resetAt} variant="pill" />}
                    <span className={`text-[11px] font-bold tabular-nums ${pctColor}`}>
                      {pct == null ? '–' : `${pct}%`}
                    </span>
                  </div>
                </div>
                {pct != null && pct > 0 && (
                  <div className="h-[6px] rounded-full bg-black/[0.08] dark:bg-white/[0.10] overflow-hidden">
                    <motion.div
                      className={`h-full rounded-full ${barColor}`}
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: DUR.bar, ease: EASE_OUT }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
