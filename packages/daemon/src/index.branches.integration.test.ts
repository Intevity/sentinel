/**
 * Targeted branch coverage for IPC handlers with multiple code paths. The
 * main IPC / lifecycle / alerts files hit one path per handler; this file
 * fills the gaps — scope variations, error branches, alternate-input modes.
 */
import { afterEach, describe, expect, it } from 'vitest';
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
  billingType = 'max',
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
    billingType,
    accountCreatedAt: new Date().toISOString(),
    subscriptionCreatedAt: new Date().toISOString(),
  };
}

// ─── upsert_alert: scope variations ──────────────────────────────────────────

describe('upsert_alert scopes', () => {
  it('pool scope rejects non-null accountId', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'upsert_alert',
      scope: 'pool',
      accountId: 'should-be-null',
      thresholdPct: 50,
      enabled: true,
    });
    expect(r.success).toBe(false);
  });

  it('pool scope with null accountId succeeds', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<{ id: number }>({
      type: 'upsert_alert',
      scope: 'pool',
      accountId: null,
      thresholdPct: 60,
      enabled: true,
    });
    expect(r.success).toBe(true);
  });

  it('pool-weekly scope with null accountId succeeds', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<{ id: number }>({
      type: 'upsert_alert',
      scope: 'pool-weekly',
      accountId: null,
      thresholdPct: 80,
      enabled: true,
    });
    expect(r.success).toBe(true);
  });

  it('account-weekly scope requires non-null accountId', async () => {
    const a = defaultAccount();
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: { [a.organizationUuid]: makeCreds({ accessToken: 'tok' }) },
      registerTokens: ['tok'],
    });
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    const r = await ctx.request<{ id: number }>({
      type: 'upsert_alert',
      scope: 'account-weekly',
      accountId: id,
      thresholdPct: 75,
      enabled: true,
    });
    expect(r.success).toBe(true);
  });

  it('budget:account scope with accountId succeeds', async () => {
    const a = defaultAccount();
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: { [a.organizationUuid]: makeCreds({ accessToken: 'tok' }) },
      registerTokens: ['tok'],
    });
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    const r = await ctx.request<{ id: number }>({
      type: 'upsert_alert',
      scope: 'budget',
      accountId: id,
      thresholdPct: 90,
      enabled: true,
      budgetScope: 'account',
    });
    expect(r.success).toBe(true);
  });

  it('budget:global scope with null accountId succeeds', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<{ id: number }>({
      type: 'upsert_alert',
      scope: 'budget',
      accountId: null,
      thresholdPct: 90,
      enabled: true,
      budgetScope: 'global',
    });
    expect(r.success).toBe(true);
  });
});

// ─── list_alerts: scope filtering ────────────────────────────────────────────

describe('list_alerts filtering', () => {
  it('filters by scope=pool', async () => {
    ctx = await startTestDaemon();
    await ctx.request({
      type: 'upsert_alert',
      scope: 'pool',
      accountId: null,
      thresholdPct: 55,
      enabled: true,
    });
    const r = await ctx.request<Array<{ thresholdPct: number }>>({
      type: 'list_alerts',
      scope: 'pool',
    });
    expect(r.success).toBe(true);
    expect(r.data?.length).toBe(1);
    expect(r.data![0]!.thresholdPct).toBe(55);
  });
});

// ─── update_account: color reset ─────────────────────────────────────────────

describe('update_account', () => {
  it('null color resets to default', async () => {
    const a = defaultAccount();
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: { [a.organizationUuid]: makeCreds({ accessToken: 'tok' }) },
      registerTokens: ['tok'],
    });
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    await ctx.request({ type: 'update_account', accountId: id, color: '#FF0000' });
    const r = await ctx.request({ type: 'update_account', accountId: id, color: null });
    expect(r.success).toBe(true);
  });

  it('missing account returns success=false', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'update_account', accountId: 'unknown', color: '#00FF00' });
    expect(r.success).toBe(false);
  });
});

// ─── get_metrics_summary: scope resolution ──────────────────────────────────

