/**
 * Alert evaluator wiring + dev_trigger_alert_event scenarios. Exercises the
 * wire-up between rate-limit / spend state and the alert-triggered broadcast
 * path. Real-threshold-crossing tests live inside `alerts.test.ts`; here we
 * only check that the startDaemon bootstrap correctly forwards alert events.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AlertTriggeredMessage, OAuthAccount } from '@claude-sentinel/shared';
import { makeCreds, startTestDaemon, type TestDaemon } from './index.test-helpers.js';

let ctx: TestDaemon | null = null;
afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

function defaultAccount(): OAuthAccount {
  return {
    accountUuid: '00000000-0000-0000-0000-000000000001',
    organizationUuid: '00000000-0000-0000-0000-000000000002',
    emailAddress: 'test@example.com',
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

describe('alerts — dev_trigger_alert_event', () => {
  it('usage-account broadcasts alert_triggered with scope=account', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'dev_trigger_alert_event',
      scenario: 'usage-account',
      accountId: 'acct-1',
    });
    expect(r.success).toBe(true);
    const msg = await ctx.waitForBroadcast<AlertTriggeredMessage>(
      (m) => m.type === 'alert_triggered' && m.scope === 'account',
    );
    expect(msg.accountId).toBe('acct-1');
    expect(msg.thresholdPct).toBe(85);
  });

  it('usage-pool broadcasts alert_triggered with scope=pool and null accountId', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'dev_trigger_alert_event',
      scenario: 'usage-pool',
    });
    expect(r.success).toBe(true);
    const msg = await ctx.waitForBroadcast<AlertTriggeredMessage>(
      (m) => m.type === 'alert_triggered' && m.scope === 'pool',
    );
    expect(msg.accountId).toBeNull();
  });

  it('usage-budget scenario carries budget fields on the broadcast', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'dev_trigger_alert_event',
      scenario: 'usage-budget',
      accountId: 'acct-2',
    });
    expect(r.success).toBe(true);
    const msg = await ctx.waitForBroadcast<AlertTriggeredMessage>(
      (m) => m.type === 'alert_triggered' && m.scope === 'budget',
    );
    expect(msg.spendUsd).toBeGreaterThan(0);
    expect(msg.budgetUsd).toBeGreaterThan(0);
  });

  it('overage-entered scenario broadcasts overage_entered', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'dev_trigger_alert_event',
      scenario: 'overage-entered',
      accountId: 'acct-3',
    });
    expect(r.success).toBe(true);
    await ctx.waitForBroadcast((m) => m.type === 'overage_entered');
  });

  it('overage-disabled scenario broadcasts overage_disabled', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'dev_trigger_alert_event',
      scenario: 'overage-disabled',
      accountId: 'acct-4',
    });
    expect(r.success).toBe(true);
    await ctx.waitForBroadcast((m) => m.type === 'overage_disabled');
  });

  it('account-switched scenario broadcasts account_switched', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'dev_trigger_alert_event',
      scenario: 'account-switched',
      accountId: 'acct-5',
    });
    expect(r.success).toBe(true);
    await ctx.waitForBroadcast((m) => m.type === 'account_switched');
  });

  it('account-paused + account-unpaused scenarios round-trip', async () => {
    ctx = await startTestDaemon();
    const p = await ctx.request({
      type: 'dev_trigger_alert_event',
      scenario: 'account-paused',
      accountId: 'acct-6',
    });
    expect(p.success).toBe(true);
    await ctx.waitForBroadcast((m) => m.type === 'account_paused');
    const u = await ctx.request({
      type: 'dev_trigger_alert_event',
      scenario: 'account-unpaused',
      accountId: 'acct-6',
    });
    expect(u.success).toBe(true);
    await ctx.waitForBroadcast((m) => m.type === 'account_unpaused');
  });
});

describe('alerts — list + upsert against live DB', () => {
  it('a created alert shows up in list_alerts and is scoped correctly', async () => {
    const a = defaultAccount();
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: a },
      sentinelCredentials: {
        [a.organizationUuid]: makeCreds({ accessToken: 'tok', subscriptionType: 'max' }),
      },
      registerTokens: ['tok'],
    });
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const accountKey = list.data![0]!.id;
    const up = await ctx.request<{ id: number }>({
      type: 'upsert_alert',
      accountId: accountKey,
      thresholdPct: 70,
      enabled: true,
    });
    expect(up.success).toBe(true);
    const listed = await ctx.request<Array<{ id: number; thresholdPct: number; accountId: string | null }>>({
      type: 'list_alerts',
      accountId: accountKey,
    });
    expect(listed.data).toHaveLength(1);
    expect(listed.data![0]!.thresholdPct).toBe(70);
    expect(listed.data![0]!.accountId).toBe(accountKey);
  });
});
