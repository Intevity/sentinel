import { useState, useEffect, useCallback } from 'react';
import type { OAuthAccount, AccountInfo } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

/**
 * Synthesize an OAuthAccount-compatible object from the AccountInfo row that
 * `get_accounts` returns. Used so every tab has a populated `activeAccount`
 * on initial load — not just after an `account_switched` broadcast. The
 * consumer-relevant fields (emailAddress, accountUuid, organizationUuid,
 * displayName, organizationName) are always present; the remainder are
 * derived from planType to keep downstream code honest.
 */
function accountInfoToOAuth(acct: AccountInfo): OAuthAccount {
  const isMax = acct.planType === 'max' || acct.planType === 'enterprise';
  const isTeamOrEnt = acct.planType === 'team' || acct.planType === 'enterprise';
  return {
    accountUuid: acct.accountUuid,
    emailAddress: acct.email,
    organizationUuid: acct.orgUuid,
    hasExtraUsageEnabled: isMax,
    billingType: acct.planType,
    accountCreatedAt: new Date(acct.createdAt).toISOString(),
    subscriptionCreatedAt: new Date(acct.createdAt).toISOString(),
    displayName: acct.displayName,
    organizationRole: 'user',
    workspaceRole: isTeamOrEnt ? 'member' : null,
    organizationName: acct.orgName,
  };
}

interface DaemonState {
  connected: boolean;
  activeAccount: OAuthAccount | null;
  accounts: AccountInfo[];
  overageActive: boolean;
  /** Increments each time the daemon broadcasts rate_limits_updated. */
  rateLimitsVersion: number;
  /** Increments each time the daemon broadcasts an overage transition. */
  overageVersion: number;
  /** Sentinel key of the account currently being probed for fresh rate-limit
   *  headers, or null when no probe is in flight. Set by rate_limits_probing,
   *  cleared by rate_limits_updated or rate_limits_probe_ended (matching id)
   *  or a 15s safety timeout. */
  probingAccountId: string | null;
  /** True until the first successful IPC round-trip — i.e. the daemon has not
   *  yet accepted our connection. The App uses this to show a startup splash
   *  instead of rendering tab content, so components don't fire their own
   *  "Refresh failed" errors while waiting. Flips to false after the first
   *  successful refetch and stays false even if the daemon later disconnects. */
  initializing: boolean;
}

export function useDaemon(): DaemonState & { refetch: () => void } {
  const [state, setState] = useState<DaemonState>({
    connected: false,
    activeAccount: null,
    accounts: [],
    overageActive: false,
    rateLimitsVersion: 0,
    overageVersion: 0,
    probingAccountId: null,
    initializing: true,
  });

  const refetch = useCallback(async () => {
    try {
      const accountsRes = await sendToSentinel<AccountInfo[]>({ type: 'get_accounts' });
      const list = accountsRes.data ?? [];
      const active = list.find((a) => a.isActive) ?? null;

      setState((prev) => ({
        ...prev,
        connected: true,
        // Flip initializing off on first success — we leave it off for the rest
        // of the session even if the daemon later disconnects briefly, so the
        // user doesn't get flipped back to the startup splash mid-session.
        initializing: false,
        // Derive the active OAuthAccount from the list rather than a bogus
        // `statusRes.data.activeAccount` field. If a fresher full OAuthAccount
        // record arrived via an earlier `account_switched` broadcast for the
        // same account, prefer it (keeps `hasExtraUsageEnabled` etc. accurate);
        // otherwise synthesize from the DB row so the UI is never blank.
        activeAccount: active
          ? prev.activeAccount && prev.activeAccount.accountUuid === active.accountUuid
            ? prev.activeAccount
            : accountInfoToOAuth(active)
          : null,
        accounts: list,
      }));
    } catch {
      // Swallow the error — while initializing it's almost certainly
      // "Daemon not connected" which the retry loop handles. After init,
      // the header dot indicates disconnected state to the user.
      setState((prev) => ({ ...prev, connected: false }));
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    // Safety: clear probingAccountId after 15s even if no completion broadcast
    // arrives (daemon crash, network stall). Cleared & restarted per probe.
    let probeTimeout: ReturnType<typeof setTimeout> | null = null;
    const clearProbeTimeout = (): void => {
      if (probeTimeout) {
        clearTimeout(probeTimeout);
        probeTimeout = null;
      }
    };

    void refetch();

    onDaemonMessage((msg) => {
      if (msg.type === 'overage_entered') {
        setState((prev) => ({
          ...prev,
          overageActive: true,
          overageVersion: prev.overageVersion + 1,
        }));
      } else if (msg.type === 'overage_exited' || msg.type === 'overage_disabled') {
        setState((prev) => ({
          ...prev,
          overageActive: false,
          overageVersion: prev.overageVersion + 1,
        }));
      } else if (msg.type === 'login_complete' && msg.email) {
        void refetch();
      } else if (msg.type === 'account_updated') {
        // Per-account metadata (currently just color) changed — pull fresh
        // accounts so every surface that renders an avatar/dot stays in sync.
        void refetch();
      } else if (msg.type === 'account_switched') {
        // Bump rateLimitsVersion immediately so UsageView re-fetches for the
        // new account without waiting for the async probe to broadcast rate_limits_updated.
        setState((prev) => ({
          ...prev,
          activeAccount: msg.to,
          rateLimitsVersion: prev.rateLimitsVersion + 1,
        }));
        void refetch();
      } else if (msg.type === 'rate_limits_updated') {
        setState((prev) => ({
          ...prev,
          rateLimitsVersion: prev.rateLimitsVersion + 1,
          // A successful headers-update for this account means the probe finished.
          probingAccountId: prev.probingAccountId === msg.accountId ? null : prev.probingAccountId,
        }));
        clearProbeTimeout();
      } else if (msg.type === 'rate_limits_probing') {
        setState((prev) => ({ ...prev, probingAccountId: msg.accountId }));
        clearProbeTimeout();
        probeTimeout = setTimeout(() => {
          setState((prev) =>
            prev.probingAccountId === msg.accountId ? { ...prev, probingAccountId: null } : prev,
          );
        }, 15_000);
      } else if (msg.type === 'rate_limits_probe_ended') {
        setState((prev) =>
          prev.probingAccountId === msg.accountId ? { ...prev, probingAccountId: null } : prev,
        );
        clearProbeTimeout();
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);

    return () => {
      unlisten?.();
      clearProbeTimeout();
    };
  }, [refetch]);

  // Polling: fast (500ms) while waiting for the daemon to come up, then 30s
  // once we've connected at least once. useEffect watches `initializing` so
  // the interval swaps over as soon as the first refetch succeeds.
  useEffect(() => {
    const ms = state.initializing ? 500 : 30_000;
    const interval = setInterval(() => void refetch(), ms);
    return () => clearInterval(interval);
  }, [state.initializing, refetch]);

  return { ...state, refetch };
}
