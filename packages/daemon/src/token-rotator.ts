import type { Database } from 'better-sqlite3';
import { listAccounts } from './db.js';
import { readActiveCredentials, readSentinelCredentials } from './accounts.js';
import type { RateLimitStore } from './rate-limit-store.js';
import type { RoundRobinStrategy } from '@claude-sentinel/shared';

/** The 5-hour rolling window is the one users think of as "session limit",
 *  so the rotator evaluates rotation decisions against it exclusively. */
const SESSION_WINDOW = 'unified-5h';

/** Name of the overage RateLimitWindow as reported by Anthropic headers. */
const OVERAGE_WINDOW = 'unified-overage';

/** Sonnet's weekly quota on Max plans. When this saturates, subsequent
 *  Sonnet requests spill into overage even if `unified-5h` has room. The
 *  rotator consults it only for Sonnet-model requests so Opus traffic
 *  stays unaffected. */
const SONNET_WINDOW = 'unified-7d_sonnet';

/** Candidates within this much of the minimum utilization are treated as
 *  equals and cycled through via the round-robin cursor. Prevents
 *  oscillation once accounts have converged. */
const TIE_BAND = 0.01; // 1 percentage point

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
 * Utilization-aware round-robin token selector used when the user's
 * `switchingMode` is `round-robin`. Holds a cached pool of
 * {accountId, token} pairs for every account whose credentials Sentinel
 * can resolve from the OS keychain.
 *
 * Two strategies, chosen live via the `getStrategy` getter:
 *
 *   balance (default) — prefer the account with the lowest `unified-5h`
 *     utilization so hot accounts drain last and cold accounts catch up.
 *     Candidates within `TIE_BAND` of the minimum rotate fairly via a
 *     cursor, keeping distribution even once accounts have converged.
 *
 *   earliest-reset — hard-target the non-blocked pool account whose
 *     `unified-5h` window resets soonest. Accounts without reset data are
 *     deprioritized. No tie band, no cursor advance: traffic sticks to one
 *     account until it blocks or its window rolls over, maximizing usage
 *     of headroom that's about to be reclaimed anyway.
 *
 * Blocked or overage-disabled accounts are skipped. If the pool is empty or
 * every account is unavailable, `pick()` returns null so the proxy can fall
 * back to the active-account behaviour (standard single-token flow).
 */
