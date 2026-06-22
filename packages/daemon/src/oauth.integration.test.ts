/**
 * Integration tests for `packages/daemon/src/oauth.ts`.
 *
 * Sentinel no longer runs the OAuth *login* flow (accounts are added via the
 * `claude setup-token` terminal — see index.lifecycle.integration.test.ts's
 * `store_setup_token` block). What remains in oauth.ts are two daemon-side
 * calls, covered here against the fake Anthropic server:
 *   1. `refreshAccessToken` — exchanges a refresh token for a fresh pair.
 *   2. `fetchProfile` — reads /api/oauth/profile to map account/org metadata.
 *
 * No `vi.mock`, no fetch stubs. Every path goes over a real TCP socket to the
 * fake Anthropic server.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { refreshAccessToken, REFRESH_TOKEN_EXPIRED, fetchProfile } from './oauth.js';
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

describe('fetchProfile (real fetch, fake profile endpoint)', () => {
  let fake: FakeAnthropic;

  beforeAll(async () => {
    fake = await startFakeAnthropic();
    // fetchProfile hits api.anthropic.com in production; getAnthropicOrigin()
    // reads this env var, so point it at the fake.
    process.env.ANTHROPIC_UPSTREAM_URL = fake.origin;
  });

  afterAll(async () => {
    await fake.close();
    delete process.env.ANTHROPIC_UPSTREAM_URL;
  });

  beforeEach(() => {
    fake.setScenario('healthy-account');
    fake.resetRequests();
    // Quiet the failure log line fetchProfile prints on the non-2xx path.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['claude_max', 'max'],
    ['claude_pro', 'pro'],
    ['claude_enterprise', 'enterprise'],
    ['claude_team', 'team'],
    ['', ''],
  ] as const)('maps org_type=%s to subscriptionType=%s', async (orgType, expected) => {
    const token = `tok-${orgType || 'none'}`;
    fake.registerToken(token, { org_type: orgType });
    const r = await fetchProfile(token);
    expect(r.subscriptionType).toBe(expected);
  });

  it('maps every account + organization field from the profile response', async () => {
    fake.registerToken('tok-full', {
      org_type: 'claude_max',
      uuid: 'u-1',
      email: 'x@y.z',
      display_name: 'X',
      org_uuid: 'o-1',
      org_name: 'Org',
      rate_limit_tier: 'standard',
      organization_role: 'admin',
      has_claude_max: true,
    });
    const r = await fetchProfile('tok-full');
    expect(r).toMatchObject({
      email: 'x@y.z',
      displayName: 'X',
      accountUuid: 'u-1',
      orgUuid: 'o-1',
      orgName: 'Org',
      rateLimitTier: 'standard',
      organizationRole: 'admin',
      // hasExtraUsageEnabled is sourced from account.has_claude_max (user-level).
      hasExtraUsageEnabled: true,
      subscriptionType: 'max',
    });
  });

  it('returns an empty struct when the profile endpoint returns non-2xx (401 for an unknown token)', async () => {
    const r = await fetchProfile('not-registered');
    expect(r.email).toBe('');
    expect(r.subscriptionType).toBe('');
    expect(r.organizationRole).toBe('user');
    expect(r.workspaceRole).toBeNull();
    expect(r.hasExtraUsageEnabled).toBe(false);
  });

  it('returns an empty struct when the response body is not JSON', async () => {
    fake.registerToken('tok-badjson');
    // 200 with a non-JSON body forces res.json() to throw → empty struct.
    fake.queueResponse('/api/oauth/profile', { status: 200, body: '<<<not-json>>>' });
    const r = await fetchProfile('tok-badjson');
    expect(r.email).toBe('');
    expect(r.subscriptionType).toBe('');
  });
});
