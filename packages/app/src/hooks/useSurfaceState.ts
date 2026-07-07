import { useCallback, useEffect, useState } from 'react';
import type { SurfaceState } from '@sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UseSurfaceStateResult {
  state: SurfaceState | null;
  loading: boolean;
  /** Force a one-shot re-read (e.g. after an activate/deactivate elsewhere). */
  refresh: () => Promise<void>;
}

/**
 * Subscribe to the presence + routing status of each Claude surface (terminal
 * CLI + Desktop app). Seeds via a one-shot `get_surface_state` so the card
 * doesn't flash empty, then stays current via `surface_state_changed`
 * broadcasts (which fire when the user installs the other surface later or
 * toggles routing). Mirrors {@link useOtelDrift}.
 */
export function useSurfaceState(): UseSurfaceStateResult {
  const [state, setState] = useState<SurfaceState | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await sendToSentinel<SurfaceState>({ type: 'get_surface_state' });
      if (res.success) setState(res.data ?? null);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        await refresh();
      } finally {
        setLoading(false);
      }
    })();
    onDaemonMessage((msg) => {
      if (msg.type === 'surface_state_changed') setState(msg.state);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [refresh]);

  return { state, loading, refresh };
}
