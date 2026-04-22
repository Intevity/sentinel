import { useState, useEffect, useCallback } from 'react';
import type { MetricsSummary } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

/** Describes which accounts a metrics rollup should cover.
 *  - `active`: follow whatever Claude Code currently has bound
 *  - `account`: pin to a specific enrolled account
 *  - `pool`: aggregate across the round-robin pool (enrolled minus exclusions)
 *  - `all`: aggregate across every enrolled account, ignoring exclusions
 *
 *  Pool membership is computed at the call site (App.tsx) and passed in as
 *  `accountIds` so the daemon never has to know what "pool" means. */
export type MetricsScope =
  | { kind: 'active' }
  | { kind: 'account'; id: string }
  | { kind: 'pool'; label: string; accountIds: string[] }
  | { kind: 'all'; label: string; accountIds: string[] };

interface UseMetricsSummaryResult {
  summary: MetricsSummary | null;
  loading: boolean;
  error: string | null;
  days: number;
  setDays: (days: number) => void;
  refetch: () => Promise<void>;
}

/**
 * Fetch the full Metrics tab rollup (cost, tokens, errors, tools, activity,
 * edit accept rate, skills, plugins) for a given scope over the selected
 * window. One `get_metrics_summary` IPC per period or scope change.
 *
 * @param scope Which accounts to roll up. Undefined defaults to the
 *        active-account fallback (legacy behavior).
 *
 * A re-fetch fires on:
 *   - mount
 *   - days selector change
 *   - scope change
 *   - account_switched broadcast (only when scope is 'active' — a pinned
 *     or pooled view shouldn't move underneath the user)
 *   - metrics_updated broadcast (fires once per OTEL batch that wrote
 *     telemetry rows) so dashboards update live
 */
export function useMetricsSummary(scope?: MetricsScope): UseMetricsSummaryResult {
  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stringify the scope for dependency tracking — React's identity-based
  // useEffect would otherwise refetch on every parent render.
  const scopeKey = scope ? JSON.stringify(scope) : '';

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload =
        scope && scope.kind === 'pool'
          ? {
              type: 'get_metrics_summary' as const,
              days,
              accountIds: scope.accountIds,
              scopeKind: 'pool' as const,
              scopeLabel: scope.label,
            }
          : scope && scope.kind === 'all'
            ? {
                type: 'get_metrics_summary' as const,
                days,
                accountIds: scope.accountIds,
                scopeKind: 'all' as const,
                scopeLabel: scope.label,
              }
            : scope && scope.kind === 'account'
              ? { type: 'get_metrics_summary' as const, days, accountId: scope.id }
              : { type: 'get_metrics_summary' as const, days };
      const res = await sendToSentinel<MetricsSummary>(payload);
      if (res.success) {
        setSummary(res.data ?? null);
      } else {
        setError(res.error ?? 'Failed to fetch metrics');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch metrics');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, scopeKey]);

  useEffect(() => {
    void fetchSummary().finally(() => setLoading(false));
  }, [fetchSummary]);

  const isActiveScope = !scope || scope.kind === 'active';
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      // `account_switched` only matters when following the active account.
      // Pinned account / pool / all views shouldn't move under the user.
      if (msg.type === 'account_switched' && isActiveScope) void fetchSummary();
      // `metrics_updated` fires once per OTEL batch that wrote rows. Refetch
      // regardless of pin state — pooled views also want live updates when
      // one of their members' telemetry just landed.
      if (msg.type === 'metrics_updated') void fetchSummary();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [fetchSummary, isActiveScope]);

  return { summary, loading, error, days, setDays, refetch: fetchSummary };
}
