/**
 * Integration tests for `refreshAccessToken` against the fake Anthropic
 * token endpoint. Supersedes the deleted `oauth.test.ts` which mocked
 * `global.fetch`.
 *
 * These tests exercise the real fetch → headers → body path so a drift
 * in the token-endpoint wire shape (status codes, body shapes, MIME
 * types) immediately breaks a test. No `vi.mock`, no fetch stubs.
 *
 * The file `oauth.ts` is currently in `vitest.config.ts`'s coverage
 * exclude list; Sprint 5 of `documentation/TEST_MIGRATION_PLAN.md` will
 * lift that exemption with this file as the backbone. Every test added
 * here is chosen to map 1:1 to a covered branch once the exemption
 * lifts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { refreshAccessToken, REFRESH_TOKEN_EXPIRED } from './oauth.js';
import { startFakeAnthropic, type FakeAnthropic } from '@claude-sentinel/test-harness';

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
    await expect(refreshAccessToken('revoked-token')).rejects.toThrowError(
      REFRESH_TOKEN_EXPIRED,
    );
  });

  it('throws REFRESH_TOKEN_EXPIRED when the endpoint returns 401', async () => {
    fake.setScenario('token-endpoint-401');
    await expect(refreshAccessToken('unauth')).rejects.toThrowError(
      REFRESH_TOKEN_EXPIRED,
    );
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
    await expect(refreshAccessToken('bad-body')).rejects.toThrowError(
      REFRESH_TOKEN_EXPIRED,
    );
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
