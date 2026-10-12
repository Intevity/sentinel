/**
 * Adding an account backed by an Anthropic API key (`store_api_key`), end to
 * end through a real daemon: input validation, the add-time key check against
 * the fake API, what lands in the keychain and the DB, and the key actually
 * authenticating Claude Code traffic through the daemon's proxy.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, writeFileSync } from 'fs';
import { userInfo } from 'os';
import type { AccountInfo, ClaudeCodeCredentials, StoreApiKeyResult } from '@sentinel/shared';
import { startTestDaemon, type TestDaemon } from './index.test-helpers.js';

const KEY = `sk-ant-usr01-${'K'.repeat(95)}`;
const NEW_KEY = `sk-ant-api03-${'N'.repeat(95)}`;
const CLI_UA = 'claude-cli/2.1.197 (external, cli)';

let ctx: TestDaemon | null = null;
afterEach(async () => {
  if (ctx) {
    chmodSync(ctx.keychainPath, 0o600);
    await ctx.cleanup();
    ctx = null;
  }
});

function keychain(d: TestDaemon): Record<string, Record<string, string> | undefined> {
  return JSON.parse(readFileSync(d.keychainPath, 'utf-8')) as Record<
    string,
    Record<string, string> | undefined
  >;
}

function storedCreds(d: TestDaemon, id: string): ClaudeCodeCredentials {
  return JSON.parse(keychain(d)['Sentinel-credentials']![id]!) as ClaudeCodeCredentials;
}

async function accounts(d: TestDaemon): Promise<AccountInfo[]> {
  return (await d.request<AccountInfo[]>({ type: 'refresh_accounts' })).data ?? [];
}

/** A Claude Code request through the daemon's proxy, signed in with some
 *  other subscription login of its own. */
async function claudeCodeRequest(d: TestDaemon): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${d.daemonPort}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer sk-ant-oat01-claude-code-own-login',
      'user-agent': CLI_UA,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-5-20250929', messages: [] }),
  });
  await res.arrayBuffer();
  return res.status;
}

