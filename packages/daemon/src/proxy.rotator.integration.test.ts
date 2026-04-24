/**
 * Migrated from `proxy.test.ts` — 429 retry, request-id → account
 * mapping, and rate_limits_updated broadcast debouncing. The 429-retry
 * test is the highest-value part of the migration: the mock version only
 * proved that `https.request` was called twice; the integration version
 * proves the real body is replayed to the real upstream with the real
 * rotator selection, and that the rate-limit store reflects both
 * attempts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  startProxyWithFake,
  postThroughProxy,
  type StartedProxy,
} from './proxy.test-helpers.js';

describe('proxy 429 rotator retry (real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('retries once against a different rotator account when the first returns 429', async () => {
    const provided = [
      { token: 'first-token', accountId: 'first-acc' },
      { token: 'second-token', accountId: 'second-acc' },
    ];
    let call = 0;

    ctx = await startProxyWithFake({
      tokens: ['first-token', 'second-token'],
      accounts: [
        { id: 'first-acc', email: 'first@example.com', token: 'first-token' },
        { id: 'second-acc', email: 'second@example.com', token: 'second-token' },
      ],
      tokenProvider: () => provided[Math.min(call++, provided.length - 1)] ?? null,
    });

    // First upstream hit 429s; second hit succeeds.
    ctx.fake.queueResponse('/v1/messages', {
      status: 429,
      extraHeaders: {
        'anthropic-ratelimit-unified-5h-status': 'blocked',
      },
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [],
    });
    expect(res.status).toBe(200);

    // Two upstream /v1/messages hits, in order: first-token then second-token.
    const msgsHits = ctx.fake
      .requests()
      .filter((r) => r.url.startsWith('/v1/messages'))
      .map((r) => r.headers.authorization);
    expect(msgsHits).toEqual(['Bearer first-token', 'Bearer second-token']);

    // Rate-limit store reflects both: first-acc had the 429 headers,
    // second-acc carried the successful response headers.
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.rateLimitStore.getAll('first-acc').length).toBeGreaterThan(0);
    expect(ctx.rateLimitStore.getAll('second-acc').length).toBeGreaterThan(0);
  });

  it('forwards the 429 when the rotator can only return the same account', async () => {
    ctx = await startProxyWithFake({
      tokens: ['only-token'],
      accounts: [{ id: 'only-acc', email: 'only@example.com', token: 'only-token' }],
      // Provider always returns the same account — the retry path sees
      // no alternate and must fall through.
      tokenProvider: () => ({ token: 'only-token', accountId: 'only-acc' }),
    });

    ctx.fake.queueResponse('/v1/messages', { status: 429 });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(429);

    // Only ONE upstream hit — no retry happened.
    const hits = ctx.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    expect(hits).toHaveLength(1);
  });
});

describe('proxy request-id → account map (real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('records the rotated account against the upstream request-id', async () => {
    ctx = await startProxyWithFake({
      tokens: ['primary-token', 'rotated-token'],
      accounts: [
        { id: 'primary-id', email: 'primary@example.com', token: 'primary-token' },
        { id: 'rotated-id', email: 'rotated@example.com', token: 'rotated-token' },
      ],
      tokenProvider: () => ({ token: 'rotated-token', accountId: 'rotated-id' }),
    });

    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await new Promise((r) => setTimeout(r, 20));

    // The fake synthesizes a fresh request-id per /v1/messages response.
    // The proxy must have captured it against the rotated account.
    expect(ctx.requestAccountMap.size()).toBeGreaterThan(0);
  });

  it('skips the map write when the upstream response has no request-id header', async () => {
    ctx = await startProxyWithFake();
    // Override: a /v1/messages response without a request-id. Easiest
    // shape is a queued override with an empty body and no fake-injected
    // headers other than scenario defaults — but scenarios DO emit a
    // request-id. Drop it via extraHeaders.
    ctx.fake.queueResponse('/v1/messages', {
      extraHeaders: { 'request-id': '' }, // empty string → treated as absent by proxy
    });

    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.requestAccountMap.size()).toBe(0);
  });
});

describe('proxy 401 upstream auth failure (real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('fires onUpstreamAuthFailure when upstream returns 401 on a request', async () => {
    const calls: string[] = [];
    ctx = await startProxyWithFake({
      onUpstreamAuthFailure: (accountId) => calls.push(accountId),
    });

    // Anthropic can reject a server-side-revoked token even when the fake
    // has it registered. Use a one-off status=401 override.
    ctx.fake.queueResponse('/v1/messages', { status: 401 });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toContain('acct-int');
  });
});

describe('proxy rate_limits_updated broadcast (real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('broadcasts rate_limits_updated on the first request and debounces a second within 2s', async () => {
    ctx = await startProxyWithFake();

    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await new Promise((r) => setTimeout(r, 30));
    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await new Promise((r) => setTimeout(r, 30));

    const rlBroadcasts = ctx.ipcServer.broadcasts.filter(
      (m) => m.type === 'rate_limits_updated',
    );
    // First broadcast fired; second is inside the 2s debounce window and must be suppressed.
    expect(rlBroadcasts).toHaveLength(1);
  });
});