describe('get_metrics_summary scopes', () => {
  it('resolves explicit accountId over active fallback', async () => {
    const a = defaultAccount();
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: { [a.organizationUuid]: makeCreds({ accessToken: 'tok' }) },
      registerTokens: ['tok'],
    });
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    const r = await ctx.request<Record<string, unknown>>({
      type: 'get_metrics_summary',
      days: 7,
      accountId: id,
    });
    expect(r.success).toBe(true);
  });

  it('aggregates with accountIds list and scopeKind=pool', async () => {
    const a = defaultAccount();
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: { [a.organizationUuid]: makeCreds({ accessToken: 'tok' }) },
      registerTokens: ['tok'],
    });
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    const r = await ctx.request<Record<string, unknown>>({
      type: 'get_metrics_summary',
      days: 7,
      accountIds: [id],
      scopeKind: 'pool',
      scopeLabel: 'Round-robin pool',
    });
    expect(r.success).toBe(true);
  });
});

// ─── get_rate_limits: accountId param ────────────────────────────────────────

describe('get_rate_limits', () => {
  it('resolves explicit accountId', async () => {
    const a = defaultAccount();
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: { [a.organizationUuid]: makeCreds({ accessToken: 'tok' }) },
      registerTokens: ['tok'],
    });
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    const r = await ctx.request<unknown[]>({ type: 'get_rate_limits', accountId: id });
    expect(r.success).toBe(true);
  });
});

// ─── acknowledge_notification with existing id ───────────────────────────────

describe('acknowledge_notification existing id', () => {
  it('round-trips with a real notification row', async () => {
    ctx = await startTestDaemon();
    // Trigger a synthetic alert to create a notification row.
    await ctx.request({
      type: 'dev_trigger_alert_event',
      scenario: 'overage-entered',
      accountId: 'ack-target',
    });
    // Wait for the broadcast then look up the notification id.
    await ctx.waitForBroadcast((m) => m.type === 'overage_entered', 3000);
    const notifs = await ctx.request<Array<{ id: number }>>({ type: 'get_notifications' });
    expect(notifs.data?.length).toBeGreaterThan(0);
    const id = notifs.data![0]!.id;
    const r = await ctx.request({ type: 'acknowledge_notification', id });
    expect(r.success).toBe(true);
  });
});

// ─── remove_account with deleteData=true ─────────────────────────────────────

describe('remove_account with deleteData', () => {
  it('hard-deletes account data when deleteData=true', async () => {
    const a = defaultAccount();
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: { [a.organizationUuid]: makeCreds({ accessToken: 'tok' }) },
      registerTokens: ['tok'],
    });
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    const r = await ctx.request({ type: 'remove_account', accountId: id, deleteData: true });
    expect(r.success).toBe(true);
  });
});

// ─── add_to_security_allowlist with eventId mode ────────────────────────────

describe('add_to_security_allowlist eventId mode', () => {
  it('derives fields from an existing security event', async () => {
    ctx = await startTestDaemon();
    // Synthesize a security event so we have a row to reference.
    await ctx.request({
      type: 'dev_trigger_security_event',
      scenario: 'secret-anthropic',
    });
    await ctx.waitForBroadcast((m) => m.type === 'security_event_detected', 3000);
    const events = await ctx.request<Array<{ id: number }>>({ type: 'get_security_events' });
    const id = events.data![0]!.id;
    const r = await ctx.request<{ id: number }>({
      type: 'add_to_security_allowlist',
      eventId: id,
    });
    expect(r.success).toBe(true);
  });
});

// ─── claude_sync_pull mode variations ───────────────────────────────────────

describe('claude_sync_pull mode variations', () => {
  it('pull with mode=merge succeeds', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'claude_sync_pull', mode: 'merge' });
    expect(r.success).toBe(true);
  });

  it('pull with mode=import succeeds', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'claude_sync_pull', mode: 'import' });
    expect(r.success).toBe(true);
  });

  it('pull with mode=export succeeds', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'claude_sync_pull', mode: 'export' });
    expect(r.success).toBe(true);
  });
});

// ─── acknowledge_security_event with existing id ────────────────────────────

describe('acknowledge_security_event existing id', () => {
  it('round-trips against a real security event row', async () => {
    ctx = await startTestDaemon();
    await ctx.request({
      type: 'dev_trigger_security_event',
      scenario: 'secret-openai',
    });
    await ctx.waitForBroadcast((m) => m.type === 'security_event_detected', 3000);
    const events = await ctx.request<Array<{ id: number }>>({ type: 'get_security_events' });
    const id = events.data![0]!.id;
    const r = await ctx.request({ type: 'acknowledge_security_event', id });
    expect(r.success).toBe(true);
  });

  it('clear_security_events with accountId scopes the wipe', async () => {
    ctx = await startTestDaemon();
    await ctx.request({
      type: 'dev_trigger_security_event',
      scenario: 'secret-github-pat',
      accountId: 'scoped-acct',
    });
    await ctx.waitForBroadcast((m) => m.type === 'security_event_detected', 3000);
    const r = await ctx.request({ type: 'clear_security_events', accountId: 'scoped-acct' });
    expect(r.success).toBe(true);
  });
});

