/**
 * Claude OAuth — token refresh + profile fetch.
 *
 * Sentinel no longer performs the OAuth *login* flow itself. Mimicking Claude
 * Code's authorize/callback/token-exchange flow with its client_id is against
 * Anthropic's ToS, so accounts are now imported from Claude Code's own session
 * (the user signs in via Claude Code; Sentinel reads the resulting credentials
 * from `claude setup-token` — see `index.ts` `storeSetupTokenAccount`).
 *
 * What remains here are two daemon-side calls that operate on credentials Claude
 * Code already minted:
 *   - refreshAccessToken(): exchange a refresh token for a fresh access token
 *     pair (used by the background token-refresher and the manual "Refresh
 *     token" IPC). This keeps non-active pool accounts usable without a switch.
 *   - fetchProfile(): read /api/oauth/profile to verify an account's
 *     org/identity (used by the startup credential-verifier for drift detection).
 */

import { getAnthropicOrigin, getOAuthTokenUrl } from './hosts.js';

/** Sentinel error thrown when the refresh_token itself is rejected by the
 *  token endpoint (400/401). Callers catch this to drive re-login UX. */
export const REFRESH_TOKEN_EXPIRED = 'REFRESH_TOKEN_EXPIRED';

/** Claude Code's OAuth client id. Sentinel reuses it ONLY to refresh tokens
 *  Claude Code already issued — never to initiate a login (that is delegated to
 *  Claude Code itself). Tests override the token endpoint via OAUTH_TOKEN_URL;
 *  see hosts.ts. Production defaults are unchanged. */
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Bounded network budgets for the daemon's own outbound Anthropic calls.
 *  fetchProfile previously used a bare `await fetch` with no timeout; on a
 *  cold VM a hung first HTTPS connection (DNS/TLS/proxy) stalled every
 *  awaiting caller — including daemon startup — indefinitely. */
const PROFILE_FETCH_TIMEOUT_MS = 10_000;
const TOKEN_FETCH_TIMEOUT_MS = 30_000;

// ─── Token refresh ─────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

/**
 * Exchange a refresh token for a fresh access/refresh token pair.
 * Used by the background refresher and by the manual "Refresh token" IPC.
 *
 * Throws a plain Error whose message is REFRESH_TOKEN_EXPIRED when the token
 * endpoint returns 400/401 (refresh token revoked or expired). All other
 * failures throw with the response body for diagnostics.
 */
export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  };

  const tokenUrl = getOAuthTokenUrl();
  console.log(`[OAuth] Token refresh → POST ${tokenUrl}`);
  const startedAt = Date.now();
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
  });
  console.log(`[OAuth] Token refresh ← ${res.status} (${Date.now() - startedAt}ms)`);

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    if (res.status === 400 || res.status === 401) {
      console.warn(`[OAuth] Refresh token rejected (${res.status}): ${text}`);
      throw new Error(REFRESH_TOKEN_EXPIRED);
    }
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<TokenResponse>;
}

// ─── Profile fetch ─────────────────────────────────────────────────────────────

interface OAuthProfile {
  // Field names confirmed from Claude Code CLI source (account.uuid, account.email, etc.)
  account?: {
    uuid?: string; // was incorrectly 'account_uuid'
    email?: string; // was incorrectly 'email_address'
    display_name?: string;
    has_claude_max?: boolean; // account-level Max flag (individual seat, not org-level)
  };
  organization?: {
    uuid?: string; // was incorrectly 'organization_uuid'
    organization_type?: string;
    rate_limit_tier?: string;
    has_extra_usage_enabled?: boolean;
    billing_type?: string;
    name?: string;
    organization_role?: string;
    workspace_role?: string | null;
  };
}

export interface ProfileResult {
  email: string;
  displayName: string;
  accountUuid: string;
  subscriptionType: string;
  rateLimitTier: string;
  orgUuid: string;
  orgName: string;
  organizationRole: string;
  workspaceRole: string | null;
  hasExtraUsageEnabled: boolean;
}

export async function fetchProfile(accessToken: string): Promise<ProfileResult> {
  const empty: ProfileResult = {
    email: '',
    displayName: '',
    accountUuid: '',
    subscriptionType: '',
    rateLimitTier: '',
    orgUuid: '',
    orgName: '',
    organizationRole: 'user',
    workspaceRole: null,
    hasExtraUsageEnabled: false,
  };

  const startedAt = Date.now();
  try {
    const res = await fetch(`${getAnthropicOrigin()}/api/oauth/profile`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(PROFILE_FETCH_TIMEOUT_MS),
    });
    console.log(`[OAuth] GET /api/oauth/profile ← ${res.status} (${Date.now() - startedAt}ms)`);
    if (!res.ok) return empty;
    const data = (await res.json()) as OAuthProfile;

    const orgType = data.organization?.organization_type ?? '';
    const subscriptionType =
      orgType === 'claude_max'
        ? 'max'
        : orgType === 'claude_pro'
          ? 'pro'
          : orgType === 'claude_enterprise'
            ? 'enterprise'
            : orgType === 'claude_team'
              ? 'team'
              : '';

    return {
      email: data.account?.email ?? '',
      displayName: data.account?.display_name ?? '',
      accountUuid: data.account?.uuid ?? '',
      subscriptionType,
      rateLimitTier: data.organization?.rate_limit_tier ?? '',
      orgUuid: data.organization?.uuid ?? '',
      orgName: data.organization?.name ?? '',
      organizationRole: data.organization?.organization_role ?? 'user',
      workspaceRole: data.organization?.workspace_role ?? null,
      // Use account.has_claude_max (user-level) rather than organization.has_extra_usage_enabled
      // (org-level). The org flag is true for any team org that has Max members, so it cannot
      // reliably identify whether THIS specific user has a Max seat.
      hasExtraUsageEnabled: data.account?.has_claude_max ?? false,
    };
  } catch (err) {
    // AbortError (timeout) lands here too — callers treat `empty` as
    // "unverifiable right now" and fall through to optimistic local state.
    console.warn(
      `[OAuth] GET /api/oauth/profile failed after ${Date.now() - startedAt}ms:`,
      err instanceof Error ? err.message : err,
    );
    return empty;
  }
}
