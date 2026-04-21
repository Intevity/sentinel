import { useCallback, useEffect, useState } from 'react';
import type { PermissionBypassEntry } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UsePermissionBypassesResult {
  entries: PermissionBypassEntry[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  remove: (id: number) => Promise<void>;
}

/**
 * Load the per-rule input bypass list and stay in sync with
 * `permission_bypasses_updated` broadcasts. Parallel to
 * `useSecurityAllowlist` but for the new permissions bypass table —
 * rows come from the banner's "Always allow this exact input"
 * checkbox and can be removed from Settings.
 */
export function usePermissionBypasses(): UsePermissionBypassesResult {
  const [entries, setEntries] = useState<PermissionBypassEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await sendToSentinel<PermissionBypassEntry[]>({
        type: 'get_permission_bypasses',
      });
      if (res.success) {
        setEntries(res.data ?? []);
        setError(null);
      } else {
        setError(res.error ?? 'Failed to load permission bypasses');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const remove = useCallback(
    async (id: number) => {
      await sendToSentinel({ type: 'remove_permission_bypass', id });
      await refetch();
    },
    [refetch],
  );

  useEffect(() => {
    void refetch();
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'permission_bypasses_updated') {
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
