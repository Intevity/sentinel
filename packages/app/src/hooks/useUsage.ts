import { useState, useEffect, useCallback } from 'react';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface DailyModelUsage {
  costUsd: number;
  tokens: number;
}

interface UsageData {
  days: number;
  accountEmail?: string;
  byDayModel: Record<string, Record<string, DailyModelUsage>>;
}

interface UseUsageResult {
  usage: UsageData | null;
  loading: boolean;
  error: string | null;
  setDays: (days: number) => void;
}

export function useUsage(accountEmail?: string): UseUsageResult {
  const [days, setDays] = useState(7);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await sendToSentinel<UsageData>({
        type: 'get_usage_summary',
        days,
      });
      setUsage(res.data ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch usage');
    } finally {
      setLoading(false);
    }
  }, [days, accountEmail]);

  useEffect(() => {
    void fetchUsage();
  }, [fetchUsage]);

  // Re-fetch whenever the active account changes.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'account_switched') void fetchUsage();
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => { unlisten?.(); };
  }, [fetchUsage]);

  return { usage, loading, error, setDays };
}
