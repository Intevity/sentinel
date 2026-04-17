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
 * edit accept rate, skills, plugins) for the active account over the selected
 * window. One `get_metrics_summary` IPC per period change / account switch.
 *
 * Replaces the older useUsage hook. A re-fetch fires on:
 *   - mount
 *   - days selector change
 *   - account_switched broadcast from the daemon
 */
export function useMetricsSummary(): UseMetricsSummaryResult {
  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState<MetricsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await sendToSentinel<MetricsSummary>({ type: 'get_metrics_summary', days });
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
  }, [days]);

  useEffect(() => { void fetchSummary(); }, [fetchSummary]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'account_switched') void fetchSummary();
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => { unlisten?.(); };
  }, [fetchSummary]);

  return { summary, loading, error, days, setDays, refetch: fetchSummary };
}
