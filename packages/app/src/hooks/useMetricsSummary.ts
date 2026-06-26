import { useState, useEffect, useCallback } from 'react';
import type { MetricsSummary, OptimizeRangePreset } from '@sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';
import { windowForRange } from '../lib/dateRange.js';

/** Describes which accounts a metrics rollup should cover.
 *  - `active`: follow whatever Claude Code currently has bound
 *  - `account`: pin to a specific enrolled account
 *  - `pool`: aggregate across the Auto-switching pool (enrolled minus exclusions)
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
  refetch: () => Promise<void>;
}

/**
 * Fetch the full Metrics tab rollup (cost, tokens, errors, tools, activity,
 * edit accept rate, skills, plugins) for a given scope over the selected
 * range. One `get_metrics_summary` IPC per range or scope change.
 *
 * @param scope Which accounts to roll up. Undefined defaults to the
 *        active-account fallback (legacy behavior).
 * @param range Shared range preset (the same selector the Optimize page
 *        uses). Resolved to an absolute window at FETCH time so a dashboard
 *        left open overnight doesn't pin '1D' to the previous midnight.
 * @param customStart `YYYY-MM-DD` start when `range === 'custom'`.
 * @param customEnd `YYYY-MM-DD` end (inclusive) when `range === 'custom'`.
 *
 * A re-fetch fires on:
 *   - mount
 *   - range / custom date change
 *   - scope change
 *   - account_switched broadcast (only when scope is 'active' — a pinned
 *     or pooled view shouldn't move underneath the user)
 *   - metrics_updated broadcast (fires once per OTEL batch that wrote
 *     telemetry rows) so dashboards update live
 */
export function useMetricsSummary(
  scope: MetricsScope | undefined,
  range: OptimizeRangePreset,
  customStart: string,
  customEnd: string,
): UseMetricsSummaryResult {
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
      // Resolve the preset to absolute bounds NOW (see the range param doc).
      const window = windowForRange(range, customStart, customEnd);
      const payload =
        scope && scope.kind === 'pool'
          ? {
              type: 'get_metrics_summary' as const,
              days: 0,
              window,
              accountIds: scope.accountIds,
              scopeKind: 'pool' as const,
              scopeLabel: scope.label,
            }
          : scope && scope.kind === 'all'
            ? {
                type: 'get_metrics_summary' as const,
                days: 0,
                window,
                accountIds: scope.accountIds,
                scopeKind: 'all' as const,
                scopeLabel: scope.label,
              }
            : scope && scope.kind === 'account'
              ? { type: 'get_metrics_summary' as const, days: 0, window, accountId: scope.id }
              : { type: 'get_metrics_summary' as const, days: 0, window };
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
  }, [range, customStart, customEnd, scopeKey]);

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

  return { summary, loading, error, refetch: fetchSummary };
}
