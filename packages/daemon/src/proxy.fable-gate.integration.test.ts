/**
 * Migrated from `proxy.test.ts` — Fable-7d saturation short-circuit.
 * These tests never hit upstream: the short-circuit fires when the
 * active account's `unified-7d_oi` window is saturated AND the
 * account is NOT opted into overage. Assertions verify the 503 shape
 * and that the fake receives zero /v1/messages hits.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';

function seedFable(
  store: import('./rate-limit-store.js').RateLimitStore,
  id: string,
  util: number,
  reset = Math.floor(Date.now() / 1000) + 900,
): void {
  store.update(id, {
    'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
    'anthropic-ratelimit-unified-7d_oi-utilization': String(util),
    'anthropic-ratelimit-unified-7d_oi-reset': String(reset),
  });
}

describe('proxy Fable 7-day gate (real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('returns 503 sentinel_fable_saturated on a Fable request when not opted in', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'hot', email: 'hot@example.com', token: 'integration-token' }],
      getOverageAllowedIds: () => new Set(),
      getOverageBufferPct: () => 5,
    });
    seedFable(ctx.rateLimitStore, 'hot', 1.0);

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-fable-5',
      messages: [],
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('sentinel_fable_saturated');
    // Upstream must NOT have seen the request.
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(false);
  });

  it('lets the Fable request through when the account is opted into overage', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'hot', email: 'hot@example.com', token: 'integration-token' }],
      getOverageAllowedIds: () => new Set(['hot']),
      getOverageBufferPct: () => 5,
    });
    seedFable(ctx.rateLimitStore, 'hot', 1.0);

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-fable-5',
      messages: [],
    });
    expect(res.status).toBe(200);
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(true);
  });

  it('does not short-circuit Opus requests on a Fable-saturated account', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'hot', email: 'hot@example.com', token: 'integration-token' }],
      getOverageAllowedIds: () => new Set(),
      getOverageBufferPct: () => 5,
    });
    seedFable(ctx.rateLimitStore, 'hot', 1.0);

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [],
    });
    expect(res.status).toBe(200);
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(true);
  });

  it('does not short-circuit when Fable 7d util is below the threshold', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'warm', email: 'warm@example.com', token: 'integration-token' }],
      getOverageAllowedIds: () => new Set(),
      getOverageBufferPct: () => 5,
    });
    seedFable(ctx.rateLimitStore, 'warm', 0.6);

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-fable-5',
      messages: [],
    });
    expect(res.status).toBe(200);
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(true);
  });

  it('does not short-circuit when the Fable window is missing from the store', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'unprobed', email: 'unprobed@example.com', token: 'integration-token' }],
      getOverageAllowedIds: () => new Set(),
      getOverageBufferPct: () => 5,
    });
    // No seedFable — an empty store for this account.

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-fable-5',
      messages: [],
    });
    expect(res.status).toBe(200);
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(true);
  });
});
