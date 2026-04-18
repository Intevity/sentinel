import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, Plus, Loader2, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import AccountCard from './AccountCard.js';
import { useAccounts } from '../hooks/useAccounts.js';
import { useAllRateLimits, fiveHourUtilization } from '../hooks/useAllRateLimits.js';
import { useSettings } from '../hooks/useSettings.js';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';
import { DUR, EASE_OUT } from '../lib/motion.js';

const TRANSIENT_ANIM = {
  initial: { opacity: 0, y: -8, height: 0 },
  animate: { opacity: 1, y: 0, height: 'auto' as const },
  exit:    { opacity: 0, height: 0 },
  transition: { duration: DUR.med, ease: EASE_OUT },
};

interface AccountSwitcherProps {
  /** Called after an account is removed or purged so the parent can refresh useDaemon state. */
  onAccountsChanged?: () => void;
}

export default function AccountSwitcher({ onAccountsChanged }: AccountSwitcherProps): React.ReactElement {
  const { accounts, removedAccounts, loading, error, switchAccount, removeAccount, purgeAccount, refreshAccounts, refreshToken } = useAccounts();
  const { byAccount: rateLimitsByAccount } = useAllRateLimits();
  const { settings } = useSettings();
  const isRoundRobin = settings?.switchingMode === 'round-robin';
  // Pool-exclusion set (RR only). `poolExcludedIds` may contain stale IDs
  // of removed accounts — harmless because the rotator filters against the
  // live account list; we do the same here when counting members.
  const excludedIds = React.useMemo(
    () => new Set(settings?.poolExcludedIds ?? []),
    [settings?.poolExcludedIds],
  );
  const poolMemberCount = accounts.reduce(
    (n, a) => (excludedIds.has(a.id) ? n : n + 1),
    0,
  );

  const togglePoolMembership = (accountId: string, nextInPool: boolean): void => {
    const current = settings?.poolExcludedIds ?? [];
    const next = nextInPool
      ? current.filter((id) => id !== accountId)
      : current.includes(accountId)
        ? current
        : [...current, accountId];
    void sendToSentinel({ type: 'update_settings', settings: { poolExcludedIds: next } });
  };
  const [switchingEmail, setSwitchingEmail] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{
    text: string;
    kind: 'success' | 'error' | 'info';
  } | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [purgingId, setPurgingId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  // Accounts flagged by the daemon as having an expired/revoked refresh token.
  // Cleared when token_refreshed or login_complete fires for the same account.
  const [expiredAccountIds, setExpiredAccountIds] = useState<Set<string>>(new Set());

  // Snapshot of account IDs when login started — used by the polling fallback
  const initialAccountIdsRef = useRef<Set<string>>(new Set());
  // Ref so the focus handler always reads the current loggingIn value
  const loggingInRef = useRef(false);
  useEffect(() => { loggingInRef.current = loggingIn; }, [loggingIn]);

  useEffect(() => {
    void refreshAccounts();
    const onFocus = () => {
      void refreshAccounts();
      if (loggingInRef.current) {
        setLoggingIn(false);
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshAccounts]);

  // Listen for login_complete broadcast from daemon
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onDaemonMessage((msg) => {
      if (msg.type === 'login_complete') {
        setLoggingIn(false);
        if (!msg.email) {
          setStatusMessage({ text: 'Login failed or was cancelled.', kind: 'error' });
          return;
        }
        const orgLabel = msg.orgName ? ` (${msg.orgName})` : '';
        if (msg.reauth) {
          // Same org was already in the DB — OAuth just refreshed the token.
          // This usually means the user wanted to add a *different* org but
          // their claude.ai browser was still on the one they already had.
          setStatusMessage({
            text:
              `Signed in to ${msg.orgName ?? msg.email} — this org was already added, token refreshed.\n` +
              `To add a different org for the same email, open claude.ai, switch the org selector ` +
              `(top-left sidebar) to the org you want, then click Add Account again.`,
            kind: 'info',
          });
          setTimeout(() => setStatusMessage(null), 30000);
        } else {
          setStatusMessage({ text: `${msg.email}${orgLabel} added to Sentinel.`, kind: 'success' });
          setTimeout(() => setStatusMessage(null), 10000);
        }
        // A fresh OAuth credential clears any expired-mark for this email,
        // regardless of which specific account row the daemon rebound.
        setExpiredAccountIds((prev) => {
          const next = new Set(prev);
          for (const a of accounts) if (a.email === msg.email) next.delete(a.id);
          return next;
        });
        void refreshAccounts();
      } else if (msg.type === 'token_refresh_failed') {
        if (msg.reason === 'expired') {
          setExpiredAccountIds((prev) => new Set(prev).add(msg.accountId));
          setStatusMessage({
            text: `Sign-in expired for ${msg.email}. Click "Re-authenticate" on that account to restore access.`,
            kind: 'error',
          });
        }
      } else if (msg.type === 'token_refreshed') {
        setExpiredAccountIds((prev) => {
          if (!prev.has(msg.accountId)) return prev;
          const next = new Set(prev);
          next.delete(msg.accountId);
          return next;
        });
      }
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { unlisten?.(); };
  }, [refreshAccounts, accounts]);

  // Polling fallback while login is in progress
  useEffect(() => {
    if (!loggingIn) return;
    initialAccountIdsRef.current = new Set(accounts.map((a) => a.id));
    const interval = setInterval(() => { void refreshAccounts(); }, 2000);
    return () => clearInterval(interval);
  }, [loggingIn]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!loggingIn) return;
    const newAccount = accounts.find((a) => !initialAccountIdsRef.current.has(a.id));
    if (newAccount) {
      setLoggingIn(false);
      setStatusMessage({ text: `${newAccount.email} added to Sentinel.`, kind: 'success' });
    }
  }, [accounts, loggingIn]);

  const handleSwitch = async (id: string, email: string): Promise<void> => {
    setSwitchingEmail(email);
    setStatusMessage(null);
    const result = await switchAccount(id, email);
    setSwitchingEmail(null);
    setStatusMessage({ text: result.message, kind: result.success ? 'success' : 'error' });
    if (result.success) setTimeout(() => setStatusMessage(null), 8000);
  };

  const handleRemoveConfirm = async (id: string, deleteData: boolean): Promise<void> => {
    setPendingRemoveId(null);
    setStatusMessage(null);
    const result = await removeAccount(id, deleteData);
    setStatusMessage({ text: result.message, kind: result.success ? 'success' : 'error' });
    if (result.success) {
      setTimeout(() => setStatusMessage(null), 4000);
      onAccountsChanged?.();
    }
  };

  const handlePurge = async (id: string): Promise<void> => {
    setPurgingId(id);
    setStatusMessage(null);
    const result = await purgeAccount(id);
    setPurgingId(null);
    setStatusMessage({ text: result.message, kind: result.success ? 'success' : 'error' });
    if (result.success) setTimeout(() => setStatusMessage(null), 4000);
  };

  const handleAddAccount = async (): Promise<void> => {
    setLoggingIn(true);
    setStatusMessage(null);
    try {
      await sendToSentinel({ type: 'start_login' });
    } catch {
      setLoggingIn(false);
      setStatusMessage({ text: 'Failed to start login.', kind: 'error' });
    }
  };

  const handleRefreshToken = async (id: string): Promise<void> => {
    setRefreshingId(id);
    setStatusMessage(null);
    const result = await refreshToken(id);
    setRefreshingId(null);
    if (result.success) {
      setExpiredAccountIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setStatusMessage({ text: 'Token refreshed.', kind: 'success' });
      setTimeout(() => setStatusMessage(null), 4000);
    } else {
      if (result.needsReauth) {
        setExpiredAccountIds((prev) => new Set(prev).add(id));
      }
      setStatusMessage({ text: result.message, kind: 'error' });
    }
  };

  return (
    <div className="space-y-2 pt-1">

      {/* Section header */}
      <div className="flex items-center justify-between mb-3">
        <span className="section-label">Accounts</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void refreshAccounts()}
            disabled={loading}
            className="text-[#8E8E93] hover:text-ios-blue disabled:opacity-40 transition-colors active:scale-90"
            title="Sync with Claude Code"
          >
            <RefreshCw size={13} strokeWidth={2.5} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => void handleAddAccount()}
            disabled={loggingIn || loading}
            className="flex items-center gap-1 text-[11px] font-semibold text-ios-blue
                       disabled:opacity-40 transition-all active:scale-95"
            title="Add another account"
          >
            {loggingIn
              ? <Loader2 size={12} className="animate-spin" />
              : <Plus size={12} strokeWidth={2.5} />
            }
            {loggingIn ? 'Opening browser…' : 'Add Account'}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-2xl bg-ios-red/10 dark:bg-ios-red/15 px-4 py-3">
          <p className="text-[12px] text-ios-red">{error}</p>
        </div>
      )}

      {/* Status message */}
      <AnimatePresence initial={false}>
      {statusMessage && (() => {
        const styles = {
          success: { bg: 'bg-ios-green/10 dark:bg-ios-green/15', fg: 'text-ios-green' },
          error:   { bg: 'bg-ios-red/10 dark:bg-ios-red/15',     fg: 'text-ios-red'   },
          info:    { bg: 'bg-ios-blue/10 dark:bg-ios-blue/15',   fg: 'text-ios-blue'  },
        }[statusMessage.kind];
        return (
          <motion.div
            {...TRANSIENT_ANIM}
            className={`overflow-hidden rounded-2xl ${styles.bg}`}
          >
            <div className="px-4 py-3 flex items-start justify-between">
              <p className={`text-[12px] font-medium whitespace-pre-line ${styles.fg}`}>
                {statusMessage.text}
              </p>
              <button
                onClick={() => setStatusMessage(null)}
                className={`ml-2 shrink-0 text-[13px] leading-none opacity-50 hover:opacity-100 transition-opacity ${styles.fg}`}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </motion.div>
        );
      })()}
      </AnimatePresence>

      {/* Login in progress hint */}
      <AnimatePresence initial={false}>
      {loggingIn && (
        <motion.div
          {...TRANSIENT_ANIM}
          className="overflow-hidden rounded-2xl bg-ios-blue/[0.08] dark:bg-ios-blue/[0.12] ring-1 ring-ios-blue/20"
        >
          <div className="px-4 py-3 flex items-center justify-between">
            <p className="text-[12px] text-ios-blue font-medium">
              Complete sign-in in your browser, then return here.
            </p>
            <button
              onClick={() => {
                void sendToSentinel({ type: 'cancel_login' }).catch(() => {});
                setLoggingIn(false);
              }}
              className="text-[11px] text-ios-blue/60 hover:text-ios-blue ml-2 shrink-0"
            >
              Cancel
            </button>
          </div>
        </motion.div>
      )}
      </AnimatePresence>

      {/* Remove confirmation prompt */}
      <AnimatePresence initial={false}>
      {pendingRemoveId && (() => {
        const target = accounts.find((a) => a.id === pendingRemoveId);
        return (
          <motion.div
            {...TRANSIENT_ANIM}
            className="overflow-hidden rounded-2xl bg-ios-red/[0.08] dark:bg-ios-red/[0.12] ring-1 ring-ios-red/20"
          >
            <div className="p-4">
              <p className="text-[13px] font-semibold text-black dark:text-white mb-0.5">
                Remove {target?.displayName || target?.email}?
              </p>
              <p className="text-[11px] text-[#8E8E93] mb-3">
                Keep data to preserve usage history, or delete everything now.
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void handleRemoveConfirm(pendingRemoveId, false)}
                  className="flex-1 text-[12px] font-semibold text-ios-orange bg-ios-orange/10
                             hover:bg-ios-orange/20 active:scale-95 px-3 py-1.5 rounded-full transition-all"
                >
                  Keep Data
                </button>
                <button
                  onClick={() => void handleRemoveConfirm(pendingRemoveId, true)}
                  className="flex-1 text-[12px] font-semibold text-white bg-ios-red
                             hover:opacity-90 active:scale-95 px-3 py-1.5 rounded-full transition-all"
                >
                  Delete Data
                </button>
                <button
                  onClick={() => setPendingRemoveId(null)}
                  className="text-[12px] text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors px-2"
                >
                  Cancel
                </button>
              </div>
            </div>
          </motion.div>
        );
      })()}
      </AnimatePresence>

      {/* Account list */}
      {accounts.map((account) => {
        const util = fiveHourUtilization(rateLimitsByAccount[account.id]);
        const expired = expiredAccountIds.has(account.id);
        const inPool = !excludedIds.has(account.id);
        return (
          <AccountCard
            key={account.id}
            account={account}
            onSwitch={(id, email) => void handleSwitch(id, email)}
            onRemove={(id) => { setStatusMessage(null); setPendingRemoveId(id); }}
            switching={switchingEmail === account.email}
            onRefreshToken={(id) => void handleRefreshToken(id)}
            refreshing={refreshingId === account.id}
            needsReauth={expired}
            onReauth={() => void handleAddAccount()}
            isRoundRobin={isRoundRobin}
            inPool={inPool}
            canExclude={poolMemberCount > 1}
            onTogglePool={togglePoolMembership}
            {...(util != null ? { fiveHourUtil: util } : {})}
          />
        );
      })}

      {/* Empty state */}
      {!loading && accounts.length === 0 && removedAccounts.length === 0 && (
        <div className="rounded-2xl bg-white dark:bg-[#1E1E1E] shadow-card px-4 py-10 text-center">
          <p className="text-[14px] font-medium text-black dark:text-white">No accounts yet</p>
          <p className="text-[12px] text-[#8E8E93] mt-1">
            Click <strong>Add Account</strong> to sign in, or make sure Claude Code is running.
          </p>
        </div>
      )}

      {/* Deleted Accounts section */}
      {removedAccounts.length > 0 && (
        <div className="pt-3">
          <div className="mb-2">
            <span className="section-label">Deleted Accounts</span>
          </div>
          <div className="space-y-2">
            {removedAccounts.map((account) => (
              <div key={account.id} className="glass-card p-3">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-black dark:text-white truncate">
                      {account.displayName || account.email}
                    </p>
                    {account.displayName && (
                      <p className="text-[11px] text-[#8E8E93] truncate">{account.email}</p>
                    )}
                    {account.orgName && (
                      <p className="text-[11px] text-[#8E8E93] truncate">{account.orgName}</p>
                    )}
                  </div>
                  <button
                    onClick={() => void handlePurge(account.id)}
                    disabled={purgingId === account.id}
                    className="flex-shrink-0 flex items-center gap-1 text-[11px] font-semibold
                               text-ios-red/70 hover:text-ios-red disabled:opacity-40
                               active:scale-95 transition-all"
                    title="Permanently delete account and all data"
                  >
                    {purgingId === account.id
                      ? <Loader2 size={11} className="animate-spin" />
                      : <Trash2 size={11} strokeWidth={2.2} />
                    }
                    Delete Data
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
