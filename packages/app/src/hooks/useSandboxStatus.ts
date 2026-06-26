import { useEffect, useState } from 'react';
import type { ClaudeSyncStatus, SandboxStatus } from '@sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UseSandboxStatusResult {
  /** Leg A settings-sync engine status (active / last pull/push / error). */
  status: ClaudeSyncStatus | null;
  /** Leg B host capability (full / network-only / unavailable + reasons). */
  capability: SandboxStatus | null;
  loading: boolean;
}

/**
 * Subscribe to the sandbox engine's live status. Seeds the Leg A sync status
 * (`get_sandbox_status`) and the Leg B host capability (`get_sandbox_capability`)
 * on mount, then keeps the sync status fresh via the `sandbox_sync_status`
 * broadcast. Mirrors {@link useClaudeSyncStatus}.
 */
export function useSandboxStatus(): UseSandboxStatusResult {
  const [status, setStatus] = useState<ClaudeSyncStatus | null>(null);
  const [capability, setCapability] = useState<SandboxStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const [sync, cap] = await Promise.all([
          sendToSentinel<ClaudeSyncStatus>({ type: 'get_sandbox_status' }),
          sendToSentinel<SandboxStatus>({ type: 'get_sandbox_capability' }),
        ]);
        if (sync.success) setStatus(sync.data ?? null);
        if (cap.success) setCapability(cap.data ?? null);
      } catch {
        /* non-fatal */
      } finally {
        setLoading(false);
      }
    })();
    onDaemonMessage((msg) => {
      if (msg.type === 'sandbox_sync_status') {
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

  return { status, capability, loading };
}
