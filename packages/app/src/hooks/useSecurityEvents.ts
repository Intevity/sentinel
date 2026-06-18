import { useCallback, useEffect, useRef, useState } from 'react';
import type { SecurityEvent, SecurityKind, SecuritySeverity } from '@sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

const DEFAULT_PAGE_SIZE = 50;

interface UseSecurityEventsParams {
  accountId?: string;
  includeWeakSignals?: boolean;
  /** Server-side severity filter. Omit to fetch all severities. */
  severity?: SecuritySeverity;
  /** Server-side kind filter. Omit to fetch all kinds (subject to the
   *  telemetry exclude derived from `includeWeakSignals`). */
  kinds?: SecurityKind[];
  /** Server-side substring search across title / reason / matchMask /
   *  sourceHint. Should already be debounced by the caller — this hook
   *  refetches on every change to this string. */
  search?: string;
  /** Page size for the initial fetch and each `loadMore()`. Default 50. */
  pageSize?: number;
}

interface UseSecurityEventsResult {
  events: SecurityEvent[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  loadMore: () => Promise<void>;
  acknowledge: (id: number) => Promise<void>;
  acknowledgeAll: () => Promise<void>;
  clearAll: () => Promise<void>;
  /** Permanently suppress all future findings with the same match_hash +
   *  detector_id, and drop any existing events matching that identity. */
  addToAllowlist: (eventId: number, note?: string) => Promise<void>;
}

export function useSecurityEvents(params: UseSecurityEventsParams = {}): UseSecurityEventsResult {
  const {
    accountId,
    includeWeakSignals = false,
    severity,
    search,
    pageSize = DEFAULT_PAGE_SIZE,
  } = params;
  // `kinds` is destructured separately so the JSON-stringify dependency
  // key below picks up array-content changes without forcing the caller
  // to memoize the array reference.
  const kinds = params.kinds;
  const kindsKey = kinds ? JSON.stringify(kinds) : '';

  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Captures the filter snapshot in effect so async fetch responses
  // arriving after a filter change can be discarded. Without this guard
  // a slow first-page fetch would clobber the next filter's results.
  const fetchTokenRef = useRef(0);

  const buildBaseRequest = useCallback((): {
    type: 'get_security_events';
    accountId?: string;
    includeWeakSignals: boolean;
    limit: number;
    severity?: SecuritySeverity;
    kinds?: SecurityKind[];
    search?: string;
  } => {
    const req: ReturnType<typeof buildBaseRequest> = {
      type: 'get_security_events',
      includeWeakSignals,
      limit: pageSize,
    };
    if (accountId !== undefined) req.accountId = accountId;
    if (severity !== undefined) req.severity = severity;
    if (kinds !== undefined && kinds.length > 0) req.kinds = kinds;
    if (search !== undefined && search.trim() !== '') req.search = search;
    return req;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, includeWeakSignals, severity, kindsKey, search, pageSize]);

  const refetch = useCallback(async () => {
    const token = ++fetchTokenRef.current;
    setLoading(true);
    try {
      const res = await sendToSentinel<SecurityEvent[]>(buildBaseRequest());
      if (token !== fetchTokenRef.current) return;
      if (res.success) {
        const data = res.data ?? [];
        setEvents(data);
        setHasMore(data.length >= pageSize);
        setError(null);
      } else {
        setError(res.error ?? 'Failed to load security events');
      }
    } catch (e) {
      if (token !== fetchTokenRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (token === fetchTokenRef.current) setLoading(false);
    }
  }, [buildBaseRequest, pageSize]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    const oldest = events[events.length - 1];
    if (!oldest) return;
    const token = fetchTokenRef.current;
    setLoadingMore(true);
    try {
      const res = await sendToSentinel<SecurityEvent[]>({
        ...buildBaseRequest(),
        beforeTs: oldest.ts,
      });
      if (token !== fetchTokenRef.current) return;
      if (res.success) {
        const page = res.data ?? [];
        // Dedup by id in case a row landed at exactly the cursor boundary.
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          return [...prev, ...page.filter((e) => !seen.has(e.id))];
        });
        setHasMore(page.length >= pageSize);
      }
    } finally {
      if (token === fetchTokenRef.current) setLoadingMore(false);
    }
  }, [buildBaseRequest, events, hasMore, loadingMore, pageSize]);

  /** HEAD-refresh: pull the newest pageSize rows for the current filter
   *  set and merge them in front of `events`, preserving any older
   *  pages the user has already loaded. Used on `security_event_detected`
   *  broadcasts so live events appear without disturbing scroll. */
  const refreshHead = useCallback(async () => {
    const token = fetchTokenRef.current;
    try {
      const res = await sendToSentinel<SecurityEvent[]>(buildBaseRequest());
      if (token !== fetchTokenRef.current) return;
      if (res.success) {
        const head = res.data ?? [];
        setEvents((prev) => {
          if (prev.length === 0) {
            return head;
          }
          const seen = new Set(prev.map((e) => e.id));
          const fresh = head.filter((e) => !seen.has(e.id));
          if (fresh.length === 0) return prev;
          return [...fresh, ...prev];
        });
      }
    } catch {
      /* silent — broadcast-driven refresh; user can retry via UI action */
    }
  }, [buildBaseRequest]);

  const acknowledge = useCallback(async (id: number) => {
    await sendToSentinel({ type: 'acknowledge_security_event', id });
    setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, acknowledged: true } : e)));
  }, []);

  const acknowledgeAll = useCallback(async () => {
    await sendToSentinel(
      accountId !== undefined
        ? { type: 'acknowledge_all_security_events', accountId }
        : { type: 'acknowledge_all_security_events' },
    );
    setEvents((prev) => prev.map((e) => ({ ...e, acknowledged: true })));
  }, [accountId]);

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
        void refreshHead();
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [refetch, refreshHead]);

  return {
    events,
    loading,
    loadingMore,
    hasMore,
    error,
    refetch,
    loadMore,
    acknowledge,
    acknowledgeAll,
    clearAll,
    addToAllowlist,
  };
}
