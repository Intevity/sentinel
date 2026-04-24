/**
 * Integration tests for `fetchRunBudget` against the fake Anthropic
 * `/v1/code/routines/run-budget` endpoint. Greenfield — no pre-existing
 * unit test to supersede. Zero mocks: every test drives the real fetch
 * + header + JSON-parse code path through a real HTTP round-trip.
 *
 * The Team-plan run-budget endpoint is undocumented and returns its
 * `limit`/`used` fields as strings in some deployments and numbers in
 * others. `parseDollarField` accepts both forms; these tests pin that
 * contract end-to-end so a fake that drifts from the live shape fails
 * loudly.
 *
 * Sprint 3 of `documentation/TEST_MIGRATION_PLAN.md` — lifts the
 * coverage exemption on `claude-ai-run-budget.ts` (vitest.config.ts).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { fetchRunBudget } from './claude-ai-run-budget.js';
import { startFakeAnthropic, type FakeAnthropic } from '@claude-sentinel/test-harness';

describe('claude-ai-run-budget integration (real fetch, fake endpoint)', () => {
  let fake: FakeAnthropic;
  const TOKEN = 'rb-token';

  beforeAll(async () => {
    fake = await startFakeAnthropic();
    fake.registerToken(TOKEN);
    process.env.ANTHROPIC_UPSTREAM_URL = fake.origin;
  });

  afterAll(async () => {
    await fake.close();
    delete process.env.ANTHROPIC_UPSTREAM_URL;
  });

  beforeEach(() => {
    fake.resetRequests();
  });

  it('returns a parsed RunBudget on 200 healthy body', async () => {
    const budget = await fetchRunBudget('org-1', TOKEN);
    expect(budget).toEqual({
      limitUsd: 10_000,
      usedUsd: 1_234,
      unifiedBillingEnabled: true,
    });
  });

  it('parses string-valued limit/used fields', async () => {
    fake.queueResponse('/v1/code/routines/run-budget', {
      status: 200,
      body: { limit: '99.50', used: '12.25', unified_billing_enabled: false },
    });
    const budget = await fetchRunBudget('org-1', TOKEN);
    expect(budget).toEqual({
      limitUsd: 99.5,
      usedUsd: 12.25,
      unifiedBillingEnabled: false,
    });
  });

  it('returns null on 403 (Max/Pro plan — endpoint does not apply)', async () => {
    fake.queueResponse('/v1/code/routines/run-budget', {
      status: 403,
      body: { error: { type: 'permission_error' } },
    });
    expect(await fetchRunBudget('org-1', TOKEN)).toBeNull();
  });

  it('returns null on 404', async () => {
    fake.queueResponse('/v1/code/routines/run-budget', { status: 404, body: '' });
    expect(await fetchRunBudget('org-1', TOKEN)).toBeNull();
  });

  it('returns null on 401 (auth_expired — primary usage path handles reauth)', async () => {
    expect(await fetchRunBudget('org-1', 'not-a-registered-token')).toBeNull();
  });

  it('returns null on 500 (transient upstream failure)', async () => {
    fake.queueResponse('/v1/code/routines/run-budget', { status: 500, body: '' });
    expect(await fetchRunBudget('org-1', TOKEN)).toBeNull();
  });

  it('returns null on malformed JSON body', async () => {
    fake.queueResponse('/v1/code/routines/run-budget', { status: 200, body: 'not json' });
    expect(await fetchRunBudget('org-1', TOKEN)).toBeNull();
  });

  it('returns null on transport failure (fake closed mid-test)', async () => {
    await fake.close();
    try {
      expect(await fetchRunBudget('org-1', TOKEN)).toBeNull();
    } finally {
      fake = await startFakeAnthropic();
      fake.registerToken(TOKEN);
      process.env.ANTHROPIC_UPSTREAM_URL = fake.origin;
    }
  });

  it('returns null for empty accessToken (short-circuits without a request)', async () => {
    expect(await fetchRunBudget('org-1', '   ')).toBeNull();
    expect(
      fake.requests().filter((r) => r.url === '/v1/code/routines/run-budget'),
    ).toHaveLength(0);
  });

  it('returns null for empty orgUuid (short-circuits without a request)', async () => {
    expect(await fetchRunBudget('', TOKEN)).toBeNull();
    expect(
      fake.requests().filter((r) => r.url === '/v1/code/routines/run-budget'),
    ).toHaveLength(0);
  });

  it('sends the required beta, version, and org-routing headers', async () => {
    await fetchRunBudget('org-42', TOKEN);
    const hits = fake.requests().filter((r) => r.url === '/v1/code/routines/run-budget');
    expect(hits).toHaveLength(1);
    const headers = hits[0]!.headers;
    expect(headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(headers['anthropic-beta']).toBe('ccr-triggers-2026-01-30');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-organization-uuid']).toBe('org-42');
    expect(headers['accept']).toBe('*/*');
  });

  it('maps null-valued limit/used through parseDollarField to null', async () => {
    fake.queueResponse('/v1/code/routines/run-budget', {
      status: 200,
      body: { limit: null, used: null, unified_billing_enabled: true },
    });
    const budget = await fetchRunBudget('org-1', TOKEN);
    expect(budget).toEqual({
      limitUsd: null,
      usedUsd: null,
      unifiedBillingEnabled: true,
    });
  });

  it('coerces non-finite numeric strings to null', async () => {
    fake.queueResponse('/v1/code/routines/run-budget', {
      status: 200,
      body: { limit: 'not-a-number', used: 'NaN', unified_billing_enabled: true },
    });
    const budget = await fetchRunBudget('org-1', TOKEN);
    expect(budget).toEqual({
      limitUsd: null,
      usedUsd: null,
      unifiedBillingEnabled: true,
    });
  });
});
