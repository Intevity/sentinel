/**
 * Integration test: real refreshAccessToken() against the fake token
 * endpoint. This exercises code that is CURRENTLY excluded from coverage
 * (packages/daemon/src/oauth.ts is in vitest.config.ts's exclude list)
 * because the old test strategy was "mock global.fetch." The fake server
 * lets us drive it end-to-end without hitting platform.claude.com.
 *
 * This test is the seed for Sprint 5 of TEST_MIGRATION_PLAN.md, where
 * oauth.ts's exemption is lifted.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

  it('refreshAccessToken returns a well-formed TokenResponse on success', async () => {
    fake.setScenario('healthy-account');
    const tokens = await refreshAccessToken('refresh-abc');
    expect(typeof tokens.access_token).toBe('string');
    expect(tokens.access_token).toMatch(/^fake-access-/);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBeGreaterThan(0);
  });

  it('throws REFRESH_TOKEN_EXPIRED when the endpoint returns 400', async () => {
    fake.setScenario('refresh-token-expired');
    await expect(refreshAccessToken('revoked-token')).rejects.toThrowError(
      REFRESH_TOKEN_EXPIRED,
    );
    fake.setScenario('healthy-account');
  });

  it('records the request against the fake so contract drift is visible', async () => {
    fake.resetRequests();
    await refreshAccessToken('refresh-xyz').catch(() => {});
    const hits = fake.requests().filter((r) => r.url === '/v1/oauth/token');
    expect(hits.length).toBe(1);
    const body = JSON.parse(hits[0]!.body) as { grant_type: string; refresh_token: string };
    expect(body.grant_type).toBe('refresh_token');
    expect(body.refresh_token).toBe('refresh-xyz');
  });
});
