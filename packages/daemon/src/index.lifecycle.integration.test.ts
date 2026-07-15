/**
 * Lifecycle paths that cross multiple subsystems: account switching, OAuth
 * flows, settings cascades, and token refresh. Detailed broadcast + DB state
 * assertions live here so the lean IPC smoke file stays readable.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { userInfo } from 'os';
import type { AccountInfo, OAuthAccount } from '@sentinel/shared';
import { markAccountRemoved, upsertAccount } from './db.js';
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

// ─── store_setup_token (claude setup-token capture) ──────────────────────────

describe('lifecycle — store_setup_token', () => {
  const TOKEN = `sk-ant-oat01-${'A'.repeat(95)}`;

  it('stores a setup-token account using the label when the profile sniff fails', async () => {
    // No token registered on the fake → /api/oauth/profile 401 → fetchProfile
    // returns empty → the daemon falls back to the user-provided label.
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'store_setup_token',
      token: TOKEN,
      label: 'work@example.com',
    });
    expect(r.success).toBe(true);

    const bc = await ctx.waitForBroadcast<{
      type: 'login_complete';
      email: string;
      imported?: boolean;
    }>((m) => m.type === 'login_complete', 8000);
    expect(bc.email).toBe('work@example.com');
    expect(bc.imported).toBe(true);

    // The row exists; its stored credential is the oat token with NO refresh
    // token and a ~1yr expiry.
    const accts = await ctx.request<Array<{ id: string; email: string }>>({
      type: 'refresh_accounts',
    });
    const row = accts.data?.find((x) => x.email === 'work@example.com');
    expect(row).toBeDefined();
    const keychain = JSON.parse(readFileSync(ctx.keychainPath, 'utf-8')) as {
      'Sentinel-credentials'?: Record<string, string>;
    };
    const stored = keychain['Sentinel-credentials']?.[row!.id];
    expect(stored).toBeDefined();
    const creds = JSON.parse(stored!) as {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    };
    expect(creds.accessToken).toBe(TOKEN);
    expect(creds.refreshToken).toBe('');
    expect(creds.expiresAt).toBeGreaterThan(Date.now() + 300 * 24 * 60 * 60 * 1000);

    // Default 95% alert seeded.
    const alerts = await ctx.request<Array<{ thresholdPct: number; enabled: boolean }>>({
      type: 'list_alerts',
      accountId: row!.id,
    });
    expect(alerts.data?.some((al) => al.thresholdPct === 95 && al.enabled)).toBe(true);
  });

  it('uses fetched profile metadata when the token can read /api/oauth/profile', async () => {
    ctx = await startTestDaemon();
    const token = `sk-ant-oat01-${'B'.repeat(95)}`;
    // Register the token so the fake's /api/oauth/profile returns this identity.
    ctx.fake.registerToken(token, {
      email: 'real@corp.com',
      org_uuid: 'org-xyz',
      org_name: 'Corp',
      org_type: 'claude_max',
    });
    const r = await ctx.request({ type: 'store_setup_token', token });
    expect(r.success).toBe(true);

    const bc = await ctx.waitForBroadcast<{
      type: 'login_complete';
      email: string;
      orgName?: string;
    }>((m) => m.type === 'login_complete', 8000);
    expect(bc.email).toBe('real@corp.com');
    expect(bc.orgName).toBe('Corp');

    const accts = await ctx.request<Array<{ email: string; orgName: string }>>({
      type: 'refresh_accounts',
    });
    expect(accts.data?.find((x) => x.email === 'real@corp.com')?.orgName).toBe('Corp');
  });

  it('stores the user-typed organization label when the profile sniff fails', async () => {
    ctx = await startTestDaemon();
    const token = `sk-ant-oat01-${'H'.repeat(95)}`;
    await ctx.request({
      type: 'store_setup_token',
      token,
      label: 'org-typed@example.com',
      orgName: '  Acme Corp  ',
    });
    const bc = await ctx.waitForBroadcast<{
      type: 'login_complete';
      email: string;
      orgName?: string;
    }>(
      (m) =>
        m.type === 'login_complete' && (m as { email?: string }).email === 'org-typed@example.com',
      8000,
    );
    expect(bc.orgName).toBe('Acme Corp');
    const accts = await ctx.request<Array<{ email: string; orgName: string }>>({
      type: 'refresh_accounts',
    });
    expect(accts.data?.find((x) => x.email === 'org-typed@example.com')?.orgName).toBe('Acme Corp');
  });

  it('rejects a token that is not an sk-ant-oat01 token', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'store_setup_token', token: 'not-a-token' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('invalid-token');
    const accts = await ctx.request<unknown[]>({ type: 'refresh_accounts' });
    expect(accts.data?.length ?? 0).toBe(0);
  });

  it(
    'does not flag an inference-only account as expired when the usage API rejects it',
    { timeout: 15000 },
    async () => {
      ctx = await startTestDaemon();
      const token = `sk-ant-oat01-${'D'.repeat(95)}`;
      // Register with an org so the account has an orgUuid (required for usage
      // polling). The usage endpoint is forced to 401 below to simulate the
      // inference-only token lacking usage scope.
      ctx.fake.registerToken(token, {
        email: 'oat@corp.com',
        org_uuid: 'org-oat',
        org_name: 'OatCorp',
        org_type: 'claude_max',
      });
      await ctx.request({ type: 'store_setup_token', token });
      await ctx.waitForBroadcast(
        (m) => m.type === 'login_complete' && (m as { email?: string }).email === 'oat@corp.com',
        8000,
      );
      const accts = await ctx.request<Array<{ id: string; email: string }>>({
        type: 'refresh_accounts',
      });
      const row = accts.data?.find((x) => x.email === 'oat@corp.com');
      expect(row).toBeDefined();

      // Force the usage endpoint to 401 (inference-only token can't read usage),
      // then fire the auth-liveness usage check the UI runs on focus/mount.
      ctx.fake.queueResponse('/api/oauth/usage', { status: 401 });
      await ctx.request({ type: 'refresh_claude_ai_usage', accountId: row!.id });
      await ctx.waitForBroadcast(
        (m) =>
          m.type === 'claude_ai_usage_updated' &&
          (m as { accountId?: string }).accountId === row!.id &&
          (m as { error?: string | null }).error === 'auth_expired',
        8000,
      );

      // A usage-API 401 is an expected scope limitation for an inference-only
      // token — it must NOT light the Re-authenticate banner.
      const flagged = ctx.broadcasts.filter(
        (m) =>
          m.type === 'token_refresh_failed' && (m as { accountId?: string }).accountId === row!.id,
      );
      expect(flagged).toHaveLength(0);
    },
  );

  it("does not clobber the stored oat credential from Claude Code's stale keychain slot", async () => {
    ctx = await startTestDaemon();
    const token = `sk-ant-oat01-${'E'.repeat(95)}`;
    ctx.fake.registerToken(token, {
      email: 'clobber@corp.com',
      org_uuid: 'org-clob',
      org_name: 'Clob',
      org_type: 'claude_max',
    });
    await ctx.request({ type: 'store_setup_token', token });
    await ctx.waitForBroadcast(
      (m) => m.type === 'login_complete' && (m as { email?: string }).email === 'clobber@corp.com',
      8000,
    );

    // Simulate Claude Code rewriting its own keychain slot with a STALE, expired
    // copy of the oat token (the real-world clobber source).
    const ccUser = userInfo().username;
    const kc = JSON.parse(readFileSync(ctx.keychainPath, 'utf-8')) as Record<
      string,
      Record<string, string>
    >;
    kc['Claude Code-credentials'] = kc['Claude Code-credentials'] ?? {};
    kc['Claude Code-credentials'][ccUser] = JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        refreshToken: '',
        expiresAt: Date.now() - 60 * 60 * 1000,
        scopes: ['user:inference', 'user:profile'],
      },
    });
    writeFileSync(ctx.keychainPath, JSON.stringify(kc, null, 2));

    // refresh_accounts captures the active account — it must NOT overwrite the
    // fresh Sentinel credential with the stale CC-keychain copy.
    await ctx.request({ type: 'refresh_accounts' });

    const after = JSON.parse(readFileSync(ctx.keychainPath, 'utf-8')) as {
      'Sentinel-credentials': Record<string, string>;
    };
    const stored = JSON.parse(after['Sentinel-credentials']['org-clob']!) as {
      accessToken: string;
      expiresAt: number;
    };
    expect(stored.accessToken).toBe(token);
    // Still the fresh ~330d expiry, not reverted to the stale past one.
    expect(stored.expiresAt).toBeGreaterThan(Date.now() + 300 * 24 * 60 * 60 * 1000);
  });

  it('re-auth (accountId) refreshes the credential in place — no duplicate row', async () => {
    ctx = await startTestDaemon();
    // First add creates the account (label path).
    await ctx.request({ type: 'store_setup_token', token: TOKEN, label: 'reauth@example.com' });
    await ctx.waitForBroadcast<{ type: 'login_complete'; email: string }>(
      (m) => m.type === 'login_complete',
      8000,
    );
    const list1 = await ctx.request<Array<{ id: string; email: string }>>({
      type: 'refresh_accounts',
    });
    const row = list1.data?.find((x) => x.email === 'reauth@example.com');
    expect(row).toBeDefined();

    // Re-authenticate that account with a NEW token + its accountId.
    const NEW = `sk-ant-oat01-${'C'.repeat(95)}`;
    await ctx.request({ type: 'store_setup_token', token: NEW, accountId: row!.id });
    const reauthBc = await ctx.waitForBroadcast<{
      type: 'login_complete';
      email: string;
      reauth?: boolean;
    }>((m) => m.type === 'login_complete' && (m as { reauth?: boolean }).reauth === true, 8000);
    expect(reauthBc.email).toBe('reauth@example.com');

    // Still one row; credential updated to the new token (in place).
    const list2 = await ctx.request<unknown[]>({ type: 'refresh_accounts' });
    expect(list2.data?.length).toBe(1);
    const keychain = JSON.parse(readFileSync(ctx.keychainPath, 'utf-8')) as {
      'Sentinel-credentials'?: Record<string, string>;
    };
    const creds = JSON.parse(keychain['Sentinel-credentials']![row!.id]!) as {
      accessToken: string;
    };
    expect(creds.accessToken).toBe(NEW);
  });
});

// ─── refresh_accounts does not auto-create accounts ──────────────────────────

describe('lifecycle — refresh_accounts (no auto-create)', () => {
  const ccUser = userInfo().username;

  it('does not create a row for an active Claude Code account the user never added', async () => {
    // Nothing seeded as active at startup → no startup row. Claude Code's slot
    // has creds, and a regular login becomes active mid-session.
    ctx = await startTestDaemon({
      claudeCodeCredentials: { [ccUser]: makeCreds({ accessToken: 'tok-untracked' }) },
      registerTokens: ['tok-untracked'],
    });
    const a = defaultAccount(
      '00000000-0000-0000-0000-0000000000c1',
      '00000000-0000-0000-0000-0000000000c2',
      'untracked@example.com',
    );
    writeFileSync(ctx.claudeJsonPath, JSON.stringify({ oauthAccount: a }, null, 2));

    // Refresh must NOT surface a brand-new account — only the setup-token flow adds.
    const r = await ctx.request<Array<{ email: string }>>({ type: 'refresh_accounts' });
    expect(r.data?.some((x) => x.email === 'untracked@example.com')).toBe(false);
    expect(r.data?.length ?? 0).toBe(0);
  });
});

// ─── update_settings cascades ────────────────────────────────────────────────

describe('lifecycle — update_settings cascades', () => {
  it('toggling switchingMode to auto refreshes the rotator pool', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'update_settings',
      settings: { switchingMode: 'auto' },
    });
    expect(r.success).toBe(true);
    const after = await ctx.request<{ switchingMode: string }>({ type: 'get_settings' });
    expect(after.data?.switchingMode).toBe('auto');
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
    // Stub process.exit BEFORE sending the message so the handler's deferred
    // 100ms timer hits our no-op instead of killing the vitest worker. We must
    // keep the stub installed until that timer actually fires — restoring it
    // earlier (e.g. right after the response) leaves a dangling real
    // process.exit(0) that fires post-assert and vitest flags as an unhandled
    // error. A promise lets us await the scheduled exit deterministically
    // instead of racing it against teardown.
    const realExit = process.exit;
    let exitCalled = 0;
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    (process.exit as unknown) = ((_code?: number) => {
      exitCalled++;
      resolveExit();
    }) as typeof process.exit;
    try {
      const resp = await ctx.request({ type: 'shutdown_daemon' });
      expect(resp.success).toBe(true);
      // Wait for the handler's deferred process.exit(0) to land in our stub —
      // this both proves the exit was scheduled and drains the timer so it
      // can't fire against the restored real exit after the test ends.
      await exited;
      expect(exitCalled).toBe(1);
    } finally {
      (process.exit as unknown) = realExit;
      await ctx?.cleanup();
      ctx = null;
    }
  });
});

// ─── removed-account handoff + restore ────────────────────────────────────────
// The proxy must never keep injecting a removed account's token (the Windows
// Claude Desktop 401 bug): removal hands off to a live account or clears the
// token, a fresh add adopts the vacant active slot, startup heals a stale
// ~/.claude.json pointer, and store_setup_token with a removed account's id
// restores it in place (metadata + history preserved).

/** Build an AccountInfo DB row matching an OAuthAccount (id = sentinel key:
 *  orgUuid when present, else accountUuid). */
