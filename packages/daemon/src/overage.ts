import type { OverageState, OverageHeaders, OverageTransition } from '@claude-sentinel/shared';

export const OVERAGE_STATUS_HEADER = 'anthropic-ratelimit-unified-overage-status';
export const OVERAGE_RESET_HEADER = 'anthropic-ratelimit-unified-overage-reset';
export const OVERAGE_REASON_HEADER = 'anthropic-ratelimit-unified-overage-disabled-reason';
export const OVERAGE_IN_USE_HEADER = 'anthropic-ratelimit-unified-overage-in-use';

export type OverageTransitionEvent = {
  accountId: string;
  transition: OverageTransition;
  state: OverageState;
};

export type TransitionHandler = (event: OverageTransitionEvent) => void;

/**
 * In-memory overage state machine.
 * Tracks per-account overage status and fires callbacks on transitions.
 */
export class OverageStateMachine {
  private readonly states = new Map<string, OverageState>();
  private readonly handlers: TransitionHandler[] = [];

  onTransition(handler: TransitionHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Parse overage-related headers from an Anthropic API response.
   */
  parseHeaders(headers: Record<string, string | string[] | undefined>): OverageHeaders {
    const rawStatus = headers[OVERAGE_STATUS_HEADER];
    const rawReset = headers[OVERAGE_RESET_HEADER];
    const rawReason = headers[OVERAGE_REASON_HEADER];
    const rawInUse = headers[OVERAGE_IN_USE_HEADER];

    const status = Array.isArray(rawStatus) ? rawStatus[0] ?? null : rawStatus ?? null;
    const resetStr = Array.isArray(rawReset) ? rawReset[0] ?? null : rawReset ?? null;
    const disabledReason = Array.isArray(rawReason) ? rawReason[0] ?? null : rawReason ?? null;
    const inUseStr = Array.isArray(rawInUse) ? rawInUse[0] ?? null : rawInUse ?? null;

    const resetsAt = resetStr !== null ? parseInt(resetStr, 10) : null;
    // `inUse` is null when the overage window is absent entirely (e.g. API-key
    // plans, or a response with no overage headers at all). When the overage
    // window IS present, a missing `in-use` header is normalized to false so
    // state transitions correctly detect exit.
    const overageWindowPresent = status !== null || resetsAt !== null || disabledReason !== null;
    const inUse =
      inUseStr !== null
        ? inUseStr.toLowerCase() === 'true' || inUseStr === '1'
        : overageWindowPresent
          ? false
          : null;

    return {
      status,
      resetsAt: resetsAt !== null && !isNaN(resetsAt) ? resetsAt : null,
      disabledReason,
      inUse,
    };
  }

  /**
   * Handle headers from an API response for the given account.
   * Returns a transition event if the overage state changed, null otherwise.
   */
  handleHeaders(
    accountId: string,
    headers: Record<string, string | string[] | undefined>,
  ): OverageTransitionEvent | null {
    const parsed = this.parseHeaders(headers);

    // No overage headers present — nothing to do
    if (parsed.status === null) {
      return null;
    }

    const now = Date.now();
    const prev = this.states.get(accountId);
    const isUsingOverage = parsed.inUse === true;
    const isDisabled = parsed.status === 'disabled';

    const newState: OverageState = {
      isUsingOverage,
      status: parsed.status,
      resetsAt: parsed.resetsAt,
      disabledReason: parsed.disabledReason,
      lastUpdated: now,
    };

    this.states.set(accountId, newState);

    // Determine transition
    let transition: OverageTransition | null = null;

    if (isUsingOverage && (prev === undefined || !prev.isUsingOverage)) {
      transition = 'entered';
    } else if (isDisabled && (prev === undefined || prev.status !== 'disabled')) {
      transition = 'disabled';
    } else if (!isUsingOverage && !isDisabled && prev !== undefined && prev.isUsingOverage) {
      transition = 'exited';
    }

    if (transition === null) {
      return null;
    }

    const event: OverageTransitionEvent = { accountId, transition, state: newState };
    this.handlers.forEach((h) => h(event));
    return event;
  }

  /**
   * Get current overage state for an account, or null if never seen.
   */
  getState(accountId: string): OverageState | null {
    return this.states.get(accountId) ?? null;
  }

  /**
   * Reset state for an account (e.g., after account switch).
   */
  resetState(accountId: string): void {
    this.states.delete(accountId);
  }

  /**
   * Get all tracked account IDs.
   */
  getTrackedAccounts(): string[] {
    return Array.from(this.states.keys());
  }
}