describe('store_api_key', () => {
  it('adds a verified key as an API account that serves Claude Code through the proxy', async () => {
    ctx = await startTestDaemon();
    ctx.fake.registerToken(KEY);

    const r = await ctx.request<StoreApiKeyResult>(
      {
        type: 'store_api_key',
        apiKey: `  ${KEY}\n`,
        label: 'Personal key',
        orgName: 'Acme',
        workspaceId: 'wrkspc_01Team',
      },
      { timeoutMs: 10_000 },
    );
    expect(r).toMatchObject({
      success: true,
      data: { email: 'Personal key', orgName: 'Acme', verified: true },
    });
    const bc = await ctx.waitForBroadcast<{
      type: 'login_complete';
      email: string;
      imported?: boolean;
      reauth?: boolean;
    }>((m) => m.type === 'login_complete');
    expect(bc).toMatchObject({ email: 'Personal key', imported: true, reauth: false });

    // The key was checked as a key: x-api-key on the free models list.
    const check = ctx.fake.requests().find((x) => x.url.startsWith('/v1/models'));
    expect(check?.headers['x-api-key']).toBe(KEY);
    expect(check?.headers['anthropic-workspace-id']).toBe('wrkspc_01Team');
    // Never spent on the OAuth metadata endpoints it can't read.
    expect(ctx.fake.requests().filter((x) => x.url.startsWith('/api/oauth/'))).toEqual([]);

    const row = (await accounts(ctx)).find((a) => a.email === 'Personal key');
    expect(row).toMatchObject({ planType: 'api', orgName: 'Acme', isActive: true });
    const creds = storedCreds(ctx, row!.id);
    expect(creds).toMatchObject({
      accessToken: KEY,
      refreshToken: '',
      workspaceId: 'wrkspc_01Team',
    });
    expect(creds.expiresAt).toBeGreaterThan(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000);
    // Adopted as the active account, yet never written into Claude Code's own
    // OAuth slot: Claude Code keeps its login; the proxy carries the key.
    expect(keychain(ctx)['Claude Code-credentials']).toBeUndefined();
    // No subscription limits, so no default usage alert.
    const alerts = await ctx.request<unknown[]>({ type: 'list_alerts', accountId: row!.id });
    expect(alerts.data).toEqual([]);

    ctx.fake.resetRequests();
    expect(await claudeCodeRequest(ctx)).toBe(200);
    const upstream = ctx.fake.requests().find((x) => x.url.startsWith('/v1/messages'));
    expect(upstream?.headers['x-api-key']).toBe(KEY);
    expect(upstream?.headers['authorization']).toBeUndefined();
    expect(upstream?.headers['anthropic-workspace-id']).toBe('wrkspc_01Team');
    expect(upstream?.headers['anthropic-beta']).toBeUndefined();
  });

  it('refuses a key Anthropic rejects and stores nothing', async () => {
    ctx = await startTestDaemon();

    const r = await ctx.request({ type: 'store_api_key', apiKey: KEY, label: 'Dead key' });
    expect(r.success).toBe(false);
    expect(r.error).toBe(
      'Anthropic rejected this API key. Check that it was copied in full and has not been disabled, deleted, or expired.',
    );
    expect(await accounts(ctx)).toEqual([]);
    expect(keychain(ctx)['Sentinel-credentials']).toBeUndefined();
  });

  it('refuses malformed input without calling Anthropic', async () => {
    ctx = await startTestDaemon();

    const notAKey = await ctx.request({
      type: 'store_api_key',
      apiKey: `sk-ant-oat01-${'A'.repeat(95)}`,
    });
    expect(notAKey).toMatchObject({
      success: false,
      error:
        'That is a Claude subscription token, not an API key. Choose "Claude subscription" to add it.',
    });

    const badWorkspace = await ctx.request({
      type: 'store_api_key',
      apiKey: KEY,
      workspaceId: 'workspace-1',
    });
    expect(badWorkspace).toMatchObject({
      success: false,
      error: 'Workspace IDs look like wrkspc_01AbC…',
    });
    expect(ctx.fake.requests().filter((x) => x.url.startsWith('/v1/models'))).toEqual([]);
  });

  it('asks for a workspace when the key works in several', async () => {
    ctx = await startTestDaemon();
    ctx.fake.registerToken(KEY);
    ctx.fake.queueResponse('/v1/models', {
      status: 400,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            'anthropic-workspace-id is required when authenticating with an identity-linked API key; send the id of the workspace this request acts in.',
        },
      },
    });

    const r = await ctx.request({ type: 'store_api_key', apiKey: KEY });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^This key works in more than one workspace\./);
    expect(await accounts(ctx)).toEqual([]);
  });

  it('stores the key unverified when Anthropic cannot answer, named "API key" by default', async () => {
    ctx = await startTestDaemon();
    ctx.fake.registerToken(KEY);
    ctx.fake.queueResponse('/v1/models', { status: 503, body: {} });

    const r = await ctx.request<StoreApiKeyResult>({ type: 'store_api_key', apiKey: KEY });
    expect(r).toMatchObject({ success: true, data: { email: 'API key', verified: false } });
    expect((await accounts(ctx)).map((a) => [a.email, a.planType])).toEqual([['API key', 'api']]);
  });

  it('replaces the key of an existing account in place, and the proxy picks up the new workspace', async () => {
    ctx = await startTestDaemon();
    ctx.fake.registerToken(KEY);
    ctx.fake.registerToken(NEW_KEY);

    await ctx.request({ type: 'store_api_key', apiKey: KEY, label: 'Team key' });
    await ctx.waitForBroadcast((m) => m.type === 'login_complete');
    const [row] = await accounts(ctx);
    // The proxy reads (and caches) "no workspace" for this account.
    expect(await claudeCodeRequest(ctx)).toBe(200);

    ctx.fake.resetRequests();
    const r = await ctx.request<StoreApiKeyResult>({
      type: 'store_api_key',
      apiKey: NEW_KEY,
      workspaceId: 'wrkspc_01New',
      accountId: row!.id,
    });
    expect(r).toMatchObject({ success: true, data: { email: 'Team key', verified: true } });
    await ctx.waitForBroadcast(
      (m) => m.type === 'login_complete' && (m as { reauth?: boolean }).reauth === true,
    );

    const after = await accounts(ctx);
    expect(after.map((a) => a.id)).toEqual([row!.id]);
    expect(storedCreds(ctx, row!.id)).toMatchObject({
      accessToken: NEW_KEY,
      workspaceId: 'wrkspc_01New',
    });

    expect(await claudeCodeRequest(ctx)).toBe(200);
    const upstream = ctx.fake.requests().find((x) => x.url.startsWith('/v1/messages'));
    expect(upstream?.headers['x-api-key']).toBe(NEW_KEY);
    expect(upstream?.headers['anthropic-workspace-id']).toBe('wrkspc_01New');
  });

  it("keeps the key when Claude Code's own slot holds a different login", async () => {
    ctx = await startTestDaemon();
    ctx.fake.registerToken(KEY);
    await ctx.request({ type: 'store_api_key', apiKey: KEY, label: 'Active key' });
    await ctx.waitForBroadcast((m) => m.type === 'login_complete');
    const [row] = await accounts(ctx);
    expect(row!.isActive).toBe(true);

    // Claude Code is still signed in with some subscription account of its own.
    const kc = keychain(ctx);
    kc['Claude Code-credentials'] = {
      [userInfo().username]: JSON.stringify({
        claudeAiOauth: {
          accessToken: `sk-ant-oat01-${'C'.repeat(95)}`,
          refreshToken: 'sk-ant-ort01-cc',
          expiresAt: Date.now() + 3600_000,
          scopes: ['user:inference', 'user:profile'],
        },
      }),
    };
    writeFileSync(ctx.keychainPath, JSON.stringify(kc, null, 2));

    // refresh_accounts snapshots Claude Code's slot under the active account;
    // that must not overwrite the API key with Claude Code's OAuth token.
    await accounts(ctx);
    expect(storedCreds(ctx, row!.id).accessToken).toBe(KEY);
  });

  it('reports a key it could not save', async () => {
    ctx = await startTestDaemon();
    ctx.fake.registerToken(KEY);
    // The credential store refuses the write.
    chmodSync(ctx.keychainPath, 0o400);

    const r = await ctx.request({ type: 'store_api_key', apiKey: KEY, label: 'Unsaved' });
    expect(r).toMatchObject({
      success: false,
      error: 'Sentinel could not save the API key. Check the daemon log.',
    });
  });
});