function accountRow(acct: OAuthAccount, planType: AccountInfo['planType'] = 'max'): AccountInfo {
  return {
    id: acct.organizationUuid || acct.accountUuid,
    accountUuid: acct.accountUuid,
    email: acct.emailAddress,
    displayName: acct.displayName ?? '',
    orgUuid: acct.organizationUuid ?? '',
    orgName: acct.organizationName ?? '',
    planType,
    isActive: false,
    createdAt: Date.now(),
    color: null,
  };
}

describe('lifecycle — removed-account handoff & restore', () => {
  it('hands the active slot to another live account when the active account is removed', async () => {
    const a = defaultAccount();
    const b = defaultAccount(
      '00000000-0000-0000-0000-00000000000b',
      '00000000-0000-0000-0000-00000000000c',
      'b@example.com',
    );
    const keyA = a.organizationUuid;
    const keyB = b.organizationUuid;
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      // Tokens deliberately NOT registered with the fake, and no refresh
      // tokens: the startup reconciliation's profile fetches then 401
      // ("unverifiable") instead of resolving to the fake's DEFAULT_PROFILE
      // org, which would org-drift row B and soft-remove it mid-test.
      sentinelCredentials: {
        [keyA]: makeCreds({ accessToken: 'token-a', refreshToken: '' }),
        [keyB]: makeCreds({ accessToken: 'token-b', refreshToken: '' }),
      },
      seedDb: (db) => {
        upsertAccount(db, accountRow(b));
      },
    });

    const r = await ctx.request({ type: 'remove_account', accountId: keyA });
    expect(r.success).toBe(true);

    // The daemon switched Claude Code + the proxy to B.
    const bc = await ctx.waitForBroadcast<{ type: 'account_switched'; to: OAuthAccount }>(
      (m) => m.type === 'account_switched',
      8000,
    );
    expect(bc.to.emailAddress).toBe('b@example.com');
    const onDisk = JSON.parse(readFileSync(ctx.claudeJsonPath, 'utf-8')) as {
      oauthAccount?: OAuthAccount;
    };
    expect(onDisk.oauthAccount?.emailAddress).toBe('b@example.com');

    // A is soft-removed (restorable), B reads as the active row.
    const removed = await ctx.request<AccountInfo[]>({ type: 'get_removed_accounts' });
    expect(removed.data?.map((x) => x.id)).toContain(keyA);
    const list = await ctx.request<AccountInfo[]>({ type: 'refresh_accounts' });
    expect(list.data?.find((x) => x.id === keyB)?.isActive).toBe(true);
  });

  it('clears the injected token when the last account is removed — clients fall back to their own credentials', async () => {
    const a = defaultAccount();
    const keyA = a.organizationUuid;
    const deadCreds = makeCreds({ accessToken: 'token-a', refreshToken: '' });
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      // token-a is deliberately NOT registered with the fake: it stands in for
      // the dead credential of a deleted account. Seeding Claude Code's slot
      // too lets the startup capture seed activeToken (capture reads CC's
      // slot, not Sentinel's store); no refresh token, so the startup
      // refresher can't swap in a fake-minted (and fake-accepted) token.
      sentinelCredentials: { [keyA]: deadCreds },
      claudeCodeCredentials: { [userInfo().username]: deadCreds },
      registerTokens: ['client-own-token'],
    });
    const url = `http://127.0.0.1:${ctx.daemonPort}/v1/models`;

    // Before removal the proxy injects the active account's (dead) token,
    // overriding the client's own header — exactly the Desktop 401 shape.
    const before = await fetch(url, { headers: { authorization: 'Bearer client-own-token' } });
    expect(before.status).toBe(401);

    const r = await ctx.request({ type: 'remove_account', accountId: keyA });
    expect(r.success).toBe(true);

    // No successor exists, so the proxy stops injecting and forwards the
    // client's own (valid) credential upstream.
    const after = await fetch(url, { headers: { authorization: 'Bearer client-own-token' } });
    expect(after.status).toBe(200);
  });

  it('adopts a new setup-token account when the active account was removed', async () => {
    const a = defaultAccount();
    const keyA = a.organizationUuid;
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: { [keyA]: makeCreds({ accessToken: 'token-a' }) },
    });
    await ctx.request({ type: 'remove_account', accountId: keyA });

    // Fresh add (unregistered token → label path). The active slot is vacant
    // (A is removed), so the new account must take over the proxy + CC session.
    const token = `sk-ant-oat01-${'F'.repeat(95)}`;
    const r = await ctx.request({ type: 'store_setup_token', token, label: 'fresh@example.com' });
    expect(r.success).toBe(true);
    await ctx.waitForBroadcast(
      (m) => m.type === 'login_complete' && (m as { email?: string }).email === 'fresh@example.com',
      8000,
    );

    const onDisk = JSON.parse(readFileSync(ctx.claudeJsonPath, 'utf-8')) as {
      oauthAccount?: OAuthAccount;
    };
    expect(onDisk.oauthAccount?.emailAddress).toBe('fresh@example.com');
    const list = await ctx.request<AccountInfo[]>({ type: 'refresh_accounts' });
    expect(list.data?.find((x) => x.email === 'fresh@example.com')?.isActive).toBe(true);
  });

  it('switches to a live account at startup when ~/.claude.json names a removed account', async () => {
    const a = defaultAccount();
    const b = defaultAccount(
      '00000000-0000-0000-0000-00000000000b',
      '00000000-0000-0000-0000-00000000000c',
      'b@example.com',
    );
    const keyA = a.organizationUuid;
    const keyB = b.organizationUuid;
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      // Unregistered tokens + no refresh tokens, so the async startup
      // reconciliation can't org-drift row B against the fake's default
      // profile (see the handoff test above for the full rationale).
      sentinelCredentials: {
        [keyA]: makeCreds({ accessToken: 'dead-token', refreshToken: '' }),
        [keyB]: makeCreds({ accessToken: 'token-b', refreshToken: '' }),
      },
      // Pre-upgrade state: the active account was removed while a healthy
      // replacement exists (deleted-then-re-added before the handoff fix).
      seedDb: (db) => {
        upsertAccount(db, accountRow(a));
        markAccountRemoved(db, keyA);
        upsertAccount(db, accountRow(b));
      },
    });

    // The startup heal switched to B before startDaemon() resolved.
    const onDisk = JSON.parse(readFileSync(ctx.claudeJsonPath, 'utf-8')) as {
      oauthAccount?: OAuthAccount;
    };
    expect(onDisk.oauthAccount?.emailAddress).toBe('b@example.com');
    const list = await ctx.request<AccountInfo[]>({ type: 'refresh_accounts' });
    expect(list.data?.find((x) => x.id === keyB)?.isActive).toBe(true);
    // A stays removed — heal must not resurrect it.
    const removed = await ctx.request<AccountInfo[]>({ type: 'get_removed_accounts' });
    expect(removed.data?.map((x) => x.id)).toContain(keyA);
  });

  it('restores a soft-removed account in place via store_setup_token accountId', async () => {
    const a = defaultAccount();
    const keyA = a.organizationUuid;
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: { [keyA]: makeCreds({ accessToken: 'dead-token' }) },
      // The user's exact scenario: the only account was removed (data kept)
      // while ~/.claude.json still names it.
      seedDb: (db) => {
        upsertAccount(db, accountRow(a, 'pro'));
        markAccountRemoved(db, keyA);
      },
    });

    const NEW = `sk-ant-oat01-${'G'.repeat(95)}`;
    const r = await ctx.request({ type: 'store_setup_token', token: NEW, accountId: keyA });
    expect(r.success).toBe(true);
    const bc = await ctx.waitForBroadcast<{ type: 'login_complete'; email: string }>(
      (m) => m.type === 'login_complete' && (m as { reauth?: boolean }).reauth === true,
      8000,
    );
    expect(bc.email).toBe(a.emailAddress);

    // Row is live again with its metadata intact — no duplicate created.
    const list = await ctx.request<AccountInfo[]>({ type: 'refresh_accounts' });
    expect(list.data?.length).toBe(1);
    const row = list.data?.find((x) => x.id === keyA);
    expect(row?.orgName).toBe('Test Org');
    expect(row?.displayName).toBe('Test User');
    expect(row?.isActive).toBe(true);
    const removed = await ctx.request<AccountInfo[]>({ type: 'get_removed_accounts' });
    expect(removed.data?.length ?? 0).toBe(0);

    // Credential replaced under the OLD key, and — since this account is the
    // active one — mirrored into Claude Code's keychain slot.
    const keychain = JSON.parse(readFileSync(ctx.keychainPath, 'utf-8')) as {
      'Sentinel-credentials'?: Record<string, string>;
      'Claude Code-credentials'?: Record<string, string>;
    };
    const sentinelCreds = JSON.parse(keychain['Sentinel-credentials']![keyA]!) as {
      accessToken: string;
    };
    expect(sentinelCreds.accessToken).toBe(NEW);
    const ccSlot = JSON.parse(keychain['Claude Code-credentials']![userInfo().username]!) as {
      claudeAiOauth?: { accessToken?: string };
    };
    expect(ccSlot.claudeAiOauth?.accessToken).toBe(NEW);
  });
});
