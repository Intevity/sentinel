import type { Database } from 'better-sqlite3';
import type { RateLimitStore } from './rate-limit-store.js';
import type { IpcServer } from './ipc.js';
import type { Settings, Alert, PauseReason } from '@claude-sentinel/shared';
import { listAlerts, listAccounts, markAlertTriggered, insertNotification } from './db.js';

const SESSION_WINDOW = 'unified-5h';

/** The general weekly quota window name. Distinct from `unified-7d_sonnet`
 *  (Sonnet-specific); this window caps Opus and every other non-Sonnet
 *  model. When Anthropic marks it `status === 'blocked'`, Sentinel pauses
 *  the account until the window's reset timestamp (days away, not hours). */
const WEEKLY_RATE_LIMIT_WINDOW = 'unified-7d';

/** Cadence for the weekly-pause fallback sweep. A 7-day rollover is a very
 *  infrequent event, so the primary release path (header-driven via
 *  `handleRateLimitUpdate`) may not fire close to the actual rollover if no
 *  traffic hits the account. The fallback tick wakes periodically and
 *  releases any weekly pause whose stored reset timestamp has passed. Five
 *  minutes is plenty — the user won't notice, and it keeps the tick cheap. */
const WEEKLY_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Spend summary sourced from Anthropic's `/api/organizations/{org}/usage`
 *  endpoint. `perAccount[id]` is the dollar value of overage spend for the
 *  current billing period as reported by claude.ai (the ONLY authoritative
 *  source — OTEL cost_usd is list-price-estimated and not comparable).
 *
 *  An entry may be `null` when no sessionKey is configured for that account
 *  or the fetch hasn't succeeded yet. Callers MUST distinguish null (no
 *  data) from 0 (known zero spend) — the rotator never pauses a `null`
 *  account because we can't prove the budget is crossed without real data.
 */
export interface SpendSummary {
  perAccount: Record<string, number | null>;
  /** Sum across every account with a known spend value. Null contributors
   *  are skipped (they don't bias the total downward); downstream
   *  consumers should recognize this is a lower-bound when any
   *  perAccount entry is null. */
  global: number;
}

/** Return the Unix-ms timestamp of the start of the current ISO week (Mon 00:00
 *  local time). Used as the re-arm key for budget-scope alerts so each alert
 *  fires at most once per calendar week regardless of how many times the
 *  threshold is re-crossed inside that window. */
export function isoWeekStartMs(now: number = Date.now()): number {
  const d = new Date(now);
  // Monday = 1 ... Sunday = 7 per ISO; getDay() returns 0..6 with Sun=0.
  const dayOfWeek = d.getDay() === 0 ? 7 : d.getDay();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (dayOfWeek - 1));
  return d.getTime();
}

/** Re-export so existing consumers that imported `PauseReason` from this
 *  module continue to work unchanged — the canonical definition now lives
 *  in `@claude-sentinel/shared` so the UI hooks and IPC messages reference
 *  the same literal union. */
export type { PauseReason } from '@claude-sentinel/shared';

export interface SpendTrackerDeps {
  db: Database;
  rateLimitStore: RateLimitStore;
  ipcServer: IpcServer;
  getSettings: () => Settings;
  /** Live accessor for Anthropic-reported dollar spend per account. Returns
   *  null when no sessionKey is configured for the account yet or the first
   *  fetch hasn't landed. Pause logic refuses to fire when this is null —
   *  we never pause on assumption, only on confirmed numbers. */
  getAnthropicSpend: (accountId: string) => number | null;
  /** Current time getter — injectable so tests can freeze the clock. */
  now?: () => number;
}

/**
 * Owns the Sentinel-side paused-account set and the budget-alert evaluator.
 * Pause rules:
 *   1. For each account, recompute the rolling 7-day spend.
 *   2. If a per-account cap is set and spend ≥ cap → pause that account.
 *   3. If the global cap is set and summed spend ≥ cap → pause every
 *      enrolled account.
 *   4. When the unified-5h window rolls over (reset timestamp advances), the
 *      affected account is cleared from the paused set and re-evaluated. If
 *      spend has aged out of the rolling window it stays unpaused; otherwise
 *      it's re-paused immediately.
 *   5. Each paused/unpaused transition broadcasts `account_paused` or
 *      `account_unpaused` + writes a notification row.
 *
 * The paused set is exposed to `TokenRotator` via `getPausedIds()` so
 * round-robin skips paused accounts. The proxy consults the same accessor
 * in `off` mode to short-circuit requests with a 503 + Retry-After.
 */
