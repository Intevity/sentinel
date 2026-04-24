import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Plus, Loader2, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import AccountCard from './AccountCard.js';
import { useAccounts } from '../hooks/useAccounts.js';
import {
  useAllRateLimits,
  fiveHourUtilization,
  fiveHourResetAt,
} from '../hooks/useAllRateLimits.js';
import { useSettings } from '../hooks/useSettings.js';
import { usePausedAccounts } from '../hooks/usePausedAccounts.js';
import { QuickSegmented } from './settings/primitives.js';
import RoundRobinStrategyMenu from './RoundRobinStrategyMenu.js';
import type { SwitchingMode, RoundRobinStrategy } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';
import { DUR, EASE_OUT } from '../lib/motion.js';

const TRANSIENT_ANIM = {
  initial: { opacity: 0, y: -8, height: 0 },
  animate: { opacity: 1, y: 0, height: 'auto' as const },
  exit: { opacity: 0, height: 0 },
  transition: { duration: DUR.med, ease: EASE_OUT },
};

interface AccountSwitcherProps {
  /** Called after an account is removed or purged so the parent can refresh useDaemon state. */
  onAccountsChanged?: () => void;
}

export default function AccountSwitcher({
  onAccountsChanged,
}: AccountSwitcherProps): React.ReactElement {
  const {
    accounts,
    removedAccounts,
    loading,
    error,
    switchAccount,
    removeAccount,
    purgeAccount,
    refreshAccounts,
    refreshToken,
  } = useAccounts();
  const { byAccount: rateLimitsByAccount } = useAllRateLimits();
  const { settings, update } = useSettings();
  const pausedMap = usePausedAccounts();
  const isRoundRobin = settings?.switchingMode === 'round-robin';
  // Pool-exclusion set (RR only). `poolExcludedIds` may contain stale IDs
  // of removed accounts — harmless because the rotator filters against the
  // live account list; we do the same here when counting members.
  const excludedIds = React.useMemo(
    () => new Set(settings?.poolExcludedIds ?? []),
    [settings?.poolExcludedIds],
  );
  const poolMemberCount = accounts.reduce((n, a) => (excludedIds.has(a.id) ? n : n + 1), 0);

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
  // Per-account status for the page-level Refresh fan-out: spinner while the
  // /api/oauth/usage fetch is in flight, then a brief green check or red X.
  // Auto-clears after a short delay so the card settles back to its normal
  // 5h pill. Keyed by accountId; absence means the card is resting.
  type CardRefreshStatus =
    | { status: 'loading' }
    | { status: 'ok' }
    | { status: 'err'; error: string };
  const [cardRefreshStatus, setCardRefreshStatus] = useState<Record<string, CardRefreshStatus>>({});
  const cardRefreshTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      for (const t of cardRefreshTimersRef.current.values()) clearTimeout(t);
      cardRefreshTimersRef.current.clear();
    };
  }, []);

  const refreshInFlight = Object.values(cardRefreshStatus).some((s) => s.status === 'loading');

  const handleRefreshClick = useCallback(async (): Promise<void> => {
    // Cancel any lingering auto-clear timers so a quick second click doesn't
    // prematurely erase the status of the new refresh.
    for (const t of cardRefreshTimersRef.current.values()) clearTimeout(t);
    cardRefreshTimersRef.current.clear();

    const targetIds = accounts.map((a) => a.id);

    // Fire the DB sync regardless of whether there are accounts yet — a new
    // one may have just been added on the claude-code side and we still
    // want to pick it up.
    const syncPromise = refreshAccounts();

    if (targetIds.length === 0) {
      await syncPromise;
      return;
    }

    setCardRefreshStatus(() => {
      const next: Record<string, CardRefreshStatus> = {};
      for (const id of targetIds) next[id] = { status: 'loading' };
      return next;
    });

    // Fire both in parallel per account: refresh_claude_ai_usage is free
    // and covers auth liveness + overage/extra-usage numbers;
    // probe_rate_limits costs ~1 Haiku token and is what actually advances
    // the 5h-reset countdown (claude.ai's usage endpoint often returns
    // null for that field). Only the usage call's result drives the
    // per-card OK/error chip — the probe broadcasts rate_limits_updated
    // on its own and is best-effort.
    const usageResults = await Promise.all(
      targetIds.map((id) => {
        void sendToSentinel({ type: 'probe_rate_limits', accountId: id }).catch(() => undefined);
        return sendToSentinel({ type: 'refresh_claude_ai_usage', accountId: id })
          .then((res) => ({
            id,
            ok: !!res.success,
            error: res.error ?? null,
          }))
          .catch((err: unknown) => ({
            id,
            ok: false,
            error: err instanceof Error ? err.message : 'Refresh failed',
          }));
      }),
    );
    await syncPromise;

    setCardRefreshStatus((prev) => {
      const next = { ...prev };
      for (const r of usageResults) {
        next[r.id] = r.ok
          ? { status: 'ok' }
          : { status: 'err', error: r.error ?? 'Refresh failed' };
      }
      return next;
    });

    // Auto-clear: success chips settle quickly, errors linger so the user
    // has time to hover the tooltip and read the reason.
    for (const r of usageResults) {
      const ms = r.ok ? 1500 : 3000;
      const t = setTimeout(() => {
        setCardRefreshStatus((prev) => {
          if (!prev[r.id]) return prev;
          const next = { ...prev };
          delete next[r.id];
          return next;
        });
        cardRefreshTimersRef.current.delete(r.id);
      }, ms);
      cardRefreshTimersRef.current.set(r.id, t);
    }
  }, [accounts, refreshAccounts]);
  const [loggingIn, setLoggingIn] = useState(false);
  // When non-null, the pre-Add-Account confirmation sheet is open. We show
  // this the first time a user with at least one existing account clicks
  // Add Account, so they can acknowledge claude.ai's limitation around
  // switching identities mid-OAuth and opt into a private-browser open.
  // null = sheet closed. Suppressed entirely on the first-ever Add Account
  // (accounts.length === 0) and on re-auth (same-email, no identity switch).
  const [pendingAddAccountConfirm, setPendingAddAccountConfirm] = useState<boolean>(false);
  // Checkbox state inside the confirmation sheet. Controls whether the
  // daemon opens the OAuth URL in a private-mode browser (Chrome / Brave /
  // Edge / Arc / Firefox, whichever is installed).
  const [addAccountIncognito, setAddAccountIncognito] = useState<boolean>(false);
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [purgingId, setPurgingId] = useState<string | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  // Accounts flagged by the daemon as having an expired/revoked refresh token.
  // Cleared when token_refreshed or login_complete fires for the same account.
  const [expiredAccountIds, setExpiredAccountIds] = useState<Set<string>>(new Set());
  // Session-scoped round-robin suggestion. Shown when the account count
  // crosses 1 → ≥2 while the user is not already in round-robin mode.
  // Re-arms on the next transition (i.e. adding a third account after
  // dismissing on the second); dismissal does not persist across restarts
  // by design — the user might want to revisit the prompt later.
  const [rrSuggestionVisible, setRrSuggestionVisible] = useState(false);
  const [enablingRoundRobin, setEnablingRoundRobin] = useState(false);

  const prevAccountCountRef = useRef<number>(accounts.length);
  useEffect(() => {
    const prev = prevAccountCountRef.current;
    if (
      prev === 1 &&
      accounts.length >= 2 &&
      settings &&
      settings.switchingMode !== 'round-robin'
    ) {
      setRrSuggestionVisible(true);
    }
    prevAccountCountRef.current = accounts.length;
  }, [accounts.length, settings]);
  // If the user switches into round-robin via Settings while the banner is
  // up, dismiss it — the suggestion no longer applies.
  useEffect(() => {
    if (settings?.switchingMode === 'round-robin' && rrSuggestionVisible) {
      setRrSuggestionVisible(false);
    }
  }, [settings?.switchingMode, rrSuggestionVisible]);

  const enableRoundRobin = async (): Promise<void> => {
    setEnablingRoundRobin(true);
    try {
      await sendToSentinel({ type: 'update_settings', settings: { switchingMode: 'round-robin' } });
      setRrSuggestionVisible(false);
      setStatusMessage({
        text: 'Round-robin enabled. Sentinel will rotate requests across your accounts.',
        kind: 'success',
      });
      setTimeout(() => setStatusMessage(null), 6000);
    } catch {
      setStatusMessage({
        text: 'Failed to enable round-robin. Try again from Settings.',
        kind: 'error',
      });
    } finally {
      setEnablingRoundRobin(false);
    }
  };

  // Snapshot of account IDs when login started — used by the polling fallback
  const initialAccountIdsRef = useRef<Set<string>>(new Set());
  // Ref so the focus handler always reads the current loggingIn value
  const loggingInRef = useRef(false);
  useEffect(() => {
    loggingInRef.current = loggingIn;
  }, [loggingIn]);

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

  // Auto-fire a free auth-liveness check for every account on mount and
  // every time the tray window regains focus. If an account's OAuth token
  // was revoked server-side while the app was closed, the daemon's inline
  // force-refresh cascade lights up the Re-authenticate banner within
  // seconds of the user opening the tray — so the user doesn't discover
  // the dead token by failing to run a Claude Code command. No Haiku cost:
  // refresh_claude_ai_usage only hits /api/oauth/usage.
  const accountIdsKey = accounts.map((a) => a.id).join(',');
  useEffect(() => {
    if (accounts.length === 0) return;
    const fireAuthCheck = (): void => {
      for (const a of accounts) {
        void sendToSentinel({ type: 'refresh_claude_ai_usage', accountId: a.id }).catch(
          () => undefined,
        );
      }
    };
    fireAuthCheck();
    window.addEventListener('focus', fireAuthCheck);
    return () => window.removeEventListener('focus', fireAuthCheck);
    // accountIdsKey captures the set of IDs so re-mounts after add/remove
    // re-arm the focus listener with the current accounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountIdsKey]);

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
              `Signed in to ${msg.orgName ?? msg.email}: this org was already added, token refreshed.\n` +
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
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [refreshAccounts, accounts]);

  // Polling fallback while login is in progress
  useEffect(() => {
    if (!loggingIn) return;
    initialAccountIdsRef.current = new Set(accounts.map((a) => a.id));
    const interval = setInterval(() => {
      void refreshAccounts();
    }, 2000);
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

  // Actually fires the start_login IPC. Split from handleAddAccount so
  // the reauth path (same email) and the confirmed-new-account path can
  // both call this directly, bypassing the confirmation sheet.
  const startLogin = async (incognito: boolean): Promise<void> => {
    setLoggingIn(true);
    setStatusMessage(null);
    try {
      await sendToSentinel({ type: 'start_login', ...(incognito ? { incognito: true } : {}) });
    } catch {
      setLoggingIn(false);
      setStatusMessage({ text: 'Failed to start login.', kind: 'error' });
    }
  };

  const handleAddAccount = async (): Promise<void> => {
    // If this is the user's first account, no existing claude.ai session
    // can get in the way — go straight to OAuth in the default browser.
    if (accounts.length === 0) {
      await startLogin(false);
      return;
    }
    // Otherwise, surface the confirmation sheet so the user can opt into
    // a private window if they're adding a different email.
    setStatusMessage(null);
    setAddAccountIncognito(false);
    setPendingAddAccountConfirm(true);
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
        <div className="flex items-center gap-2">
          <span className="section-label">Accounts</span>
          {settings && (
            <div data-tour-id="switching-mode" className="flex items-center gap-1">
              <QuickSegmented<SwitchingMode>
                ariaLabel="Account switching mode"
                value={settings.switchingMode}
                onChange={(v) => void update({ switchingMode: v }).catch(() => undefined)}
                options={[
                  { value: 'off', label: 'Manual', title: 'You pick the active account manually' },
                  {
                    value: 'round-robin',
                    label: 'Round-robin',
                    title: 'Proxy rotates tokens across enrolled accounts per request',
                  },
                ]}
              />
              <AnimatePresence initial={false}>
                {isRoundRobin && (
                  <motion.div
                    key="rr-strategy-menu"
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.85 }}
                    transition={{ duration: DUR.fast, ease: EASE_OUT }}
                    className="flex items-center"
                  >
                    <RoundRobinStrategyMenu
                      value={settings.roundRobinStrategy}
                      onChange={(v: RoundRobinStrategy) =>
                        void update({ roundRobinStrategy: v }).catch(() => undefined)
                      }
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void handleRefreshClick()}
            disabled={loading || refreshInFlight}
            className="text-[#8E8E93] hover:text-ios-blue disabled:opacity-40 transition-colors active:scale-90"
            title="Refresh accounts and usage"
          >
            <RefreshCw
              size={13}
              strokeWidth={2.5}
              className={loading || refreshInFlight ? 'animate-spin' : ''}
            />
          </button>
          <button
            onClick={() => void handleAddAccount()}
            disabled={loggingIn || loading}
            data-tour-id="add-account"
            className="flex items-center gap-1 text-[11px] font-semibold text-ios-blue
                       disabled:opacity-40 transition-all active:scale-95"
            title="Add another account"
          >
            {loggingIn ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Plus size={12} strokeWidth={2.5} />
            )}
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
        {statusMessage &&
          (() => {
            const styles = {
              success: { bg: 'bg-ios-green/10 dark:bg-ios-green/15', fg: 'text-ios-green' },
              error: { bg: 'bg-ios-red/10 dark:bg-ios-red/15', fg: 'text-ios-red' },
              info: { bg: 'bg-ios-blue/10 dark:bg-ios-blue/15', fg: 'text-ios-blue' },
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

      {/* Round-robin suggestion — appears once per 1→≥2 transition while the
          user isn't in round-robin mode. Gives a one-click path from the
          Accounts tab instead of making them dig into Settings. */}
      <AnimatePresence initial={false}>
        {rrSuggestionVisible && (
          <motion.div
            {...TRANSIENT_ANIM}
            className="overflow-hidden rounded-2xl bg-ios-blue/[0.08] dark:bg-ios-blue/[0.12] ring-1 ring-ios-blue/20"
          >
            <div className="px-4 py-3">
              <p className="text-[12px] font-semibold text-ios-blue mb-1">Try round-robin?</p>
              <p className="text-[11px] text-[#8E8E93] leading-snug mb-2.5">
                With multiple accounts enrolled, Sentinel can rotate the OAuth token per request so
                usage drains across all of them. You can tune the strategy (balance vs. earliest
                reset) from Settings.
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void enableRoundRobin()}
                  disabled={enablingRoundRobin}
                  className="flex-1 text-[12px] font-semibold text-white bg-ios-blue hover:opacity-90 active:scale-95 px-3 py-1.5 rounded-full transition-all disabled:opacity-50"
                >
                  {enablingRoundRobin ? (
                    <Loader2 size={12} className="inline animate-spin" />
                  ) : (
                    'Switch to round-robin'
                  )}
                </button>
                <button
                  onClick={() => setRrSuggestionVisible(false)}
                  className="text-[12px] text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors px-2"
                >
                  Not now
                </button>
              </div>
            </div>
          </motion.div>
        )}
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

      {/* Add Account confirmation sheet. Shown when a user with ≥1 existing
          account clicks Add Account. Explains claude.ai's known limitation
          (the "switch accounts" link on the OAuth consent page drops OAuth
          state — same bug Claude Code has) and lets the user opt into a
          private-browser open if they're enrolling a different identity. */}
      <AnimatePresence initial={false}>
        {pendingAddAccountConfirm && (
          <motion.div
            {...TRANSIENT_ANIM}
            className="overflow-hidden rounded-2xl bg-ios-blue/[0.08] dark:bg-ios-blue/[0.12] ring-1 ring-ios-blue/20"
          >
            <div className="p-4">
              <p className="text-[13px] font-semibold text-black dark:text-white mb-1">
                Add another account
              </p>
              <p className="text-[11px] text-[#8E8E93] leading-snug mb-3">
                Re-authorizing the same email (to add another organization, for example) works in
                your default browser. Switching to a different email signs you out of claude.ai and
                drops the OAuth flow: the same limitation Claude Code has. For a different email,
                check the box below to complete sign-in in a private window.
              </p>
              <label className="flex items-center gap-2 cursor-pointer mb-3 select-none">
                <input
                  type="checkbox"
                  checked={addAccountIncognito}
                  onChange={(e) => setAddAccountIncognito(e.target.checked)}
                  className="accent-ios-blue w-4 h-4"
                />
                <span className="text-[12px] text-black dark:text-white">
                  Adding a different email (open in a private window)
                </span>
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setPendingAddAccountConfirm(false);
                    void startLogin(addAccountIncognito);
                  }}
                  className="flex-1 text-[12px] font-semibold text-white bg-ios-blue hover:opacity-90 active:scale-95 px-3 py-1.5 rounded-full transition-all"
                >
                  Continue
                </button>
                <button
                  onClick={() => setPendingAddAccountConfirm(false)}
                  className="text-[12px] text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors px-2"
                >
                  Cancel
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Remove confirmation prompt */}
      <AnimatePresence initial={false}>
        {pendingRemoveId &&
          (() => {
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
        const resetAt = fiveHourResetAt(rateLimitsByAccount[account.id]);
        const expired = expiredAccountIds.has(account.id);
        const inPool = !excludedIds.has(account.id);
        const weeklyCap =
          settings?.budgetWeeklyUsdByAccount[account.id] ?? settings?.budgetWeeklyUsdGlobal ?? null;
        const pausedState = pausedMap[account.id];
        const paused = pausedState != null;
        const pauseReason = pausedState?.reason ?? null;
        const cardStatus = cardRefreshStatus[account.id];
        return (
          <AccountCard
            key={account.id}
            account={account}
            onSwitch={(id, email) => void handleSwitch(id, email)}
            onRemove={(id) => {
              setStatusMessage(null);
              setPendingRemoveId(id);
            }}
            switching={switchingEmail === account.email}
            onRefreshToken={(id) => void handleRefreshToken(id)}
            refreshing={refreshingId === account.id}
            needsReauth={expired}
            onReauth={() => void startLogin(true)}
            isRoundRobin={isRoundRobin}
            inPool={inPool}
            canExclude={poolMemberCount > 1}
            onTogglePool={togglePoolMembership}
            {...(util != null ? { fiveHourUtil: util } : {})}
            fiveHourResetAt={resetAt}
            weeklyCapUsd={weeklyCap}
            paused={paused}
            pauseReason={pauseReason}
            {...(cardStatus ? { refreshUsageStatus: cardStatus.status } : {})}
            refreshUsageError={cardStatus?.status === 'err' ? cardStatus.error : null}
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
                    {purgingId === account.id ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Trash2 size={11} strokeWidth={2.2} />
                    )}
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
