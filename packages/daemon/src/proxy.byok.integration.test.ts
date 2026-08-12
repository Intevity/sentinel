/**
 * Bring-your-own-key passthrough. A client that authenticates itself and is not
 * a Claude Code surface (opencode's native Anthropic provider, any AI SDK app)
 * must reach Anthropic on its OWN credential: Sentinel observes the traffic but
 * never swaps in a pooled subscription token, and never files the response's
 * rate-limit headers against a pooled account.
 *
 * The inverse matters just as much — when Sentinel DOES inject, a stale or
 * dummy `x-api-key` must be stripped, or upstream is free to honour the wrong
 * credential while Sentinel books the usage against the account it thought it
 * used.
 *
 * Driven over real HTTP through `startProxyWithFake`; the fake accepts either
 * auth form, so these requests get real 200s with real rate-limit headers
 * rather than a 401 that would make the attribution assertions vacuous.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, type StartedProxy } from './proxy.test-helpers.js';
import { BYOK_ACCOUNT_ID } from './proxy.js';

const CLIENT_KEY = 'sk-ant-api03-client-owned-key';
const OPENCODE_UA = 'opencode/1.18.16';
/** Real Claude Desktop 3p-gateway UA, verbatim from the desktop-health test. */
const DESKTOP_UA = 'claude-cli/2.1.197 (external, claude-desktop-3p, agent-sdk/0.3.197)';

/** POST /v1/messages with an explicit header set (no implicit Authorization —
 *  `postThroughProxy` always adds one, which is exactly what BYOK must not have). */
async function post(
  port: number,
  headers: Record<string, string>,
  body: unknown = { model: 'claude-sonnet-4-5-20250929', messages: [] },
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('proxy BYOK passthrough (real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('forwards a client API key untouched and never injects the pool token', async () => {
    ctx = await startProxyWithFake({ tokens: ['pool-token', CLIENT_KEY] });
    ctx.activeToken.value = 'pool-token';

    const res = await post(ctx.proxyPort, {
      'x-api-key': CLIENT_KEY,
      'user-agent': OPENCODE_UA,
    });
    expect(res.status).toBe(200);

    const upstream = ctx.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.headers['x-api-key']).toBe(CLIENT_KEY);
    // The whole point: no pooled Bearer rides along beside the client's key.
    expect(upstream[0]!.headers['authorization']).toBeUndefined();
  });

  it('attributes BYOK rate-limit headers to the reserved key, not a pooled account', async () => {
    ctx = await startProxyWithFake({
      scenario: 'healthy-account',
      tokens: ['pool-token', CLIENT_KEY],
      accounts: [{ id: 'acct-pool', email: 'pool@example.com', token: 'pool-token' }],
    });

    await post(ctx.proxyPort, { 'x-api-key': CLIENT_KEY, 'user-agent': OPENCODE_UA });
    await new Promise((r) => setTimeout(r, 30));

    // The scenario emits real 5h/7d windows, so "nothing on the pool account"
    // is a live assertion rather than an artifact of an unauthenticated 401.
    expect(ctx.rateLimitStore.getAll(BYOK_ACCOUNT_ID).length).toBeGreaterThan(0);
    expect(ctx.rateLimitStore.getAll('acct-pool')).toEqual([]);
  });

  it('does not broadcast routed_account_changed for BYOK traffic', async () => {
    ctx = await startProxyWithFake({
      tokens: ['tok-auto', CLIENT_KEY],
      accounts: [{ id: 'acct-auto', email: 'auto@example.com', token: 'tok-auto' }],
      tokenProvider: () => ({ token: 'tok-auto', accountId: 'acct-auto' }),
    });

    await post(ctx.proxyPort, { 'x-api-key': CLIENT_KEY, 'user-agent': OPENCODE_UA });
    await new Promise((r) => setTimeout(r, 30));

    expect(
      ctx.ipcServer.broadcasts.filter((m) => m.type === 'routed_account_changed'),
    ).toHaveLength(0);
  });

  it('strips a stale x-api-key when it injects the pool token for Claude Code', async () => {
    ctx = await startProxyWithFake({ tokens: ['pool-token'] });
    ctx.activeToken.value = 'pool-token';

    const res = await post(ctx.proxyPort, {
      'x-api-key': 'stale-dummy-key',
      'user-agent': 'claude-cli/2.1.197 (external, cli)',
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    });
    expect(res.status).toBe(200);

    const upstream = ctx.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    expect(upstream[0]!.headers['authorization']).toBe('Bearer pool-token');
    expect(upstream[0]!.headers['x-api-key']).toBeUndefined();
  });

  it('keeps pooling for the Claude Desktop gateway, which sends a dummy credential', async () => {
    // Desktop is a Claude surface by user-agent even though its gateway config
    // supplies a placeholder key — it must keep getting the real pool token.
    ctx = await startProxyWithFake({ tokens: ['pool-token'] });
    ctx.activeToken.value = 'pool-token';

    await post(ctx.proxyPort, {
      'x-api-key': 'sentinel-local-proxy',
      'user-agent': DESKTOP_UA,
    });

    const upstream = ctx.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    expect(upstream[0]!.headers['authorization']).toBe('Bearer pool-token');
    expect(upstream[0]!.headers['x-api-key']).toBeUndefined();
  });
});
