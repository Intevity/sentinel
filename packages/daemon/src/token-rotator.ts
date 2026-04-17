import type { Database } from 'better-sqlite3';
import { listAccounts } from './db.js';
import { readActiveCredentials, readSentinelCredentials } from './accounts.js';
import type { RateLimitStore } from './rate-limit-store.js';

/**
 * A (accountId, token) pair drawn from the rotator's current pool.
 */
export interface RotatedCredential {
  accountId: string;
  token: string;
}

/**
 * Round-robin token selector used when the user's `switchingMode` is
 * `round-robin`. Holds a cached pool of {accountId, token} pairs for every
 * account whose credentials Sentinel can resolve from the OS keychain, and
 * hands them out one-per-request so rate-limit usage drains evenly across
 * every account.
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
    for (const account of accounts) {
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
   * Return the next account that isn't blocked or overage-disabled,
   * advancing the round-robin cursor. Returns null when every account
   * is unavailable or the pool is empty.
   */
  pick(): RotatedCredential | null {
    if (this.pool.length === 0) return null;
    // Try at most `pool.length` accounts before giving up — every one
    // could be blocked.
    for (let i = 0; i < this.pool.length; i++) {
      const idx = (this.cursor + i) % this.pool.length;
      const candidate = this.pool[idx]!;
      if (!this.isBlocked(candidate.accountId)) {
        this.cursor = (idx + 1) % this.pool.length;
        return candidate;
      }
    }
    return null;
  }

  /**
   * Heuristic: an account is considered blocked when any of its rate-limit
   * windows has `status === 'blocked'`. Overage-disabled is effectively the
   * same signal as far as the proxy is concerned — the account cannot serve
   * traffic until it resets.
   */
  private isBlocked(accountId: string): boolean {
    const windows = this.rateLimitStore.getAll(accountId);
    return windows.some((w) => w.status === 'blocked');
  }
}
