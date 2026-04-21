import { useState, useEffect } from 'react';
import type { OverageCreditGrant } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UseOverageGrantsResult {
  grants: Record<string, OverageCreditGrant>;
  loading: boolean;
  /** Force a re-read from `~/.claude.json`. Useful if the user has taken an
   *  action that may have updated the cache outside Sentinel's normal
   *  reload triggers (switch / probe / OTEL). */
  refresh: () => Promise<void>;
}

/**
 * Live view of the daemon's mirror of `~/.claude.json:overageCreditGrantCache`.
 * Keyed by Anthropic accountUuid — consumers that hold a Sentinel id must
 * map via AccountInfo.accountUuid.
 *
 * Fetches once on mount, then updates whenever the daemon broadcasts
 * `overage_grants_updated` (after startup, after a switch, after a probe
 * cycle, or after an explicit refresh_overage_grants request).
 */
export function useOverageGrants(): UseOverageGrantsResult {
  const [grants, setGrants] = useState<Record<string, OverageCreditGrant>>({});
  const [loading, setLoading] = useState(true);

  const fetchOnce = async (): Promise<void> => {
    try {
      const res = await sendToSentinel<Record<string, OverageCreditGrant>>({
        type: 'get_overage_grants',
      });
      if (res.success && res.data) setGrants(res.data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (cancelled) return;
      await fetchOnce();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'overage_grants_updated') setGrants(msg.grants);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, []);

  const refresh = async (): Promise<void> => {
    await sendToSentinel({ type: 'refresh_overage_grants' });
    // The daemon broadcasts overage_grants_updated as a side-effect; our
    // subscription above will pick it up. No need to set state manually.
  };

  return { grants, loading, refresh };
}
