import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FailedUpdateAttempt } from '../lib/updateRecovery.js';

interface UseFailedUpdateResult {
  attempt: FailedUpdateAttempt | null;
  dismiss: () => void;
}

/**
 * One-shot read of the update attempt that a previous launch tried and failed
 * to install (Rust `reconcile_update_attempt` populates it during setup).
 *
 * A pull, not a `listen()` subscription like `update_available`: the verdict is
 * known before the webview exists, and Sentinel starts hidden in the tray, so
 * an event emitted at that moment would be dropped. Reading managed state on
 * mount is race-free and idempotent under StrictMode's double-invoke.
 */
export function useFailedUpdate(): UseFailedUpdateResult {
  const [attempt, setAttempt] = useState<FailedUpdateAttempt | null>(null);

  useEffect(() => {
    invoke<FailedUpdateAttempt | null>('get_failed_update_attempt')
      .then((a) => setAttempt(a ?? null))
      .catch(() => setAttempt(null));
  }, []);

  const dismiss = useCallback((): void => setAttempt(null), []);

  return { attempt, dismiss };
}
