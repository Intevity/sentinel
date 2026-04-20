import { useEffect, useState } from 'react';
import { onDaemonMessage } from '../lib/ipc.js';

/**
 * Tracks whether a sibling-enrollment walk is in progress. The daemon
 * fires `additional_orgs_available` after a sessionKey is captured and
 * `/api/bootstrap` reveals more orgs the user could enroll with the same
 * login. An empty `orgs` list means the walk is finished.
 *
 * App.tsx uses this to defer the Security Setup Wizard until every
 * sibling has been enrolled (or the banner has been dismissed) — we don't
 * want the wizard to pop over the sibling prompt mid-OAuth.
 */
export function usePendingSiblings(): { pending: boolean } {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'additional_orgs_available') {
        setPending(msg.orgs.length > 0);
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

  return { pending };
}
