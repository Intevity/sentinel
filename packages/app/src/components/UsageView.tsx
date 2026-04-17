import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { sendToSentinel } from '../lib/ipc.js';
import type { RateLimitWindow, OAuthAccount, AccountInfo } from '@claude-sentinel/shared';
import { useSettings } from '../hooks/useSettings.js';
import { useAllRateLimits, fiveHourUtilization } from '../hooks/useAllRateLimits.js';

// Human-readable labels for known rate-limit window names
const WINDOW_META: Record<string, { label: string; order: number }> = {
  'unified-5h':        { label: '5-Hour Window',        order: 0 },
  'unified-7d':        { label: 'Weekly — All Models',  order: 1 },
  'unified-7d_sonnet': { label: 'Weekly — Sonnet',      order: 2 },
  'unified-overage':   { label: 'Overage Budget',       order: 3 },
};

// Windows that carry no useful display data (metadata / redundant)
const HIDDEN_WINDOWS = new Set(['unified', 'unified-status']);

function windowLabel(name: string): string {
  return WINDOW_META[name]?.label ??
    name.split(/[-_]/).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ');
}

function windowOrder(name: string): number {
  return WINDOW_META[name]?.order ?? 99;
}

/** Unix seconds → "resets in Xh Ym" or "resets in Xd Yh" */
function formatReset(reset: number | null): string {
  if (reset == null) return '';
  const diff = reset * 1000 - Date.now();
  if (diff <= 0) return 'resets soon';
  const totalMins = Math.floor(diff / 60_000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h >= 24) return `resets in ${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
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
  const resetStr = formatReset(w.reset);

  const barColor =
    blocked         ? 'bg-ios-red'    :
    pct == null     ? 'bg-[#8E8E93]'  :
    pct >= 90       ? 'bg-ios-red'    :
    pct >= 70       ? 'bg-ios-orange' :
    /* default */     'bg-ios-blue';

  const pctColor =
    blocked         ? 'text-ios-red'   :
    pct == null     ? 'text-[#8E8E93]' :
    pct >= 90       ? 'text-ios-red'   :
    pct >= 70       ? 'text-ios-orange':
    /* default */     'text-ios-blue';

  return (
    <div className="space-y-1.5">
      {/* Label row */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-semibold text-black dark:text-white">
          {windowLabel(w.name)}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {blocked && (
            <span className="text-[10px] font-semibold text-ios-red bg-ios-red/10 px-1.5 py-0.5 rounded-full">
              Blocked
            </span>
          )}
          {pct != null && (
            <span className={`text-[11px] font-bold tabular-nums ${pctColor}`}>{pct}%</span>
          )}
          {resetStr && (
            <span className="text-[10px] text-[#8E8E93]">{resetStr}</span>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-[6px] rounded-full bg-black/[0.08] dark:bg-white/[0.10] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${blocked ? 100 : (pct ?? 0)}%` }}
        />
      </div>

      {/* Detail line: API-key plans show counts; subscription plans show utilization fraction */}
      {w.limit != null && w.remaining != null ? (
        <p className="text-[10px] text-[#8E8E93] tabular-nums">
          {(w.limit - w.remaining).toLocaleString()} used ·{' '}
          {w.remaining.toLocaleString()} remaining ·{' '}
          {w.limit.toLocaleString()} limit
        </p>
      ) : w.utilization != null ? (
        <p className="text-[10px] text-[#8E8E93]">
          {(w.utilization * 100).toFixed(1)}% of quota consumed
        </p>
      ) : null}
    </div>
  );
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
}

export default function UsageView(props: UsageViewProps): React.ReactElement {
  const { settings } = useSettings();
  // In round-robin mode, per-request token rotation means the "active account"
  // stream of headers churns rapidly — showing one account's Usage is noisy
  // and misleading. Render a pool view instead (aggregate + per-account rows).
  if (settings?.switchingMode === 'round-robin') {
    return <RoundRobinUsageView accounts={props.accounts} />;
  }
  return <SingleAccountUsageView {...props} />;
}

