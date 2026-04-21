import type { Database } from 'better-sqlite3';
import type { RateLimitStore } from './rate-limit-store.js';
import type { IpcServer } from './ipc.js';
import type { RateLimitWindow, Settings } from '@claude-sentinel/shared';
import { listAlerts, listAccounts, markAlertTriggered, insertNotification } from './db.js';

/** Only evaluate alerts against the 5-hour window — see plan rationale. */
const SESSION_WINDOW = 'unified-5h';

export interface AlertEvaluatorDeps {
  db: Database;
  rateLimitStore: RateLimitStore;
  ipcServer: IpcServer;
  /** Optional — used to decorate notification titles/bodies with an email. */
  getEmailForAccount?: (accountId: string) => string | null;
}

export interface PoolAlertEvaluatorDeps extends AlertEvaluatorDeps {
  /** Live accessor for the current persisted settings. Used to skip pool
   *  evaluation outside round-robin mode and to filter out excluded accounts. */
  getSettings: () => Settings;
}

/**
 * Subscribe to rate-limit updates and fire user-configured per-account alerts
 * when the unified-5h window crosses a configured threshold.
 *
 * Re-firing within the same 5-hour window is blocked by comparing
 * `last_triggered_reset_ts` to the window's current `reset`. Once the window
 * rolls over (a new `reset` value arrives), the alert can fire again.
 *
 * Each trigger:
 *  - persists a notifications row (visible in the Alerts tab history)
 *  - broadcasts `alert_triggered` for the UI to fire a native OS notification
 *  - updates `alerts.last_triggered_reset_ts`
 */
export function startAlertEvaluator(deps: AlertEvaluatorDeps): void {
  const handler = (accountId: string, _windows: RateLimitWindow[]): void => {
    const session = deps.rateLimitStore.getAll(accountId).find((w) => w.name === SESSION_WINDOW);
    if (!session || session.utilization == null) return;

    const alerts = listAlerts(deps.db, { scope: 'account', accountId }).filter((a) => a.enabled);
    if (alerts.length === 0) return;

    const utilPct = session.utilization * 100;
    const resetTs = session.reset ?? 0;

    for (const alert of alerts) {
      if (utilPct < alert.thresholdPct) continue;
      if (alert.lastTriggeredResetTs === resetTs) continue;

      const email = deps.getEmailForAccount?.(accountId) ?? accountId;
      const title = `Sentinel: ${alert.thresholdPct}% usage reached`;
      const body = `${email} has used ${utilPct.toFixed(1)}% of its 5-hour window.`;

      insertNotification(deps.db, {
        ts: Date.now(),
        accountId,
        type: 'usage_alert',
        title,
        body,
      });

      deps.ipcServer.broadcast({
        type: 'alert_triggered',
        alertId: alert.id,
        accountId,
        scope: 'account',
        thresholdPct: alert.thresholdPct,
        utilization: session.utilization,
      });

      markAlertTriggered(deps.db, alert.id, resetTs);
      console.log(
        `[Alerts] Fired alert ${alert.id} (${alert.thresholdPct}%) on ${accountId} at ${utilPct.toFixed(1)}%`,
      );
    }
  };

  deps.rateLimitStore.onUpdate(handler);
}

/**
 * Snapshot of the pool's aggregate 5-hour state. `utilPct` is the arithmetic
 * mean of each pool member's unified-5h utilization (missing treated as 0
 * so fresh, unprobed accounts don't artificially lower the mean). `resetTs`
 * is the minimum `reset` timestamp across pool members — i.e. the earliest
 * any pool window will roll over. Zero when no pool member has observed
 * reset headers yet.
 *
 * Returns null when pool has zero eligible members (no enrolled accounts, or
 * all are excluded).
 */
function computePoolSnapshot(
  db: Database,
  rateLimitStore: RateLimitStore,
  excluded: ReadonlySet<string>,
): { utilPct: number; resetTs: number; memberCount: number } | null {
  const members = listAccounts(db).filter((a) => !excluded.has(a.id));
  if (members.length === 0) return null;
  let sumUtil = 0;
  let minReset = Number.POSITIVE_INFINITY;
  for (const m of members) {
    const w = rateLimitStore.getAll(m.id).find((x) => x.name === SESSION_WINDOW);
    sumUtil += w?.utilization ?? 0;
    if (w?.reset != null) minReset = Math.min(minReset, w.reset);
  }
  return {
    utilPct: (sumUtil / members.length) * 100,
    resetTs: minReset === Number.POSITIVE_INFINITY ? 0 : minReset,
    memberCount: members.length,
  };
}

