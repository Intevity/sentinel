import type { Database } from 'better-sqlite3';
import type { ClaudeCodeCredentials } from '@sentinel/shared';
import { listAccounts } from './db.js';
import {
  readSentinelCredentials,
  writeSentinelCredentials,
  writeClaudeCodeCredentials,
} from './accounts.js';
import { refreshAccessToken, REFRESH_TOKEN_EXPIRED } from './oauth.js';
import type { IpcServer } from './ipc.js';
import type { ActiveToken, ActiveAccountId } from './proxy.js';

/** Refresh a credential when its access token expires within this window. */
const REFRESH_THRESHOLD_MS = 30 * 60 * 1000;

/** How often the background scanner walks every stored credential. */
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** Randomize each scan's wait by ±this fraction. A fixed 15-minute interval
 *  makes the refresh train land on a perfectly predictable grid; combined with
 *  N accounts refreshing back-to-back it reads as scripted rather than
 *  user-driven. Only the *schedule* is randomized — which accounts actually
 *  refresh is still governed by REFRESH_THRESHOLD_MS, so jitter never causes an
 *  extra token call. */
const CHECK_JITTER_RATIO = 0.2;

/** Pause between per-account refreshes within one scan, so N due accounts don't
 *  hit the token endpoint as a single concurrent burst from one IP. */
const SCAN_STAGGER_MS = 2_000;

function jittered(ms: number, random: () => number = Math.random): number {
  return Math.round(ms * (1 + (random() * 2 - 1) * CHECK_JITTER_RATIO));
}

export interface TokenRefresherDeps {
  db: Database;
  activeToken: ActiveToken;
  activeAccountId: ActiveAccountId;
  ipcServer: IpcServer;
  /** Auto-switching pool cache. Structural type so this module doesn't import
   *  TokenRotator (avoids a circular dep with index.ts). `refresh()` must be
   *  called after every successful token rotation or the pool will keep
   *  handing out the pre-refresh token and requests will 401. */
  tokenRotator: { refresh(): void };
}

export interface RefreshResult {
  success: boolean;
  expiresAt?: number;
  error?: string;
  /** True when the refresh token itself was rejected — caller must prompt re-login. */
  needsReauth?: boolean;
}

// Accounts whose refresh token has been rejected. Retried only after the user
// re-authenticates via store_setup_token (which clears the entry).
const expiredRefreshTokens = new Set<string>();

/** Called from the store_setup_token success handler so a re-authenticated
 *  account is eligible for background refresh again. */
export function markAccountReauthenticated(accountId: string): void {
  expiredRefreshTokens.delete(accountId);
}

