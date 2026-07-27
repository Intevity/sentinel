/**
 * 429 handling, request-id → account mapping, and rate_limits_updated
 * broadcast debouncing, all against a real upstream listener.
 *
 * The 429 tests used to assert the opposite of what they assert now. Sentinel
 * replayed a throttled request under a DIFFERENT account's Bearer token —
 * byte-identical payload, second credential, immediately after the first was
 * rate-limited, which reads as credential rotation to evade a rate limit. That
 * replay is gone; a 429 reaches the client. Auto-switching still moves FUTURE
 * requests off the saturated account via the rotator, which is what these tests
 * now pin down.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';

describe('proxy 429 handling (real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('forwards a 429 to the client without replaying it under another credential', async () => {
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
      // A second, healthy account IS available — the point of this test is that
      // Sentinel does not use it to re-send this request.
      tokenProvider: () => provided[Math.min(call++, provided.length - 1)] ?? null,
    });

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
    // The client sees the 429, which is what Claude Code expects and handles.
    expect(res.status).toBe(429);

    // Exactly ONE upstream hit, under the FIRST account's token. Two hits with
    // two different Bearer tokens is the pattern being removed.
    const msgsHits = ctx.fake
      .requests()
      .filter((r) => r.url.startsWith('/v1/messages'))
      .map((r) => r.headers.authorization);
    expect(msgsHits).toEqual(['Bearer first-token']);

    // The 429's own rate-limit headers still land in the store against the
    // account that earned them — that is what steers the rotator away from it
    // on subsequent requests, without replaying this one.
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.rateLimitStore.getAll('first-acc').length).toBeGreaterThan(0);
    expect(ctx.rateLimitStore.getAll('second-acc')).toEqual([]);
  });

  it('forwards a 429 unchanged when only one account exists', async () => {
    ctx = await startProxyWithFake({
      tokens: ['only-token'],
      accounts: [{ id: 'only-acc', email: 'only@example.com', token: 'only-token' }],
      tokenProvider: () => ({ token: 'only-token', accountId: 'only-acc' }),
    });

    ctx.fake.queueResponse('/v1/messages', { status: 429 });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(429);

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

    const rlBroadcasts = ctx.ipcServer.broadcasts.filter((m) => m.type === 'rate_limits_updated');
    // First broadcast fired; second is inside the 2s debounce window and must be suppressed.
    expect(rlBroadcasts).toHaveLength(1);
  });
});
