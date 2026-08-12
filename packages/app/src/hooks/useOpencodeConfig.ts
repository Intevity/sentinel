import { useCallback, useEffect, useState } from 'react';
import type { OpencodeConfigDetails } from '@sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

interface UseOpencodeConfigResult {
  details: OpencodeConfigDetails | null;
  loading: boolean;
  /** True while an activate / deactivate action is in flight. */
  acting: boolean;
  actionError: string | null;
  /** Point opencode's Anthropic provider at Sentinel (Enable). */
  activate: () => Promise<boolean>;
  /** Remove Sentinel's base URL from opencode's config (Disable). */
  deactivate: () => Promise<boolean>;
  refresh: () => Promise<void>;
}

/**
 * Subscribe to opencode's provider-config state. Seeds via
 * `get_opencode_config_state` and exposes the enable / disable actions.
 *
 * There is no dedicated broadcast for this config (no file watcher — opencode's
 * config is edited far less often than Claude Code's settings), so the hook
 * re-reads on `surface_state_changed`, which the detector emits whenever the
 * opencode surface transitions. opencode analog of `useClaudeDesktopDrift`.
 */
export function useOpencodeConfig(): UseOpencodeConfigResult {
  const [details, setDetails] = useState<OpencodeConfigDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await sendToSentinel<OpencodeConfigDetails>({
        type: 'get_opencode_config_state',
      });
      if (res.success) setDetails(res.data ?? null);
    } catch {
      /* non-fatal */
    }
  }, []);

  const run = useCallback(
    async (type: 'activate_opencode' | 'deactivate_opencode', failLabel: string) => {
      setActing(true);
      setActionError(null);
      try {
        const res = await sendToSentinel<OpencodeConfigDetails>({ type });
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

  const activate = useCallback(
    () => run('activate_opencode', 'Failed to update opencode config'),
    [run],
  );
  const deactivate = useCallback(
    () => run('deactivate_opencode', 'Failed to update opencode config'),
    [run],
  );

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
      if (msg.type === 'surface_state_changed') void refresh();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [refresh]);

  return { details, loading, acting, actionError, activate, deactivate, refresh };
}
