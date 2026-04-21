import { useCallback, useEffect, useState } from 'react';
import type { SecurityEvent } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UseSecurityEventsParams {
  accountId?: string;
  includeWeakSignals?: boolean;
  limit?: number;
}

interface UseSecurityEventsResult {
  events: SecurityEvent[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  acknowledge: (id: number) => Promise<void>;
  acknowledgeAll: () => Promise<void>;
  clearAll: () => Promise<void>;
  /** Permanently suppress all future findings with the same match_hash +
   *  detector_id, and drop any existing events matching that identity. */
  addToAllowlist: (eventId: number, note?: string) => Promise<void>;
}

export function useSecurityEvents(params: UseSecurityEventsParams = {}): UseSecurityEventsResult {
  const { accountId, includeWeakSignals = false, limit = 200 } = params;
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await sendToSentinel<SecurityEvent[]>({
        type: 'get_security_events',
        ...(accountId !== undefined ? { accountId } : {}),
        includeWeakSignals,
        limit,
      });
      if (res.success) {
        setEvents(res.data ?? []);
        setError(null);
      } else {
        setError(res.error ?? 'Failed to load security events');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [accountId, includeWeakSignals, limit]);

  const acknowledge = useCallback(
    async (id: number) => {
      await sendToSentinel({ type: 'acknowledge_security_event', id });
      await refetch();
    },
    [refetch],
  );

  const acknowledgeAll = useCallback(async () => {
    await sendToSentinel(
      accountId !== undefined
        ? { type: 'acknowledge_all_security_events', accountId }
        : { type: 'acknowledge_all_security_events' },
    );
    await refetch();
  }, [accountId, refetch]);

  const clearAll = useCallback(async () => {
    await sendToSentinel(
      accountId !== undefined
        ? { type: 'clear_security_events', accountId }
        : { type: 'clear_security_events' },
    );
    await refetch();
  }, [accountId, refetch]);

  const addToAllowlist = useCallback(
    async (eventId: number, note?: string) => {
      await sendToSentinel(
        note !== undefined
          ? { type: 'add_to_security_allowlist', eventId, note }
          : { type: 'add_to_security_allowlist', eventId },
      );
      await refetch();
    },
    [refetch],
  );

  useEffect(() => {
    void refetch();
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'security_event_detected') {
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

  return { events, loading, error, refetch, acknowledge, acknowledgeAll, clearAll, addToAllowlist };
}
