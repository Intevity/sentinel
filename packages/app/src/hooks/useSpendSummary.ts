import { useState, useEffect } from 'react';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

export interface SpendSummary {
  /** Null means "no Anthropic-side data yet" (sessionKey missing or fetch
   *  pending). UI must distinguish from `0` = known zero spend. */
  perAccount: Record<string, number | null>;
  global: number;
}

interface UseSpendSummaryResult {
  summary: SpendSummary;
  loading: boolean;
}

/**
 * Live view of the daemon's rolling 7-day spend summary. Fetches once on
 * mount, then updates whenever the daemon broadcasts `spend_update` (which
 * happens after every OTEL batch that carried fresh `cost_usd` rows).
 *
 * Returns a fully-populated object (empty perAccount + global=0) on startup
 * so consumers can render unconditionally.
 */
export function useSpendSummary(): UseSpendSummaryResult {
  const [summary, setSummary] = useState<SpendSummary>({ perAccount: {}, global: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await sendToSentinel<SpendSummary>({ type: 'get_spend_summary' });
        if (!cancelled && res.success && res.data) setSummary(res.data);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'spend_update') {
        setSummary({ perAccount: msg.perAccount, global: msg.global });
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, []);

  return { summary, loading };
}
