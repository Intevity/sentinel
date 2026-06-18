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

export interface TokenRefresherDeps {
  db: Database;
  activeToken: ActiveToken;
  activeAccountId: ActiveAccountId;
  ipcServer: IpcServer;
  /** Round-robin pool cache. Structural type so this module doesn't import
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
// re-authenticates via start_login (which clears the entry).
const expiredRefreshTokens = new Set<string>();

/** Called from the start_login success handler so a re-authenticated account
 *  is eligible for background refresh again. */
export function markAccountReauthenticated(accountId: string): void {
  expiredRefreshTokens.delete(accountId);
}

export async function refreshIfNeeded(
  deps: TokenRefresherDeps,
  accountId: string,
  email: string,
  force = false,
): Promise<RefreshResult> {
  if (!force && expiredRefreshTokens.has(accountId)) {
    return {
      success: false,
      error: 'Sign-in expired — please re-authenticate.',
      needsReauth: true,
    };
  }

  const creds = readSentinelCredentials(accountId);
  if (!creds?.refreshToken) {
    // Missing keychain entry is the same end-state as a rejected refresh
    // token from the user's POV: the account cannot be refreshed without
    // re-auth. Broadcast so the UI's Re-authenticate banner lights up
    // instead of the card silently drifting on stale data. Reused reason
    // 'expired' keeps the UI listener single-path (AccountSwitcher maps
    // that reason to expiredAccountIds → needsReauth → banner).
    deps.ipcServer.broadcast({
      type: 'token_refresh_failed',
      accountId,
      email,
      reason: 'expired',
    });
    return {
      success: false,
      error: 'No stored refresh token — sign in again.',
      needsReauth: true,
    };
  }

  const msRemaining = creds.expiresAt - Date.now();
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
    // must reflect it before the next pick() or round-robin will keep
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

async function scanAll(deps: TokenRefresherDeps): Promise<void> {
  const accounts = listAccounts(deps.db);
  for (const acct of accounts) {
    await refreshIfNeeded(deps, acct.id, acct.email);
  }
}

/**
 * Start the background token refresher. Runs an immediate pass so a token
 * that expired overnight gets refreshed before the user's first API call,
 * then re-scans every CHECK_INTERVAL_MS. Returns a stop function.
 */
export function startTokenRefresher(deps: TokenRefresherDeps): () => void {
  void scanAll(deps);
  const timer = setInterval(() => {
    void scanAll(deps);
  }, CHECK_INTERVAL_MS);
  return (): void => {
    clearInterval(timer);
  };
}
