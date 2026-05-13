import { useCallback, useEffect, useState } from 'react';
import type { DetectorStatsRow } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UseDetectorStatsResult {
  rows: DetectorStatsRow[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

/**
 * Load per-detector activity counts + current override tier for the
 * Settings > Security > Detectors tuning UI. Refetches on
 * `settings_changed` (the override field is derived from settings) and on
 * `security_event_detected` (counts may have moved).
 */
export function useDetectorStats(): UseDetectorStatsResult {
  const [rows, setRows] = useState<DetectorStatsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await sendToSentinel<DetectorStatsRow[]>({ type: 'get_detector_stats' });
      if (res.success) {
        setRows(res.data ?? []);
        setError(null);
      } else {
        setError(res.error ?? 'Failed to load detector stats');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      // Two refresh triggers: a setting change can flip an override, and
      // a new finding can change the aggregate counts. Both cheap; the
      // SQL aggregate is small.
      if (msg.type === 'settings_changed' || msg.type === 'security_event_detected') {
        void refetch();
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [refetch]);

  return { rows, loading, error, refetch };
}
