import { useState, useEffect, useCallback } from 'react';
import type { MetricsSummary } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

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
 * edit accept rate, skills, plugins) for a given account over the selected
 * window. One `get_metrics_summary` IPC per period or scope change.
 *
 * @param viewAccountId Account key to query. Pass undefined to fall back to
 *        the daemon's active account (legacy behavior).
 *
 * A re-fetch fires on:
 *   - mount
 *   - days selector change
 *   - viewAccountId change (per-tab picker)
 *   - account_switched broadcast from the daemon (only when the hook is
 *     following the active account — when an explicit id is set we ignore
 *     the broadcast because the user pinned a specific scope)
 *   - metrics_updated broadcast from the daemon (fires once per OTEL batch
 *     that wrote telemetry rows) so dashboards update live
 */
export function useMetricsSummary(viewAccountId?: string): UseMetricsSummaryResult {
  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await sendToSentinel<MetricsSummary>(
        viewAccountId
          ? { type: 'get_metrics_summary', days, accountId: viewAccountId }
          : { type: 'get_metrics_summary', days },
      );
      if (res.success) {
        setSummary(res.data ?? null);
      } else {
        setError(res.error ?? 'Failed to fetch metrics');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch metrics');
    } finally {
      setLoading(false);
    }
  }, [days, viewAccountId]);

  useEffect(() => { void fetchSummary(); }, [fetchSummary]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      // `account_switched` only matters when this hook is following the
      // active account — a pinned view shouldn't move underneath the user.
      if (msg.type === 'account_switched' && !viewAccountId) void fetchSummary();
      // `metrics_updated` fires once per OTEL batch that wrote rows. Refetch
      // regardless of pin state — even a pinned view wants fresh data when
      // the currently active account's telemetry just landed.
      if (msg.type === 'metrics_updated') void fetchSummary();
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => { unlisten?.(); };
  }, [fetchSummary, viewAccountId]);

  return { summary, loading, error, days, setDays, refetch: fetchSummary };
}
