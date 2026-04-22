/**
 * Claude OAuth PKCE flow — mirrors what Claude Code CLI does.
 *
 * Flow:
 *  1. Generate PKCE verifier + challenge
 *  2. Open browser to claude.ai OAuth authorize URL
 *  3. Spin up a local HTTP server to capture the callback
 *  4. Exchange auth code for tokens via platform.claude.com/v1/oauth/token
 *  5. Return the token set
 */

import { createServer } from 'http';
import { createHash, randomBytes } from 'crypto';

import { exec } from 'child_process';
import type { ClaudeCodeCredentials } from '@claude-sentinel/shared';
import { SENTINEL_LOGO_DATA_URL } from './logo.js';

/** Sentinel error thrown when a login is intentionally aborted (cancel or restart). */
export const OAUTH_ABORTED = 'LOGIN_ABORTED';

/** Sentinel error thrown when the refresh_token itself is rejected by the
 *  token endpoint (400/401). Callers catch this to drive re-login UX. */
export const REFRESH_TOKEN_EXPIRED = 'REFRESH_TOKEN_EXPIRED';

/**
 * Resolves when the current callback server has fully closed.
 * Used to prevent EADDRINUSE when a new login starts immediately after a cancel.
 */
let serverClosePromise: Promise<void> | null = null;

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTH_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const SCOPES =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload org:create_api_key';

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

function generateVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function deriveChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function generateState(): string {
  return randomBytes(16).toString('hex');
}

// ─── Local callback server ────────────────────────────────────────────────────

const CALLBACK_PORT = 47285; // must match the port registered with the OAuth provider

/**
 * Starts the OAuth callback server on the fixed callback port.
 * Waits for any previous server to fully close first so there is never an
 * EADDRINUSE error when a new login starts immediately after a cancel.
 */
async function startCallbackServer(expectedState: string, signal?: AbortSignal): Promise<string> {
  // Wait for the previous server to release the port (if any).
  if (serverClosePromise) {
    console.log('[OAuth] Waiting for previous callback server to close...');
    await serverClosePromise;
  }

  return new Promise((resolve, reject) => {
    let closeResolve!: () => void;
    serverClosePromise = new Promise<void>((r) => {
      closeResolve = r;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${CALLBACK_PORT}`);

      // Silently ignore browser-initiated requests (favicon, etc.)
      if (url.pathname !== '/callback') {
        res.writeHead(204);
        res.end();
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      console.log(
        `[OAuth] Callback received — has_code: ${!!code}, state_match: ${state === expectedState}, error: ${error ?? 'none'}`,
      );

      // Hard failure: the provider returned an explicit error.
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><p>Login failed. You can close this window.</p></body></html>');
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      // No code yet — could be a browser pre-check or prefetch; keep waiting.
      if (!code) {
        console.warn(
          '[OAuth] Callback request had no code — ignoring (browser pre-check?). URL:',
          req.url,
        );
        res.writeHead(204);
        res.end();
        return;
      }

      // State mismatch — browsers sometimes send a stale/duplicate request before
      // the real redirect arrives.  Log it and keep the server open so the correct
      // callback can still be processed.
      if (state !== expectedState) {
        console.warn(
          `[OAuth] State mismatch — ignoring (stale request?). Expected: ${expectedState}, Got: ${state}`,
        );
        res.writeHead(204);
        res.end();
        return;
      }

      // Confirmation page shown after OAuth consent succeeds. Browsers
      // block `window.close()` on tabs they didn't open via JS, so the
      // tab doesn't auto-close; the copy tells the user what to do
      // next. Styling uses the Sentinel app's iOS-blue accent and the
      // 128×128 app icon (inlined as a data URL by build time) so the
      // page feels continuous with Sentinel itself.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Claude Sentinel</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root {
      color-scheme: light dark;
      --ios-blue: #007AFF;
      --bg: #F5F5F7;
      --card: #FFFFFF;
      --fg: #1D1D1F;
      --muted: #6E6E73;
      --border: rgba(0,0,0,0.08);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0D0D0F;
        --card: #1E1E1E;
        --fg: #F5F5F7;
        --muted: #8E8E93;
        --border: rgba(255,255,255,0.08);
      }
    }
    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--fg);
    }
    .shell {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px;
      box-sizing: border-box;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 40px 36px;
      text-align: center;
      max-width: 420px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.08);
    }
    .logo {
      width: 72px;
      height: 72px;
      margin: 0 auto 20px;
      border-radius: 16px;
      display: block;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 22px;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    p {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.5;
    }
    .check {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 12px;
      color: var(--ios-blue);
      font-size: 13px;
      font-weight: 500;
    }
    .check svg { width: 16px; height: 16px; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="card">
      <img class="logo" src="${SENTINEL_LOGO_DATA_URL}" alt="Claude Sentinel">
      <div class="check">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 8.5l3.5 3.5L13 5"></path>
        </svg>
        Signed in
      </div>
      <h1>Claude Sentinel is ready</h1>
      <p>You can close this window and return to Sentinel.</p>
    </div>
  </div>
</body>
</html>`);
      server.close();
      resolve(code);
    });

    // When the server closes for any reason, resolve the close-promise so that
    // the next startCallbackServer call can safely bind to the same port.
    server.on('close', () => {
      closeResolve();
      serverClosePromise = null;
    });

    // Abort handler — closes the server and rejects with the sentinel value so
    // the daemon knows not to broadcast a failure notification.
    const onAbort = (): void => {
      server.close(); // triggers 'close' event → closeResolve()
      reject(new Error(OAUTH_ABORTED));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // Timeout after 5 minutes
    const timer = setTimeout(
      () => {
        server.close();
        reject(new Error('OAuth login timed out (5 minutes)'));
      },
      5 * 60 * 1000,
    );

    server.listen(CALLBACK_PORT, () => {
      console.log(
        `[OAuth] Callback server listening on http://localhost:${CALLBACK_PORT}/callback`,
      );
    });

    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ─── Token exchange ────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
  state: string,
): Promise<TokenResponse> {
  const body = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    state,
  };

  console.log(`[OAuth] Token exchange → POST ${TOKEN_URL}`);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json() as Promise<TokenResponse>;
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

  console.log(`[OAuth] Token refresh → POST ${TOKEN_URL}`);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

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

interface ProfileResult {
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

async function fetchProfile(accessToken: string): Promise<ProfileResult> {
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

  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
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
  } catch {
    return empty;
  }
}

// ─── Open browser ──────────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.error('[OAuth] Failed to open browser:', err.message);
  });
}

