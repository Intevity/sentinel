import { useCallback, useEffect, useState } from 'react';
import type { ByokState } from '@sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UseByokStateResult {
  /** True once any usage has been recorded under the reserved BYOK key. */
  hasUsage: boolean;
}

/**
 * Subscribe to whether bring-your-own-key usage exists. Seeds via a one-shot
 * `get_byok_state`, then re-checks on `metrics_updated` broadcasts — the
 * proxy fires one (debounced) after every BYOK usage write, so the "API key"
 * scope row appears in the Metrics picker as soon as the first API-key
 * request lands. The flag tracks the daemon in both directions: data
 * retention can purge every BYOK usage row, and the row must then leave the
 * picker (App resolves a now-unoffered BYOK pick back to the default scope).
 * The probe is a limit-1 lookup, so re-checking on every (debounced)
 * broadcast is cheap. Mirrors {@link useSurfaceState}.
 */
export function useByokState(): UseByokStateResult {
  const [hasUsage, setHasUsage] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await sendToSentinel<ByokState>({ type: 'get_byok_state' });
      if (res.success) setHasUsage(res.data?.hasUsage === true);
    } catch {
      /* non-fatal — the picker simply omits the row */
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void refresh();
    onDaemonMessage((msg) => {
      if (msg.type === 'metrics_updated') void refresh();
    })
      .then((fn) => {
        // Unmounted before the subscription resolved: drop it immediately.
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  return { hasUsage };
}
