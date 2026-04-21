import { useCallback, useEffect, useState } from 'react';
import type { ClaudeSyncStatus } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UseClaudeSyncStatusResult {
  status: ClaudeSyncStatus | null;
  loading: boolean;
  /** Fire a manual pull. `mode` is only meaningful on first-enable;
   *  plain manual pulls default to 'merge'. */
  pull: (mode?: 'merge' | 'import' | 'export') => Promise<void>;
  /** Fire a manual push. No options — exports the current ruleset. */
  push: () => Promise<void>;
}

/**
 * Subscribe to the Claude Code sync engine's live status. Seeds from
 * an initial `get_claude_sync_status` call on mount so the UI doesn't
 * flash "unknown" waiting for the next broadcast, then updates via
 * the `claude_sync_status` broadcast the daemon fires on every
 * engine state transition (start, stop, pull done, push done, error).
 */
export function useClaudeSyncStatus(): UseClaudeSyncStatusResult {
  const [status, setStatus] = useState<ClaudeSyncStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const pull = useCallback(async (mode?: 'merge' | 'import' | 'export') => {
    const payload: { type: 'claude_sync_pull'; mode?: 'merge' | 'import' | 'export' } = {
      type: 'claude_sync_pull',
    };
    if (mode) payload.mode = mode;
    await sendToSentinel(payload).catch(() => undefined);
  }, []);

  const push = useCallback(async () => {
    await sendToSentinel({ type: 'claude_sync_push' }).catch(() => undefined);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const res = await sendToSentinel<ClaudeSyncStatus>({ type: 'get_claude_sync_status' });
        if (res.success) setStatus(res.data ?? null);
      } catch {
        /* non-fatal */
      } finally {
        setLoading(false);
      }
    })();
    onDaemonMessage((msg) => {
      if (msg.type === 'claude_sync_status') {
        setStatus(msg.status);
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

  return { status, loading, pull, push };
}