// ─── Public API ────────────────────────────────────────────────────────────────

export interface OAuthResult {
  credentials: ClaudeCodeCredentials;
  email: string;
  displayName: string;
  accountUuid: string;
  orgUuid: string;
  orgName: string;
  subscriptionType: string;
  organizationRole: string;
  workspaceRole: string | null;
  hasExtraUsageEnabled: boolean;
  /** URL that was opened in the browser — useful for manual fallback display */
  authUrl: string;
}

/**
 * Run the full PKCE login flow.  Opens the user's browser, waits for the
 * callback, exchanges the code, and returns the credential set.
 *
 * Pass an AbortSignal to cancel the pending login without broadcasting a
 * failure — used when the user starts a new login while one is in progress.
 */
export interface OAuthLoginOptions {
  signal?: AbortSignal;
  /** How to surface the authorize URL to the user. Default opens the
   *  system browser via exec('open URL'), which leaves Sentinel out of
   *  the loop for any cookies claude.ai sets during the login + consent
   *  pages. Callers that want mid-flow cookie capture (e.g. to pick up
   *  the sessionKey for the freshly-added account) can pass an override
   *  that opens the URL inside a Tauri WebviewWindow — the webview's
   *  WKHTTPCookieStore is shared with the rest of the app, so anything
   *  claude.ai sets there is visible to the Connect claude.ai flow
   *  afterwards. */
  openAuthUrl?: (url: string) => void;
  /** Hint the authorize endpoint which org should mint the token.
   *  Attached as `organization_uuid=<uuid>` query param. When the user
   *  is already signed in to claude.ai (sessionKey present), claude.ai
   *  should honor the hint and skip the org chooser. When it isn't
   *  honored, the user sees the chooser as usual — no regression. */
  orgUuidHint?: string;
}

export async function startOAuthLogin(
  signalOrOpts?: AbortSignal | OAuthLoginOptions,
): Promise<OAuthResult> {
  // Backward-compatible overload: older callers pass the AbortSignal
  // directly. The modern callsite passes an options object with both
  // signal and the authorize-URL handler.
  const opts: OAuthLoginOptions =
    signalOrOpts instanceof AbortSignal ? { signal: signalOrOpts } : (signalOrOpts ?? {});

  const verifier = generateVerifier();
  const challenge = deriveChallenge(verifier);
  const state = generateState();

  const redirectUri = `http://localhost:${CALLBACK_PORT}/callback`;
  const codePromise = startCallbackServer(state, opts.signal);

  // Build the authorization URL
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  const authUrl = `${AUTH_URL}?${params.toString()}`;
  // Note: we intentionally don't pass `organization_uuid` on the
  // authorize URL. claude.ai's server keys off the `lastActiveOrg`
  // cookie rather than a URL param, so the correct way to preselect
  // is to fetch `/api/organizations/{uuid}/sync/settings` first (the
  // server answers with a `Set-Cookie: lastActiveOrg=<uuid>`) and
  // then navigate to this URL. That happens on the webview side via
  // open_oauth_webview's preselect path — this function just hands
  // the URL up, along with the hint so the caller can wire it into
  // the webview.

  const openAuthUrl = opts.openAuthUrl ?? openBrowser;
  openAuthUrl(authUrl);
  console.log('[OAuth] Surfaced auth URL:', authUrl);

  // Wait for the auth code
  const code = await codePromise;

  // Exchange for tokens
  const tokens = await exchangeCode(code, verifier, redirectUri, state);
  const profile = await fetchProfile(tokens.access_token);

  const credentials: ClaudeCodeCredentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    scopes: (tokens.scope ?? SCOPES).split(' ').filter(Boolean),
  };
  if (profile.subscriptionType) credentials.subscriptionType = profile.subscriptionType;
  if (profile.rateLimitTier) credentials.rateLimitTier = profile.rateLimitTier;

  return {
    credentials,
    email: profile.email,
    displayName: profile.displayName,
    accountUuid: profile.accountUuid,
    orgUuid: profile.orgUuid,
    orgName: profile.orgName,
    subscriptionType: profile.subscriptionType,
    organizationRole: profile.organizationRole,
    workspaceRole: profile.workspaceRole,
    hasExtraUsageEnabled: profile.hasExtraUsageEnabled,
    authUrl,
  };
}
