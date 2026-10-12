/**
 * Pooled API-key accounts. When the account Sentinel routes a Claude Code
 * request to is backed by an Anthropic API key rather than a subscription
 * token, the proxy must authenticate it the way the API expects a key:
 * `x-api-key`, no `Authorization: Bearer`, no subscription OAuth beta flag,
 * and the workspace an identity-linked key acts in.
 *
 * Driven over real HTTP through `startProxyWithFake`. The fake accepts an
 * `x-api-key` only for registered keys, so a 200 here is proof the key arrived
 * where the API reads it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import { startProxyWithFake, type StartedProxy } from './proxy.test-helpers.js';
import { applyPooledCredential } from './proxy.js';

const API_KEY = `sk-ant-api03-${'k'.repeat(95)}`;
const USER_KEY = `sk-ant-usr01-${'u'.repeat(95)}`;
const CLI_UA = 'claude-cli/2.1.197 (external, cli)';

async function post(port: number, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'claude-sonnet-4-5-20250929', messages: [] }),
  });
}

describe('proxy with a pooled API-key account (real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('sends the key as x-api-key with the workspace, and drops the OAuth beta flag', async () => {
    const workspaceAsked: string[] = [];
    const workspaceFor = (id: string): string | undefined => {
      workspaceAsked.push(id);
      return id === 'acct-usr' ? 'wrkspc_01Team' : undefined;
    };
    ctx = await startProxyWithFake({
      tokens: [USER_KEY],
      accounts: [{ id: 'acct-usr', email: 'Personal key', token: USER_KEY }],
      getApiKeyWorkspaceId: workspaceFor,
    });

    // Claude Code signed in with a subscription: it sends its own Bearer token
    // and the OAuth beta flag beside its other betas.
    const res = await post(ctx.proxyPort, {
      authorization: 'Bearer sk-ant-oat01-claude-code-own-login',
      'user-agent': CLI_UA,
      'anthropic-beta': 'claude-code-20250219, oauth-2025-04-20, interleaved-thinking-2025-05-14',
    });
    expect(res.status).toBe(200);

    const upstream = ctx.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    expect(upstream).toHaveLength(1);
    const headers = upstream[0]!.headers;
    expect(headers['x-api-key']).toBe(USER_KEY);
    expect(headers['authorization']).toBeUndefined();
    expect(headers['anthropic-workspace-id']).toBe('wrkspc_01Team');
    expect(headers['anthropic-beta']).toBe('claude-code-20250219,interleaved-thinking-2025-05-14');
    expect(workspaceAsked).toEqual(['acct-usr']);
  });

  it('omits the beta header when the OAuth flag was its only entry, and sends no workspace when none is set', async () => {
    ctx = await startProxyWithFake({
      tokens: [API_KEY],
      accounts: [{ id: 'acct-api', email: 'Workspace key', token: API_KEY }],
      getApiKeyWorkspaceId: () => undefined,
    });

    const res = await post(ctx.proxyPort, {
      authorization: 'Bearer stale',
      'user-agent': CLI_UA,
      'anthropic-beta': 'oauth-2025-04-20',
    });
    expect(res.status).toBe(200);

    const headers = ctx.fake.requests().find((r) => r.url.startsWith('/v1/messages'))!.headers;
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['anthropic-beta']).toBeUndefined();
    expect(headers['anthropic-workspace-id']).toBeUndefined();
  });

  it('authenticates non-messages /v1 calls with the key too', async () => {
    ctx = await startProxyWithFake({
      tokens: [API_KEY],
      accounts: [{ id: 'acct-api', email: 'Workspace key', token: API_KEY }],
    });

    const res = await fetch(`http://127.0.0.1:${ctx.proxyPort}/v1/models`, {
      headers: { authorization: 'Bearer stale', 'user-agent': CLI_UA },
    });
    expect(res.status).toBe(200);
    const headers = ctx.fake.requests().find((r) => r.url.startsWith('/v1/models'))!.headers;
    expect(headers['x-api-key']).toBe(API_KEY);
    expect(headers['authorization']).toBeUndefined();
  });

  it("flags a rejected key on /v1 calls but not on Claude Code's account endpoints", async () => {
    const flagged: string[] = [];
    // The key is NOT registered with the fake, so every upstream call is 401.
    ctx = await startProxyWithFake({
      tokens: [],
      accounts: [{ id: 'acct-api', email: 'Workspace key', token: API_KEY }],
      onUpstreamAuthFailure: (id) => flagged.push(id),
    });

    const profile = await fetch(`http://127.0.0.1:${ctx.proxyPort}/api/oauth/profile`, {
      headers: { 'user-agent': CLI_UA },
    });
    expect(profile.status).toBe(401);
    expect(flagged).toEqual([]);

    const messages = await post(ctx.proxyPort, { 'user-agent': CLI_UA });
    expect(messages.status).toBe(401);
    await vi.waitFor(() => expect(flagged).toEqual(['acct-api']));
  });
});

describe('applyPooledCredential', () => {
  const headersOf = (h: Record<string, string | string[]>): IncomingMessage['headers'] => ({
    ...h,
  });

  it('puts a subscription token in Authorization and removes a client x-api-key', () => {
    const headers = headersOf({ 'x-api-key': 'client', 'anthropic-beta': 'oauth-2025-04-20' });
    applyPooledCredential(headers, 'sk-ant-oat01-token', 'wrkspc_ignored');
    expect(headers).toEqual({
      authorization: 'Bearer sk-ant-oat01-token',
      'anthropic-beta': 'oauth-2025-04-20',
    });
  });

  it('reads a beta header that arrived as an array', () => {
    const headers = headersOf({ 'anthropic-beta': ['oauth-2025-04-20', 'context-1m-2025-08-07'] });
    applyPooledCredential(headers, API_KEY, undefined);
    expect(headers['anthropic-beta']).toBe('context-1m-2025-08-07');
  });

  it('leaves a request with no beta header without one', () => {
    const headers = headersOf({ authorization: 'Bearer stale' });
    applyPooledCredential(headers, USER_KEY, 'wrkspc_01A');
    expect(headers).toEqual({ 'x-api-key': USER_KEY, 'anthropic-workspace-id': 'wrkspc_01A' });
  });
});
