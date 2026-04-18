import type { Database } from 'better-sqlite3';
import { listAccounts } from './db.js';
import { readActiveCredentials, readSentinelCredentials } from './accounts.js';
import type { RateLimitStore } from './rate-limit-store.js';

/** Mirror of `auto-switch.ts`'s SESSION_WINDOW — the 5-hour rolling window
 *  is the one users think of as "session limit". */
const SESSION_WINDOW = 'unified-5h';

/** Candidates within this much of the minimum utilization are treated as
 *  equals and cycled through via the round-robin cursor. Prevents
 *  oscillation once accounts have converged. */
const TIE_BAND = 0.01; // 1 percentage point

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
 * On each `pick()`, prefers the account with the lowest `unified-5h`
 * utilization so hot accounts drain last and cold accounts catch up. When
 * multiple candidates are within `TIE_BAND` of the minimum, the
 * round-robin cursor decides — keeping fair rotation once accounts have
 * converged.
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
   * Return the account with the most session-window headroom, advancing
   * the round-robin cursor within the tie band. Returns null when every
   * account is unavailable or the pool is empty.
   */
  pick(): RotatedCredential | null {
    if (this.pool.length === 0) return null;

    // Score every non-blocked candidate by its unified-5h utilization.
    // Missing/null utilization is treated as 0 — same convention as
    // auto-switch.ts so fresh accounts are preferred over known-hot ones.
    const candidates: { idx: number; util: number }[] = [];
    let minUtil = Infinity;
    for (let i = 0; i < this.pool.length; i++) {
      const entry = this.pool[i]!;
      const windows = this.rateLimitStore.getAll(entry.accountId);
      if (windows.some((w) => w.status === 'blocked')) continue;
      const sessionWindow = windows.find((w) => w.name === SESSION_WINDOW);
      const util = sessionWindow?.utilization ?? 0;
      candidates.push({ idx: i, util });
      if (util < minUtil) minUtil = util;
    }
    if (candidates.length === 0) return null;

    // Tie band: candidates within TIE_BAND of the minimum rotate fairly.
    const tieCutoff = minUtil + TIE_BAND;
    const tier = candidates.filter((c) => c.util <= tieCutoff);

    // Walk the pool starting at the cursor; take the first tier member we
    // hit so rotation inside the band is stable and fair.
    for (let i = 0; i < this.pool.length; i++) {
      const idx = (this.cursor + i) % this.pool.length;
      const hit = tier.find((c) => c.idx === idx);
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
