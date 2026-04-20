import { useState, useEffect } from 'react';
import { onDaemonMessage } from '../lib/ipc.js';

export interface PausedState {
  reason: 'sentinel_budget' | 'anthropic_overage_disabled';
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
 * Returns a map keyed by Sentinel id with the reason + projected rollover
 * timestamp. Consumers render "Paused — resumes in Xh" badges from this.
 *
 * NOTE: this hook only reflects events broadcast while it is mounted. When
 * a component mounts after some accounts have already entered the paused
 * set, it will miss those until the daemon rebroadcasts (which happens on
 * every spend recompute for state transitions only). If this matters, add
 * a `get_paused_accounts` IPC.
 */
export function usePausedAccounts(): Record<string, PausedState> {
  const [paused, setPaused] = useState<Record<string, PausedState>>({});

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
    }).then((fn) => { unlisten = fn; }).catch(() => undefined);
    return () => { unlisten?.(); };
  }, []);

  return paused;
}
