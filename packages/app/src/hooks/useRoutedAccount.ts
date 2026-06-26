import { useEffect, useState } from 'react';
import { onDaemonMessage } from '../lib/ipc.js';

/**
 * Tracks the Sentinel account id (orgUuid||accountUuid) the daemon is
 * currently routing requests through in Auto switching mode. The daemon
 * broadcasts `routed_account_changed` only when the rotator's target
 * changes (earliest-reset is sticky), so this updates rarely, not per
 * request. Returns null until the first request flows; callers fall back
 * to the manually-active account in that window.
 */
export function useRoutedAccount(): string | null {
  const [routedAccountId, setRoutedAccountId] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'routed_account_changed') {
        setRoutedAccountId(msg.accountId);
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

  return routedAccountId;
}
