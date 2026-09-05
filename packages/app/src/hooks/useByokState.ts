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
 * request lands. The flag never flips back off mid-session (usage rows only
 * accrue), so the re-check short-circuits once true. Mirrors
 * {@link useSurfaceState}.
 */
export function useByokState(): UseByokStateResult {
  const [hasUsage, setHasUsage] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await sendToSentinel<ByokState>({ type: 'get_byok_state' });
      if (res.success && res.data?.hasUsage) setHasUsage(true);
    } catch {
      /* non-fatal — the picker simply omits the row */
    }
  }, []);

  useEffect(() => {
    if (hasUsage) return; // latched — no more probes needed
    let unlisten: (() => void) | null = null;
    void refresh();
    onDaemonMessage((msg) => {
      if (msg.type === 'metrics_updated') void refresh();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [refresh, hasUsage]);

  return { hasUsage };
}
