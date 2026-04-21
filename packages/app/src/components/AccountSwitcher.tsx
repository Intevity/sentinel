import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Plus, Loader2, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { invoke } from '@tauri-apps/api/core';
import AccountCard from './AccountCard.js';
import { useAccounts } from '../hooks/useAccounts.js';
import { useAllRateLimits, fiveHourUtilization, fiveHourResetAt } from '../hooks/useAllRateLimits.js';
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
  const [refreshStatus, setRefreshStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const refreshStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleRefreshClick = useCallback(async (): Promise<void> => {
    const result = await refreshAccounts();
    if (refreshStatusTimerRef.current) clearTimeout(refreshStatusTimerRef.current);
    setRefreshStatus(result.ok
      ? { kind: 'ok', text: 'Updated' }
      : { kind: 'err', text: result.error ?? 'Failed' });
    refreshStatusTimerRef.current = setTimeout(() => setRefreshStatus(null), 3000);
  }, [refreshAccounts]);
  const [loggingIn, setLoggingIn] = useState(false);
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

  // Sibling enrollment prompt state. Fired by the daemon after a
  // sessionKey is captured when `/api/bootstrap` reveals additional
  // chat-capable orgs the user can access with the same login.
  //
  // `siblingOffer` is the latest broadcast payload (email + remaining
  // org list). When non-null the banner is visible. `siblingAdding`
  // tracks whether we're currently walking the user through adding
  // them — once set, each `login_complete` automatically kicks off
  // OAuth for the next sibling instead of waiting for another click.
  const [siblingOffer, setSiblingOffer] = useState<{
    email: string;
    orgs: Array<{ orgUuid: string; orgName: string }>;
  } | null>(null);
  const [siblingAdding, setSiblingAdding] = useState(false);
  // Mirror to a ref so the login_complete callback can read the live
  // value without forcing the effect to re-subscribe on every change.
  const siblingAddingRef = useRef(false);
  useEffect(() => { siblingAddingRef.current = siblingAdding; }, [siblingAdding]);
  const siblingOfferRef = useRef<typeof siblingOffer>(null);
  useEffect(() => { siblingOfferRef.current = siblingOffer; }, [siblingOffer]);
  const prevAccountCountRef = useRef<number>(accounts.length);
  useEffect(() => {
    const prev = prevAccountCountRef.current;
    if (prev === 1 && accounts.length >= 2 && settings && settings.switchingMode !== 'round-robin') {
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
      setStatusMessage({ text: 'Round-robin enabled. Sentinel will rotate requests across your accounts.', kind: 'success' });
      setTimeout(() => setStatusMessage(null), 6000);
    } catch {
      setStatusMessage({ text: 'Failed to enable round-robin. Try again from Settings.', kind: 'error' });
    } finally {
      setEnablingRoundRobin(false);
    }
  };

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
      if (msg.type === 'additional_orgs_available') {
        // Daemon has just discovered the user has more chat-capable
        // orgs on this sessionKey than we have Sentinel rows for. The
        // list is incremental — re-broadcast after each sibling is
        // added with the remainder. Empty list means we're done.
        if (msg.orgs.length === 0) {
          setSiblingOffer(null);
          setSiblingAdding(false);
        } else {
          setSiblingOffer({ email: msg.email, orgs: msg.orgs });
          // If we're mid-walk (user clicked Add Remaining earlier),
          // auto-advance to the next OAuth round. The next broadcast
          // after that round completes will either narrow the list or
          // clear it.
          if (siblingAddingRef.current) {
            void (async () => {
              try {
                await sendToSentinel({ type: 'start_login' });
                setLoggingIn(true);
              } catch {
                setSiblingAdding(false);
                setStatusMessage({ text: 'Failed to start login for the next account.', kind: 'error' });
              }
            })();
          }
        }
        return;
      }
      if (msg.type === 'oauth_authorize_url') {
        // Daemon has generated the OAuth authorize URL and wants it
        // opened. We hand it to a Tauri WebviewWindow instead of the
        // system browser so claude.ai's cookies land in the app's own
        // cookie store — the Connect claude.ai flow that fires after
        // the new account appears then finds the sessionKey without
        // a second login. `orgUuidHint`, when present, tells the Rust
        // side to warm up the WKHTTPCookieStore with the target
        // org's `lastActiveOrg` cookie before navigating to the
        // OAuth URL, so claude.ai preselects the right org and skips
        // the chooser (used by the sibling-enrollment walk). Errors
        // are logged but not surfaced; the daemon's callback server
        // stays alive either way.
        void invoke('open_oauth_webview', {
          url: msg.url,
          ...(msg.orgUuidHint ? { orgUuidHint: msg.orgUuidHint } : {}),
        }).catch((e: unknown) => {
          console.warn('[OAuth] open_oauth_webview failed:', e);
        });
        return;
      }
      if (msg.type === 'login_complete') {
        setLoggingIn(false);
        if (!msg.email) {
          // A failed/cancelled login aborts any in-flight sibling walk;
          // resuming would surprise the user (they likely cancelled on
          // purpose).
          setSiblingAdding(false);
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
        void (async () => {
          await refreshAccounts();
          // Auto-kick the Connect claude.ai flow for the freshly-
          // added account. The OAuth webview we just opened left
          // claude.ai cookies (including the HttpOnly sessionKey) in
          // the shared WKHTTPCookieStore; the claude.ai login webview
          // that `start_claude_ai_login` spins up will scrape them in
          // <200ms without requiring a second user login. Skip when
          // it's a re-auth of an existing account — that path
          // already keeps whatever sessionKey the user previously
          // captured and auto-reconnecting would surprise them.
          // Also skip when this was a silent-sibling enrollment:
          // that path has already mirrored the sessionKey in the
          // daemon, and auto-kicking Connect would pop a visible
          // webview, erasing the "no window" UX we just shipped.
          if (msg.reauth || msg.silent) return;
          // Find the latest account row for this email. The daemon
          // upserts synchronously before broadcasting, so by the
          // time refreshAccounts returns it's in state. Take the one
          // with the highest createdAt (most recent) to disambiguate
          // same-email + different-org cases.
          const latest = await sendToSentinel<import('@claude-sentinel/shared').AccountInfo[]>({ type: 'refresh_accounts' });
          if (!latest.success || !latest.data) return;
          const candidate = latest.data
            .filter((a) => a.email === msg.email)
            .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
          if (!candidate) return;
          try {
            await invoke('start_claude_ai_login', { accountId: candidate.id });
          } catch (e) {
            console.warn('[OAuth] auto-connect after login_complete failed:', e);
          }
        })();
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

  const handleAddRemainingSiblings = async (): Promise<void> => {
    setSiblingAdding(true);
    setStatusMessage(null);
    const firstMissing = siblingOffer?.orgs[0]?.orgUuid;
    const email = siblingOffer?.email;
    if (!firstMissing || !email) {
      setSiblingAdding(false);
      return;
    }
    // Silent server-to-server enrollment: reuses the shared sessionKey
    // to pull an OAuth token for the target org without opening any
    // webview. The daemon falls back to the browser/webview flow
    // automatically if claude.ai refuses the silent path (Cloudflare
    // challenge, sessionKey expired, etc.), so the user still gets
    // enrolled in that case — just with a visible window.
    try {
      await sendToSentinel({
        type: 'silent_sibling_login',
        email,
        orgUuidHint: firstMissing,
      });
      setLoggingIn(true);
    } catch {
      setSiblingAdding(false);
      setStatusMessage({ text: 'Failed to start login.', kind: 'error' });
    }
  };

  const handleDismissSiblingOffer = (): void => {
    setSiblingOffer(null);
    setSiblingAdding(false);
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
        <div className="flex items-center gap-2">
          <span className="section-label">Accounts</span>
          {settings && (
            <div data-tour-id="switching-mode" className="flex items-center gap-1">
              <QuickSegmented<SwitchingMode>
                ariaLabel="Account switching mode"
                value={settings.switchingMode}
                onChange={(v) => void update({ switchingMode: v }).catch(() => undefined)}
                options={[
                  { value: 'off',         label: 'Manual',      title: 'You pick the active account manually' },
                  { value: 'round-robin', label: 'Round-robin', title: 'Proxy rotates tokens across enrolled accounts per request' },
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
          {refreshStatus && (
            <span className={`text-[10px] font-medium ${refreshStatus.kind === 'ok' ? 'text-ios-green' : 'text-ios-red'}`}>
              {refreshStatus.text}
            </span>
          )}
          <button
            onClick={() => void handleRefreshClick()}
            disabled={loading}
            className="text-[#8E8E93] hover:text-ios-blue disabled:opacity-40 transition-colors active:scale-90"
            title="Sync with Claude Code"
          >
            <RefreshCw size={13} strokeWidth={2.5} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => void handleAddAccount()}
            disabled={loggingIn || loading}
            data-tour-id="add-account"
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
            <p className="text-[12px] font-semibold text-ios-blue mb-1">
              Try round-robin?
            </p>
            <p className="text-[11px] text-[#8E8E93] leading-snug mb-2.5">
              With multiple accounts enrolled, Sentinel can rotate the OAuth token
              per request so usage drains across all of them. You can tune the
              strategy (balance vs. earliest reset) from Settings.
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void enableRoundRobin()}
                disabled={enablingRoundRobin}
                className="flex-1 text-[12px] font-semibold text-white bg-ios-blue hover:opacity-90 active:scale-95 px-3 py-1.5 rounded-full transition-all disabled:opacity-50"
              >
                {enablingRoundRobin
                  ? <Loader2 size={12} className="inline animate-spin" />
                  : 'Switch to round-robin'}
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

      {/* Sibling account enrollment offer. Daemon fires
          `additional_orgs_available` after sessionKey capture when
          claude.ai reports the signed-in user has more chat-capable
          orgs than Sentinel has rows for. We surface the list with
          friendly org names and offer to walk the user through
          adding them one OAuth round at a time. Re-broadcasts after
          each added sibling narrow the list; empty list auto-clears
          this banner. */}
      <AnimatePresence initial={false}>
      {siblingOffer && (
        <motion.div
          {...TRANSIENT_ANIM}
          className="overflow-hidden rounded-2xl bg-ios-blue/[0.08] dark:bg-ios-blue/[0.12] ring-1 ring-ios-blue/20"
        >
          <div className="px-4 py-3">
            <p className="text-[12px] font-semibold text-ios-blue mb-1">
              {siblingAdding
                ? `Add ${siblingOffer.orgs[0]?.orgName || 'the next org'} next`
                : `More accounts for ${siblingOffer.email}`}
            </p>
            <p className="text-[11px] text-[#8E8E93] leading-snug mb-2">
              {siblingAdding
                ? 'Sign in at claude.ai and pick this org when the chooser appears:'
                : `You have ${siblingOffer.orgs.length} more claude.ai ${siblingOffer.orgs.length === 1 ? 'account' : 'accounts'} on this login. Add ${siblingOffer.orgs.length === 1 ? 'it' : 'them'}?`}
            </p>
            <ul className="text-[11px] text-black dark:text-white mb-2.5 space-y-0.5">
              {siblingOffer.orgs.map((o, i) => (
                <li key={o.orgUuid} className={i === 0 && siblingAdding ? 'font-semibold text-ios-blue' : ''}>
                  • {o.orgName || o.orgUuid}
                </li>
              ))}
            </ul>
            {!siblingAdding && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void handleAddRemainingSiblings()}
                  disabled={loggingIn}
                  className="flex-1 text-[12px] font-semibold text-white bg-ios-blue hover:opacity-90 active:scale-95 px-3 py-1.5 rounded-full transition-all disabled:opacity-50"
                >
                  {siblingOffer.orgs.length === 1 ? 'Add account' : 'Add all'}
                </button>
                <button
                  onClick={handleDismissSiblingOffer}
                  className="text-[12px] text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors px-2"
                >
                  Not now
                </button>
              </div>
            )}
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
                setSiblingAdding(false);
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
        const resetAt = fiveHourResetAt(rateLimitsByAccount[account.id]);
        const expired = expiredAccountIds.has(account.id);
        const inPool = !excludedIds.has(account.id);
        const weeklyCap =
          settings?.budgetWeeklyUsdByAccount[account.id]
          ?? settings?.budgetWeeklyUsdGlobal
          ?? null;
        const paused = !!pausedMap[account.id];
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
            fiveHourResetAt={resetAt}
            weeklyCapUsd={weeklyCap}
            paused={paused}
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
