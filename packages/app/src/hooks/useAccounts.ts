import { useState, useRef, useCallback, useEffect } from 'react';
import type { AccountInfo } from '@sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';
import { subscribeDemoMode } from '../lib/demoMode.js';

interface UseAccountsResult {
  accounts: AccountInfo[];
  removedAccounts: AccountInfo[];
  loading: boolean;
  error: string | null;
  switchAccount: (id: string, email: string) => Promise<{ success: boolean; message: string }>;
  removeAccount: (
    id: string,
    deleteData: boolean,
  ) => Promise<{ success: boolean; message: string }>;
  purgeAccount: (id: string) => Promise<{ success: boolean; message: string }>;
  refreshAccounts: () => Promise<{ ok: boolean; error?: string }>;
  refreshToken: (
    accountId: string,
  ) => Promise<{ success: boolean; message: string; needsReauth?: boolean }>;
}

export function useAccounts(): UseAccountsResult {
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [removedAccounts, setRemovedAccounts] = useState<AccountInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Prevents concurrent refresh_accounts IPC calls — the Rust PENDING map holds
  // only one sender per requestType, so a second in-flight call would overwrite
  // the first, causing it to time out.
  const refreshingRef = useRef(false);

  // Syncs daemon DB with ~/.claude.json and returns the latest account list.
  // Also fetches the removed-accounts list so the Deleted Accounts section stays fresh.
  // Returns { ok, error? } so callers can show refresh feedback without
  // racing React's batched `error` state update.
  const refreshAccounts = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (refreshingRef.current) return { ok: true };
    refreshingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const [res, removedRes] = await Promise.all([
        sendToSentinel<AccountInfo[]>({ type: 'refresh_accounts' }),
        sendToSentinel<AccountInfo[]>({ type: 'get_removed_accounts' }),
      ]);
      setAccounts(res.data ?? []);
      setRemovedAccounts(removedRes.data ?? []);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Refresh failed';
      setError(msg);
      return { ok: false, error: msg };
    } finally {
      setLoading(false);
      refreshingRef.current = false;
    }
  }, []);

  const switchAccount = useCallback(
    async (id: string, email: string): Promise<{ success: boolean; message: string }> => {
      setLoading(true);
      setError(null);
      try {
        const res = await sendToSentinel({ type: 'switch_account', accountId: id, email: email });
        if (res.success) {
          await refreshAccounts();
          return {
            success: true,
            message: `Switched to ${email}. API calls are already using this account. Open a new terminal to update the displayed account in Claude Code.`,
          };
        }
        return { success: false, message: res.error ?? 'Switch failed' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Switch failed';
        setError(msg);
        return { success: false, message: msg };
      } finally {
        setLoading(false);
      }
    },
    [refreshAccounts],
  );

  const removeAccount = useCallback(
    async (id: string, deleteData: boolean): Promise<{ success: boolean; message: string }> => {
      setError(null);
      try {
        const res = await sendToSentinel({ type: 'remove_account', accountId: id, deleteData });
        if (res.success) {
          // For "Keep Data" — move account from active list to removed list without a full
          // refreshAccounts() call (which would re-add the active account from ~/.claude.json).
          if (!deleteData) {
            setAccounts((prev) => {
              const moved = prev.find((a) => a.id === id);
              if (moved) setRemovedAccounts((r) => [moved, ...r]);
              return prev.filter((a) => a.id !== id);
            });
          } else {
            // "Delete Data" — account is hard-deleted, just remove from active list.
            setAccounts((prev) => prev.filter((a) => a.id !== id));
          }
          return {
            success: true,
            message: deleteData ? 'Account and data deleted' : 'Account removed',
          };
        }
        return { success: false, message: res.error ?? 'Remove failed' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Remove failed';
        setError(msg);
        return { success: false, message: msg };
      }
    },
    [],
  );

  const purgeAccount = useCallback(
    async (id: string): Promise<{ success: boolean; message: string }> => {
      setError(null);
      try {
        const res = await sendToSentinel({ type: 'purge_account', accountId: id });
        if (res.success) {
          setRemovedAccounts((prev) => prev.filter((a) => a.id !== id));
          return { success: true, message: 'Account and all data permanently deleted' };
        }
        return { success: false, message: res.error ?? 'Delete failed' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Delete failed';
        setError(msg);
        return { success: false, message: msg };
      }
    },
    [],
  );

  // Refetch when the daemon broadcasts `account_updated` (e.g. the avatar
  // color changed via the picker). Without this the local `accounts` state
  // stays stale — the DB has the new color but every AccountCard still
  // renders the previous avatar until the user triggers another refresh.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    onDaemonMessage((msg) => {
      if (msg.type === 'account_updated') void refreshAccounts();
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
    };
  }, [refreshAccounts]);

  // Toggling demo mode (dev-only) re-fetches so the account list/dropdowns
  // re-render with masked (or restored) emails immediately, without a restart.
  useEffect(() => subscribeDemoMode(() => void refreshAccounts()), [refreshAccounts]);

  const refreshToken = useCallback(
    async (
      accountId: string,
    ): Promise<{ success: boolean; message: string; needsReauth?: boolean }> => {
      setError(null);
      try {
        const res = await sendToSentinel<{ expiresAt: number }>({
          type: 'refresh_token',
          accountId,
        });
        if (res.success) {
          return { success: true, message: 'Token refreshed.' };
        }
        // Daemon returns needsReauth via error text convention; surface the hint.
        const err = res.error ?? 'Refresh failed';
        const needsReauth = /expired|re-authenticate|sign in/i.test(err);
        return { success: false, message: err, needsReauth };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Refresh failed';
        setError(msg);
        return { success: false, message: msg };
      }
    },
    [],
  );

  return {
    accounts,
    removedAccounts,
    loading,
    error,
    switchAccount,
    removeAccount,
    purgeAccount,
    refreshAccounts,
    refreshToken,
  };
}
