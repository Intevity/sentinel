import { useEffect, useState } from 'react';
import type { AutoModeStatus } from '@sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

const IDLE_STATUS: AutoModeStatus = {
  active: false,
  source: null,
  lastDetectedAt: null,
};

/**
 * Live auto-mode status. Seeds from `get_permissions_status` on mount, then
 * stays in sync via `permissions_status` broadcasts. The daemon emits only
 * on edges (activated / deactivated / source-changed), so the hook state
 * matches the daemon's computed view without polling.
 */
export function useAutoModeStatus(): AutoModeStatus {
  const [status, setStatus] = useState<AutoModeStatus>(IDLE_STATUS);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void (async (): Promise<void> => {
      try {
        const res = await sendToSentinel<AutoModeStatus>({ type: 'get_permissions_status' });
        if (!cancelled && res.success && res.data) setStatus(res.data);
      } catch {
        // Non-fatal — broadcast will backfill.
      }
    })();

    onDaemonMessage((msg) => {
      if (msg.type === 'permissions_status') setStatus(msg.status);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return status;
}