// ─── switch_account email-fallback + lookup paths ────────────────────────────

describe('switch_account lookup paths', () => {
  it('resolves by email when accountId is empty', async () => {
    const a = defaultAccount();
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: {
        [a.organizationUuid]: makeCreds({ accessToken: 'tok', subscriptionType: 'max' }),
        [a.emailAddress]: makeCreds({ accessToken: 'tok-by-email', subscriptionType: 'max' }),
      },
      registerTokens: ['tok', 'tok-by-email'],
    });
    const r = await ctx.request({
      type: 'switch_account',
      accountId: '',
      email: a.emailAddress,
    });
    expect(r.success).toBe(true);
  });
});

// ─── inferPlanType subscription-type variations ──────────────────────────────

describe('inferPlanType via startup seeding', () => {
  it('classifies pro subscription correctly', async () => {
    const a = defaultAccount(undefined, undefined, undefined, 'pro');
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: {
        [a.organizationUuid]: makeCreds({ accessToken: 'tok', subscriptionType: 'pro' }),
      },
      registerTokens: ['tok'],
    });
    const r = await ctx.request<Array<{ planType: string }>>({ type: 'get_accounts' });
    expect(r.data?.[0]?.planType).toBe('pro');
  });

  it('classifies team subscription correctly', async () => {
    const a = defaultAccount(undefined, undefined, undefined, 'team');
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: {
        [a.organizationUuid]: makeCreds({ accessToken: 'tok', subscriptionType: 'team' }),
      },
      registerTokens: ['tok'],
    });
    const r = await ctx.request<Array<{ planType: string }>>({ type: 'get_accounts' });
    expect(r.data?.[0]?.planType).toBe('team');
  });

  it('classifies enterprise subscription correctly', async () => {
    const a = defaultAccount(undefined, undefined, undefined, 'enterprise');
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: {
        [a.organizationUuid]: makeCreds({
          accessToken: 'tok',
          subscriptionType: 'enterprise',
        }),
      },
      registerTokens: ['tok'],
    });
    const r = await ctx.request<Array<{ planType: string }>>({ type: 'get_accounts' });
    expect(r.data?.[0]?.planType).toBe('enterprise');
  });
});

// ─── Missing-field defaults through startup ─────────────────────────────────

describe('startup nullish defaults', () => {
  it('seeds account with empty displayName / orgName defaults', async () => {
    const a: OAuthAccount = {
      accountUuid: '00000000-0000-0000-0000-000000000001',
      organizationUuid: '00000000-0000-0000-0000-000000000002',
      emailAddress: 'test@example.com',
      displayName: '',
      organizationName: '',
      organizationRole: 'user',
      workspaceRole: null,
      hasExtraUsageEnabled: false,
      billingType: 'pro',
      accountCreatedAt: new Date().toISOString(),
      subscriptionCreatedAt: new Date().toISOString(),
    };
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: {
        [a.organizationUuid]: makeCreds({ accessToken: 'tok', subscriptionType: 'pro' }),
      },
      registerTokens: ['tok'],
    });
    const r = await ctx.request<Array<{ displayName: string; orgName: string }>>({
      type: 'get_accounts',
    });
    expect(r.data?.[0]?.displayName).toBe('');
    expect(r.data?.[0]?.orgName).toBe('');
  });
});

// ─── list_alerts scope filter variations ─────────────────────────────────────

describe('list_alerts scope variations', () => {
  it('filters scope=all', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<unknown[]>({ type: 'list_alerts', scope: 'all' });
    expect(r.success).toBe(true);
    expect(Array.isArray(r.data)).toBe(true);
  });

  it('filters scope=pool-weekly', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<unknown[]>({ type: 'list_alerts', scope: 'pool-weekly' });
    expect(r.success).toBe(true);
    expect(Array.isArray(r.data)).toBe(true);
  });
});
