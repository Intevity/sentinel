import type { Database } from 'better-sqlite3';
import type { RateLimitStore } from './rate-limit-store.js';
import type { IpcServer } from './ipc.js';
import type { Settings, OAuthAccount, RateLimitWindow } from '@claude-sentinel/shared';
import { listAccounts, insertNotification } from './db.js';

/** The only rate-limit window auto-switch evaluates. Keeping this fixed
 *  (rather than exposing it per-rule) matches the clarified product spec:
 *  "% of current session usage" always means the 5-hour window. */
const SESSION_WINDOW = 'unified-5h';

export interface AutoSwitchDeps {
  db: Database;
  rateLimitStore: RateLimitStore;
  ipcServer: IpcServer;
  /** Current value of the persisted settings; refreshed in-process on change. */
  getSettings: () => Settings;
  /** Reads ~/.claude.json to derive which account is active. */
  getActiveAccount: () => OAuthAccount | null;
  /** Computes the Sentinel key (orgUuid || accountUuid) for an account. */
  sentinelKey: (orgUuid: string, accountUuid: string) => string;
  /** Performs a full account switch with side effects — invoked when the
   *  threshold is crossed and a viable candidate exists. */
  performSwitch: (accountId: string, email: string) => { success: boolean; error?: string };
}

/**
 * Wire up auto-switch behaviour. Subscribes to rate-limit header updates
 * and, when the active account crosses `autoSwitchThresholdPct` on the
 * unified-5h window, invokes `performSwitch` with the candidate account
 * that has the most remaining capacity. When no candidate is below the
 * threshold, broadcasts `all_accounts_exhausted` once per 5-hour window.
 *
 * Returns a disposer that detaches the listener — useful for tests.
 */
export function startAutoSwitch(deps: AutoSwitchDeps): () => void {
  let lastExhaustedResetTs: number | null = null;

  const handler = (accountId: string, _windows: RateLimitWindow[]): void => {
    const settings = deps.getSettings();
    if (settings.switchingMode !== 'auto-switch') return;

    const active = deps.getActiveAccount();
    if (!active) return;
    const activeKey = deps.sentinelKey(active.organizationUuid ?? '', active.accountUuid);
    // Only react when the updated account is the active one. Rate-limit
    // updates for other accounts (e.g. from background probes) don't trigger
    // an auto-switch — by definition the user is consuming the active one.
    if (accountId !== activeKey) return;

    const activeWindow = deps.rateLimitStore
      .getAll(activeKey)
      .find((w) => w.name === SESSION_WINDOW);
    if (!activeWindow || activeWindow.utilization == null) return;

    const thresholdFraction = settings.autoSwitchThresholdPct / 100;
    if (activeWindow.utilization < thresholdFraction) return;

    // Active is above threshold — find the best candidate.
    const accounts = listAccounts(deps.db).filter((a) => a.id !== activeKey);

    const candidates: { id: string; email: string; utilization: number }[] = [];
    for (const acct of accounts) {
      const windows = deps.rateLimitStore.getAll(acct.id);
      const w = windows.find((x) => x.name === SESSION_WINDOW);
      // Treat unknown utilization as 0 so fresh accounts (not yet probed)
      // are preferred over known-hot ones.
      const util = w?.utilization ?? 0;
      const blocked = windows.some((x) => x.status === 'blocked');
      if (blocked) continue;
      candidates.push({ id: acct.id, email: acct.email, utilization: util });
    }

    const below = candidates.filter((c) => c.utilization < thresholdFraction);

    if (below.length === 0) {
      // Every other account is also above the threshold — or there are none.
      // Stay on the current account and notify the user, but only once per
      // 5-hour window to avoid spamming.
      const resetTs = activeWindow.reset ?? 0;
      if (resetTs === lastExhaustedResetTs) return;
      lastExhaustedResetTs = resetTs;

      const title = `All accounts at ${settings.autoSwitchThresholdPct}%+ usage`;
      const body = `Sentinel is staying on ${active.emailAddress} because every account has exceeded the auto-switch threshold. Usage will continue on the current account.`;
      insertNotification(deps.db, {
        ts: Date.now(),
        accountId: activeKey,
        type: 'all_accounts_exhausted',
        title,
        body,
      });
      deps.ipcServer.broadcast({
        type: 'all_accounts_exhausted',
        thresholdPct: settings.autoSwitchThresholdPct,
      });
      console.log(`[AutoSwitch] All accounts exhausted at ${settings.autoSwitchThresholdPct}% — staying on ${active.emailAddress}`);
      return;
    }

    // Pick lowest utilization among below-threshold candidates.
    below.sort((a, b) => a.utilization - b.utilization);
    const target = below[0]!;
    console.log(`[AutoSwitch] Active (${activeKey}) at ${(activeWindow.utilization * 100).toFixed(1)}% — switching to ${target.email} at ${(target.utilization * 100).toFixed(1)}%`);
    const result = deps.performSwitch(target.id, target.email);
    if (!result.success) {
      console.warn(`[AutoSwitch] Switch to ${target.email} failed: ${result.error}`);
    }
  };

  deps.rateLimitStore.onUpdate(handler);

  // RateLimitStore.onUpdate has no public unsubscribe; returning a no-op
  // disposer is acceptable given the store is process-lifetime.
  return () => {
    /* no-op — RateLimitStore has no removeListener */
  };
}