/**
 * Fire any enabled pool-scoped alerts whose threshold is crossed by the
 * current pool-wide mean utilization. Called both on every rate-limit
 * update (via startPoolAlertEvaluator) and eagerly when `poolExcludedIds`
 * changes so the re-composed pool's utilization is re-checked immediately.
 */
export function evaluatePoolOnce(deps: PoolAlertEvaluatorDeps): void {
  const settings = deps.getSettings();
  if (settings.switchingMode !== 'round-robin') return;
  const excluded = new Set(settings.poolExcludedIds);
  const snapshot = computePoolSnapshot(deps.db, deps.rateLimitStore, excluded);
  if (!snapshot) return;

  const alerts = listAlerts(deps.db, { scope: 'pool' }).filter((a) => a.enabled);
  if (alerts.length === 0) return;

  for (const alert of alerts) {
    if (snapshot.utilPct < alert.thresholdPct) continue;
    if (alert.lastTriggeredResetTs === snapshot.resetTs) continue;

    const title = `Sentinel: pool at ${alert.thresholdPct}%`;
    const body = `Round-robin pool has used ${snapshot.utilPct.toFixed(1)}% of its 5-hour window on average across ${snapshot.memberCount} account${snapshot.memberCount === 1 ? '' : 's'}.`;

    insertNotification(deps.db, {
      ts: Date.now(),
      accountId: null,
      type: 'usage_alert',
      title,
      body,
    });

    deps.ipcServer.broadcast({
      type: 'alert_triggered',
      alertId: alert.id,
      accountId: null,
      scope: 'pool',
      thresholdPct: alert.thresholdPct,
      utilization: snapshot.utilPct / 100,
    });

    markAlertTriggered(deps.db, alert.id, snapshot.resetTs);
    console.log(
      `[Alerts] Fired pool alert ${alert.id} (${alert.thresholdPct}%) at ${snapshot.utilPct.toFixed(1)}%`,
    );
  }
}

/**
 * Wire the pool-alert evaluator to rate-limit updates. Every time any
 * account's rate-limit headers land we recompute the pool mean and fire any
 * pool alerts whose threshold is crossed. No-op when switching mode is not
 * round-robin, or when the updated account is excluded from the pool (the
 * pool mean can't change in that case).
 */
export function startPoolAlertEvaluator(deps: PoolAlertEvaluatorDeps): void {
  deps.rateLimitStore.onUpdate((accountId) => {
    const settings = deps.getSettings();
    if (settings.switchingMode !== 'round-robin') return;
    if (settings.poolExcludedIds.includes(accountId)) return;
    evaluatePoolOnce(deps);
  });
}

/**
 * Prevent a newly-created alert from firing in the window where it was born.
 *
 * Without this, an alert whose threshold is already met at creation time will
 * fire on the first rate-limit header update that follows — because
 * `last_triggered_reset_ts` starts as NULL and the evaluator's re-fire guard
 * (`lastTriggeredResetTs === resetTs`) is bypassed by the NULL comparison.
 *
 * If current 5h utilization is already at or above the threshold, we mark the
 * alert as if it had fired in this window. The evaluator then skips it until
 * the window rolls over (new `reset` value), which is the desired
 * edge-triggered behavior.
 *
 * Handles both scopes: per-account alerts check the bound account's window;
 * pool alerts check the current pool snapshot.
 */
export function primeNewAlertAgainstCurrentWindow(
  db: Database,
  rateLimitStore: RateLimitStore,
  alert: {
    id: number;
    scope: 'account' | 'pool' | 'budget';
    accountId: string | null;
    thresholdPct: number;
  },
  getSettings?: () => Settings,
): void {
  // Budget-scope alerts have their own priming path on spend-tracker init;
  // they don't fire off rate-limit headers.
  if (alert.scope === 'budget') return;
  if (alert.scope === 'pool') {
    // Pool alerts require access to settings for the exclusion list.
    const settings = getSettings?.();
    if (!settings) return;
    const excluded = new Set(settings.poolExcludedIds);
    const snapshot = computePoolSnapshot(db, rateLimitStore, excluded);
    if (!snapshot) return;
    if (snapshot.utilPct < alert.thresholdPct) return;
    markAlertTriggered(db, alert.id, snapshot.resetTs);
    return;
  }
  if (!alert.accountId) return;
  const session = rateLimitStore.getAll(alert.accountId).find((w) => w.name === SESSION_WINDOW);
  if (!session || session.utilization == null) return;
  const utilPct = session.utilization * 100;
  if (utilPct < alert.thresholdPct) return;
  markAlertTriggered(db, alert.id, session.reset ?? 0);
}
