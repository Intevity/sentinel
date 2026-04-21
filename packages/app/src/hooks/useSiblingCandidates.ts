import { useCallback, useEffect, useState } from 'react';
import type { SiblingCandidates } from '@claude-sentinel/shared';
import { onDaemonMessage, sendToSentinel } from '../lib/ipc.js';

interface UseSiblingCandidatesResult {
  /** Per-email list of chat-capable orgs the user hasn't enrolled yet.
   *  Empty map when everything connected is already fully enrolled or
   *  no sessionKeys are stored. */
  candidates: SiblingCandidates;
  /** True while the initial fetch is in flight. Consumers typically
   *  ignore this — the hook starts empty and fills itself in without
   *  needing a loading state — but we expose it for completeness. */
  loading: boolean;
  /** Manually re-fetch the candidate list. Useful on page focus so we
   *  don't show stale data if the user re-arranged accounts from
   *  another window while Configuration was backgrounded. */
  refetch: () => Promise<void>;
  /** Optimistically drop a candidate after the user triggers enrollment
   *  for it. The daemon will re-broadcast `additional_orgs_available`
   *  with the true state once the `silent_sibling_login` completes,
   *  but we remove immediately so the pill button doesn't stay visible
   *  during the ~1s round trip. */
  consume: (email: string, orgUuid: string) => void;
}

export function useSiblingCandidates(): UseSiblingCandidatesResult {
  const [candidates, setCandidates] = useState<SiblingCandidates>({});
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await sendToSentinel<SiblingCandidates>({
        type: 'get_sibling_candidates',
      });
      if (res.success && res.data) setCandidates(res.data);
    } catch {
      // Keep previous state on error — candidates are advisory, not
      // load-bearing. The next broadcast will reconcile.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Reactive updates: the daemon broadcasts `additional_orgs_available`
  // after every sessionKey capture (set_claude_ai_session_key), which
  // is exactly when the candidate list for that email changes. We
  // splice the broadcast into our state so a newly-enrolled sibling
  // disappears from the prompt as soon as the enrollment completes.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onDaemonMessage((msg) => {
      if (msg.type === 'additional_orgs_available') {
        setCandidates((prev) => {
          const next = { ...prev };
          if (msg.orgs.length === 0) {
            delete next[msg.email];
          } else {
            next[msg.email] = msg.orgs;
          }
          return next;
        });
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, []);

  const consume = useCallback((email: string, orgUuid: string): void => {
    setCandidates((prev) => {
      const entry = prev[email];
      if (!entry) return prev;
      const remaining = entry.filter((o) => o.orgUuid !== orgUuid);
      const next = { ...prev };
      if (remaining.length === 0) {
        delete next[email];
      } else {
        next[email] = remaining;
      }
      return next;
    });
  }, []);

  return { candidates, loading, refetch, consume };
}
