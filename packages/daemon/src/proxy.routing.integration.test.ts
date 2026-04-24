/**
 * Migrated from `proxy.test.ts` — routing, credential selection, OTEL
 * forwarding, proxy-error paths. Replaces a cluster of `vi.mock('https')`-
 * based tests with real HTTP requests through `createProxyServer` against
 * the fake Anthropic listener.
 *
 * Each test spins up a fresh proxy + fake + db so failures don't cross-
 * pollute — startup cost is ~30 ms per test on a local dev machine, dwarfed
 * by the signal lift of exercising the real header pipeline + URL parser.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  startProxyWithFake,
  postThroughProxy,
  getThroughProxy,
  type StartedProxy,
} from './proxy.test-helpers.js';

describe('proxy routing + credential selection (real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('tokenProvider takes precedence over activeToken and attributes rate-limits to the rotated account', async () => {
    ctx = await startProxyWithFake({
      tokens: ['primary-token', 'rotated-token'],
      accounts: [
        { id: 'primary-id', email: 'primary@example.com', token: 'primary-token' },
        { id: 'rotated-id', email: 'rotated@example.com', token: 'rotated-token' },
      ],
      tokenProvider: () => ({ token: 'rotated-token', accountId: 'rotated-id' }),
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [],
    });
    expect(res.status).toBe(200);

    // Authorization the fake actually saw must match the rotated token.
    const hit = ctx.fake.requests().find((r) => r.url.startsWith('/v1/messages'));
    expect(hit?.headers.authorization).toBe('Bearer rotated-token');

    // Rate-limit attribution lands under the rotated account.
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.rateLimitStore.getAll('rotated-id').length).toBeGreaterThan(0);
    expect(ctx.rateLimitStore.getAll('primary-id')).toHaveLength(0);
  });

  it('x-sentinel-probe-token / -account override both activeToken and tokenProvider, and are stripped before upstream', async () => {
    ctx = await startProxyWithFake({
      tokens: ['primary-token', 'rotated-token', 'probe-token'],
      accounts: [
        { id: 'primary-id', email: 'primary@example.com', token: 'primary-token' },
        { id: 'rotated-id', email: 'rotated@example.com', token: 'rotated-token' },
        { id: 'probe-account', email: 'probe@example.com', token: 'probe-token' },
      ],
      tokenProvider: () => ({ token: 'rotated-token', accountId: 'rotated-id' }),
    });

    await postThroughProxy(
      ctx.proxyPort,
      '/v1/messages',
      { messages: [] },
      {
        headers: {
          'x-sentinel-probe-token': 'probe-token',
          'x-sentinel-probe-account': 'probe-account',
        },
      },
    );

    const hit = ctx.fake.requests().find((r) => r.url.startsWith('/v1/messages'));
    expect(hit?.headers.authorization).toBe('Bearer probe-token');
    // Probe headers must not leak upstream.
    expect(hit?.headers['x-sentinel-probe-token']).toBeUndefined();
    expect(hit?.headers['x-sentinel-probe-account']).toBeUndefined();

    // Attribution lands on the probe account.
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.rateLimitStore.getAll('probe-account').length).toBeGreaterThan(0);
    expect(ctx.rateLimitStore.getAll('primary-id')).toHaveLength(0);
    expect(ctx.rateLimitStore.getAll('rotated-id')).toHaveLength(0);
  });

  it('falls back to activeToken when tokenProvider returns null', async () => {
    ctx = await startProxyWithFake({
      tokens: ['primary-token'],
      accounts: [{ id: 'primary-id', email: 'primary@example.com', token: 'primary-token' }],
      tokenProvider: () => null,
    });

    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    const hit = ctx.fake.requests().find((r) => r.url.startsWith('/v1/messages'));
    expect(hit?.headers.authorization).toBe('Bearer primary-token');
  });

  it('handles /health GET locally (never touches upstream)', async () => {
    ctx = await startProxyWithFake();
    const res = await getThroughProxy(ctx.proxyPort, '/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; pid: number };
    expect(body.status).toBe('ok');
    expect(typeof body.pid).toBe('number');
    // No upstream hit.
    expect(ctx.fake.requests()).toHaveLength(0);
  });

  it('routes POST /v1/metrics to the OTEL handler (not upstream)', async () => {
    ctx = await startProxyWithFake();
    const res = await postThroughProxy(
      ctx.proxyPort,
      '/v1/metrics',
      // Valid empty OTLP metrics body so the real receiver parses without error.
      { resourceMetrics: [] },
    );
    expect(res.status).toBe(200);
    // The fake never saw /v1/metrics — the OTEL path is local.
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/metrics'))).toBe(false);
  });

  it('routes POST /v1/logs to the OTEL handler', async () => {
    ctx = await startProxyWithFake();
    const res = await postThroughProxy(ctx.proxyPort, '/v1/logs', { resourceLogs: [] });
    expect(res.status).toBe(200);
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/logs'))).toBe(false);
  });

  it('proxies /v1/messages to the fake and preserves the path', async () => {
    ctx = await startProxyWithFake();
    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [],
    });
    expect(res.status).toBe(200);
    const hit = ctx.fake.requests().find((r) => r.url.startsWith('/v1/messages'));
    expect(hit).toBeDefined();
    expect(hit?.url.startsWith('/v1/messages')).toBe(true);
  });

  it('proxies unknown paths to the upstream (future-proof fallback)', async () => {
    ctx = await startProxyWithFake();
    // The fake's default 404 is still a valid upstream hit — the proxy's job
    // is to forward, not to enforce allow-listed paths.
    const res = await getThroughProxy(ctx.proxyPort, '/v1/some-future-endpoint');
    // Either 404 (fake default) or 200 — what matters is that the proxy forwarded
    // rather than refusing.
    expect([200, 404]).toContain(res.status);
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/some-future-endpoint'))).toBe(
      true,
    );
  });

  it('returns 502 when the upstream connection fails', async () => {
    ctx = await startProxyWithFake();
    // Close the fake to force ECONNREFUSED on subsequent proxy requests.
    await ctx.fake.close();

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(502);
  });

  it('returns 502 on upstream connection failure for non-messages paths too', async () => {
    ctx = await startProxyWithFake();
    await ctx.fake.close();
    const res = await getThroughProxy(ctx.proxyPort, '/v1/some-future-endpoint');
    expect(res.status).toBe(502);
  });
});

describe('proxy OTEL error handling (real HTTP)', () => {
  let ctx: StartedProxy;

  beforeEach(async () => {
    ctx = await startProxyWithFake();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('returns 400 from the real OTEL receiver on malformed body', async () => {
    // The real OtelReceiver.handleMetrics catches JSON parse errors and
    // answers 400. This replaces the "otelHandler error → 500" test whose
    // only assertion was that `otelHandler.mockRejectedValue` propagated —
    // the real handler has its own error path we can exercise end-to-end.
    const res = await fetch(`http://127.0.0.1:${ctx.proxyPort}/v1/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
  });
});