export class TokenRotator {
  private pool: RotatedCredential[] = [];
  private cursor = 0;

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
    /** Live accessor for the active round-robin sub-strategy. Read on every
     *  `pick()` so toggling the strategy in Settings takes effect for the
     *  next request with no restart. Defaults to `'balance'`. */
    private readonly getStrategy: () => RoundRobinStrategy = () => 'balance',
    /** Live accessor for the user's overage opt-in allow-list (Sentinel ids).
     *  An account NOT on this list whose 5h window is saturated — i.e. the
     *  next request would consume Anthropic's overage budget — is skipped by
     *  `pick()`. Defaults to an empty set (opt-in: no overage spending). */
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
      // User opted this account out of round-robin — don't fetch credentials
      // or include it in the rotation pool.
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
    // Keep cursor in-bounds after a shrink.
    if (next.length === 0) this.cursor = 0;
    else this.cursor = this.cursor % next.length;
  }

  /**
   * The current number of (accountId, token) pairs in the pool.
   */
  size(): number {
    return this.pool.length;
  }

  /**
   * Return the account to bill the next request to. Behavior depends on
   * the live strategy getter — see the class docstring for the two modes.
   * Returns null when every account is unavailable or the pool is empty.
   *
   * `ctx.isSonnet` routes through the same overage gate with the Sonnet
   * 7-day window folded in: an account whose Sonnet 7d utilization is at
   * or above the threshold is treated as "will draw overage for this
   * request" and subject to the same opt-in. Non-Sonnet requests
   * (undefined or `isSonnet: false`) bypass this branch so Opus traffic
   * is unaffected. Missing `unified-7d_sonnet` on an account is treated
   * as "not saturated" (the account has no observed Sonnet usage yet).
   *
   * Account eligibility (in order):
   *   1. Pool membership (not in `poolExcludedIds`, has a token) — handled in
   *      refresh(), not here.
   *   2. Not blocked (`status === 'blocked'` on any window).
   *   3. Not paused by SpendTracker (Sentinel-side weekly cap hit).
   *   4. Two-tier overage gate: candidates whose next request would draw
   *      Anthropic overage (5h saturated with overage status 'allowed',
   *      overage-inUse=true, OR — for Sonnet requests — 7d_sonnet
   *      saturated) are set aside. The rotator prefers candidates that
   *      will NOT spend overage so pool-wide quota drains first. Only
   *      when no "fresh" candidates remain do we fall through to the
   *      overage tier — and even then, only accounts the user has
   *      explicitly opted in via `overageEnabledIds` are eligible.
   */
  pick(ctx?: { isSonnet: boolean }): RotatedCredential | null {
    if (this.pool.length === 0) return null;

    const isSonnet = ctx?.isSonnet === true;
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
    // entirely — they're never eligible in round-robin.
    const fresh: { idx: number; util: number; reset: number }[] = [];
    const overage: { idx: number; util: number; reset: number }[] = [];
    let minUtilFresh = Infinity;
    let minUtilOverage = Infinity;

    for (let i = 0; i < this.pool.length; i++) {
      const entry = this.pool[i]!;
      if (paused.has(entry.accountId)) continue;
      const windows = this.rateLimitStore.getAll(entry.accountId);
      if (windows.some((w) => w.status === 'blocked')) continue;
      const sessionWindow = windows.find((w) => w.name === SESSION_WINDOW);
      const overageWindow = windows.find((w) => w.name === OVERAGE_WINDOW);
      const sonnetWindow = windows.find((w) => w.name === SONNET_WINDOW);
      const util = sessionWindow?.utilization ?? 0;
      const reset = sessionWindow?.reset ?? Number.POSITIVE_INFINITY;
      // "Will this request draw overage?" — the 5h signals apply to every
      // model, and for Sonnet requests we additionally check the Sonnet
      // 7-day window. Sonnet saturation draws overage even when 5h has
      // room, so this is the gap the explicit context closes.
      const sonnetWouldDrawOverage =
        isSonnet &&
        sonnetWindow?.utilization != null &&
        sonnetWindow.utilization >= overageThreshold;
      const willUseOverage =
        overageWindow?.inUse === true ||
        (util >= overageThreshold && overageWindow?.status === 'allowed') ||
        sonnetWouldDrawOverage;

      if (willUseOverage) {
        if (!overageAllowed.has(entry.accountId)) continue;
        overage.push({ idx: i, util, reset });
        if (util < minUtilOverage) minUtilOverage = util;
      } else {
        fresh.push({ idx: i, util, reset });
        if (util < minUtilFresh) minUtilFresh = util;
      }
    }

    // Prefer the fresh tier: drain pool-wide 5h quota before spilling to
    // overage, regardless of which strategy the user picked.
    const tier = fresh.length > 0 ? fresh : overage;
    const minUtil = fresh.length > 0 ? minUtilFresh : minUtilOverage;
    if (tier.length === 0) return null;

    const strategy = this.getStrategy();
    if (strategy === 'earliest-reset') {
      // Hard-target the account whose window rolls over soonest. Tie-break
      // by lower utilization (so we don't hammer a nearly-exhausted tie),
      // then by pool index for determinism. Do NOT advance the cursor —
      // traffic sticks to the chosen account until it blocks or resets.
      const ranked = [...tier].sort(
        (a, b) => a.reset - b.reset || a.util - b.util || a.idx - b.idx,
      );
      return this.pool[ranked[0]!.idx]!;
    }

    // balance (default): tie band around minUtil rotates fairly via cursor.
    const tieCutoff = minUtil + TIE_BAND;
    const banded = tier.filter((c) => c.util <= tieCutoff);

    // Walk the pool starting at the cursor; take the first tier member we
    // hit so rotation inside the band is stable and fair.
    for (let i = 0; i < this.pool.length; i++) {
      const idx = (this.cursor + i) % this.pool.length;
      const hit = banded.find((c) => c.idx === idx);
      if (hit) {
        this.cursor = (idx + 1) % this.pool.length;
        return this.pool[idx]!;
      }
    }

    // Unreachable (tier is non-empty and the circular walk covers every
    // index) — fall back to null for type safety.
    return null;
  }
}
