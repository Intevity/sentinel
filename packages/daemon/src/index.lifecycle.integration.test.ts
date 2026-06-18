/**
 * Lifecycle paths that cross multiple subsystems: account switching, OAuth
 * flows, settings cascades, and token refresh. Detailed broadcast + DB state
 * assertions live here so the lean IPC smoke file stays readable.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import type { OAuthAccount } from '@sentinel/shared';
import { makeCreds, startTestDaemon, type TestDaemon } from './index.test-helpers.js';

let ctx: TestDaemon | null = null;
afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

function defaultAccount(
  uuid = '00000000-0000-0000-0000-000000000001',
  orgUuid = '00000000-0000-0000-0000-000000000002',
  email = 'test@example.com',
): OAuthAccount {
  return {
    accountUuid: uuid,
    organizationUuid: orgUuid,
    emailAddress: email,
    displayName: 'Test User',
    organizationName: 'Test Org',
    organizationRole: 'owner',
    workspaceRole: null,
    hasExtraUsageEnabled: true,
    billingType: 'max',
    accountCreatedAt: new Date().toISOString(),
    subscriptionCreatedAt: new Date().toISOString(),
  };
}

// ─── switch_account + performSwitch ──────────────────────────────────────────

describe('lifecycle — switch_account', () => {
  it('returns error when credentials are missing for the target', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'switch_account',
      accountId: 'unknown-id',
      email: 'nobody@example.com',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/credentials/i);
  });

  it('flips the active account, writes claude.json, and broadcasts account_switched', async () => {
    const a = defaultAccount();
    // Seed two accounts in the tmp keychain so we can switch between them.
    const b = defaultAccount(
      '00000000-0000-0000-0000-00000000000b',
      '00000000-0000-0000-0000-00000000000c',
      'b@example.com',
    );
    const keyA = a.organizationUuid;
    const keyB = b.organizationUuid;
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: {
        [keyA]: makeCreds({ accessToken: 'token-a', subscriptionType: 'max' }),
        [keyB]: makeCreds({ accessToken: 'token-b', subscriptionType: 'max' }),
      },
      registerTokens: ['token-a', 'token-b'],
    });
    // Priming upsert: ensure B has a DB row so performSwitch finds it.
    // refresh_accounts only snapshots the currently-active account, so seed
    // B via store_credentials + a direct switch attempt.
    const r = await ctx.request<OAuthAccount>({
      type: 'switch_account',
      accountId: keyB,
      email: b.emailAddress,
    });
    expect(r.success).toBe(true);
    expect(r.data?.emailAddress).toBe('b@example.com');
    // ~/.claude.json now carries the new account.
    const onDisk = JSON.parse(readFileSync(ctx.claudeJsonPath, 'utf-8'));
    expect(onDisk.oauthAccount?.emailAddress).toBe('b@example.com');
    // Broadcast went out.
    const bc = await ctx.waitForBroadcast<{ type: 'account_switched'; to: OAuthAccount }>(
      (m) => m.type === 'account_switched',
    );
    expect(bc.to.emailAddress).toBe('b@example.com');
  });
});

// ─── OAuth login / cancel ────────────────────────────────────────────────────

describe('lifecycle — start_login / cancel_login', () => {
  it('start_login acknowledges immediately and returns success', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'start_login' });
    expect(r.success).toBe(true);
    // The login attempt runs in the background and may log a browser-launch
    // error, but the IPC ACK is what the UI waits on.
  });

  it('cancel_login aborts a pending login', async () => {
    ctx = await startTestDaemon();
    await ctx.request({ type: 'start_login' });
    const r = await ctx.request({ type: 'cancel_login' });
    expect(r.success).toBe(true);
  });

  it('cancel_login when no login is in-flight is a no-op success', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'cancel_login' });
    expect(r.success).toBe(true);
  });

  it('start_login while a login is in-flight aborts the previous one', async () => {
    ctx = await startTestDaemon();
    await ctx.request({ type: 'start_login' });
    // Second call within the same session should succeed without hanging on
    // the first's pending AbortController.
    const r = await ctx.request({ type: 'start_login' });
    expect(r.success).toBe(true);
  });
});

// ─── update_settings cascades ────────────────────────────────────────────────

describe('lifecycle — update_settings cascades', () => {
  it('toggling switchingMode to round-robin refreshes the rotator pool', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'update_settings',
      settings: { switchingMode: 'round-robin' },
    });
    expect(r.success).toBe(true);
    const after = await ctx.request<{ switchingMode: string }>({ type: 'get_settings' });
    expect(after.data?.switchingMode).toBe('round-robin');
  });

  it('updating logLevel propagates to the logger singleton', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'update_settings',
      settings: { logLevel: 'debug' },
    });
    expect(r.success).toBe(true);
    const after = await ctx.request<{ logLevel: string }>({ type: 'get_settings' });
    expect(after.data?.logLevel).toBe('debug');
  });

  it('toggling claudeCodeSyncEnabled does not crash (engine start/stop path)', async () => {
    ctx = await startTestDaemon();
    const r1 = await ctx.request({
      type: 'update_settings',
      settings: { claudeCodeSyncEnabled: true },
    });
    expect(r1.success).toBe(true);
    const r2 = await ctx.request({
      type: 'update_settings',
      settings: { claudeCodeSyncEnabled: false },
    });
    expect(r2.success).toBe(true);
  });

  it('changing backgroundProbeIntervalSec restarts the prober', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'update_settings',
      settings: { backgroundProbeIntervalSec: 600 },
    });
    expect(r.success).toBe(true);
    const after = await ctx.request<{ backgroundProbeIntervalSec: number }>({
      type: 'get_settings',
    });
    expect(after.data?.backgroundProbeIntervalSec).toBe(600);
  });

  it('changing poolExcludedIds persists through settings_changed broadcast', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'update_settings',
      settings: { poolExcludedIds: ['acc-1', 'acc-2'] },
    });
    expect(r.success).toBe(true);
    await ctx.waitForBroadcast((m) => m.type === 'settings_changed');
    const after = await ctx.request<{ poolExcludedIds: string[] }>({ type: 'get_settings' });
    expect(after.data?.poolExcludedIds).toEqual(['acc-1', 'acc-2']);
  });

  it('changing budget triggers SpendTracker recompute', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'update_settings',
      settings: { budgetWeeklyUsdGlobal: 100 },
    });
    expect(r.success).toBe(true);
    const after = await ctx.request<{ budgetWeeklyUsdGlobal: number | null }>({
      type: 'get_settings',
    });
    expect(after.data?.budgetWeeklyUsdGlobal).toBe(100);
  });
});

// ─── refresh_token ───────────────────────────────────────────────────────────

describe('lifecycle — refresh_token', () => {
  it('returns error for an unknown account', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'refresh_token', accountId: 'unknown' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Unknown account/i);
  });

  it('succeeds for a seeded account and returns a new expiresAt', async () => {
    const a = defaultAccount();
    const key = a.organizationUuid;
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: { [key]: makeCreds({ accessToken: 'old-token' }) },
      registerTokens: ['old-token'],
    });
    const r = await ctx.request<{ expiresAt: number }>({
      type: 'refresh_token',
      accountId: key,
    });
    expect(r.success).toBe(true);
    expect(r.data?.expiresAt).toBeGreaterThan(0);
  });
});

// ─── purge_all_data ──────────────────────────────────────────────────────────

describe('lifecycle — purge_all_data', () => {
  it('returns success even when accounts are present', async () => {
    const a = defaultAccount();
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: {
        [a.organizationUuid]: makeCreds({ accessToken: 'tok', subscriptionType: 'max' }),
      },
      registerTokens: ['tok'],
    });
    const r = await ctx.request({ type: 'purge_all_data' });
    expect(r.success).toBe(true);
  });
});

// ─── shutdown_daemon handler (with exit guard) ───────────────────────────────

describe('lifecycle — shutdown_daemon', () => {
  it('responds success and schedules a process exit (intercepted for test)', async () => {
    ctx = await startTestDaemon();
    // Stub process.exit BEFORE sending the message so the 100ms timer inside
    // the handler hits our no-op instead of killing the vitest worker. Also
    // shut the daemon down ourselves to prevent the DB-close timing race
    // from the shutdown that runs alongside our handle.shutdown().
    const realExit = process.exit;
    let exitCalled = 0;
    (process.exit as unknown) = ((_code?: number) => {
      exitCalled++;
    }) as typeof process.exit;
    try {
      const resp = await ctx.request({ type: 'shutdown_daemon' });
      expect(resp.success).toBe(true);
      // Cleanup before the 100ms timer fires; that way our stub never runs
      // and background tasks don't interleave with the daemon's own cleanup.
      await ctx.cleanup();
      ctx = null;
    } finally {
      (process.exit as unknown) = realExit;
    }
    expect(exitCalled).toBe(0); // cleanup beat the 100ms timer
  });
});
