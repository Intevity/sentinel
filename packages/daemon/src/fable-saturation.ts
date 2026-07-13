import type { FableSaturationTransition } from '@sentinel/shared';

/**
 * Event emitted when an account's Fable 7-day utilization crosses (or
 * falls back below) the user-configured overage-buffer threshold.
 *
 *   entered — utilization went from below-threshold to at-or-above. The
 *             next Fable request on this account will draw from the
 *             monthly overage budget unless the account is opted in.
 *   exited  — utilization fell back below the threshold (window rollover).
 */
export type FableSaturationEvent = {
  accountId: string;
  transition: FableSaturationTransition;
  /** Utilization fraction 0-1 at the time of the transition. */
  utilization: number;
  /** Unix seconds when the Fable 7-day window resets. Null when the
   *  header didn't carry a reset value (unlikely in practice but possible
   *  for claude.ai snapshots that pre-date live headers). */
  resetsAt: number | null;
};

export type FableTransitionHandler = (event: FableSaturationEvent) => void;

/** Per-window fired-transitions cache. Keyed by `resetsAt`; within a
 *  window, each transition type fires at most once. A new `resetsAt`
 *  implicitly opens a new window and clears the set. Mirrors the dedup
 *  pattern used by `OverageStateMachine`. */
type FiredWindow = {
  resetsAt: number | null;
  transitions: Set<FableSaturationTransition>;
};

type AccountState = {
  isSaturated: boolean;
  resetsAt: number | null;
};

/**
 * In-memory state machine tracking Fable 7-day window saturation per
 * account. Fable has its own weekly quota on Max plans (the
 * `unified-7d_oi` rate-limit window); when that quota exhausts,
 * subsequent Fable requests draw from the monthly overage budget even if
 * `unified-5h` still has room. This machine fires edge-triggered
 * transitions so the daemon can surface a native notification and persist
 * a timeline entry, and so the proxy's short-circuit can make request
 * decisions based on saturation state without re-deriving it every time.
 *
 * Driven from the rate-limit store's `onUpdate` callback rather than
 * response headers directly, because saturation is a threshold-crossing
 * on a stored utilization value rather than a single boolean header like
 * overage `in-use`.
 */
export class FableSaturationMachine {
  private readonly states = new Map<string, AccountState>();
  private readonly fired = new Map<string, FiredWindow>();
  private readonly handlers: FableTransitionHandler[] = [];

  onTransition(handler: FableTransitionHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Feed the current Fable window snapshot for an account and fire any
   * transition that crossed relative to the previous call.
   *
   * `thresholdPct` is the overage-buffer threshold expressed as a percent
   * in `[0, 100]` (e.g. 95 when `overageBufferPct=5`). Utilization at or
   * above this threshold is considered saturated. Called from the
   * rate-limit store's `onUpdate` callback with the merged window set.
   *
   * Returns the fired event (or null when no transition crossed). The
   * returned event is also dispatched to every registered handler.
   */
  update(
    accountId: string,
    utilization: number | null,
    resetsAt: number | null,
    thresholdPct: number,
  ): FableSaturationEvent | null {
    if (utilization == null) return null;

    const threshold = Math.max(0, Math.min(100, thresholdPct)) / 100;
    const isSaturated = utilization >= threshold;
    const prev = this.states.get(accountId);

    this.states.set(accountId, { isSaturated, resetsAt });

    let transition: FableSaturationTransition | null = null;
    if (isSaturated && (prev === undefined || !prev.isSaturated)) {
      transition = 'entered';
    } else if (!isSaturated && prev !== undefined && prev.isSaturated) {
      transition = 'exited';
    } else if (
      isSaturated &&
      prev !== undefined &&
      prev.isSaturated &&
      prev.resetsAt !== resetsAt
    ) {
      // Same saturation state but the window rolled over — treat as a
      // fresh entered so the new window gets its own timeline entry.
      transition = 'entered';
    }

    if (transition === null) return null;

    // Per-window dedup: same resetsAt + same transition already fired →
    // swallow it. A new resetsAt opens a fresh window.
    let window = this.fired.get(accountId);
    if (window === undefined || window.resetsAt !== resetsAt) {
      window = { resetsAt, transitions: new Set() };
      this.fired.set(accountId, window);
    }
    if (window.transitions.has(transition)) return null;
    window.transitions.add(transition);

    const event: FableSaturationEvent = {
      accountId,
      transition,
      utilization,
      resetsAt,
    };
    this.handlers.forEach((h) => h(event));
    return event;
  }

  /**
   * Seed the state after a restart so a transition already persisted for
   * the current window isn't re-emitted. Callers pass the reset timestamp
   * and the transitions that already fired on it.
   */
  rehydrate(
    accountId: string,
    state: { isSaturated: boolean; resetsAt: number | null },
    transitions: FableSaturationTransition[],
  ): void {
    this.states.set(accountId, { isSaturated: state.isSaturated, resetsAt: state.resetsAt });
    this.fired.set(accountId, {
      resetsAt: state.resetsAt,
      transitions: new Set(transitions),
    });
  }

  /**
   * Clear an account's state (e.g. on account removal).
   */
  resetState(accountId: string): void {
    this.states.delete(accountId);
    this.fired.delete(accountId);
  }

  /**
   * True when the account's last known Fable utilization was at or above
   * the threshold. False when unknown or below. Used by the proxy's
   * short-circuit and the rotator's overage tier.
   */
  isSaturated(accountId: string): boolean {
    return this.states.get(accountId)?.isSaturated ?? false;
  }
}

/**
 * Build the notification body for an `entered` Fable saturation event.
 * Pure so the wiring in index.ts can stay simple and the two copy paths
 * stay unit-tested. `who` is whatever identifier the UI should show
 * (email preferred, account id fallback).
 *
 * The two branches reflect what Sentinel will actually do next:
 *
 *   optedIn  — proxy lets further Fable requests through; Anthropic
 *              bills them against the monthly overage pool.
 *   not-in   — proxy's Fable short-circuit returns 503 for further
 *              Fable requests on this account, so the accurate message
 *              is "will be blocked", not "will draw from overage".
 */
export function buildFableSaturationBody(
  who: string,
  utilization: number,
  optedIn: boolean,
): string {
  const pct = (utilization * 100).toFixed(1);
  if (optedIn) {
    return `${who} has used ${pct}% of its Fable 7-day window. Further Fable requests will draw from overage.`;
  }
  return `${who} has used ${pct}% of its Fable 7-day window. Further Fable requests will be blocked by Sentinel. Switch accounts, use a non-Fable model, or enable overage in Settings.`;
}
