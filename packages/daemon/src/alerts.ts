import type { Database } from 'better-sqlite3';
import type { RateLimitStore } from './rate-limit-store.js';
import type { IpcServer } from './ipc.js';
import type { AlertScope, RateLimitWindow, Settings } from '@claude-sentinel/shared';
import { listAlerts, listAccounts, markAlertTriggered, insertNotification } from './db.js';

/** Only evaluate alerts against the 5-hour window — see plan rationale. */
const SESSION_WINDOW = 'unified-5h';

/** Window name for Sonnet's weekly quota. `account-sonnet`-scoped alerts
 *  evaluate against this window rather than `unified-5h`. */
const SONNET_WINDOW = 'unified-7d_sonnet';

/** Window name for the general weekly quota (caps Opus and every other
 *  non-Sonnet model). `account-weekly` and `pool-weekly`-scoped alerts
 *  evaluate against this window. Distinct from SONNET_WINDOW — the two
 *  quotas are reported separately by Anthropic and a user may want
 *  independent thresholds on each. */
const WEEKLY_WINDOW = 'unified-7d';

/** Minimum advance in the session reset timestamp before an alert
 *  re-fires. The rate-limit store merges two data sources (proxy
 *  response headers and the claude.ai usage sync) that both describe
 *  the same logical 5h/7d window reset, but their timestamps can
 *  disagree — initially by ±1 second due to ISO-string rounding, and
 *  in practice by much more: Anthropic's two endpoints (proxy headers
 *  vs `/api/oauth/usage`) return `reset` values that drift by
 *  thousands of seconds inside the same window, so a small tolerance
 *  lets a single crossing fire the alert multiple times as the
 *  stored `reset` flips between sources.
 *
 *  Dedup tolerance is set to half the window length: any advance less
 *  than that is intra-window drift; a genuine rollover advances by a
 *  full window (5h = 18000 s, 7d = 604800 s) and still re-arms the
 *  alert. Keyed by window so the 5-hour and 7-day evaluators don't
 *  share a single too-tight or too-loose threshold. */
const WINDOW_DEDUP_TOLERANCE_SEC_5H = 9000;
const WINDOW_DEDUP_TOLERANCE_SEC_7D = 302400;

export interface AlertEvaluatorDeps {
  db: Database;
  rateLimitStore: RateLimitStore;
  ipcServer: IpcServer;
  /** Optional — used to decorate notification titles/bodies with an email. */
  getEmailForAccount?: (accountId: string) => string | null;
  /** Optional — when provided, the per-account and Sonnet evaluators skip
   *  accounts the user has excluded from the round-robin pool while
   *  `switchingMode === 'round-robin'`. Prevents false-positive notifications
   *  firing off rate-limit headers that arrive from background probes or
   *  claude.ai usage sync on accounts Sentinel is no longer routing to.
   *  Missing → legacy "always evaluate" behaviour. */
  getSettings?: () => Settings;
}

export interface PoolAlertEvaluatorDeps extends AlertEvaluatorDeps {
  /** Live accessor for the current persisted settings. Used to skip pool
   *  evaluation outside round-robin mode and to filter out excluded accounts. */
  getSettings: () => Settings;
}

/** Shared predicate: `true` when the given accountId is in the user's
 *  round-robin exclusion list AND round-robin is the active mode. Used by
 *  both per-account and Sonnet evaluators to stay silent on accounts the
 *  user has explicitly taken out of rotation. Outside round-robin mode
 *  `poolExcludedIds` is defined to be ignored, so the guard no-ops there. */
