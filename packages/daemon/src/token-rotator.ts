import type { Database } from 'better-sqlite3';
import { FABLE_WEEKLY_WINDOW } from '@sentinel/shared';
import { listAccounts } from './db.js';
import { readActiveCredentials, readSentinelCredentials } from './accounts.js';
import type { RateLimitStore } from './rate-limit-store.js';

/** The 5-hour rolling window is the one users think of as "session limit",
 *  so the rotator evaluates rotation decisions against it exclusively. */
const SESSION_WINDOW = 'unified-5h';

/** Name of the overage RateLimitWindow as reported by Anthropic headers. */
const OVERAGE_WINDOW = 'unified-overage';

/** Fable's weekly quota on Max plans. When this saturates, subsequent
 *  Fable requests spill into overage even if `unified-5h` has room. The
 *  rotator consults it only for Fable-model requests so Opus traffic
 *  stays unaffected. */
const FABLE_WINDOW = FABLE_WEEKLY_WINDOW;

/** Two `unified-5h` resets within this many seconds count as the same
 *  window boundary. The store has two writers for the reset value — API
 *  response headers (epoch seconds) and the claude.ai usage sync (an ISO
 *  timestamp converted to epoch seconds) — and they can disagree at second
 *  granularity for the same window. Comparing resets exactly treated every
 *  such disagreement as a real ordering change and re-targeted traffic,
 *  degenerating the rotator into request-by-request alternation. Windows
 *  are 5 hours long; a sub-minute difference is never a reason to move. */
const RESET_TIE_TOLERANCE_SEC = 60;

/** Minimum buffer the rotator is willing to apply. A buffer of 0% means the
 *  threshold is exactly 1.0, which — given Anthropic's 2-decimal-truncated
 *  utilization header — matches full saturation. That preserves the old
 *  pre-buffer behavior when the user slides the setting to zero. */
const MIN_BUFFER_PCT = 0;
const MAX_BUFFER_PCT = 50;

/**
 * A (accountId, token) pair drawn from the rotator's current pool.
 */
export interface RotatedCredential {
  accountId: string;
  token: string;
}

/**
 * Utilization-aware token selector used when the user's `switchingMode` is
 * `auto`. Holds a cached pool of {accountId, token} pairs for every account
 * whose credentials Sentinel can resolve from the OS keychain.
 *
 * Single strategy — earliest-reset: hard-target the non-blocked pool
 * account whose `unified-5h` window resets soonest. Accounts without reset
 * data — or whose stored reset is already in the past (an expired window
 * whose next request would open a brand-new one) — are deprioritized.
 * Traffic sticks to one account until it blocks or its window rolls over,
 * maximizing usage of headroom that's about to be reclaimed anyway. Once a
 * target is chosen the rotator holds it while its reset stays within
 * RESET_TIE_TOLERANCE_SEC of the tier minimum — neither utilization shifts
 * nor second-level reset jitter between the store's two writers (API headers
 * vs claude.ai sync) re-targets traffic. Only a genuinely earlier window on
 * another account, or the target leaving the tier (blocked, paused, removed,
 * buffer threshold), moves the pick. A target whose reset reads as unknown
 * also holds: it is the account currently serving traffic, so its store data
 * is the freshest, and a missing window there means a writer blink or a
 * just-expired window — both self-correcting on its next response — not
 * evidence that another account resets sooner.
 *
 * Accounts at or above the buffer threshold drop out of the fresh tier
 * regardless of whether overage is available on claude.ai. That's the
 * point of the buffer — it's keep-alive headroom, not just overage
 * avoidance. An at-threshold account is only eligible via the overage
 * tier when overage is `allowed` AND the account is opted in; in every
 * other case (overage `disabled`, no overage window, or `allowed` but not
 * opted in) it's skipped entirely. Blocked accounts are also skipped.
 *
 * If the pool is empty or every account is unavailable, `pick()` returns
 * null so the proxy can fall back to the active-account behaviour
 * (standard single-token flow).
 */
