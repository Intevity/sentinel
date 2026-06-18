import { useCallback, useEffect, useState } from 'react';
import type { OtelDriftDetails } from '@sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UseOtelDriftResult {
  details: OtelDriftDetails | null;
  loading: boolean;
  /** True while a Re-patch or Promote action is in flight. UI uses this
   *  to disable the buttons + show a spinner so the user can't queue
   *  two writes back-to-back. */
  acting: boolean;
  /** Most recent action error, cleared on the next attempt. */
  actionError: string | null;
  /** Re-patch `~/.claude/settings.json` so Sentinel's eight managed env
   *  keys are restored. Resolves to true on success, false on error. */
  repatch: () => Promise<boolean>;
  /** Promote the foreign endpoint into Sentinel's external forwarder
   *  AND re-patch Claude Code back to Sentinel. `chosenHeaderName` lets
   *  the modal pick an explicit header when the heuristic finds none or
   *  multiple. */
  promote: (chosenHeaderName?: string) => Promise<boolean>;
  /** Force a one-shot inspect. Useful if a stale state slips past the
   *  broadcast pipeline (e.g. devtools window opened). */
  refresh: () => Promise<void>;
}

/**
 * Subscribe to OTEL drift state for `~/.claude/settings.json`. Seeds via
 * a one-shot `get_otel_drift_state` so the UI doesn't flash empty on
 * mount, then stays current via the `otel_drift_state` broadcast (one
 * fires on watcher events and after every Re-patch / Promote action).
 */
export function useOtelDrift(): UseOtelDriftResult {
  const [details, setDetails] = useState<OtelDriftDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await sendToSentinel<OtelDriftDetails>({ type: 'get_otel_drift_state' });
      if (res.success) setDetails(res.data ?? null);
    } catch {
      /* non-fatal */
    }
  }, []);

  const repatch = useCallback(async (): Promise<boolean> => {
    setActing(true);
    setActionError(null);
    try {
      const res = await sendToSentinel<OtelDriftDetails>({ type: 'repatch_otel_settings' });
      if (!res.success) {
        setActionError(res.error ?? 'Re-patch failed');
        return false;
      }
      if (res.data) setDetails(res.data);
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setActing(false);
    }
  }, []);

  const promote = useCallback(async (chosenHeaderName?: string): Promise<boolean> => {
    setActing(true);
    setActionError(null);
    try {
      const payload =
        chosenHeaderName !== undefined
          ? { type: 'promote_foreign_otel_endpoint' as const, chosenHeaderName }
          : { type: 'promote_foreign_otel_endpoint' as const };
      const res = await sendToSentinel<OtelDriftDetails>(payload);
      if (!res.success) {
        setActionError(res.error ?? 'Promote failed');
        return false;
      }
      if (res.data) setDetails(res.data);
      return true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setActing(false);
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
      if (msg.type === 'otel_drift_state') {
        setDetails(msg.details);
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

  return { details, loading, acting, actionError, repatch, promote, refresh };
}