function SingleAccountUsageView({ rateLimitsVersion, isProbing, activeAccount }: UsageViewProps): React.ReactElement {
  const [windows, setWindows] = useState<RateLimitWindow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const busy = loading || Boolean(isProbing);

  const fetchRateLimits = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await sendToSentinel<RateLimitWindow[]>({ type: 'get_rate_limits' });
      setWindows(res.data ?? []);
      setLastUpdated(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rate limits');
    } finally {
      setLoading(false);
    }
  }, []);

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
  const billing = activeAccount?.billingType;
  const hasSonnetQuota =
    weekly != null ||
    activeAccount?.hasExtraUsageEnabled === true ||
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
        <span className="section-label">Usage</span>
        <div className="flex items-center gap-2">
          {isProbing && (
            <span className="text-[10px] text-ios-blue font-medium">Refreshing…</span>
          )}
          <button
            onClick={() => void fetchRateLimits()}
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
          <RefreshCw size={16} strokeWidth={2.5} className="animate-spin text-ios-blue mx-auto mb-2" />
          <p className="text-[12px] text-[#8E8E93]">Fetching rate limits…</p>
        </div>
      )}

      {displayWindows.length > 0 && (
        <div className="glass-card px-4 py-4 space-y-5">
          {displayWindows.map((w) => (
            <ProgressRow key={w.name} window={w} />
          ))}
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

  const rows = accounts.map((acct) => ({
    account: acct,
    util: fiveHourUtilization(byAccount[acct.id]),
  }));

  const knownUtils = rows.map((r) => r.util).filter((u): u is number => u != null);
  const poolPct = knownUtils.length === 0
    ? null
    : Math.min(100, Math.round((knownUtils.reduce((a, b) => a + b, 0) / knownUtils.length) * 100));

  const poolColor =
    poolPct == null   ? 'bg-[#8E8E93]'  :
    poolPct >= 90     ? 'bg-ios-red'    :
    poolPct >= 70     ? 'bg-ios-orange' :
    /* default */       'bg-ios-blue';
  const poolPctColor =
    poolPct == null   ? 'text-[#8E8E93]' :
    poolPct >= 90     ? 'text-ios-red'   :
    poolPct >= 70     ? 'text-ios-orange':
    /* default */       'text-ios-blue';

  return (
    <div className="space-y-3 pt-1">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="section-label">Usage</span>
          <span className="text-[9px] font-semibold text-ios-blue bg-ios-blue/10 px-1.5 py-0.5 rounded-full uppercase tracking-wider">
            Round-robin
          </span>
        </div>
        <button
          onClick={() => void refetch()}
          className="text-[#8E8E93] hover:text-ios-blue transition-colors active:scale-90"
          title="Refresh"
        >
          <RefreshCw size={13} strokeWidth={2.5} />
        </button>
      </div>

      {/* Pool meter */}
      <div className="glass-card px-4 py-4 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-semibold text-black dark:text-white">
            Pool 5h
          </span>
          <div className="flex items-center gap-2 shrink-0">
            {poolPct != null && (
              <span className={`text-[11px] font-bold tabular-nums ${poolPctColor}`}>{poolPct}% avg</span>
            )}
            <span className="text-[10px] text-[#8E8E93]">
              {knownUtils.length} of {accounts.length}
            </span>
          </div>
        </div>
        <div className="h-[6px] rounded-full bg-black/[0.08] dark:bg-white/[0.10] overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${poolColor}`}
            style={{ width: `${poolPct ?? 0}%` }}
          />
        </div>
        <p className="text-[10px] text-[#8E8E93] leading-snug">
          Average 5-hour utilization across every account in the round-robin pool.
          Accounts with no data yet are excluded from the average.
        </p>
      </div>

      {/* Per-account rows */}
      {accounts.length === 0 ? (
        <div className="glass-card px-4 py-10 text-center">
          <p className="text-[12px] text-[#8E8E93]">No accounts configured.</p>
        </div>
      ) : (
        <div className="glass-card px-4 py-4 space-y-4">
          {rows.map(({ account, util }) => {
            const pct = util == null
              ? null
              : util <= 0 ? 0
              : util >= 1 ? 100
              : Math.min(100, Math.round(util * 100));
            const barColor =
              pct == null ? 'bg-[#8E8E93]'  :
              pct >= 90   ? 'bg-ios-red'    :
              pct >= 70   ? 'bg-ios-orange' :
              /* default */ 'bg-ios-blue';
            const pctColor =
              pct == null ? 'text-[#8E8E93]' :
              pct >= 90   ? 'text-ios-red'   :
              pct >= 70   ? 'text-ios-orange':
              /* default */ 'text-ios-blue';
            const label = account.displayName || account.email;
            const sub = account.orgName || (account.displayName ? account.email : null);
            return (
              <div key={account.id} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-semibold text-black dark:text-white truncate leading-snug">
                      {label}
                    </p>
                    {sub && (
                      <p className="text-[10px] text-[#8E8E93] truncate leading-snug">{sub}</p>
                    )}
                  </div>
                  <span className={`text-[11px] font-bold tabular-nums shrink-0 ${pctColor}`}>
                    {pct == null ? '—' : `${pct}%`}
                  </span>
                </div>
                <div className="h-[6px] rounded-full bg-black/[0.08] dark:bg-white/[0.10] overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${barColor}`}
                    style={{ width: `${pct ?? 0}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
