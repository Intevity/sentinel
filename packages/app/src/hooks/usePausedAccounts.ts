import { useState, useEffect } from 'react';
import type { PauseReason } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

export interface PausedState {
  reason: PauseReason;
  resetsAt: number | null;
}

interface PausedAccountDetail {
  accountId: string;
  reason: PauseReason;
  resetsAt: number | null;
}

/**
 * Live view of the daemon's paused-account set.
 *
 * The daemon broadcasts `account_paused` when it begins blocking an account
 * (e.g. because rolling 7d spend crossed the Sentinel-side cap) and
 * `account_unpaused` when the condition clears (5h rollover drops the spend
 * below the cap, or the cap itself was removed).
 *
 * Seeds state from `get_paused_accounts` on mount so paused-badge UI
 * renders on first paint — broadcasts only fire on state transitions, so
 * a pause that persists across a daemon restart would otherwise be
 * invisible until the next real transition.
 *
 * Returns a map keyed by Sentinel id with the reason + projected rollover
 * timestamp. Consumers render "Paused — resumes in Xh" badges from this.
 */
export function usePausedAccounts(): Record<string, PausedState> {
  const [paused, setPaused] = useState<Record<string, PausedState>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await sendToSentinel<PausedAccountDetail[]>({ type: 'get_paused_accounts' });
        if (!cancelled && res.success && res.data) {
          const seeded: Record<string, PausedState> = {};
          for (const entry of res.data) {
            seeded[entry.accountId] = { reason: entry.reason, resetsAt: entry.resetsAt };
          }
          setPaused((prev) => ({ ...seeded, ...prev }));
        }
      } catch {
        // ignore — broadcasts will still populate state as transitions fire
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'account_paused') {
        setPaused((prev) => ({
          ...prev,
          [msg.accountId]: { reason: msg.reason, resetsAt: msg.resetsAt },
        }));
      } else if (msg.type === 'account_unpaused') {
        setPaused((prev) => {
          if (!(msg.accountId in prev)) return prev;
          const next = { ...prev };
          delete next[msg.accountId];
          return next;
        });
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

  return paused;
}
