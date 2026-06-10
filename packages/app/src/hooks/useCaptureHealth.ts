import { useCallback, useEffect, useState } from 'react';
import type { CaptureHealth } from '@sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UseCaptureHealthResult {
  health: CaptureHealth | null;
  loading: boolean;
  /** Force a one-shot re-inspect. Useful when the Optimize tab regains focus. */
  refresh: () => Promise<void>;
}

/**
 * Subscribe to capture-health for the proxy ingestion path that feeds the
 * Optimize tab. Seeds via a one-shot `get_capture_health` so the tab doesn't
 * flash its empty-state on mount, then stays current via the
 * `capture_health_changed` broadcast (fires only on real transitions).
 *
 * The Optimize tab uses `health.state === 'proxy-bypassed'` to explain an
 * empty tab caused by Claude Code's API traffic bypassing Sentinel's proxy
 * (an overridden ANTHROPIC_BASE_URL) rather than silently showing zeros.
 */
export function useCaptureHealth(): UseCaptureHealthResult {
  const [health, setHealth] = useState<CaptureHealth | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await sendToSentinel<CaptureHealth>({ type: 'get_capture_health' });
      if (res.success) setHealth(res.data ?? null);
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
      if (msg.type === 'capture_health_changed') {
        setHealth(msg.health);
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [refresh]);

  return { health, loading, refresh };
}
