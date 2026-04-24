/**
 * Migrated from `proxy.test.ts` — Sonnet-7d saturation short-circuit.
 * These tests never hit upstream: the short-circuit fires when the
 * active account's `unified-7d_sonnet` window is saturated AND the
 * account is NOT opted into overage. Assertions verify the 503 shape
 * and that the fake receives zero /v1/messages hits.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';

function seedSonnet(
  store: import('./rate-limit-store.js').RateLimitStore,
  id: string,
  util: number,
  reset = Math.floor(Date.now() / 1000) + 900,
): void {
  store.update(id, {
    'anthropic-ratelimit-unified-7d_sonnet-status': 'allowed',
    'anthropic-ratelimit-unified-7d_sonnet-utilization': String(util),
    'anthropic-ratelimit-unified-7d_sonnet-reset': String(reset),
  });
}

describe('proxy Sonnet 7-day gate (real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('returns 503 sentinel_sonnet_saturated on a Sonnet request when not opted in', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'hot', email: 'hot@example.com', token: 'integration-token' }],
      getOverageAllowedIds: () => new Set(),
      getOverageBufferPct: () => 5,
    });
    seedSonnet(ctx.rateLimitStore, 'hot', 1.0);

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-sonnet-4-6',
      messages: [],
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('sentinel_sonnet_saturated');
    // Upstream must NOT have seen the request.
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(false);
  });

  it('lets the Sonnet request through when the account is opted into overage', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'hot', email: 'hot@example.com', token: 'integration-token' }],
      getOverageAllowedIds: () => new Set(['hot']),
      getOverageBufferPct: () => 5,
    });
    seedSonnet(ctx.rateLimitStore, 'hot', 1.0);

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-sonnet-4-6',
      messages: [],
    });
    expect(res.status).toBe(200);
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(true);
  });

  it('does not short-circuit Opus requests on a Sonnet-saturated account', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'hot', email: 'hot@example.com', token: 'integration-token' }],
      getOverageAllowedIds: () => new Set(),
      getOverageBufferPct: () => 5,
    });
    seedSonnet(ctx.rateLimitStore, 'hot', 1.0);

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [],
    });
    expect(res.status).toBe(200);
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(true);
  });

  it('does not short-circuit when Sonnet 7d util is below the threshold', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'warm', email: 'warm@example.com', token: 'integration-token' }],
      getOverageAllowedIds: () => new Set(),
      getOverageBufferPct: () => 5,
    });
    seedSonnet(ctx.rateLimitStore, 'warm', 0.6);

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-sonnet-4-6',
      messages: [],
    });
    expect(res.status).toBe(200);
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(true);
  });

  it('does not short-circuit when the Sonnet window is missing from the store', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'unprobed', email: 'unprobed@example.com', token: 'integration-token' }],
      getOverageAllowedIds: () => new Set(),
      getOverageBufferPct: () => 5,
    });
    // No seedSonnet — an empty store for this account.

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-sonnet-4-6',
      messages: [],
    });
    expect(res.status).toBe(200);
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(true);
  });
});