export async function refreshIfNeeded(
  deps: TokenRefresherDeps,
  accountId: string,
  email: string,
  force = false,
  /** True only when the caller has REAL evidence the token was rejected
   *  upstream (a 401 on an actual inference request). Routine callers — manual
   *  "Refresh token", the usage-API liveness probe, the startup heal pass —
   *  leave this false. It governs whether an inference-only (no-refresh-token)
   *  account is flagged for re-auth: such a token is long-lived and can't be
   *  refreshed, so a mere `force` must NOT condemn it; only a real rejection
   *  (or actual local expiry) does. Ignored for accounts that have a refresh
   *  token — those refresh normally. */
  tokenRejected = false,
): Promise<RefreshResult> {
  if (!force && expiredRefreshTokens.has(accountId)) {
    return {
      success: false,
      error: 'Sign-in expired — please re-authenticate.',
      needsReauth: true,
    };
  }

  const creds = readSentinelCredentials(accountId);
  if (!creds?.accessToken) {
    // No stored credential at all — same end-state as a dead token: the account
    // can't be used without re-auth. Broadcast so the Re-authenticate banner
    // lights up instead of the card silently drifting on stale data. Reused
    // reason 'expired' keeps the UI listener single-path (AccountSwitcher maps
    // that reason to expiredAccountIds → needsReauth → banner).
    deps.ipcServer.broadcast({
      type: 'token_refresh_failed',
      accountId,
      email,
      reason: 'expired',
    });
    return {
      success: false,
      error: 'No stored credentials — add the account again.',
      needsReauth: true,
    };
  }

  const msRemaining = creds.expiresAt - Date.now();

  if (!creds.refreshToken) {
    // Inference-scoped `claude setup-token` accounts carry a long-lived (~1yr)
    // access token with NO refresh token. They're healthy unless the access
    // token has actually expired, OR an upstream 401 (tokenRejected) proves it's
    // dead. A routine `force` (manual refresh, usage probe, startup heal) is NOT
    // evidence of death and must NOT light the Re-authenticate banner — that was
    // the bug where refreshing/restarting instantly "expired" a fresh account.
    if (tokenRejected || msRemaining <= 0) {
      deps.ipcServer.broadcast({
        type: 'token_refresh_failed',
        accountId,
        email,
        reason: 'expired',
      });
      return {
        success: false,
        error: 'Token expired — add the account again.',
        needsReauth: true,
      };
    }
    return { success: true, expiresAt: creds.expiresAt };
  }

  if (!force && msRemaining > REFRESH_THRESHOLD_MS) {
    return { success: true, expiresAt: creds.expiresAt };
  }

  try {
    const tokens = await refreshAccessToken(creds.refreshToken);
    const updated: ClaudeCodeCredentials = {
      ...creds,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? creds.refreshToken,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scopes: tokens.scope ? tokens.scope.split(' ').filter(Boolean) : creds.scopes,
    };
    writeSentinelCredentials(accountId, updated);

    // Invariant: Sentinel's keychain now has the new token; the rotator pool
    // must reflect it before the next pick() or Auto routing will keep
    // serving the pre-refresh token and 401. Invalidate unconditionally —
    // the pool covers every non-excluded account, not just the active one.
    deps.tokenRotator.refresh();

    // If this account is currently active, keep Claude Code's keychain slot and
    // the proxy's in-memory token reference in sync so the next request uses
    // the fresh token without waiting for a switch.
    if (accountId === deps.activeAccountId.value) {
      try {
        writeClaudeCodeCredentials(updated);
      } catch (err) {
        console.warn(
          '[TokenRefresher] Could not update Claude Code keychain:',
          err instanceof Error ? err.message : String(err),
        );
      }
      deps.activeToken.value = updated.accessToken;
    }

    expiredRefreshTokens.delete(accountId);
    console.log(
      `[TokenRefresher] Refreshed ${email} (${accountId}) — expires ${new Date(updated.expiresAt).toISOString()}`,
    );
    deps.ipcServer.broadcast({ type: 'token_refreshed', accountId, expiresAt: updated.expiresAt });
    return { success: true, expiresAt: updated.expiresAt };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === REFRESH_TOKEN_EXPIRED) {
      expiredRefreshTokens.add(accountId);
      deps.ipcServer.broadcast({
        type: 'token_refresh_failed',
        accountId,
        email,
        reason: 'expired',
      });
      return {
        success: false,
        error: 'Sign-in expired — please re-authenticate.',
        needsReauth: true,
      };
    }
    console.warn(`[TokenRefresher] Failed to refresh ${email}:`, msg);
    // Everything that isn't a token-endpoint 400/401 — timeouts, DNS errors,
    // 5xx from the endpoint — is reported as "network" so the UI message is
    // actionable ("try again later") rather than scary ("re-authenticate").
    const reason = msg.startsWith('Token refresh failed') ? 'unknown' : 'network';
    deps.ipcServer.broadcast({ type: 'token_refresh_failed', accountId, email, reason });
    return { success: false, error: msg };
  }
}

async function scanAll(deps: TokenRefresherDeps, staggerMs = SCAN_STAGGER_MS): Promise<void> {
  const accounts = listAccounts(deps.db);
  for (let i = 0; i < accounts.length; i++) {
    const acct = accounts[i];
    /* v8 ignore next -- listAccounts never yields holes; index guard for TS. */
    if (!acct) continue;
    // Space out consecutive refreshes. Only accounts actually due for a refresh
    // make a network call, so in the common case this loop is a no-op walk and
    // the delay never materializes.
    if (i > 0 && staggerMs > 0) {
      await new Promise((r) => setTimeout(r, staggerMs));
    }
    await refreshIfNeeded(deps, acct.id, acct.email);
  }
}

/**
 * Start the background token refresher. Runs an immediate pass so a token
 * that expired overnight gets refreshed before the user's first API call,
 * then re-scans on a jittered ~CHECK_INTERVAL_MS cadence. Returns a stop
 * function.
 *
 * Uses a self-rescheduling timeout rather than setInterval so each wait gets
 * its own jitter instead of one fixed period repeating forever.
 */
export function startTokenRefresher(
  deps: TokenRefresherDeps,
  opts: { random?: () => number; staggerMs?: number } = {},
): () => void {
  const random = opts.random ?? Math.random;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(
      () => {
        void scanAll(deps, opts.staggerMs).finally(scheduleNext);
      },
      jittered(CHECK_INTERVAL_MS, random),
    );
  };

  void scanAll(deps, opts.staggerMs);
  scheduleNext();

  return (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
