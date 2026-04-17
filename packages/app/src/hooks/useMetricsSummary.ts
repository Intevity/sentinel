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
    if (viewAccountId) return; // pinned — don't auto-follow the active account
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'account_switched') void fetchSummary();
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => { unlisten?.(); };
  }, [fetchSummary, viewAccountId]);

  return { summary, loading, error, days, setDays, refetch: fetchSummary };
}
