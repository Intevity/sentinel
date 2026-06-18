/**
 * Integration tests for `packages/daemon/src/oauth.ts`.
 *
 * Two describe blocks:
 *   1. `oauth integration (real fetch, fake token endpoint)` — covers
 *      `refreshAccessToken`, the simplest exported function. Supersedes the
 *      deleted `oauth.test.ts` (Sprint 2 of TEST_MIGRATION_PLAN.md).
 *   2. `oauth login flow (PKCE end-to-end)` — covers `startOAuthLogin`
 *      (and, via it, the internal `startCallbackServer`, `exchangeCode`,
 *      `fetchProfile` helpers). Added in Sprint 5 to lift oauth.ts's
 *      coverage exemption.
 *
 * No `vi.mock`, no fetch stubs. Every path goes over a real TCP socket
 * to the fake Anthropic server.
 *
 * The login flow's one test seam is the `openAuthUrl` callback on
 * `startOAuthLogin`. In production it shells out to a platform browser;
 * here we intercept the URL, parse `state`, and synthesize the browser
 * callback with a direct `fetch` to `http://localhost:47285/callback`.
 * The real HTTP listener in `startCallbackServer` handles it — no mock,
 * no monkey-patching.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  refreshAccessToken,
  startOAuthLogin,
  OAUTH_ABORTED,
  REFRESH_TOKEN_EXPIRED,
  type OAuthResult,
} from './oauth.js';
import { startFakeAnthropic, type FakeAnthropic } from '@sentinel/test-harness';

describe('oauth integration (real fetch, fake token endpoint)', () => {
  let fake: FakeAnthropic;

  beforeAll(async () => {
    fake = await startFakeAnthropic();
    process.env.OAUTH_TOKEN_URL = fake.tokenUrl;
  });

  afterAll(async () => {
    await fake.close();
    delete process.env.OAUTH_TOKEN_URL;
  });

  beforeEach(() => {
    fake.setScenario('healthy-account');
    fake.resetRequests();
  });

  it('refreshAccessToken returns a well-formed TokenResponse on success', async () => {
    const tokens = await refreshAccessToken('refresh-abc');
    expect(typeof tokens.access_token).toBe('string');
    expect(tokens.access_token).toMatch(/^fake-access-/);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBeGreaterThan(0);
    expect(tokens.refresh_token).toMatch(/^fake-refresh-/);
  });

  it('POSTs grant_type=refresh_token with the correct body and URL', async () => {
    await refreshAccessToken('refresh-xyz');
    const hits = fake.requests().filter((r) => r.url === '/v1/oauth/token');
    expect(hits.length).toBe(1);
    const hit = hits[0]!;
    expect(hit.method).toBe('POST');
    expect(hit.headers['content-type']).toBe('application/json');
    const body = JSON.parse(hit.body) as {
      grant_type: string;
      refresh_token: string;
      client_id: string;
    };
    expect(body.grant_type).toBe('refresh_token');
    expect(body.refresh_token).toBe('refresh-xyz');
    expect(body.client_id).toBeTruthy();
  });

  it('throws REFRESH_TOKEN_EXPIRED when the endpoint returns 400', async () => {
    fake.setScenario('refresh-token-expired');
    await expect(refreshAccessToken('revoked-token')).rejects.toThrowError(REFRESH_TOKEN_EXPIRED);
  });

  it('throws REFRESH_TOKEN_EXPIRED when the endpoint returns 401', async () => {
    fake.setScenario('token-endpoint-401');
    await expect(refreshAccessToken('unauth')).rejects.toThrowError(REFRESH_TOKEN_EXPIRED);
  });

  it('throws a generic error on 5xx with the response body in the message', async () => {
    fake.setScenario('token-endpoint-500');
    await expect(refreshAccessToken('any')).rejects.toThrow(/503.*maintenance/);
  });

  it('throws REFRESH_TOKEN_EXPIRED on a 400 invalid_request body shape', async () => {
    // Anthropic's docs distinguish between `invalid_grant` (refresh token
    // revoked) and `invalid_request` (e.g. malformed grant_type). Both
    // produce a 400 and our code treats all 400/401 as expired-refresh.
    // This test pins that contract: if either shape ever comes back as
    // something else, the test breaks loudly.
    fake.setScenario('token-endpoint-invalid-request');
    await expect(refreshAccessToken('bad-body')).rejects.toThrowError(REFRESH_TOKEN_EXPIRED);
  });

  it('records the request against the fake so contract drift is visible', async () => {
    await refreshAccessToken('refresh-contract').catch(() => {});
    const hits = fake.requests().filter((r) => r.url === '/v1/oauth/token');
    expect(hits.length).toBe(1);
    const body = JSON.parse(hits[0]!.body) as { grant_type: string; refresh_token: string };
    expect(body.grant_type).toBe('refresh_token');
    expect(body.refresh_token).toBe('refresh-contract');
  });
});

describe('oauth login flow (PKCE end-to-end)', () => {
  let fake: FakeAnthropic;

  beforeAll(async () => {
    fake = await startFakeAnthropic();
    process.env.OAUTH_TOKEN_URL = fake.tokenUrl;
    process.env.OAUTH_AUTH_URL = fake.authUrl;
    // fetchProfile hits api.anthropic.com in production; redirect to the
    // fake for tests. getAnthropicOrigin() reads this env var.
    process.env.ANTHROPIC_UPSTREAM_URL = fake.origin;
  });

  afterAll(async () => {
    await fake.close();
    delete process.env.OAUTH_TOKEN_URL;
    delete process.env.OAUTH_AUTH_URL;
    delete process.env.ANTHROPIC_UPSTREAM_URL;
  });

  beforeEach(() => {
    fake.setScenario('healthy-account');
    fake.resetRequests();
    // Quiet the ~7 log lines the callback server prints per login. Do not
    // silence console.error — genuine failures should still surface.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /**
   * Fire the browser-side callback redirect into the real callback server
   * on port 47285. `authUrl` must contain the `state` param set by
   * startOAuthLogin.
   *
   * The fetch may reject with ECONNRESET because `forceClose` destroys
   * active sockets after writing the success HTML. A real browser
   * tolerates this; the test doesn't care about the response body.
   * Swallow the error so it does not bubble as an unhandled rejection.
   */
  async function simulateCallback(
    authUrl: string,
    opts: { code?: string; state?: string; errorParam?: string } = {},
  ): Promise<void> {
    const parsed = new URL(authUrl);
    const state = opts.state ?? parsed.searchParams.get('state') ?? '';
    const params = new URLSearchParams();
    if (opts.errorParam) {
      params.set('error', opts.errorParam);
      params.set('state', state);
    } else {
      params.set('code', opts.code ?? 'fake-auth-code');
      params.set('state', state);
    }
    try {
      await fetch(`http://localhost:47285/callback?${params.toString()}`);
    } catch {
      // expected on success path — server force-closes sockets after res.end()
    }
  }

  /**
   * Drive a happy-path login end-to-end. Used by many tests that need a
   * completed OAuthResult for their assertions.
   */
  async function completeLogin(
    authUrlCapture?: { url?: string },
    overrides: { incognito?: boolean; orgUuidHint?: string } = {},
  ): Promise<OAuthResult> {
    return startOAuthLogin({
      ...overrides,
      openAuthUrl: (url) => {
        if (authUrlCapture) authUrlCapture.url = url;
        void simulateCallback(url);
      },
    });
  }

  it('returns credentials + profile on happy path', async () => {
    const result = await completeLogin();
    expect(result.credentials.accessToken).toMatch(/^fake-access-/);
    expect(result.credentials.refreshToken).toMatch(/^fake-refresh-/);
    expect(result.credentials.expiresAt).toBeGreaterThan(Date.now());
    // Default profile = claude_max, has_claude_max: true.
    expect(result.email).toBe('test@example.com');
    expect(result.displayName).toBe('Test User');
    expect(result.subscriptionType).toBe('max');
    expect(result.hasExtraUsageEnabled).toBe(true);
    expect(result.organizationRole).toBe('primary_owner');
    expect(result.workspaceRole).toBeNull();
    // Sanity: the fake saw the token exchange and the profile fetch.
    expect(fake.requests().some((r) => r.url === '/v1/oauth/token' && r.method === 'POST')).toBe(
      true,
    );
    expect(fake.requests().some((r) => r.url === '/api/oauth/profile')).toBe(true);
  });

  it('surfaces authorize URL with PKCE params (S256 challenge, state, redirect_uri, scope)', async () => {
    const capture: { url?: string } = {};
    await completeLogin(capture);
    const url = new URL(capture.url!);
    expect(url.origin + url.pathname).toBe(fake.authUrl);
    const params = url.searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('code_challenge_method')).toBe('S256');
    const challenge = params.get('code_challenge');
    // base64url: alphanumeric, '-', '_', no padding, 43 chars for SHA-256.
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('state')).toMatch(/^[0-9a-f]{32}$/);
    expect(params.get('client_id')).toBeTruthy();
    expect(params.get('redirect_uri')).toBe('http://localhost:47285/callback');
    expect(params.get('scope')).toContain('user:profile');
    expect(params.get('scope')).toContain('user:inference');
  });

  it('exchangeCode POSTs verifier/code/state/redirect_uri as JSON', async () => {
    const capture: { url?: string } = {};
    await completeLogin(capture);
    const exchangeHit = fake.requests().find((r) => r.url === '/v1/oauth/token');
    expect(exchangeHit).toBeDefined();
    expect(exchangeHit!.method).toBe('POST');
    expect(exchangeHit!.headers['content-type']).toBe('application/json');
    const body = JSON.parse(exchangeHit!.body) as {
      grant_type: string;
      code: string;
      redirect_uri: string;
      client_id: string;
      code_verifier: string;
      state: string;
    };
    expect(body.grant_type).toBe('authorization_code');
    expect(body.code).toBe('fake-auth-code');
    expect(body.redirect_uri).toBe('http://localhost:47285/callback');
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    // state echoed back matches the authorize URL's state param
    const authState = new URL(capture.url!).searchParams.get('state');
    expect(body.state).toBe(authState);
  });

  // ─── fetchProfile org_type matrix ─────────────────────────────────────
  // Each override queues a fully-shaped profile body so the subscriptionType
  // mapping is exercised without depending on which access_token the fake
  // mints. The auth gate still runs first (resolveAuth is called before
  // popOverride in handleProfile).

  const queueProfileBody = (orgType: string, opts: Partial<{ hasMax: boolean }> = {}): void => {
    fake.queueResponse('/api/oauth/profile', {
      body: {
        account: {
          uuid: 'u-1',
          email: 'x@y.z',
          display_name: 'X',
          has_claude_max: opts.hasMax ?? false,
        },
        organization: {
          uuid: 'o-1',
          name: 'Org',
          organization_type: orgType,
          rate_limit_tier: 'standard',
          organization_role: 'admin',
          workspace_role: null,
          has_extra_usage_enabled: false,
        },
      },
    });
  };

  it('fetchProfile maps org_type=claude_max to subscriptionType=max', async () => {
    queueProfileBody('claude_max');
    const r = await completeLogin();
    expect(r.subscriptionType).toBe('max');
  });

  it('fetchProfile maps org_type=claude_pro to subscriptionType=pro', async () => {
    queueProfileBody('claude_pro');
    const r = await completeLogin();
    expect(r.subscriptionType).toBe('pro');
  });

  it('fetchProfile maps org_type=claude_enterprise to subscriptionType=enterprise', async () => {
    queueProfileBody('claude_enterprise');
    const r = await completeLogin();
    expect(r.subscriptionType).toBe('enterprise');
  });

  it('fetchProfile maps org_type=claude_team to subscriptionType=team', async () => {
    queueProfileBody('claude_team');
    const r = await completeLogin();
    expect(r.subscriptionType).toBe('team');
  });

  it('unknown org_type becomes empty subscriptionType; every optional field honors its default', async () => {
    // Every optional field is omitted so the nullish-coalesce defaults fire
    // for email, display_name, accountUuid, rate_limit_tier, orgUuid,
    // orgName, organizationRole, workspaceRole, has_extra_usage_enabled.
    fake.queueResponse('/api/oauth/profile', {
      body: {
        account: {},
        organization: {},
      },
    });
    const r = await completeLogin();
    expect(r.subscriptionType).toBe('');
    expect(r.email).toBe('');
    expect(r.displayName).toBe('');
    expect(r.accountUuid).toBe('');
    // rateLimitTier is exposed only via credentials, not the top-level result.
    expect(r.orgUuid).toBe('');
    expect(r.orgName).toBe('');
    expect(r.organizationRole).toBe('user');
    expect(r.workspaceRole).toBeNull();
    expect(r.hasExtraUsageEnabled).toBe(false);
    // subscriptionType / rateLimitTier both empty → neither attached to
    // credentials (exercises the truthiness guards at oauth.ts:790-791).
    expect(r.credentials.subscriptionType).toBeUndefined();
    expect(r.credentials.rateLimitTier).toBeUndefined();
  });

  it('fetchProfile returns empty struct when profile endpoint returns non-2xx', async () => {
    fake.queueResponse('/api/oauth/profile', { status: 500, body: 'boom' });
    const r = await completeLogin();
    expect(r.email).toBe('');
    expect(r.subscriptionType).toBe('');
    expect(r.organizationRole).toBe('user');
    expect(r.workspaceRole).toBeNull();
    expect(r.hasExtraUsageEnabled).toBe(false);
  });

  it('fetchProfile returns empty struct when JSON parse throws', async () => {
    // Status 200 but a non-JSON body forces res.json() to throw.
    fake.queueResponse('/api/oauth/profile', { status: 200, body: '<<<not-json>>>' });
    const r = await completeLogin();
    expect(r.email).toBe('');
    expect(r.subscriptionType).toBe('');
  });

  // ─── exchangeCode failure ─────────────────────────────────────────────

  it('startOAuthLogin throws "Token exchange failed" when /v1/oauth/token returns 5xx', async () => {
    fake.queueResponse('/v1/oauth/token', { status: 500, body: 'boom' });
    await expect(
      startOAuthLogin({
        openAuthUrl: (url) => {
          void simulateCallback(url);
        },
      }),
    ).rejects.toThrow(/Token exchange failed \(500\): boom/);
  });

  // ─── startCallbackServer branches ─────────────────────────────────────

  it('provider error on callback (?error=access_denied) rejects with "OAuth error: access_denied"', async () => {
    await expect(
      startOAuthLogin({
        openAuthUrl: (url) => {
          // Include error_description to exercise the log-format branch that
          // appends `, desc: <text>` when the provider ships a description.
          const parsed = new URL(url);
          const state = parsed.searchParams.get('state') ?? '';
          const params = new URLSearchParams({
            error: 'access_denied',
            error_description: 'user declined consent',
            state,
          });
          void fetch(`http://localhost:47285/callback?${params.toString()}`).catch(() => undefined);
        },
      }),
    ).rejects.toThrow(/OAuth error: access_denied/);
  });

  it('callback with no code is ignored; subsequent valid callback still resolves', async () => {
    const result = await startOAuthLogin({
      openAuthUrl: async (url) => {
        // First: empty callback (no code, no state). Server should 204.
        const first = await fetch('http://localhost:47285/callback');
        expect(first.status).toBe(204);
        // Second: valid callback → resolves the login.
        await simulateCallback(url);
      },
    });
    expect(result.credentials.accessToken).toMatch(/^fake-access-/);
  });

  it('callback with mismatched state is ignored; subsequent valid callback still resolves', async () => {
    const result = await startOAuthLogin({
      openAuthUrl: async (url) => {
        // Wrong state, real code — server should 204 and keep waiting.
        await simulateCallback(url, { state: 'not-the-real-state' });
        // Now the real callback.
        await simulateCallback(url);
      },
    });
    expect(result.credentials.accessToken).toMatch(/^fake-access-/);
  });

  it('non-/callback request returns 204 and does not resolve', async () => {
    const result = await startOAuthLogin({
      openAuthUrl: async (url) => {
        // Browser favicon-style prefetch.
        const favi = await fetch('http://localhost:47285/favicon.ico');
        expect(favi.status).toBe(204);
        await simulateCallback(url);
      },
    });
    expect(result.credentials.accessToken).toMatch(/^fake-access-/);
  });

  it('AbortSignal before callback rejects with OAUTH_ABORTED and releases the port', async () => {
    const ctrl = new AbortController();
    const p = startOAuthLogin({
      signal: ctrl.signal,
      openAuthUrl: () => {
        // Deliberately do not fire the callback. Abort below.
      },
    });
    // Allow the listen to bind before aborting.
    await new Promise((r) => setImmediate(r));
    ctrl.abort();
    await expect(p).rejects.toThrow(OAUTH_ABORTED);
    // Port released — the next login must succeed.
    const result = await completeLogin();
    expect(result.credentials.accessToken).toMatch(/^fake-access-/);
  });

  it('consecutive logins after a prior completion work (port reuse)', async () => {
    // Each completeLogin() binds the fixed port 47285, completes, and
    // cleans up. A second call must bind cleanly — the close path has to
    // release both the TCP listener and `serverClosePromise`.
    const r1 = await completeLogin();
    const r2 = await completeLogin();
    expect(r1.credentials.accessToken).toMatch(/^fake-access-/);
    expect(r2.credentials.accessToken).toMatch(/^fake-access-/);
    expect(r1.credentials.accessToken).not.toBe(r2.credentials.accessToken);
  });

  it('AbortSignal fired after successful callback does not re-throw', async () => {
    const ctrl = new AbortController();
    const result = await startOAuthLogin({
      signal: ctrl.signal,
      openAuthUrl: (url) => {
        void simulateCallback(url);
      },
    });
    // Aborting after resolution should be a no-op (listener is {once: true}).
    ctrl.abort();
    expect(result.credentials.accessToken).toMatch(/^fake-access-/);
  });

  it('accepts bare AbortSignal (backward-compat overload)', async () => {
    // The legacy call signature passed AbortSignal positionally instead of
    // via options. Ensure the `instanceof AbortSignal` branch still routes.
    const ctrl = new AbortController();
    // We can't use the AbortSignal path with openAuthUrl injection because
    // the positional overload doesn't accept an options object — so test
    // the cancellation branch directly by aborting immediately.
    const p = startOAuthLogin(ctrl.signal);
    await new Promise((r) => setImmediate(r));
    ctrl.abort();
    await expect(p).rejects.toThrow(OAUTH_ABORTED);
  });

  it('defaults expires_in to 1h and scopes to DEFAULT SCOPES when the token response omits them', async () => {
    // Queue a token response that omits both expires_in and scope — exercises
    // the `?? 3600` / `?? SCOPES` fallbacks at oauth.ts:787-788.
    fake.queueResponse('/v1/oauth/token', {
      body: {
        access_token: 'fake-access-noexpiry',
        refresh_token: 'fake-refresh-noexpiry',
        token_type: 'Bearer',
        // expires_in and scope omitted
      },
    });
    // Also register this token so the profile fetch's Bearer check passes.
    // registerToken is the public API on the fake; without it, handleProfile
    // returns 401 and we lose the assertion.
    const before = Date.now();
    const r = await startOAuthLogin({
      openAuthUrl: (url) => {
        void simulateCallback(url);
      },
    }).catch((err: Error) => err);
    // The minted token is 'fake-access-noexpiry' which wasn't registered by
    // handleToken (that happens for fake-access-<uuid> tokens, not our
    // queued override). Profile fetch will 401 and fetchProfile returns the
    // empty struct — but the credential envelope still uses the defaults.
    expect(r).not.toBeInstanceOf(Error);
    const result = r as OAuthResult;
    expect(result.credentials.accessToken).toBe('fake-access-noexpiry');
    // expires_in omitted → default 3600s. Verify the window is within a
    // generous tolerance of 1h (account for elapsed test time).
    const deltaMs = result.credentials.expiresAt - before;
    expect(deltaMs).toBeGreaterThanOrEqual(3600 * 1000 - 2_000);
    expect(deltaMs).toBeLessThanOrEqual(3600 * 1000 + 2_000);
    // scope omitted → default SCOPES list is used (non-empty, split on spaces).
    expect(result.credentials.scopes.length).toBeGreaterThan(1);
    expect(result.credentials.scopes).toContain('user:profile');
    expect(result.credentials.scopes).toContain('user:inference');
  });

  it('orgUuidHint is accepted without altering the authorize URL or failing the flow', async () => {
    // The hint is logged but intentionally NOT attached to the URL (see
    // comment in oauth.ts at line 731). This test pins that contract.
    const capture: { url?: string } = {};
    const result = await completeLogin(capture, { orgUuidHint: 'abc-123' });
    expect(result.credentials.accessToken).toMatch(/^fake-access-/);
    expect(new URL(capture.url!).searchParams.get('organization_uuid')).toBeNull();
  });
});
