import { useCallback, useEffect, useRef, useState } from 'react';
import type { PendingSecurityBlock } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UsePendingBlocksResult {
  pending: PendingSecurityBlock[];
  loading: boolean;
  error: string | null;
  /** Approve a held block. Adds the match to the allowlist, releases
   *  the held request upstream, and clears the banner. */
  approve: (pendingId: string) => Promise<void>;
  /** Deny a held block. Triggers the 403 immediately and clears the banner. */
  deny: (pendingId: string) => Promise<void>;
  /** Seconds remaining before the approve window expires. Ticks every
   *  second so banners show a live countdown. */
  secondsRemaining: (pendingId: string) => number;
}

/**
 * Tracks every outbound block currently held by the proxy waiting for the
 * user's decision. Subscribes to `security_block_pending` and
 * `security_block_resolved` broadcasts; on mount, fetches the current
 * pending set via `list_pending_blocks` so a UI reload mid-hold still sees
 * them. Also ticks internal state once per second so consumers can render
 * a live countdown without each banner owning its own timer.
 */
export function usePendingSecurityBlocks(): UsePendingBlocksResult {
  const [pending, setPending] = useState<PendingSecurityBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Dummy state bump driving the 1 s countdown tick.
  const [, setTick] = useState(0);
  const mountedRef = useRef(true);

  const refetch = useCallback(async () => {
    try {
      const res = await sendToSentinel<PendingSecurityBlock[]>({ type: 'list_pending_blocks' });
      if (!mountedRef.current) return;
      if (res.success) {
        setPending(res.data ?? []);
        setError(null);
      } else {
        setError(res.error ?? 'Failed to load pending blocks');
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  const approve = useCallback(async (pendingId: string) => {
    await sendToSentinel({ type: 'approve_blocked_request', pendingId }).catch(() => undefined);
    // The daemon broadcasts `security_block_resolved` on success; the
    // subscription below will remove it from state. No optimistic update
    // needed.
  }, []);

  const deny = useCallback(async (pendingId: string) => {
    await sendToSentinel({ type: 'deny_blocked_request', pendingId }).catch(() => undefined);
  }, []);

  const secondsRemaining = useCallback((pendingId: string): number => {
    const entry = pending.find((p) => p.pendingId === pendingId);
    if (!entry) return 0;
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  }, [pending]);

  useEffect(() => {
    mountedRef.current = true;
    void refetch();

    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'security_block_pending') {
        setPending((prev) => {
          // Replace if the id already exists (shouldn't happen but defensive).
          const without = prev.filter((p) => p.pendingId !== msg.pending.pendingId);
          return [...without, msg.pending];
        });
      } else if (msg.type === 'security_block_resolved') {
        setPending((prev) => prev.filter((p) => p.pendingId !== msg.pendingId));
      }
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);

    // 1 s tick so consumers (the banner countdown) re-render without
    // wiring their own timer.
    const tickHandle = window.setInterval(() => setTick((n) => n + 1), 1000);

    return () => {
      mountedRef.current = false;
      unlisten?.();
      window.clearInterval(tickHandle);
    };
  }, [refetch]);

  return { pending, loading, error, approve, deny, secondsRemaining };
}
