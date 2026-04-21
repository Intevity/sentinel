import { useCallback, useEffect, useState } from 'react';
import type { SecurityAllowlistEntry } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UseSecurityAllowlistResult {
  entries: SecurityAllowlistEntry[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  remove: (id: number) => Promise<void>;
}

/**
 * Pull the user's allowlist from the daemon and keep it in sync with
 * security broadcasts (adding an entry via "Always allow" on a Security
 * row deletes the matching events, which fires `security_event_detected`
 * via the scanner's normal path; we re-fetch on any such broadcast to
 * catch newly-added entries too).
 */
export function useSecurityAllowlist(): UseSecurityAllowlistResult {
  const [entries, setEntries] = useState<SecurityAllowlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await sendToSentinel<SecurityAllowlistEntry[]>({
        type: 'get_security_allowlist',
      });
      if (res.success) {
        setEntries(res.data ?? []);
        setError(null);
      } else {
        setError(res.error ?? 'Failed to load allowlist');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const remove = useCallback(
    async (id: number) => {
      await sendToSentinel({ type: 'remove_from_security_allowlist', id });
      await refetch();
    },
    [refetch],
  );

  useEffect(() => {
    void refetch();
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'security_event_detected' || msg.type === 'security_allowlist_updated') {
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

  return { entries, loading, error, refetch, remove };
}