function isExcludedInRoundRobin(
  getSettings: (() => Settings) | undefined,
  accountId: string,
): boolean {
  const settings = getSettings?.();
  if (!settings) return false;
  if (settings.switchingMode !== 'round-robin') return false;
  return settings.poolExcludedIds.includes(accountId);
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

    if (isExcludedInRoundRobin(deps.getSettings, accountId)) return;

    const alerts = listAlerts(deps.db, { scope: 'account', accountId }).filter((a) => a.enabled);
    if (alerts.length === 0) return;

    const utilPct = session.utilization * 100;
    const resetTs = session.reset ?? 0;

    for (const alert of alerts) {
      if (utilPct < alert.thresholdPct) continue;
      if (
        alert.lastTriggeredResetTs != null &&
        resetTs > 0 &&
        resetTs - alert.lastTriggeredResetTs < WINDOW_DEDUP_TOLERANCE_SEC_5H
      ) {
        continue;
      }

      const email = deps.getEmailForAccount?.(accountId) ?? accountId;
      const title = `Sentinel: ${alert.thresholdPct}% usage reached`;
      const overageSuffix = utilPct > 100 ? ' (overage in use)' : '';
      const body = `${email} has used ${utilPct.toFixed(1)}% of its 5-hour window${overageSuffix}.`;

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
 * Snapshot of the pool's aggregate state for a given window name. `utilPct`
 * is the arithmetic mean of each pool member's utilization on the named
 * window (missing treated as 0 so fresh, unprobed accounts don't
 * artificially lower the mean). `resetTs` is the minimum `reset` timestamp
 * across pool members — i.e. the earliest any pool member's window will
 * roll over. Zero when no pool member has observed reset headers yet.
 *
 * Returns null when pool has zero eligible members (no enrolled accounts, or
 * all are excluded).
 *
 * `windowName` defaults to the 5-hour window to preserve the original call
 * sites; pass `WEEKLY_WINDOW` for the pool-weekly evaluator.
 */
function computePoolSnapshot(
  db: Database,
  rateLimitStore: RateLimitStore,
  excluded: ReadonlySet<string>,
  windowName: string = SESSION_WINDOW,
): { utilPct: number; resetTs: number; memberCount: number } | null {
  const members = listAccounts(db).filter((a) => !excluded.has(a.id));
  if (members.length === 0) return null;
  let sumUtil = 0;
  let minReset = Number.POSITIVE_INFINITY;
  for (const m of members) {
    const w = rateLimitStore.getAll(m.id).find((x) => x.name === windowName);
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
    if (
      alert.lastTriggeredResetTs != null &&
      snapshot.resetTs > 0 &&
      snapshot.resetTs - alert.lastTriggeredResetTs < WINDOW_DEDUP_TOLERANCE_SEC_5H
    ) {
      continue;
    }

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
 * Pool-weekly counterpart of `evaluatePoolOnce` — fires `pool-weekly`-scope
 * alerts when the mean `unified-7d` utilization across the round-robin pool
 * crosses a configured threshold. Mirrors the 5-hour pool evaluator but
 * reads the general weekly window instead, and only re-fires once per 7-day
 * rollover. Called both on every rate-limit update and eagerly when
 * `poolExcludedIds` changes.
 */
export function evaluateWeeklyPoolOnce(deps: PoolAlertEvaluatorDeps): void {
  const settings = deps.getSettings();
  if (settings.switchingMode !== 'round-robin') return;
  const excluded = new Set(settings.poolExcludedIds);
  const snapshot = computePoolSnapshot(deps.db, deps.rateLimitStore, excluded, WEEKLY_WINDOW);
  if (!snapshot) return;

  const alerts = listAlerts(deps.db, { scope: 'pool-weekly' }).filter((a) => a.enabled);
  if (alerts.length === 0) return;

  for (const alert of alerts) {
    if (snapshot.utilPct < alert.thresholdPct) continue;
    if (
      alert.lastTriggeredResetTs != null &&
      snapshot.resetTs > 0 &&
      snapshot.resetTs - alert.lastTriggeredResetTs < WINDOW_DEDUP_TOLERANCE_SEC_7D
    ) {
      continue;
    }

    const title = `Sentinel: pool weekly at ${alert.thresholdPct}%`;
    const body = `Round-robin pool has used ${snapshot.utilPct.toFixed(1)}% of its 7-day window on average across ${snapshot.memberCount} account${snapshot.memberCount === 1 ? '' : 's'}.`;

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
      scope: 'pool-weekly',
      thresholdPct: alert.thresholdPct,
      utilization: snapshot.utilPct / 100,
    });

    markAlertTriggered(deps.db, alert.id, snapshot.resetTs);
    console.log(
      `[Alerts] Fired pool-weekly alert ${alert.id} (${alert.thresholdPct}%) at ${snapshot.utilPct.toFixed(1)}%`,
    );
  }
}

/**
 * Wire the pool-weekly evaluator to rate-limit updates. Same gating as
 * `startPoolAlertEvaluator`: no-op outside round-robin, skip when the
 * updated account is excluded from the pool.
 */
export function startWeeklyPoolAlertEvaluator(deps: PoolAlertEvaluatorDeps): void {
  deps.rateLimitStore.onUpdate((accountId) => {
    const settings = deps.getSettings();
    if (settings.switchingMode !== 'round-robin') return;
    if (settings.poolExcludedIds.includes(accountId)) return;
    evaluateWeeklyPoolOnce(deps);
  });
}

/**
 * Subscribe to rate-limit updates and fire user-configured
 * `account-sonnet`-scope alerts when the unified-7d_sonnet window crosses
 * the configured threshold. Mirrors `startAlertEvaluator` but reads the
 * Sonnet window instead of the 5-hour window; re-fire is gated per-Sonnet
 * window reset so each alert fires at most once per 7-day rollover.
 */
export function startSonnetAlertEvaluator(deps: AlertEvaluatorDeps): void {
  const handler = (accountId: string, _windows: RateLimitWindow[]): void => {
    const sonnet = deps.rateLimitStore.getAll(accountId).find((w) => w.name === SONNET_WINDOW);
    if (!sonnet || sonnet.utilization == null) return;

    if (isExcludedInRoundRobin(deps.getSettings, accountId)) return;

    const alerts = listAlerts(deps.db, { scope: 'account-sonnet', accountId }).filter(
      (a) => a.enabled,
    );
    if (alerts.length === 0) return;

    const utilPct = sonnet.utilization * 100;
    const resetTs = sonnet.reset ?? 0;

    for (const alert of alerts) {
      if (utilPct < alert.thresholdPct) continue;
      if (
        alert.lastTriggeredResetTs != null &&
        resetTs > 0 &&
        resetTs - alert.lastTriggeredResetTs < WINDOW_DEDUP_TOLERANCE_SEC_7D
      ) {
        continue;
      }

      const email = deps.getEmailForAccount?.(accountId) ?? accountId;
      const title = `Sentinel: ${alert.thresholdPct}% Sonnet usage reached`;
      const overageSuffix = utilPct > 100 ? ' (overage in use)' : '';
      const body = `${email} has used ${utilPct.toFixed(1)}% of its Sonnet 7-day window${overageSuffix}.`;

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
        scope: 'account-sonnet',
        thresholdPct: alert.thresholdPct,
        utilization: sonnet.utilization,
      });

      markAlertTriggered(deps.db, alert.id, resetTs);
      console.log(
        `[Alerts] Fired sonnet alert ${alert.id} (${alert.thresholdPct}%) on ${accountId} at ${utilPct.toFixed(1)}%`,
      );
    }
  };

  deps.rateLimitStore.onUpdate(handler);
}

