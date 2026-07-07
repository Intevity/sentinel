import { useCallback, useEffect, useState } from 'react';
import type { ClaudeDesktopDriftDetails } from '@sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UseClaudeDesktopDriftResult {
  details: ClaudeDesktopDriftDetails | null;
  loading: boolean;
  /** True while an activate / deactivate / re-apply action is in flight. */
  acting: boolean;
  actionError: string | null;
  /** Write Sentinel's gateway config into the desktop app (Enable). */
  activate: () => Promise<boolean>;
  /** Remove Sentinel's gateway config from the desktop app (Disable). */
  deactivate: () => Promise<boolean>;
  /** Re-apply after drift (recovery). */
  reapply: () => Promise<boolean>;
  refresh: () => Promise<void>;
}

/**
 * Subscribe to the Claude Desktop app's gateway-config drift state. Seeds via
 * `get_claude_desktop_drift_state`, stays current via the
 * `claude_desktop_drift_state` broadcast, and exposes the enable / disable /
 * re-apply actions. Desktop analog of {@link useOtelDrift}.
 */
export function useClaudeDesktopDrift(): UseClaudeDesktopDriftResult {
  const [details, setDetails] = useState<ClaudeDesktopDriftDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await sendToSentinel<ClaudeDesktopDriftDetails>({
        type: 'get_claude_desktop_drift_state',
      });
      if (res.success) setDetails(res.data ?? null);
    } catch {
      /* non-fatal */
    }
  }, []);

  const run = useCallback(
    async (
      type: 'activate_desktop' | 'deactivate_desktop' | 'reapply_desktop_config',
      failLabel: string,
    ): Promise<boolean> => {
      setActing(true);
      setActionError(null);
      try {
        const res = await sendToSentinel<ClaudeDesktopDriftDetails>({ type });
        if (!res.success) {
          setActionError(res.error ?? failLabel);
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
    },
    [],
  );

  const activate = useCallback(() => run('activate_desktop', 'Enable failed'), [run]);
  const deactivate = useCallback(() => run('deactivate_desktop', 'Disable failed'), [run]);
  const reapply = useCallback(() => run('reapply_desktop_config', 'Re-apply failed'), [run]);

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
      if (msg.type === 'claude_desktop_drift_state') setDetails(msg.details);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [refresh]);

  return { details, loading, acting, actionError, activate, deactivate, reapply, refresh };
}
