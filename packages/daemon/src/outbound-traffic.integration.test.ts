/**
 * Outbound-traffic invariants.
 *
 * These tests exist because an Anthropic account was suspended for "suspicious
 * signals" while the only client in use was Claude Code through Sentinel's
 * proxy. An audit found Sentinel originating traffic that no user action
 * produced — most visibly a synthetic `POST /v1/messages` per account every
 * 300s, 24/7, carrying a fabricated `claude-cli/sentinel-probe` user-agent.
 *
 * The invariant this file defends: **Sentinel proxies Claude Code's requests,
 * and originates nothing that imitates Claude Code.** Every assertion here is
 * about what does or does not reach the wire, measured against the fake
 * Anthropic listener's recorded requests — not about internal state.
 *
 * If one of these fails, Sentinel has started generating traffic on its own
 * again. Read the failure as a product regression, not a flaky test.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { AccountInfo, ClaudeCodeCredentials, OAuthAccount } from '@sentinel/shared';

import { startTestDaemon, type TestDaemon } from './index.test-helpers.js';
import { upsertAccount } from './db.js';
import { sentinelUserAgent } from './http-identity.js';

const ORG_A = '00000000-0000-0000-0000-0000000000a1';
const ACCT_A = '00000000-0000-0000-0000-0000000000a2';
const ORG_B = '00000000-0000-0000-0000-0000000000b1';
const ACCT_B = '00000000-0000-0000-0000-0000000000b2';

function account(orgUuid: string, accountUuid: string, email: string): OAuthAccount {
  return {
    accountUuid,
    emailAddress: email,
    organizationUuid: orgUuid,
    hasExtraUsageEnabled: false,
    billingType: 'claude_max',
    accountCreatedAt: new Date().toISOString(),
    subscriptionCreatedAt: new Date().toISOString(),
    displayName: email,
    organizationRole: 'admin',
    workspaceRole: null,
    organizationName: 'Test Org',
  };
}

function row(acct: OAuthAccount): AccountInfo {
  return {
    id: acct.organizationUuid || acct.accountUuid,
    accountUuid: acct.accountUuid,
    email: acct.emailAddress,
    displayName: acct.displayName ?? '',
    orgUuid: acct.organizationUuid ?? '',
    orgName: acct.organizationName ?? '',
    planType: 'max',
    isActive: false,
    createdAt: Date.now(),
    color: null,
  };
}

/** Credentials that are healthy and NOT near expiry, so nothing legitimately
 *  needs refreshing during the test. `refreshToken: ''` keeps the startup
 *  reconciliation from org-drifting the seeded rows (see the note in
 *  index.lifecycle.integration.test.ts). */
function creds(accessToken: string): ClaudeCodeCredentials {
  return {
    accessToken,
    refreshToken: '',
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
    scopes: ['user:profile', 'user:inference'],
    subscriptionType: 'max',
  };
}

const A = account(ORG_A, ACCT_A, 'a@example.com');
const B = account(ORG_B, ACCT_B, 'b@example.com');

let ctx: TestDaemon | null = null;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = null;
});

/** Every `POST /v1/messages` the fake saw — i.e. every inference request. */
function inferenceRequests(d: TestDaemon): { url: string; headers: Record<string, unknown> }[] {
  return d
    .fake!.requests()
    .filter((r) => r.method === 'POST' && r.url.startsWith('/v1/messages'))
    .map((r) => ({ url: r.url, headers: r.headers as Record<string, unknown> }));
}

async function bootTwoAccounts(settings: Record<string, unknown> = {}): Promise<TestDaemon> {
  return startTestDaemon({
    claudeState: { oauthAccount: A },
    settings,
    sentinelCredentials: {
      [ORG_A]: creds('token-a'),
      [ORG_B]: creds('token-b'),
    },
    seedDb: (db) => {
      upsertAccount(db, row(A));
      upsertAccount(db, row(B));
    },
  });
}

describe('outbound traffic — Sentinel originates no synthetic inference', () => {
  it('sends zero /v1/messages requests across daemon startup and steady state', async () => {
    ctx = await bootTwoAccounts();

    // The deleted background prober fired its first pass synchronously inside
    // startUsageProber(), and the deleted startup probe fired from the proxy's
    // listen callback — so both would already be recorded by now. Give the
    // async startup work (reconciliation, usage poll) room to land too, so a
    // reintroduced probe on any of those paths is caught rather than raced past.
    await ctx.request({ type: 'get_settings' });
    await new Promise((r) => setTimeout(r, 1500));

    expect(inferenceRequests(ctx)).toEqual([]);
  });

  it('does not probe on account switch', async () => {
    ctx = await bootTwoAccounts();
    ctx.fake.resetRequests();

    const r = await ctx.request({
      type: 'switch_account',
      accountId: ORG_B,
      email: B.emailAddress,
    });
    expect({ success: r.success, error: r.error }).toEqual({ success: true, error: undefined });
    await new Promise((r) => setTimeout(r, 750));

    // A switch is local bookkeeping. It may refresh usage metadata; it must not
    // originate a billable inference request.
    expect(inferenceRequests(ctx)).toEqual([]);
  });

  it('ignores the probe_rate_limits IPC while manualRateLimitProbeEnabled is false', async () => {
    ctx = await bootTwoAccounts();
    ctx.fake.resetRequests();

    // The handler still answers success — the UI's refresh flow does not need
    // to care whether the opt-in is on — but nothing reaches the wire.
    const r = await ctx.request({ type: 'probe_rate_limits', accountId: ORG_A });
    expect(r.success).toBe(true);
    await new Promise((r) => setTimeout(r, 500));

    expect(inferenceRequests(ctx)).toEqual([]);
  });
});