export class SpendTracker {
  /** Paused accounts keyed by id, with the reason they're paused. Reason is
   *  consulted by the proxy 503 path (for error copy + Retry-After source
   *  window) and by each evaluator so that one evaluator's cleanup pass
   *  never drops a pause owned by the other. */
  private paused = new Map<string, PauseReason>();
  /** Last-known reset timestamp per (account, window-name). When the next
   *  reset is strictly greater, we auto-unpause-then-reevaluate the
   *  matching pause reason — 5h rollover clears sentinel_budget pauses;
   *  7d rollover clears sentinel_weekly_rate_limit pauses. */
  private lastResetByWindow = new Map<string, Map<string, number>>();
  /** Debounce: the last spend summary we broadcasted. Skips spend_update
   *  broadcasts when the numbers haven't moved. */
  private lastBroadcastJson = '';
  /** Fallback sweep timer handle (see WEEKLY_SWEEP_INTERVAL_MS for why). */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: SpendTrackerDeps) {}

  private clock(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Accessor passed to `TokenRotator`. Returns a read-only set view of
   *  the paused ids (reasons stay internal; consumers that only need the
   *  membership check — rotator skip, proxy short-circuit — don't need to
   *  branch on reason). */
  getPausedIds(): ReadonlySet<string> {
    return new Set(this.paused.keys());
  }

  /** Lookup the pause reason for a specific account. Returns null when the
   *  account isn't paused. Consumed by the proxy 503 path to pick the
   *  right error type + reset window for Retry-After. */
  getPauseReason(accountId: string): PauseReason | null {
    return this.paused.get(accountId) ?? null;
  }

  /** Start the fallback sweep tick. Idempotent. Must be paired with
   *  `stop()` on daemon shutdown — otherwise the interval leaks into
   *  test teardown and hot-reload. */
  start(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => {
      this.sweepWeeklyResets();
    }, WEEKLY_SWEEP_INTERVAL_MS);
    // Don't let the interval alone keep the event loop alive — the daemon
    // main process owns lifecycle via IPC sockets and the proxy.
    this.sweepTimer.unref?.();
  }

  /** Stop the fallback sweep tick. Safe to call multiple times. */
  stop(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Latest Anthropic-reported spend summary. Reads through to the usage
   *  store via the injected `getAnthropicSpend` getter — cheap, no SQL. */
  getSpendSummary(): SpendSummary {
    return this.computeSpend();
  }

  /** Pull per-account dollar spend from the injected Anthropic-usage getter
   *  and sum known values for the global total. Null entries are preserved
   *  so callers can render "no data yet" states rather than a misleading 0. */
  private computeSpend(): SpendSummary {
    const perAccount: Record<string, number | null> = {};
    let global = 0;
    for (const acc of listAccounts(this.deps.db)) {
      const v = this.deps.getAnthropicSpend(acc.id);
      perAccount[acc.id] = v;
      if (typeof v === 'number' && Number.isFinite(v)) global += v;
    }
    return { perAccount, global };
  }

  /** Explicit recompute. Called after every OTEL batch write, after every
   *  rate-limit update, and from the `update_settings` IPC handler when a
   *  budget field changes. Broadcasts `spend_update` when numbers moved,
   *  fires budget-scope alerts, and updates both pause evaluators. The
   *  weekly-rate-limit evaluator runs after the budget evaluator; each
   *  evaluator is scoped to its own reason so neither overwrites the
   *  other's pauses. */
  recompute(): void {
    const settings = this.deps.getSettings();
    const spend = this.computeSpend();
    this.emitSpendIfChanged(spend);
    this.evaluateBudgetAlerts(settings, spend);
    this.evaluatePauseSet(settings, spend);
    this.evaluateWeeklyRateLimitPauses();
  }

  /** Called on every rate-limit store update. Detects rollover of either
   *  the 5-hour or the 7-day window and clears the matching pause reason
   *  (5h rollover → sentinel_budget pause clears; 7d rollover →
   *  sentinel_weekly_rate_limit pause clears) before re-evaluating. */
  handleRateLimitUpdate(accountId: string): void {
    const allWindows = this.deps.rateLimitStore.getAll(accountId);
    let byName = this.lastResetByWindow.get(accountId);
    if (!byName) {
      byName = new Map<string, number>();
      this.lastResetByWindow.set(accountId, byName);
    }
    const rolledOver = new Set<string>();
    for (const windowName of [SESSION_WINDOW, WEEKLY_RATE_LIMIT_WINDOW]) {
      const w = allWindows.find((x) => x.name === windowName);
      if (!w || w.reset == null) continue;
      const prev = byName.get(windowName);
      byName.set(windowName, w.reset);
      // Only interesting transitions: the reset timestamp moved forward. A
      // first-seen reset doesn't count as a rollover.
      if (prev == null || w.reset <= prev) continue;
      rolledOver.add(windowName);
    }
    if (rolledOver.size === 0) return;
    // Clear pauses whose reason matches a window that just rolled over.
    const currentReason = this.paused.get(accountId);
    if (
      (currentReason === 'sentinel_budget' && rolledOver.has(SESSION_WINDOW)) ||
      (currentReason === 'sentinel_weekly_rate_limit' &&
        rolledOver.has(WEEKLY_RATE_LIMIT_WINDOW))
    ) {
      this.paused.delete(accountId);
      this.deps.ipcServer.broadcast({ type: 'account_unpaused', accountId });
    }
    this.recompute();
  }

  /** Fallback tick: release any weekly-rate-limit pause whose stored reset
   *  timestamp has passed, even if no rate-limit update landed on the
   *  account near the actual rollover. Handles the "idle account" case —
   *  if nothing rotated to this account during its 7-day rollover window,
   *  header-driven release never fires and the pause would otherwise
   *  linger past the rollover. */
  private sweepWeeklyResets(): void {
    const nowSec = Math.floor(this.clock() / 1000);
    let changed = false;
    for (const [id, reason] of [...this.paused]) {
      if (reason !== 'sentinel_weekly_rate_limit') continue;
      const w = this.deps.rateLimitStore
        .getAll(id)
        .find((x) => x.name === WEEKLY_RATE_LIMIT_WINDOW);
      if (w?.reset == null) continue;
      if (nowSec < w.reset) continue;
      this.paused.delete(id);
      this.deps.ipcServer.broadcast({ type: 'account_unpaused', accountId: id });
      console.log(`[Spend] Unpaused ${id} (reason=weekly_rate_limit, sweep)`);
      changed = true;
    }
    if (changed) this.recompute();
  }

  private emitSpendIfChanged(spend: SpendSummary): void {
    const json = JSON.stringify(spend);
    if (json === this.lastBroadcastJson) return;
    this.lastBroadcastJson = json;
    this.deps.ipcServer.broadcast({
      type: 'spend_update',
      perAccount: spend.perAccount,
      global: spend.global,
    });
  }

  private evaluatePauseSet(settings: Settings, spend: SpendSummary): void {
    // Compute who SHOULD be paused under current rules.
    const shouldPause = new Set<string>();
    const globalCap = settings.budgetWeeklyUsdGlobal;
    // Global cap tripping requires that EVERY enrolled account contributes a
    // known spend number; if any entry is null (unconfigured sessionKey or
    // failed fetch) the total is a lower bound and we can't honestly say
    // the global cap was crossed. Refuse to pause on assumption.
    const allKnown = Object.values(spend.perAccount).every((v) => typeof v === 'number');
    const globalTripped =
      allKnown && typeof globalCap === 'number' && globalCap > 0 && spend.global >= globalCap;
    // Evaluate against every KNOWN account id — the union of enrolled
    // accounts (via spend.perAccount seeding) plus any id currently sitting
    // in the paused set. Without the latter, a paused account that was
    // soft-deleted or never had a usage_events row would never reach the
    // cleanup branch below and the pause would stick forever.
    const candidates = new Set<string>([
      ...Object.keys(spend.perAccount),
      ...this.paused.keys(),
    ]);
    for (const accountId of candidates) {
      const accountCap = settings.budgetWeeklyUsdByAccount[accountId];
      const accountSpend = spend.perAccount[accountId];
      if (globalTripped) {
        shouldPause.add(accountId);
        continue;
      }
      // Per-account cap only fires on a KNOWN spend number. If the fetch
      // hasn't landed yet, leave the account in its prior pause state.
      if (
        typeof accountSpend === 'number' &&
        typeof accountCap === 'number' &&
        accountCap > 0 &&
        accountSpend >= accountCap
      ) {
        shouldPause.add(accountId);
      }
    }

    // Diff against current state: broadcast transitions. Only touch
    // entries that are either not paused (new budget pause) or already
    // paused with reason 'sentinel_budget' (this evaluator's territory).
    // A 'sentinel_weekly_rate_limit' pause must not be overwritten by
    // this evaluator — the weekly evaluator owns those.
    for (const id of shouldPause) {
      const existing = this.paused.get(id);
      if (existing != null) continue; // already paused (for any reason); don't re-broadcast
      this.paused.set(id, 'sentinel_budget');
      const window = this.deps.rateLimitStore.getAll(id).find((w) => w.name === SESSION_WINDOW);
      const resetsAt = window?.reset ?? null;
      this.deps.ipcServer.broadcast({
        type: 'account_paused',
        accountId: id,
        reason: 'sentinel_budget',
        resetsAt,
      });
      insertNotification(this.deps.db, {
        ts: this.clock(),
        accountId: id,
        type: 'usage_alert',
        title: 'Sentinel: account paused',
        body: globalTripped
          ? `Global weekly budget of $${globalCap!.toFixed(2)} reached. All accounts paused until the 5-hour window resets.`
          : `Weekly budget of $${settings.budgetWeeklyUsdByAccount[id]!.toFixed(2)} reached. Paused until the 5-hour window resets.`,
      });
      console.log(
        `[Spend] Paused ${id} (spend=$${(spend.perAccount[id] ?? 0).toFixed(2)}, cap=$${(settings.budgetWeeklyUsdByAccount[id] ?? globalCap ?? 0).toFixed?.(2)}, reason=${globalTripped ? 'global' : 'account'})`,
      );
    }
    // Cleanup: only this evaluator's own pauses (sentinel_budget). Never
    // drop a weekly-rate-limit pause here — that evaluator owns it.
    for (const [id, reason] of [...this.paused]) {
      if (reason !== 'sentinel_budget') continue;
      if (shouldPause.has(id)) continue;
      this.paused.delete(id);
      this.deps.ipcServer.broadcast({ type: 'account_unpaused', accountId: id });
      console.log(`[Spend] Unpaused ${id} (spend=$${(spend.perAccount[id] ?? 0).toFixed(2)})`);
    }
  }

  /** Weekly-rate-limit pause evaluator. An account's `unified-7d` status
   *  being `'blocked'` is Anthropic's own "will 429 further requests"
   *  signal, so we short-circuit locally rather than letting traffic keep
   *  rotating to the account and getting rejected. Resumption keys on the
   *  7-day reset (via `handleRateLimitUpdate` and the fallback sweep),
   *  not the 5-hour reset — a budget-style 5h release would re-admit the
   *  account hours before Anthropic is willing to serve it.
   *
   *  Scoped to its own reason: does not touch 'sentinel_budget' pauses,
   *  and its own pauses survive a budget evaluation pass. */
  private evaluateWeeklyRateLimitPauses(): void {
    const shouldPause = new Set<string>();
    for (const acc of listAccounts(this.deps.db)) {
      const w = this.deps.rateLimitStore
        .getAll(acc.id)
        .find((x) => x.name === WEEKLY_RATE_LIMIT_WINDOW);
      if (w?.status === 'blocked') shouldPause.add(acc.id);
    }

    // Enter weekly pauses. Skip ids already paused for any reason — if an
    // account is already under a budget pause, layering a second broadcast
    // would be noisy and the set membership (what rotator/proxy care about)
    // is unchanged anyway.
    for (const id of shouldPause) {
      if (this.paused.has(id)) continue;
      this.paused.set(id, 'sentinel_weekly_rate_limit');
      const w = this.deps.rateLimitStore
        .getAll(id)
        .find((x) => x.name === WEEKLY_RATE_LIMIT_WINDOW);
      const resetsAt = w?.reset ?? null;
      this.deps.ipcServer.broadcast({
        type: 'account_paused',
        accountId: id,
        reason: 'sentinel_weekly_rate_limit',
        resetsAt,
      });
      insertNotification(this.deps.db, {
        ts: this.clock(),
        accountId: id,
        type: 'usage_alert',
        title: 'Sentinel: account paused',
        body: 'Weekly (7-day) rate limit reached. Paused until the 7-day window resets.',
      });
      console.log(
        `[Spend] Paused ${id} (reason=weekly_rate_limit, resetsAt=${resetsAt ?? 'unknown'})`,
      );
    }

    // Cleanup: only this evaluator's own pauses. A weekly pause that's no
    // longer warranted (window flipped back to 'allowed' on its own) can
    // be dropped. A budget pause is left alone.
    for (const [id, reason] of [...this.paused]) {
      if (reason !== 'sentinel_weekly_rate_limit') continue;
      if (shouldPause.has(id)) continue;
      this.paused.delete(id);
      this.deps.ipcServer.broadcast({ type: 'account_unpaused', accountId: id });
      console.log(`[Spend] Unpaused ${id} (reason=weekly_rate_limit)`);
    }
  }

  private evaluateBudgetAlerts(settings: Settings, spend: SpendSummary): void {
    const alerts = listAlerts(this.deps.db, { scope: 'budget' }).filter((a) => a.enabled);
    if (alerts.length === 0) return;
    const weekKey = isoWeekStartMs(this.clock());

    for (const alert of alerts) {
      const { observed, cap, accountId } = this.resolveAlertContext(alert, settings, spend);
      if (cap == null || cap <= 0) continue;
      if (observed == null) continue; // no data yet — can't fire honestly
      const pct = (observed / cap) * 100;
      if (pct < alert.thresholdPct) continue;
      if (alert.lastTriggeredResetTs === weekKey) continue;

      this.deps.ipcServer.broadcast({
        type: 'alert_triggered',
        alertId: alert.id,
        accountId: accountId,
        scope: 'budget',
        thresholdPct: alert.thresholdPct,
        utilization: observed / cap,
        spendUsd: observed,
        budgetUsd: cap,
        ...(alert.budgetScope ? { budgetScope: alert.budgetScope } : {}),
      });
      insertNotification(this.deps.db, {
        ts: this.clock(),
        accountId,
        type: 'usage_alert',
        title: `Sentinel: ${alert.thresholdPct}% of weekly budget`,
        body: `$${observed.toFixed(2)} of $${cap.toFixed(2)} used this week.`,
      });
      markAlertTriggered(this.deps.db, alert.id, weekKey);
    }
  }

  private resolveAlertContext(
    alert: Alert,
    settings: Settings,
    spend: SpendSummary,
  ): { observed: number | null; cap: number | null; accountId: string | null } {
    if (alert.budgetScope === 'global') {
      // Only meaningful when every account has a known value.
      const allKnown = Object.values(spend.perAccount).every((v) => typeof v === 'number');
      return {
        observed: allKnown ? spend.global : null,
        cap: settings.budgetWeeklyUsdGlobal ?? null,
        accountId: null,
      };
    }
    const id = alert.accountId;
    if (!id) return { observed: null, cap: null, accountId: null };
    return {
      observed: spend.perAccount[id] ?? null,
      cap: settings.budgetWeeklyUsdByAccount[id] ?? null,
      accountId: id,
    };
  }
}