export class TokenRotator {
  private pool: RotatedCredential[] = [];
  /** Sticky account for the earliest-reset strategy. When two or more
   *  accounts share the minimum reset value, the rotator picks one and
   *  stays on it until it leaves the tier (blocked, paused, removed, or
   *  its reset is no longer the minimum). Prevents per-request
   *  alternation that would otherwise drain tied accounts in lockstep. */
  private earliestResetStickyId: string | null = null;

  constructor(
    private readonly db: Database,
    private readonly rateLimitStore: RateLimitStore,
    /** The account that is "primary" in ~/.claude.json; its creds come from
     *  Claude Code's keychain slot when Sentinel doesn't have its own copy. */
    private readonly activeAccountIdRef: { value: string },
    /** Live accessor for the user's pool-exclusion list. Read on every
     *  `refresh()` so mode/settings changes take effect immediately.
     *  Defaults to an empty set — every enrolled account rotates. */
    private readonly getExcludedIds: () => ReadonlySet<string> = () => new Set(),
    /** Live accessor for the user's overage opt-in allow-list (Sentinel ids).
     *  Once an account crosses the buffer threshold it leaves the fresh
     *  tier; only accounts on this list (AND with overage status `allowed`)
     *  are retained as overage-tier fallbacks. Defaults to empty set
     *  (opt-in: no overage spending). */
    private readonly getOverageAllowedIds: () => ReadonlySet<string> = () => new Set(),
    /** Live accessor for the Sentinel-side paused-account set. An account
     *  in this set is never returned from `pick()` regardless of rate-limit
     *  state (see SpendTracker for the membership rules). Defaults to empty. */
    private readonly getPausedAccountIds: () => ReadonlySet<string> = () => new Set(),
    /** Live accessor for the user-tunable overage safety buffer. Rotator
     *  treats an account as "will use overage" when its unified-5h
     *  utilization is ≥ (1 − bufferPct/100). Default 10 (cut-off at 90%).
     *  Integer range [0, 50]; clamped inside `pick()` for safety. 0 reverts
     *  to the legacy "cut off only at saturation" behavior. */
    private readonly getOverageBufferPct: () => number = () => 10,
    /** Clock seam (epoch seconds). The earliest-reset strategy compares
     *  stored reset timestamps against it to detect expired windows;
     *  tests pin it so hand-seeded epoch values stay meaningful. */
    private readonly nowSec: () => number = () => Date.now() / 1000,
  ) {
    this.refresh();
  }

  /**
   * Rebuild the token pool from scratch. Call whenever the account set or
   * keychain state changes (post-switch, post-login, on remove/purge,
   * settings change).
   */
  refresh(): void {
    const next: RotatedCredential[] = [];
    const accounts = listAccounts(this.db);
    const excluded = this.getExcludedIds();
    for (const account of accounts) {
      // User opted this account out of the Auto-switching pool — don't fetch
      // credentials or include it in the rotation pool.
      if (excluded.has(account.id)) continue;
      // Prefer Sentinel's own per-account store; fall back to Claude Code's
      // single slot only for the currently active account (handled by
      // readActiveCredentials' activeId guard).
      const creds =
        readSentinelCredentials(account.id) ??
        readActiveCredentials(account.id, this.activeAccountIdRef.value);
      if (creds?.accessToken) {
        next.push({ accountId: account.id, token: creds.accessToken });
      }
    }
    this.pool = next;
  }

  /**
   * The current number of (accountId, token) pairs in the pool.
   */
  size(): number {
    return this.pool.length;
  }

