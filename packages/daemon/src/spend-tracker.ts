import type { Database } from 'better-sqlite3';
import type { RateLimitStore } from './rate-limit-store.js';
import type { IpcServer } from './ipc.js';
import type { Settings, Alert } from '@claude-sentinel/shared';
import { listAlerts, listAccounts, markAlertTriggered, insertNotification } from './db.js';

const SESSION_WINDOW = 'unified-5h';

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

/** Reason an account was paused — embedded in the `account_paused` IPC
 *  message so the UI can render cause-specific copy. */
export type PauseReason = 'sentinel_budget' | 'anthropic_overage_disabled';

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
  private paused = new Set<string>();
  /** Last-known unified-5h reset timestamp per account (Unix seconds). When
   *  the next reset is strictly greater, we auto-unpause-then-reevaluate. */
  private lastSessionReset = new Map<string, number>();
  /** Debounce: the last spend summary we broadcasted. Skips spend_update
   *  broadcasts when the numbers haven't moved. */
  private lastBroadcastJson = '';

  constructor(private readonly deps: SpendTrackerDeps) {}

  private clock(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  /** Accessor passed to `TokenRotator`. Reading returns the live set each
   *  time so changes take effect on the next pick. */
  getPausedIds(): ReadonlySet<string> {
    return this.paused;
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
   *  fires budget-scope alerts, and updates the paused set + its
   *  corresponding account_paused / account_unpaused broadcasts. */
  recompute(): void {
    const settings = this.deps.getSettings();
    const spend = this.computeSpend();
    this.emitSpendIfChanged(spend);
    this.evaluateBudgetAlerts(settings, spend);
    this.evaluatePauseSet(settings, spend);
  }

  /** Called on every rate-limit store update. Detects unified-5h rollover
   *  and clears + re-evaluates pause for the affected account. */
  handleRateLimitUpdate(accountId: string): void {
    const window = this.deps.rateLimitStore
      .getAll(accountId)
      .find((w) => w.name === SESSION_WINDOW);
    if (!window || window.reset == null) return;
    const prev = this.lastSessionReset.get(accountId);
    this.lastSessionReset.set(accountId, window.reset);
    // Only interesting transitions: the reset timestamp moved forward. A
    // first-seen reset doesn't count as a rollover.
    if (prev == null || window.reset <= prev) return;
    // Rollover: clear pause entry so recompute() gets a fresh decision.
    if (this.paused.has(accountId)) {
      this.paused.delete(accountId);
      this.deps.ipcServer.broadcast({ type: 'account_unpaused', accountId });
    }
    this.recompute();
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
      allKnown &&
      typeof globalCap === 'number' && globalCap > 0 && spend.global >= globalCap;
    // Evaluate against every KNOWN account id — the union of enrolled
    // accounts (via spend.perAccount seeding) plus any id currently sitting
    // in the paused set. Without the latter, a paused account that was
    // soft-deleted or never had a usage_events row would never reach the
    // cleanup branch below and the pause would stick forever.
    const candidates = new Set<string>([
      ...Object.keys(spend.perAccount),
      ...this.paused,
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
        typeof accountCap === 'number' && accountCap > 0 &&
        accountSpend >= accountCap
      ) {
        shouldPause.add(accountId);
      }
    }

    // Diff against current state: broadcast transitions.
    for (const id of shouldPause) {
      if (!this.paused.has(id)) {
        this.paused.add(id);
        const window = this.deps.rateLimitStore.getAll(id).find((w) => w.name === SESSION_WINDOW);
        const resetsAt = window?.reset ?? null;
        const reason: PauseReason = 'sentinel_budget';
        this.deps.ipcServer.broadcast({
          type: 'account_paused',
          accountId: id,
          reason,
          resetsAt,
        });
        insertNotification(this.deps.db, {
          ts: this.clock(),
          accountId: id,
          type: 'usage_alert',
          title: 'Sentinel: account paused',
          body:
            globalTripped
              ? `Global weekly budget of $${globalCap!.toFixed(2)} reached. All accounts paused until the 5-hour window resets.`
              : `Weekly budget of $${settings.budgetWeeklyUsdByAccount[id]!.toFixed(2)} reached. Paused until the 5-hour window resets.`,
        });
        console.log(`[Spend] Paused ${id} (spend=$${(spend.perAccount[id] ?? 0).toFixed(2)}, cap=$${(settings.budgetWeeklyUsdByAccount[id] ?? globalCap ?? 0).toFixed?.(2)}, reason=${globalTripped ? 'global' : 'account'})`);
      }
    }
    for (const id of [...this.paused]) {
      if (!shouldPause.has(id)) {
        this.paused.delete(id);
        this.deps.ipcServer.broadcast({ type: 'account_unpaused', accountId: id });
        console.log(`[Spend] Unpaused ${id} (spend=$${(spend.perAccount[id] ?? 0).toFixed(2)})`);
      }
    }
  }

  private evaluateBudgetAlerts(settings: Settings, spend: SpendSummary): void {
    const alerts = listAlerts(this.deps.db, { scope: 'budget' }).filter((a) => a.enabled);
    if (alerts.length === 0) return;
    const weekKey = isoWeekStartMs(this.clock());

    for (const alert of alerts) {
      const { observed, cap, accountId } = this.resolveAlertContext(alert, settings, spend);
      if (cap == null || cap <= 0) continue;
      if (observed == null) continue;  // no data yet — can't fire honestly
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