/**
 * Subscribe to rate-limit updates and fire user-configured
 * `account-weekly`-scope alerts when the unified-7d window crosses the
 * configured threshold. Mirrors `startSonnetAlertEvaluator` but reads the
 * general (non-Sonnet) weekly window; re-fire is gated per-weekly-window
 * reset so each alert fires at most once per 7-day rollover.
 *
 * Distinct from the `account-sonnet` evaluator: an account can saturate its
 * Sonnet 7-day quota while the general 7-day window is fresh (and vice
 * versa), and users frequently want different thresholds on each.
 */
export function startWeeklyAlertEvaluator(deps: AlertEvaluatorDeps): void {
  const handler = (accountId: string, _windows: RateLimitWindow[]): void => {
    const weekly = deps.rateLimitStore.getAll(accountId).find((w) => w.name === WEEKLY_WINDOW);
    if (!weekly || weekly.utilization == null) return;

    if (isExcludedInRoundRobin(deps.getSettings, accountId)) return;

    const alerts = listAlerts(deps.db, { scope: 'account-weekly', accountId }).filter(
      (a) => a.enabled,
    );
    if (alerts.length === 0) return;

    const utilPct = weekly.utilization * 100;
    const resetTs = weekly.reset ?? 0;

    for (const alert of alerts) {
      if (utilPct < alert.thresholdPct) continue;
      if (
        alert.lastTriggeredResetTs != null &&
        resetTs > 0 &&
        resetTs - alert.lastTriggeredResetTs < WINDOW_DEDUP_TOLERANCE_SEC_7D
      ) {
        continue;
      }

      const email = deps.getEmailForAccount?.(accountId) ?? accountId;
      const title = `Sentinel: ${alert.thresholdPct}% weekly usage reached`;
      const overageSuffix = utilPct > 100 ? ' (overage in use)' : '';
      const body = `${email} has used ${utilPct.toFixed(1)}% of its weekly 7-day window${overageSuffix}.`;

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
        scope: 'account-weekly',
        thresholdPct: alert.thresholdPct,
        utilization: weekly.utilization,
      });

      markAlertTriggered(deps.db, alert.id, resetTs);
      console.log(
        `[Alerts] Fired weekly alert ${alert.id} (${alert.thresholdPct}%) on ${accountId} at ${utilPct.toFixed(1)}%`,
      );
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
 *
 * Handles both scopes: per-account alerts check the bound account's window;
 * pool alerts check the current pool snapshot.
 */
export function primeNewAlertAgainstCurrentWindow(
  db: Database,
  rateLimitStore: RateLimitStore,
  alert: {
    id: number;
    scope: AlertScope;
    accountId: string | null;
    thresholdPct: number;
  },
  getSettings?: () => Settings,
): void {
  // Budget-scope alerts have their own priming path on spend-tracker init;
  // they don't fire off rate-limit headers.
  if (alert.scope === 'budget') return;
  if (alert.scope === 'pool' || alert.scope === 'pool-weekly') {
    // Pool alerts require access to settings for the exclusion list.
    const settings = getSettings?.();
    if (!settings) return;
    const excluded = new Set(settings.poolExcludedIds);
    const windowName = alert.scope === 'pool-weekly' ? WEEKLY_WINDOW : SESSION_WINDOW;
    const snapshot = computePoolSnapshot(db, rateLimitStore, excluded, windowName);
    if (!snapshot) return;
    if (snapshot.utilPct < alert.thresholdPct) return;
    markAlertTriggered(db, alert.id, snapshot.resetTs);
    return;
  }
  if (!alert.accountId) return;
  const windowName =
    alert.scope === 'account-sonnet'
      ? SONNET_WINDOW
      : alert.scope === 'account-weekly'
        ? WEEKLY_WINDOW
        : SESSION_WINDOW;
  const w = rateLimitStore.getAll(alert.accountId).find((x) => x.name === windowName);
  if (!w || w.utilization == null) return;
  const utilPct = w.utilization * 100;
  if (utilPct < alert.thresholdPct) return;
  markAlertTriggered(db, alert.id, w.reset ?? 0);
}
