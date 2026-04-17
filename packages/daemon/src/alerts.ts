import type { Database } from 'better-sqlite3';
import type { RateLimitStore } from './rate-limit-store.js';
import type { IpcServer } from './ipc.js';
import type { RateLimitWindow } from '@claude-sentinel/shared';
import { listAlerts, markAlertTriggered, insertNotification } from './db.js';

/** Only evaluate alerts against the 5-hour window — see plan rationale. */
const SESSION_WINDOW = 'unified-5h';

export interface AlertEvaluatorDeps {
  db: Database;
  rateLimitStore: RateLimitStore;
  ipcServer: IpcServer;
  /** Optional — used to decorate notification titles/bodies with an email. */
  getEmailForAccount?: (accountId: string) => string | null;
}

/**
 * Subscribe to rate-limit updates and fire user-configured alerts when the
 * unified-5h window crosses a configured threshold.
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
    const session = deps.rateLimitStore
      .getAll(accountId)
      .find((w) => w.name === SESSION_WINDOW);
    if (!session || session.utilization == null) return;

    const alerts = listAlerts(deps.db, accountId).filter((a) => a.enabled);
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
        thresholdPct: alert.thresholdPct,
        utilization: session.utilization,
      });

      markAlertTriggered(deps.db, alert.id, resetTs);
      console.log(`[Alerts] Fired alert ${alert.id} (${alert.thresholdPct}%) on ${accountId} at ${utilPct.toFixed(1)}%`);
    }
  };

  deps.rateLimitStore.onUpdate(handler);
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
 */
export function primeNewAlertAgainstCurrentWindow(
  db: Database,
  rateLimitStore: RateLimitStore,
  alert: { id: number; accountId: string; thresholdPct: number },
): void {
  const session = rateLimitStore
    .getAll(alert.accountId)
    .find((w) => w.name === SESSION_WINDOW);
  if (!session || session.utilization == null) return;
  const utilPct = session.utilization * 100;
  if (utilPct < alert.thresholdPct) return;
  markAlertTriggered(db, alert.id, session.reset ?? 0);
}