  /**
   * Return the account to bill the next request to (earliest-reset — see
   * the class docstring). Returns null when every account is unavailable or
   * the pool is empty.
   *
   * `ctx.isFable` routes through the same overage gate with the Fable
   * 7-day window folded in: an account whose Fable 7d utilization is at
   * or above the threshold is treated as "will draw overage for this
   * request" and subject to the same opt-in. Non-Fable requests
   * (undefined or `isFable: false`) bypass this branch so Opus traffic
   * is unaffected. Missing `unified-7d_oi` on an account is treated
   * as "not saturated" (the account has no observed Fable usage yet).
   *
   * Account eligibility (in order):
   *   1. Pool membership (not in `poolExcludedIds`, has a token) — handled in
   *      refresh(), not here.
   *   2. Not blocked (`status === 'blocked'` on any window).
   *   3. Not paused by SpendTracker (Sentinel-side weekly cap hit).
   *   4. Two-tier buffer gate. Below threshold → fresh tier. At or above
   *      threshold (or with overage already `in-use`) → only retained as
   *      an overage-tier fallback when overage status is `allowed` AND
   *      the account is on `overageEnabledIds`. Everything else is
   *      skipped: accounts whose claude.ai overage is `disabled`, plans
   *      without an overage window, and opted-out `allowed` accounts all
   *      drop out at the threshold so the pool rotates off them before
   *      Claude Code hits 100% and stalls. The rotator always drains the
   *      fresh tier before touching the overage tier.
   */
  pick(ctx?: { isFable: boolean }): RotatedCredential | null {
    if (this.pool.length === 0) return null;

    const isFable = ctx?.isFable === true;
    const overageAllowed = this.getOverageAllowedIds();
    const paused = this.getPausedAccountIds();
    // Buffer is read once per pick(). Clamp here so malformed settings
    // (from a bad in-memory patch or a future schema drift) can't push the
    // threshold outside [0, 1].
    const rawBuffer = this.getOverageBufferPct();
    const clampedBuffer = Math.max(MIN_BUFFER_PCT, Math.min(MAX_BUFFER_PCT, rawBuffer));
    const overageThreshold = 1 - clampedBuffer / 100;

    // Partition viable candidates into two tiers:
    //   fresh    — next request will NOT draw overage
    //   overage  — next request WILL draw overage AND account is opted-in
    //
    // Accounts that would draw overage but aren't opted in are skipped
    // entirely — they're never eligible for Auto switching.
    const fresh: { idx: number; util: number; reset: number }[] = [];
    const overage: { idx: number; util: number; reset: number }[] = [];
    const now = this.nowSec();
    // Set when the earliest-reset sticky account is pushed out of the
    // fresh tier solely by the Fable 7d gate for THIS request — its 5h
    // window still has room, so the sticky must survive the detour.
    let stickyFableEjected = false;

    for (let i = 0; i < this.pool.length; i++) {
      const entry = this.pool[i]!;
      if (paused.has(entry.accountId)) continue;
      const windows = this.rateLimitStore.getAll(entry.accountId);
      const sessionWindow = windows.find((w) => w.name === SESSION_WINDOW);
      const overageWindow = windows.find((w) => w.name === OVERAGE_WINDOW);
      const fableWindow = windows.find((w) => w.name === FABLE_WINDOW);
      const util = sessionWindow?.utilization ?? 0;
      // A reset that is missing OR already behind the clock carries no
      // scheduling information: the stored window has expired, and the
      // account's next request would open a brand-new 5h window. Rank
      // it like "no data" instead of letting the stale timestamp win
      // "earliest" and yank traffic onto an idle account (which would
      // open a fresh window and immediately lose the pick again — a
      // periodic request leak).
      const rawReset = sessionWindow?.reset;
      const reset = rawReset == null || rawReset <= now ? Number.POSITIVE_INFINITY : rawReset;
      // Blocked on any window means the 5h or 7d quota is exhausted. The
      // account is still reachable when overage is available and opted in:
      // Anthropic lets the overage grant cover further spend. Route those
      // through the overage tier. Every other blocked case (overage
      // disabled, no overage window, not opted in) skips the account —
      // the caller would just get a 429 otherwise.
      if (windows.some((w) => w.status === 'blocked')) {
        const canUseOverage =
          overageWindow?.status === 'allowed' && overageAllowed.has(entry.accountId);
        if (!canUseOverage) continue;
        overage.push({ idx: i, util, reset });
        continue;
      }
      // Partitioning runs in two steps. First: is this account out of the
      // fresh tier? That's true whenever its 5h (or Fable 7d, for Fable
      // requests) utilization is at or above the buffer threshold — or the
      // overage window shows `in-use` already. The buffer is keep-alive
      // headroom as much as it is an overage-cost guard: an account at 99%
      // is one request away from a 429 whether or not overage exists to
      // catch it.
      const fableAtThreshold =
        isFable && fableWindow?.utilization != null && fableWindow.utilization >= overageThreshold;
      const atOrAboveThreshold = util >= overageThreshold || fableAtThreshold;
      const overageActive = overageWindow?.inUse === true;

      if (atOrAboveThreshold || overageActive) {
        if (
          entry.accountId === this.earliestResetStickyId &&
          fableAtThreshold &&
          util < overageThreshold &&
          !overageActive
        ) {
          stickyFableEjected = true;
        }
        // Second step: eligible for the overage tier? Only when overage is
        // actually available on this account (claude.ai hasn't disabled it,
        // and the window exists at all) AND the user opted this account in.
        // Everyone else is skipped entirely — including accounts with
        // overage disabled, which previously slipped through to the fresh
        // tier and drove Claude Code into 429s at 100%.
        const canUseOverage =
          overageWindow?.status === 'allowed' && overageAllowed.has(entry.accountId);
        if (!canUseOverage) continue;
        overage.push({ idx: i, util, reset });
      } else {
        fresh.push({ idx: i, util, reset });
      }
    }

    // Prefer the fresh tier: drain pool-wide 5h quota before spilling to
    // overage.
    const tier = fresh.length > 0 ? fresh : overage;
    if (tier.length === 0) return null;

    // Hard-target the account whose window rolls over soonest. For the
    // initial pick (no sticky), tie-break by lower utilization, then by
    // pool index. Traffic sticks to the chosen account until it blocks or
    // resets.
    const ranked = [...tier].sort((a, b) => a.reset - b.reset || a.util - b.util || a.idx - b.idx);
    const minReset = ranked[0]!.reset;

    if (this.earliestResetStickyId !== null) {
      const sticky = ranked.find((r) => this.pool[r.idx]!.accountId === this.earliestResetStickyId);
      // Hold the sticky while it is still effectively earliest. Util is
      // intentionally NOT consulted: re-evaluating it on every pick is
      // what caused tied accounts to alternate request-by-request as
      // their utilizations ticked up in lockstep. Resets within
      // RESET_TIE_TOLERANCE_SEC of the minimum count as the same window
      // boundary — the store's two reset writers (API headers vs the
      // claude.ai usage sync) disagree at second granularity, and the
      // previous strict equality re-targeted traffic on every such
      // disagreement. An unknown (+Infinity) sticky reset also holds:
      // see the class docstring.
      if (
        sticky &&
        (sticky.reset === Number.POSITIVE_INFINITY ||
          sticky.reset <= minReset + RESET_TIE_TOLERANCE_SEC)
      ) {
        return this.pool[sticky.idx]!;
      }
      // The sticky account was pushed out of the tier by the Fable 7d
      // gate for THIS request only — its 5h window still has room.
      // Serve the request from the runner-up without re-targeting, so
      // non-Fable traffic keeps draining the sticky account instead of
      // the target flip-flopping with every model change.
      if (!sticky && stickyFableEjected) {
        return this.pool[ranked[0]!.idx]!;
      }
    }

    // Reaching here means the target is being set for the first time or
    // moved off an account that is no longer effectively earliest — one
    // log line per actual change, never per pick.
    const next = ranked[0]!;
    const nextId = this.pool[next.idx]!.accountId;
    const resetIn =
      next.reset === Number.POSITIVE_INFINITY
        ? 'unknown'
        : `${Math.round((next.reset - now) / 60)}m`;
    console.log(
      `[Rotator] earliest-reset target -> ${nextId} ` +
        `(reset in ${resetIn}, util ${(next.util * 100).toFixed(0)}%)`,
    );
    this.earliestResetStickyId = nextId;
    return this.pool[next.idx]!;
  }
}