describe('outbound traffic — the opted-in manual probe identifies honestly', () => {
  it('sends exactly one request, naming Sentinel rather than claude-cli', async () => {
    ctx = await bootTwoAccounts({ manualRateLimitProbeEnabled: true });
    ctx.fake.resetRequests();

    const r = await ctx.request({ type: 'probe_rate_limits', accountId: ORG_A });
    expect(r.success).toBe(true);
    // Probe is fire-and-forget; wait for it to reach the fake.
    await new Promise((r) => setTimeout(r, 1000));

    const sent = inferenceRequests(ctx);
    expect(sent).toHaveLength(1);

    const ua = sent[0]!.headers['user-agent'];
    expect(ua).toBe(sentinelUserAgent());
    // The specific regression: a fabricated Claude Code product token on a
    // request Claude Code never made.
    expect(ua).not.toMatch(/claude-cli/);
  });
});

describe('outbound traffic — Sentinel-originated metadata calls are attributable', () => {
  it('carries a Sentinel user-agent and none of undici’s browser artifacts', async () => {
    ctx = await bootTwoAccounts();
    await ctx.request({ type: 'refresh_claude_ai_usage', accountId: ORG_A });
    await new Promise((r) => setTimeout(r, 750));

    const metadata = ctx.fake
      .requests()
      .filter((r) => r.url.startsWith('/api/oauth/') || r.url.startsWith('/v1/code/'));
    // Sanity: the daemon really did make metadata calls, so the assertions
    // below are testing something.
    expect(metadata.length).toBeGreaterThan(0);

    for (const req of metadata) {
      expect(req.headers['user-agent']).toBe(sentinelUserAgent());
      // `fetch()` appended these two unconditionally, so a generic Node bot UA
      // arrived alongside browser-only Fetch-metadata headers. Moving these
      // call sites to http-identity.ts is what removed them; if someone
      // reverts one to `fetch`, this fails.
      expect(req.headers['sec-fetch-mode']).toBeUndefined();
      expect(req.headers['accept-language']).toBeUndefined();
    }
  });

  it('never presents a claude-cli user-agent on any Sentinel-originated request', async () => {
    ctx = await bootTwoAccounts();
    await ctx.request({ type: 'refresh_claude_ai_usage', accountId: ORG_A });
    await new Promise((r) => setTimeout(r, 750));

    const impersonating = ctx.fake
      .requests()
      .filter((r) => String(r.headers['user-agent'] ?? '').includes('claude-cli'));
    expect(impersonating).toEqual([]);
  });
});

describe('outbound traffic — daemon startup makes no credential burst', () => {
  it('refreshes no tokens at boot when every token is far from expiry', async () => {
    ctx = await bootTwoAccounts();
    await ctx.request({ type: 'get_settings' });
    await new Promise((r) => setTimeout(r, 1500));

    // Boot used to force-refresh EVERY account unconditionally, producing an
    // N-credential burst against the token endpoint on every app launch.
    const tokenCalls = ctx.fake
      .requests()
      .filter((r) => r.method === 'POST' && r.url.includes('/oauth/token'));
    expect(tokenCalls).toEqual([]);
  });

  it('keeps boot-time profile calls within the drift-check budget', async () => {
    ctx = await bootTwoAccounts();
    await ctx.request({ type: 'get_settings' });
    await new Promise((r) => setTimeout(r, 1500));

    // Two profile calls per account used to leave at boot: one from
    // `healDriftedRows` (a bounded, one-shot org-scope integrity check that
    // stays) and a second from the startup `subscriptionType` back-fill loop,
    // which fetched unconditionally even though its write is a no-op once the
    // field is populated. That second pass is now skipped when there is
    // nothing to learn.
    //
    // Budget for N accounts: N drift checks + 1 active-account verification.
    // Asserting the bound rather than an exact count keeps this robust to
    // verifier scheduling, while still failing loudly if anyone reintroduces an
    // all-accounts profile loop (2 accounts would jump from ≤3 to 5).
    const profileCalls = ctx.fake.requests().filter((r) => r.url.startsWith('/api/oauth/profile'));
    expect(profileCalls.length).toBeLessThanOrEqual(3);
  });
});
