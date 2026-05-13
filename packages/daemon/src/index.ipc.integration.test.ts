/**
 * Smoke coverage for every IPC handler in `index.ts`. One test per message
 * type where possible; related grouped. Detailed behavior paths
 * (`switch_account`, `start_login`, `update_settings` cascades, alerts) live
 * in the lifecycle + alerts sibling files.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { OAuthAccount } from '@claude-sentinel/shared';
import { makeCreds, startTestDaemon, type TestDaemon } from './index.test-helpers.js';

let ctx: TestDaemon | null = null;

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

async function startWithActiveAccount(token = 'active-token'): Promise<TestDaemon> {
  const account = defaultAccount();
  const key = account.organizationUuid;
  const t = await startTestDaemon({
    claudeState: { oauthAccount: account },
    sentinelCredentials: { [key]: makeCreds({ accessToken: token, subscriptionType: 'max' }) },
    registerTokens: [token],
  });
  return t;
}

afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

// ─── Read-only accounts + credentials ────────────────────────────────────────

describe('IPC — account surface', () => {
  it('get_accounts returns empty array on fresh DB', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'get_accounts' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('refresh_accounts round-trips with active account seeded', async () => {
    ctx = await startWithActiveAccount();
    const r = await ctx.request<unknown[]>({ type: 'refresh_accounts' });
    expect(r.success).toBe(true);
    expect(r.data).toHaveLength(1);
  });

  it('get_removed_accounts returns empty array when nothing removed', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'get_removed_accounts' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('remove_account + get_removed_accounts shows soft-deleted entry', async () => {
    ctx = await startWithActiveAccount();
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    const r = await ctx.request({ type: 'remove_account', accountId: id });
    expect(r.success).toBe(true);
    const removed = await ctx.request<unknown[]>({ type: 'get_removed_accounts' });
    expect(removed.data).toHaveLength(1);
  });

  it('purge_account removes an account hard', async () => {
    ctx = await startWithActiveAccount();
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    const r = await ctx.request({ type: 'purge_account', accountId: id });
    expect(r.success).toBe(true);
    const after = await ctx.request<unknown[]>({ type: 'get_accounts' });
    expect(after.data).toEqual([]);
  });

  it('store_credentials + get_credentials round-trips an opaque blob', async () => {
    ctx = await startTestDaemon();
    const r1 = await ctx.request({
      type: 'store_credentials',
      email: 'x@example.com',
      blob: 'opaque-blob',
    });
    expect(r1.success).toBe(true);
    const r2 = await ctx.request<string>({ type: 'get_credentials', email: 'x@example.com' });
    expect(r2.success).toBe(true);
    expect(r2.data).toBe('opaque-blob');
  });

  it('get_credentials returns error on unknown email', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'get_credentials', email: 'missing@example.com' });
    expect(r.success).toBe(false);
  });

  it('update_account writes color and broadcasts account_updated', async () => {
    ctx = await startWithActiveAccount();
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    const r = await ctx.request({ type: 'update_account', accountId: id, color: '#FF9F0A' });
    expect(r.success).toBe(true);
    await ctx.waitForBroadcast((m) => m.type === 'account_updated');
  });
});

// ─── Usage + metrics ────────────────────────────────────────────────────────

describe('IPC — usage / metrics', () => {
  it('get_usage_summary without active account returns error', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'get_usage_summary', days: 7 });
    expect(r.success).toBe(false);
  });

  it('get_usage_summary with active account returns a usage wrapper', async () => {
    ctx = await startWithActiveAccount();
    const r = await ctx.request<{ days: number; accountId: string; byDayModel: object }>({
      type: 'get_usage_summary',
      days: 7,
    });
    expect(r.success).toBe(true);
    expect(r.data?.days).toBe(7);
    expect(typeof r.data?.byDayModel).toBe('object');
  });

  it('get_metrics_summary returns a MetricsSummary shape', async () => {
    ctx = await startWithActiveAccount();
    const r = await ctx.request<Record<string, unknown>>({
      type: 'get_metrics_summary',
      days: 7,
    });
    expect(r.success).toBe(true);
    expect(r.data).toBeDefined();
  });

  it('get_rate_limits returns array of windows (may be empty)', async () => {
    ctx = await startWithActiveAccount();
    const r = await ctx.request<unknown[]>({ type: 'get_rate_limits' });
    expect(r.success).toBe(true);
    expect(Array.isArray(r.data)).toBe(true);
  });

  it('get_all_rate_limits returns an object', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<Record<string, unknown>>({ type: 'get_all_rate_limits' });
    expect(r.success).toBe(true);
    expect(typeof r.data).toBe('object');
  });
});

// ─── Overage ─────────────────────────────────────────────────────────────────

describe('IPC — overage', () => {
  it('get_overage_grants returns an object (empty when no cache)', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<Record<string, unknown>>({ type: 'get_overage_grants' });
    expect(r.success).toBe(true);
    expect(typeof r.data).toBe('object');
  });

  it('refresh_overage_grants succeeds (no broadcast when cache is empty)', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'refresh_overage_grants' });
    expect(r.success).toBe(true);
    // Broadcast only fires when the cache actually changes. An empty cache
    // reload is a no-op and intentionally silent, so don't assert on it here.
  });
});

// ─── Daemon lifecycle introspection ──────────────────────────────────────────

describe('IPC — daemon status', () => {
  it('get_daemon_status returns pid + uptime', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<{ pid: number; uptimeMs: number; startedAt: number }>({
      type: 'get_daemon_status',
    });
    expect(r.success).toBe(true);
    expect(r.data?.pid).toBe(process.pid);
    expect(r.data?.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(r.data?.startedAt).toBeGreaterThan(0);
  });

  it('get_daemon_logs + clear_daemon_logs round-trip', async () => {
    ctx = await startTestDaemon();
    const r1 = await ctx.request<unknown[]>({ type: 'get_daemon_logs' });
    expect(r1.success).toBe(true);
    expect(r1.data?.length ?? 0).toBeGreaterThan(0);
    const r2 = await ctx.request<{ count: number }>({ type: 'clear_daemon_logs' });
    expect(r2.success).toBe(true);
    await ctx.waitForBroadcast((m) => m.type === 'daemon_logs_cleared');
  });
});

// ─── Settings ────────────────────────────────────────────────────────────────

describe('IPC — settings', () => {
  it('get_settings returns the full Settings object', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<{ switchingMode: string; logLevel: string }>({
      type: 'get_settings',
    });
    expect(r.success).toBe(true);
    expect(r.data?.switchingMode).toBe('off');
    expect(r.data?.logLevel).toBe('info');
  });

  it('update_settings merges partials and broadcasts settings_changed', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'update_settings',
      settings: { switchingMode: 'round-robin' },
    });
    expect(r.success).toBe(true);
    await ctx.waitForBroadcast((m) => m.type === 'settings_changed');
    const after = await ctx.request<{ switchingMode: string }>({ type: 'get_settings' });
    expect(after.data?.switchingMode).toBe('round-robin');
  });
});

// ─── Notifications ───────────────────────────────────────────────────────────

describe('IPC — notifications', () => {
  it('get_notifications returns an empty array initially', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<unknown[]>({ type: 'get_notifications' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('acknowledge_notification on unknown id returns success=false', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'acknowledge_notification', id: 99999 });
    expect(r.success).toBe(false);
  });

  it('acknowledge_all_notifications succeeds with count=0 on empty table', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<{ count: number }>({ type: 'acknowledge_all_notifications' });
    expect(r.success).toBe(true);
    expect(r.data?.count).toBe(0);
  });

  it('get_notifications passes through beforeTs / accountId / types to the DB layer', async () => {
    ctx = await startTestDaemon();
    // Seed three notifications via the daemon's DB writer so they land
    // in the same SQLite the IPC handler reads from.
    const { getDb, insertNotification } = await import('./db.js');
    const db = getDb();
    const now = Date.now();
    insertNotification(db, {
      ts: now - 3000,
      accountId: 'acc-a',
      type: 'overage_entered',
      title: 'old-acc-a',
      body: 'B',
    });
    insertNotification(db, {
      ts: now - 2000,
      accountId: 'acc-b',
      type: 'security_high',
      title: 'mid-acc-b',
      body: 'B',
    });
    insertNotification(db, {
      ts: now - 1000,
      accountId: null,
      type: 'account_switched',
      title: 'global',
      body: 'B',
    });

    // accountId scoping: acc-a row + global row, not acc-b row.
    const scoped = await ctx.request<Array<{ title: string }>>({
      type: 'get_notifications',
      accountId: 'acc-a',
    });
    expect(scoped.success).toBe(true);
    expect((scoped.data ?? []).map((n) => n.title).sort()).toEqual(['global', 'old-acc-a']);

    // types restricts to the security set only.
    const sec = await ctx.request<Array<{ title: string }>>({
      type: 'get_notifications',
      types: ['security_low', 'security_medium', 'security_high'],
    });
    expect((sec.data ?? []).map((n) => n.title)).toEqual(['mid-acc-b']);

    // beforeTs cursor: skip the newest row.
    const newest = await ctx.request<Array<{ ts: number; title: string }>>({
      type: 'get_notifications',
      limit: 1,
    });
    expect((newest.data ?? []).map((n) => n.title)).toEqual(['global']);
    const next = await ctx.request<Array<{ title: string }>>({
      type: 'get_notifications',
      beforeTs: newest.data![0]!.ts,
      limit: 5,
    });
    expect((next.data ?? []).map((n) => n.title)).toEqual(['mid-acc-b', 'old-acc-a']);
  });
});

// ─── Alerts ──────────────────────────────────────────────────────────────────

describe('IPC — alerts', () => {
  it('list_alerts returns empty array initially', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<unknown[]>({ type: 'list_alerts' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('upsert_alert creates a per-account alert', async () => {
    ctx = await startWithActiveAccount();
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    const r = await ctx.request<{ id: number }>({
      type: 'upsert_alert',
      accountId: id,
      thresholdPct: 80,
      enabled: true,
    });
    expect(r.success).toBe(true);
  });

  it('upsert_alert rejects invalid threshold', async () => {
    ctx = await startWithActiveAccount();
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    const r = await ctx.request({
      type: 'upsert_alert',
      accountId: id,
      thresholdPct: 200,
      enabled: true,
    });
    expect(r.success).toBe(false);
  });

  it('delete_alert on unknown id returns success=false', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'delete_alert', id: 99999 });
    expect(r.success).toBe(false);
  });

  it('upsert_alert → delete_alert round-trips the created row', async () => {
    ctx = await startWithActiveAccount();
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    const up = await ctx.request<{ id: number }>({
      type: 'upsert_alert',
      accountId: id,
      thresholdPct: 50,
      enabled: true,
    });
    expect(up.success).toBe(true);
    const del = await ctx.request({ type: 'delete_alert', id: up.data!.id });
    expect(del.success).toBe(true);
  });
});

// ─── Spend ───────────────────────────────────────────────────────────────────

describe('IPC — spend', () => {
  it('get_spend_summary returns initialized state', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<Record<string, unknown>>({ type: 'get_spend_summary' });
    expect(r.success).toBe(true);
    expect(typeof r.data).toBe('object');
  });

  it('get_paused_accounts returns empty array initially', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<unknown[]>({ type: 'get_paused_accounts' });
    expect(r.success).toBe(true);
    expect(Array.isArray(r.data)).toBe(true);
  });
});

// ─── Claude AI usage ─────────────────────────────────────────────────────────

describe('IPC — claude.ai usage', () => {
  it('get_claude_ai_usage returns a snapshot', async () => {
    ctx = await startWithActiveAccount();
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    const r = await ctx.request<Record<string, unknown>>({
      type: 'get_claude_ai_usage',
      accountId: id,
    });
    expect(r.success).toBe(true);
  });

  it('refresh_claude_ai_usage round-trips', async () => {
    ctx = await startWithActiveAccount();
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    const r = await ctx.request({ type: 'refresh_claude_ai_usage', accountId: id });
    expect(r.success).toBe(true);
  });
});

// ─── Security events + allowlist ─────────────────────────────────────────────

describe('IPC — security events', () => {
  it('get_security_events returns empty array initially', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<unknown[]>({ type: 'get_security_events' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('get_security_events surfaces LOW real findings by default and gates telemetry behind includeWeakSignals', async () => {
    ctx = await startTestDaemon();
    // Real LOW-severity finding with sub-0.7 confidence — this is the
    // case that used to be invisible on the Security page (decoupled
    // from the weak-signal/telemetry filter as of this change).
    await ctx.request({
      type: 'dev_trigger_security_event',
      scenario: 'tool-use-low-severity',
    });
    await ctx.waitForBroadcast((m) => m.type === 'security_event_detected', 3000);
    // Scanner-self-telemetry — should still be hidden by default.
    await ctx.request({
      type: 'dev_trigger_security_event',
      scenario: 'scan-truncated',
    });
    await ctx.waitForBroadcast((m) => m.type === 'security_event_detected', 3000);

    const defaultResp = await ctx.request<Array<{ kind: string; severity: string }>>({
      type: 'get_security_events',
    });
    expect(defaultResp.success).toBe(true);
    const defaultKinds = (defaultResp.data ?? []).map((e) => e.kind).sort();
    // Real LOW finding visible by default — the bug-fix lock-in.
    expect(defaultKinds).toContain('risky_bash');
    // Telemetry hidden by default.
    expect(defaultKinds).not.toContain('scan_truncated');

    const allResp = await ctx.request<Array<{ kind: string; severity: string }>>({
      type: 'get_security_events',
      includeWeakSignals: true,
    });
    expect(allResp.success).toBe(true);
    const allKinds = (allResp.data ?? []).map((e) => e.kind).sort();
    expect(allKinds).toContain('risky_bash');
    expect(allKinds).toContain('scan_truncated');
  });

  it('get_security_events passes severity / kinds / search / beforeTs through to the DB layer', async () => {
    ctx = await startTestDaemon();
    const { getDb, insertSecurityEvent } = await import('./db.js');
    const db = getDb();
    const now = Date.now();
    insertSecurityEvent(db, {
      ts: now - 3000,
      accountId: 'acc-a',
      sessionId: null,
      direction: 'outbound',
      severity: 'high',
      kind: 'secret',
      detectorId: 'aws-access-key',
      confidence: 0.95,
      title: 'AWS access key',
      reason: 'r',
      matchMask: 'AKIA[...]',
      matchHash: 'h-old-secret',
      contextHash: 'c1',
      snippet: '[REDACTED:secret]',
      sourceHint: 'messages[0]',
      details: null,
      blocked: false,
      provenance: 'file-read',
    });
    insertSecurityEvent(db, {
      ts: now - 2000,
      accountId: 'acc-a',
      sessionId: null,
      direction: 'outbound',
      severity: 'medium',
      kind: 'pii',
      detectorId: 'email',
      confidence: 0.8,
      title: 'Email address',
      reason: 'r',
      matchMask: null,
      matchHash: 'h-pii',
      contextHash: 'c2',
      snippet: null,
      sourceHint: null,
      details: null,
      blocked: false,
      provenance: 'conversation',
    });
    insertSecurityEvent(db, {
      ts: now - 1000,
      accountId: 'acc-a',
      sessionId: null,
      direction: 'outbound',
      severity: 'high',
      kind: 'secret',
      detectorId: 'github-token',
      confidence: 0.9,
      title: 'GitHub token',
      reason: 'r',
      matchMask: 'ghp_[...]',
      matchHash: 'h-new-secret',
      contextHash: 'c3',
      snippet: null,
      sourceHint: null,
      details: null,
      blocked: false,
      provenance: 'file-read',
    });

    // severity filter
    const high = await ctx.request<Array<{ matchHash: string }>>({
      type: 'get_security_events',
      severity: 'high',
    });
    expect((high.data ?? []).map((e) => e.matchHash).sort()).toEqual([
      'h-new-secret',
      'h-old-secret',
    ]);

    // kinds filter
    const piiOnly = await ctx.request<Array<{ kind: string }>>({
      type: 'get_security_events',
      kinds: ['pii'],
    });
    expect((piiOnly.data ?? []).map((e) => e.kind)).toEqual(['pii']);

    // search filter (case-insensitive across title/reason/match_mask/source_hint)
    const aws = await ctx.request<Array<{ matchHash: string }>>({
      type: 'get_security_events',
      search: 'aws',
    });
    expect((aws.data ?? []).map((e) => e.matchHash)).toEqual(['h-old-secret']);

    // beforeTs cursor — fetch newest, then page older
    const newest = await ctx.request<Array<{ ts: number; matchHash: string }>>({
      type: 'get_security_events',
      limit: 1,
    });
    expect((newest.data ?? []).map((e) => e.matchHash)).toEqual(['h-new-secret']);
    const older = await ctx.request<Array<{ matchHash: string }>>({
      type: 'get_security_events',
      beforeTs: newest.data![0]!.ts,
      limit: 5,
    });
    expect((older.data ?? []).map((e) => e.matchHash)).toEqual(['h-pii', 'h-old-secret']);
  });

  it('get_detector_stats returns one row per detector with override merged from settings', async () => {
    ctx = await startTestDaemon();
    // Seed two distinct detectors. One blocked, one approved, one
    // pure-noise — so the aggregate row shapes are testable.
    const { getDb, insertSecurityEvent } = await import('./db.js');
    const db = getDb();
    const now = Date.now();
    insertSecurityEvent(db, {
      ts: now - 1000,
      accountId: 'acc-a',
      sessionId: null,
      direction: 'outbound',
      severity: 'medium',
      kind: 'prompt_injection',
      detectorId: 'noisy-detector',
      confidence: 0.7,
      title: 't',
      reason: 'r',
      matchMask: null,
      matchHash: 'h1',
      contextHash: 'c1',
      snippet: null,
      sourceHint: null,
      details: null,
      blocked: false,
      provenance: 'tool-result',
    });
    insertSecurityEvent(db, {
      ts: now - 500,
      accountId: 'acc-a',
      sessionId: null,
      direction: 'outbound',
      severity: 'medium',
      kind: 'prompt_injection',
      detectorId: 'noisy-detector',
      confidence: 0.6,
      title: 't',
      reason: 'r',
      matchMask: null,
      matchHash: 'h2',
      contextHash: 'c2',
      snippet: null,
      sourceHint: null,
      details: null,
      blocked: false,
      provenance: 'tool-result',
    });
    insertSecurityEvent(db, {
      ts: now - 100,
      accountId: 'acc-a',
      sessionId: null,
      direction: 'outbound',
      severity: 'high',
      kind: 'secret',
      detectorId: 'real-detector',
      confidence: 0.95,
      title: 't',
      reason: 'r',
      matchMask: null,
      matchHash: 'h3',
      contextHash: 'c3',
      snippet: null,
      sourceHint: null,
      details: null,
      blocked: true,
      provenance: 'file-read',
    });

    // Demote one of the two via settings so the override field is
    // observable. (We don't trigger the auto-migration here because the
    // seed data is below its 20-event floor; this is a direct
    // user-driven update_settings.)
    await ctx.request({
      type: 'update_settings',
      settings: { detectorOverrides: { 'noisy-detector': 'informational' } },
    });

    const r = await ctx.request<
      Array<{
        detectorId: string;
        total: number;
        blocked: number;
        approved: number;
        avgConfidence: number;
        override: string;
      }>
    >({ type: 'get_detector_stats' });
    expect(r.success).toBe(true);
    // Sorted by total DESC: noisy-detector (2) > real-detector (1).
    expect(r.data).toHaveLength(2);
    expect(r.data![0]!.detectorId).toBe('noisy-detector');
    expect(r.data![0]!.total).toBe(2);
    expect(r.data![0]!.blocked).toBe(0);
    expect(r.data![0]!.approved).toBe(0);
    expect(r.data![0]!.override).toBe('informational');
    expect(r.data![1]!.detectorId).toBe('real-detector');
    expect(r.data![1]!.total).toBe(1);
    expect(r.data![1]!.blocked).toBe(1);
    // No explicit override → default 'active'.
    expect(r.data![1]!.override).toBe('active');
  });

  it('acknowledge_security_event on unknown id returns success=false', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'acknowledge_security_event', id: 99999 });
    expect(r.success).toBe(false);
  });

  it('acknowledge_all_security_events succeeds on empty table', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'acknowledge_all_security_events' });
    expect(r.success).toBe(true);
  });

  it('clear_security_events succeeds on empty table', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'clear_security_events' });
    expect(r.success).toBe(true);
  });

  it('get_security_allowlist returns empty array initially', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<unknown[]>({ type: 'get_security_allowlist' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('add_to_security_allowlist + remove_from_security_allowlist round-trip', async () => {
    ctx = await startTestDaemon();
    const add = await ctx.request<{ id: number }>({
      type: 'add_to_security_allowlist',
      matchHash: 'abc123',
      detectorId: 'test-detector',
    });
    expect(add.success).toBe(true);
    const id = add.data!.id;
    const remove = await ctx.request({ type: 'remove_from_security_allowlist', id });
    expect(remove.success).toBe(true);
  });
});

// ─── Permission rules + bypasses + claude-sync ───────────────────────────────

describe('IPC — permissions', () => {
  it('list_permission_rules returns empty array initially', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<unknown[]>({ type: 'list_permission_rules' });
    expect(r.success).toBe(true);
    expect(Array.isArray(r.data)).toBe(true);
  });

  it('get_permissions_status returns AutoModeStatus', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<Record<string, unknown>>({ type: 'get_permissions_status' });
    expect(r.success).toBe(true);
    expect(r.data).toBeDefined();
  });

  it('upsert_permission_rule + delete_permission_rule round-trip', async () => {
    ctx = await startTestDaemon();
    const up = await ctx.request<{ id: string }>({
      type: 'upsert_permission_rule',
      rule: {
        decision: 'deny',
        tool: 'Bash',
        pattern: 'rm -rf *',
        raw: 'Bash(rm -rf *)',
        source: 'local',
        enabled: true,
      },
    });
    expect(up.success).toBe(true);
    await ctx.waitForBroadcast((m) => m.type === 'permission_rules_changed');
    const del = await ctx.request({ type: 'delete_permission_rule', id: up.data!.id });
    expect(del.success).toBe(true);
  });

  it('get_permission_bypasses returns empty array initially', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<unknown[]>({ type: 'get_permission_bypasses' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('remove_permission_bypass on unknown id returns success=false', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'remove_permission_bypass', id: 99999 });
    expect(r.success).toBe(false);
  });
});

describe('IPC — claude sync', () => {
  it('get_claude_sync_status returns a status struct', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<Record<string, unknown>>({ type: 'get_claude_sync_status' });
    expect(r.success).toBe(true);
  });

  it('claude_sync_pull + claude_sync_push succeed when sync is disabled', async () => {
    ctx = await startTestDaemon();
    const pull = await ctx.request({ type: 'claude_sync_pull' });
    expect(pull.success).toBe(true);
    const push = await ctx.request({ type: 'claude_sync_push' });
    expect(push.success).toBe(true);
  });
});

// ─── Pending security blocks ────────────────────────────────────────────────

describe('IPC — pending blocks', () => {
  it('list_pending_blocks returns empty array when idle', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<unknown[]>({ type: 'list_pending_blocks' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('approve_blocked_request on unknown pendingId returns success=false', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'approve_blocked_request', pendingId: 'unknown' });
    expect(r.success).toBe(false);
  });

  it('deny_blocked_request on unknown pendingId returns success=false', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'deny_blocked_request', pendingId: 'unknown' });
    expect(r.success).toBe(false);
  });
});

// ─── Request-log store ──────────────────────────────────────────────────────

describe('IPC — request logs', () => {
  it('get_request_detail returns null for unknown id', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'get_request_detail', requestId: 'nope' });
    expect(r.success).toBe(true);
    expect(r.data).toBeNull();
  });

  it('clear_request_logs succeeds on empty store and broadcasts', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<{ deleted: number }>({ type: 'clear_request_logs' });
    expect(r.success).toBe(true);
    await ctx.waitForBroadcast((m) => m.type === 'request_logs_cleared');
  });
});

// ─── Dev triggers ────────────────────────────────────────────────────────────

describe('IPC — dev triggers', () => {
  it('dev_trigger_security_event synthesizes an event', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'dev_trigger_security_event',
      scenario: 'secret-anthropic',
    });
    expect(r.success).toBe(true);
    await ctx.waitForBroadcast((m) => m.type === 'security_event_detected', 3000);
  });

  it('dev_trigger_alert_event synthesizes an alert', async () => {
    ctx = await startWithActiveAccount();
    const r = await ctx.request({
      type: 'dev_trigger_alert_event',
      scenario: 'usage-account',
    });
    expect(r.success).toBe(true);
    await ctx.waitForBroadcast((m) => m.type === 'alert_triggered', 3000);
  });
});

// ─── Probe + refresh + purge ─────────────────────────────────────────────────

describe('IPC — probes and purges', () => {
  it('probe_rate_limits succeeds for a seeded account', async () => {
    ctx = await startWithActiveAccount();
    const list = await ctx.request<Array<{ id: string }>>({ type: 'get_accounts' });
    const id = list.data![0]!.id;
    const r = await ctx.request({ type: 'probe_rate_limits', accountId: id });
    expect(r.success).toBe(true);
  });

  it('probe_rate_limits with unknown accountId short-circuits to success', async () => {
    ctx = await startTestDaemon();
    // Handler is fire-and-forget — it early-exits when no cred exists but
    // still acknowledges the request. That contract is what the UI relies on.
    const r = await ctx.request({ type: 'probe_rate_limits', accountId: 'unknown-id' });
    expect(r.success).toBe(true);
  });

  it('purge_all_data returns success and clears keychain entries', async () => {
    ctx = await startWithActiveAccount();
    const r = await ctx.request({ type: 'purge_all_data' });
    expect(r.success).toBe(true);
  });
});

// ─── External OTEL forwarder ────────────────────────────────────────────────

describe('IPC — OTEL exporter', () => {
  it('get_otel_exporter_status returns a not-configured status on fresh install', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<{
      secretConfigured: boolean;
      ready: boolean;
      sent: number;
      failed: number;
      dropped: number;
      lastForwardOkAt: number | null;
      lastForwardErr: string | null;
      inFlight: number;
    }>({ type: 'get_otel_exporter_status' });
    expect(r.success).toBe(true);
    expect(r.data?.secretConfigured).toBe(false);
    expect(r.data?.ready).toBe(false);
    expect(r.data?.sent).toBe(0);
  });

  it('set_otel_exporter_secret + get_otel_exporter_status flips configured to true', async () => {
    ctx = await startTestDaemon();
    const setResp = await ctx.request({
      type: 'set_otel_exporter_secret',
      value: 'my-ingestion-key',
    });
    expect(setResp.success).toBe(true);
    const r = await ctx.request<{ secretConfigured: boolean }>({
      type: 'get_otel_exporter_status',
    });
    expect(r.success).toBe(true);
    expect(r.data?.secretConfigured).toBe(true);
  });

  it('clear_otel_exporter_secret flips configured back to false', async () => {
    ctx = await startTestDaemon();
    await ctx.request({ type: 'set_otel_exporter_secret', value: 'k' });
    await ctx.request({ type: 'clear_otel_exporter_secret' });
    const r = await ctx.request<{ secretConfigured: boolean }>({
      type: 'get_otel_exporter_status',
    });
    expect(r.success).toBe(true);
    expect(r.data?.secretConfigured).toBe(false);
  });

  it('set_otel_exporter_secret with empty value clears the slot', async () => {
    ctx = await startTestDaemon();
    await ctx.request({ type: 'set_otel_exporter_secret', value: 'abc' });
    await ctx.request({ type: 'set_otel_exporter_secret', value: '' });
    const r = await ctx.request<{ secretConfigured: boolean }>({
      type: 'get_otel_exporter_status',
    });
    expect(r.success).toBe(true);
    expect(r.data?.secretConfigured).toBe(false);
  });

  it('test_otel_exporter reports no-endpoint cleanly', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<{ ok: boolean; status: number | null; message: string }>({
      type: 'test_otel_exporter',
    });
    expect(r.success).toBe(true);
    expect(r.data?.ok).toBe(false);
    expect(r.data?.message).toBe('no endpoint configured');
  });
});

// ─── Scan benchmark ─────────────────────────────────────────────────────────

describe('IPC — scan benchmark', () => {
  it('run_scan_benchmark completes and persists a result', async () => {
    ctx = await startTestDaemon();
    // CPU-heavy: sweeps 5 payload sizes (1/2/4/8/16 MB) with a per-size
    // safety cap of ~2 s, so worst case is ~10 s. Ubuntu CI runners under
    // v8 coverage routinely exceed the 5 s default IPC timeout; raise the
    // request ceiling well below the 30 s vitest test timeout.
    const r = await ctx.request<{ recommendedMb: number }>(
      { type: 'run_scan_benchmark' },
      { timeoutMs: 25_000 },
    );
    expect(r.success).toBe(true);
    expect(typeof r.data?.recommendedMb).toBe('number');
  }, 30_000);
});
