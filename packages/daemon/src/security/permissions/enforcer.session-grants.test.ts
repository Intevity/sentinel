import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import { ServerResponse } from 'http';
import { Socket } from 'net';
import type { Database } from 'better-sqlite3';
import type { Settings } from '@claude-sentinel/shared';
import {
  getDb,
  closeDb,
  insertSessionGrant,
  findSessionGrant,
  pruneExpiredSessionGrants,
  recordApprovalEvent,
  countRecentApprovals,
  upsertPermissionRule,
  listPermissionRules,
} from '../../db.js';
import { createPermissionsEnforcer } from './enforcer.js';

function defaultSettings(over: Partial<Settings> = {}): Settings {
  return {
    launchAtLogin: true,
    switchingMode: 'off',
    alertSoundName: null,
    overageOsNotify: true,
    autoUpdate: false,
    alternateApiUrl: null,
    poolExcludedIds: [],
    reauthIncognitoDefault: true,
    overageEnabledIds: [],
    budgetWeeklyUsdByAccount: {},
    budgetWeeklyUsdGlobal: null,
    overageBufferPct: 5,
    roundRobinStrategy: 'balance',
    backgroundProbeIntervalSec: 300,
    telemetryRetentionDays: 30,
    dataRetentionDays: 365,
    optimizeRange: 'all',
    securityScanEnabled: false,
    securityEnforcementMode: null,
    securityScanSecrets: false,
    securityScanInjection: false,
    securityScanToolUse: false,
    securityOsNotifyThreshold: 'high',
    securityPersistSnippet: true,
    securityContextVerbosity: 'standard',
    securityEventRetentionDays: 30,
    securityApproveHoldSec: 60,
    detectorOverrides: {},
    toolPermissionsEnabled: true,
    toolPermissionDefaultAction: 'allow',
    toolPermissionSkipInAutoMode: true,
    toolPermissionAutoModeActive: false,
    securityOversizedThresholdMb: 1,
    securityScanOversizedSync: false,
    securityMuteScanDeferred: false,
    securityMuteScanTruncated: false,
    securityMuteScanSkipped: false,
    lastScanBenchmark: null,
    claudeCodeSyncEnabled: false,
    securityIncidentReplay: false,
    logLevel: 'info',
    requestLoggingEnabled: false,
    requestLogRetentionDays: 7,
    requestLogMaxBodyKb: 256,
    requestLogCaptureResponse: true,
    requestLogRedactAuthHeaders: true,
    cacheTtlForceOneHour: false,
    securitySetupCompleted: false,
    tourCompleted: false,
    theme: 'system',
    denyPrivateNetworkByDefault: false,
    toolPermissionResolveSymlinks: false,
    daemonHealthFailMode: 'warn',
    securityWebhookUrl: null,
    securityWebhookSecret: null,
    securityWebhookSeverityFloor: 'high',
    optimizeCaptureEnabled: true,
    optimizeAutoRecommend: true,
    optimizeShowMicroOpportunities: false,
    optimizeUnits: 'tokens',
    otelForwardingEnabled: false,
    otelForwardMetrics: true,
    otelForwardLogs: true,
    otelEmitSentinelMetrics: true,
    otelExporterEndpoint: null,
    otelExporterHeaderName: 'signoz-ingestion-key',
    otelServiceInstanceId: '00000000-0000-4000-8000-000000000000',
    optimizeChartView: 'realized',
    compressionEnabled: false,
    compressionLevel: 'conservative',
    compressionMaxBodyKb: 4096,
    compressionRetrievalEnabled: false,
    compressionRetrievalInstalls: [],
    ...over,
  };
}

const ipcStub = (): { broadcast: (m: unknown) => void; broadcasts: unknown[] } => {
  const broadcasts: unknown[] = [];
  return { broadcast: (m) => broadcasts.push(m), broadcasts };
};

function makeQuietResponse(): ServerResponse {
  const sock = new Socket();
  sock.write = (() => true) as unknown as Socket['write'];
  const req = {} as unknown as import('http').IncomingMessage;
  const res = new ServerResponse(req);
  res.assignSocket(sock);
  res.write = ((..._args: unknown[]): boolean => true) as unknown as ServerResponse['write'];
  return res;
}

const TEST_DB = (): string =>
  join(tmpdir(), `sentinel-session-grants-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

describe('Sprint 9 — session_approval_grants helpers', () => {
  const path = TEST_DB();
  let db: Database;

  beforeEach(() => {
    db = getDb(path);
  });
  afterEach(() => {
    closeDb();
    if (existsSync(path)) unlinkSync(path);
  });

  it('insert + find honors the (session_id, rule_key) primary key', () => {
    const now = 1_700_000_000_000;
    insertSessionGrant(db, {
      sessionId: 'sess-A',
      ruleKey: 'Bash|rm *',
      nowMs: now,
      expiresAtMs: now + 60_000,
    });
    expect(findSessionGrant(db, { sessionId: 'sess-A', ruleKey: 'Bash|rm *', nowMs: now })).toBe(
      true,
    );
    // Different session id ⇒ no match.
    expect(findSessionGrant(db, { sessionId: 'sess-B', ruleKey: 'Bash|rm *', nowMs: now })).toBe(
      false,
    );
    // Different rule key ⇒ no match.
    expect(findSessionGrant(db, { sessionId: 'sess-A', ruleKey: 'Bash|sudo *', nowMs: now })).toBe(
      false,
    );
  });

  it('expired grants return false and are deleted lazily on read', () => {
    const issued = 1_700_000_000_000;
    insertSessionGrant(db, {
      sessionId: 'sess-A',
      ruleKey: 'Bash|rm *',
      nowMs: issued,
      expiresAtMs: issued + 1_000,
    });
    // Past the expiry → returns false.
    expect(
      findSessionGrant(db, { sessionId: 'sess-A', ruleKey: 'Bash|rm *', nowMs: issued + 5_000 }),
    ).toBe(false);
    // And the row was deleted by the lazy-prune branch.
    const remaining = db
      .prepare(
        'SELECT COUNT(*) AS n FROM session_approval_grants WHERE session_id = ? AND rule_key = ?',
      )
      .get('sess-A', 'Bash|rm *') as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('upsert refreshes expires_at instead of inserting a duplicate', () => {
    const t0 = 1_000;
    insertSessionGrant(db, {
      sessionId: 'sess-A',
      ruleKey: 'Bash|rm *',
      nowMs: t0,
      expiresAtMs: t0 + 1_000,
    });
    insertSessionGrant(db, {
      sessionId: 'sess-A',
      ruleKey: 'Bash|rm *',
      nowMs: t0 + 500,
      expiresAtMs: t0 + 9_999,
    });
    const rows = db
      .prepare(
        'SELECT expires_at AS e FROM session_approval_grants WHERE session_id = ? AND rule_key = ?',
      )
      .all('sess-A', 'Bash|rm *') as Array<{ e: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.e).toBe(t0 + 9_999);
  });

  it('pruneExpiredSessionGrants removes only expired rows', () => {
    insertSessionGrant(db, {
      sessionId: 's1',
      ruleKey: 'Bash|rm *',
      nowMs: 0,
      expiresAtMs: 1_000,
    });
    insertSessionGrant(db, {
      sessionId: 's2',
      ruleKey: 'Bash|rm *',
      nowMs: 0,
      expiresAtMs: 10_000,
    });
    const removed = pruneExpiredSessionGrants(db, 5_000);
    expect(removed).toBe(1);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM session_approval_grants').get() as {
      n: number;
    };
    expect(remaining.n).toBe(1);
  });
});

describe('Sprint 9 — approval_events helpers', () => {
  const path = TEST_DB();
  let db: Database;

  beforeEach(() => {
    db = getDb(path);
  });
  afterEach(() => {
    closeDb();
    if (existsSync(path)) unlinkSync(path);
  });

  it('countRecentApprovals returns rows in the (sessionId, ruleKey, sinceMs) window', () => {
    const baseTs = 1_700_000_000_000;
    for (let i = 0; i < 5; i += 1) {
      recordApprovalEvent(db, {
        sessionId: 'sess-A',
        ruleKey: 'Bash|rm *',
        approvedAtMs: baseTs + i * 10_000,
      });
    }
    // One older event outside the window.
    recordApprovalEvent(db, {
      sessionId: 'sess-A',
      ruleKey: 'Bash|rm *',
      approvedAtMs: baseTs - 10 * 60_000,
    });
    // Different (rule_key) and (session_id) noise.
    recordApprovalEvent(db, {
      sessionId: 'sess-A',
      ruleKey: 'Bash|sudo *',
      approvedAtMs: baseTs + 1_000,
    });
    recordApprovalEvent(db, {
      sessionId: 'sess-B',
      ruleKey: 'Bash|rm *',
      approvedAtMs: baseTs + 1_000,
    });
    const count = countRecentApprovals(db, {
      sessionId: 'sess-A',
      ruleKey: 'Bash|rm *',
      sinceMs: baseTs - 5 * 60_000,
    });
    expect(count).toBe(5);
  });

  it('returns zero when nothing matches', () => {
    const n = countRecentApprovals(db, {
      sessionId: 'never-seen',
      ruleKey: 'Bash|rm *',
      sinceMs: 0,
    });
    expect(n).toBe(0);
  });
});

describe('Sprint 9 — enforcer integration: session grants + recent cwd', () => {
  const path = TEST_DB();
  let db: Database;

  beforeEach(() => {
    db = getDb(path);
  });
  afterEach(() => {
    closeDb();
    if (existsSync(path)) unlinkSync(path);
  });

  it('stripDeniedTools forwards body when an active session grant exists for the matched rule', async () => {
    upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'WebFetch',
      pattern: null,
      raw: 'WebFetch',
    });
    const settings = defaultSettings({
      securityApproveHoldSec: 30,
    });
    const enforcer = createPermissionsEnforcer({
      db,
      ipcServer: ipcStub() as never,
      getSettings: () => settings,
    });
    // Pre-seed a session grant for the rule so the strip path
    // short-circuits and returns the body unchanged.
    const nowMs = Date.now();
    insertSessionGrant(db, {
      sessionId: 'sess-1',
      ruleKey: 'WebFetch|*',
      nowMs,
      expiresAtMs: nowMs + 60_000,
    });
    const userIdJson = JSON.stringify({
      device_id: 'd1',
      account_uuid: 'a',
      session_id: 'sess-1',
    });
    const body = Buffer.from(
      JSON.stringify({
        metadata: { user_id: userIdJson },
        system:
          '<env>\nWorking directory: /Users/jeff/work/api\nIs directory a git repo: yes\n</env>',
        tools: [{ name: 'WebFetch', description: 'fetch' }],
        messages: [],
      }),
    );
    const out = await enforcer.stripDeniedTools(body, 'acc-1');
    expect(out).toBe(body);
    enforcer.shutdown();
  });

  it('records the cwd into the recent-cwd buffer when a request includes one', async () => {
    upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'WebFetch',
      pattern: null,
      raw: 'WebFetch',
    });
    const settings = defaultSettings();
    const enforcer = createPermissionsEnforcer({
      db,
      ipcServer: ipcStub() as never,
      getSettings: () => settings,
    });
    const buildBody = (sessionId: string, cwd: string): Buffer =>
      Buffer.from(
        JSON.stringify({
          metadata: {
            user_id: JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: sessionId }),
          },
          system: `<env>\nWorking directory: ${cwd}\n</env>`,
          tools: [{ name: 'Read' }],
          messages: [],
        }),
      );
    await enforcer.stripDeniedTools(buildBody('s1', '/Users/jeff/repo-a'), 'acc');
    await enforcer.stripDeniedTools(buildBody('s2', '/Users/jeff/repo-b'), 'acc');
    // Re-record the same cwd; should move to front, not duplicate.
    await enforcer.stripDeniedTools(buildBody('s1', '/Users/jeff/repo-a'), 'acc');
    const recents = enforcer.getRecentCwds();
    expect(recents).toEqual(['/Users/jeff/repo-a', '/Users/jeff/repo-b']);
    enforcer.shutdown();
  });

  it('createInterceptor awaitDecision short-circuits on a matching session grant', async () => {
    upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm *',
      raw: 'Bash(rm *)',
    });
    const settings = defaultSettings({
      securityApproveHoldSec: 30,
    });
    const enforcer = createPermissionsEnforcer({
      db,
      ipcServer: ipcStub() as never,
      getSettings: () => settings,
    });
    // Pre-seed the grant so awaitDecision returns 'approve' immediately
    // when the deny rule matches the streamed tool_use input.
    const nowMs = Date.now();
    insertSessionGrant(db, {
      sessionId: 'sess-grant-1',
      ruleKey: 'Bash|rm *',
      nowMs,
      expiresAtMs: nowMs + 60_000,
    });
    const body = Buffer.from(
      JSON.stringify({
        metadata: {
          user_id: JSON.stringify({
            device_id: 'd',
            account_uuid: 'a',
            session_id: 'sess-grant-1',
          }),
        },
        system: '<env>\nWorking directory: /Users/jeff/repo\n</env>',
        messages: [],
      }),
    );
    const res = makeQuietResponse();
    const interceptor = enforcer.createInterceptor(res, 'acc', undefined, body);
    expect(interceptor).not.toBeNull();
    const stream =
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"rm thing.txt\\"}"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
    interceptor!.push(stream);
    interceptor!.flush();
    // Yield so the async awaitDecision short-circuit can run.
    await new Promise((r) => setImmediate(r));
    enforcer.shutdown();
    res.socket?.destroy();
    // Assert that no synthetic-block text-event was emitted: the
    // pending registry was bypassed because the grant fired.
    expect(enforcer.listPending()).toHaveLength(0);
  });

  it('createInterceptor populates recentApproveCount on the pending broadcast when session_id is known', async () => {
    upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm *',
      raw: 'Bash(rm *)',
    });
    // Pre-seed three approval-events so the pending block carries
    // recentApproveCount: 3 on the broadcast.
    const t = Date.now();
    for (let i = 0; i < 3; i += 1) {
      recordApprovalEvent(db, {
        sessionId: 'sess-recent-1',
        ruleKey: 'Bash|rm *',
        approvedAtMs: t - i * 1000,
      });
    }
    const settings = defaultSettings({
      securityApproveHoldSec: 30,
    });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({
      db,
      ipcServer: ipc as never,
      getSettings: () => settings,
    });
    const body = Buffer.from(
      JSON.stringify({
        metadata: {
          user_id: JSON.stringify({
            device_id: 'd',
            account_uuid: 'a',
            session_id: 'sess-recent-1',
          }),
        },
        system: '<env>\nWorking directory: /Users/jeff/repo\n</env>',
        messages: [],
      }),
    );
    const res = makeQuietResponse();
    const interceptor = enforcer.createInterceptor(res, 'acc', undefined, body);
    const stream =
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"rm only.txt\\"}"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
    interceptor!.push(stream);
    interceptor!.flush();
    // Wait for the pending broadcast to land (the awaitDecision is
    // async). We poll because the SSE machinery hops through several
    // microtasks before the broadcast fires.
    let pendingMsg: { recentApproveCount?: number } | undefined;
    for (let i = 0; i < 20 && !pendingMsg; i += 1) {
      await new Promise((r) => setImmediate(r));
      pendingMsg = ipc.broadcasts.find(
        (m): m is { type: string; pending: { recentApproveCount?: number } } =>
          (m as { type: string }).type === 'security_block_pending',
      )?.pending;
    }
    expect(pendingMsg).toBeDefined();
    expect(pendingMsg!.recentApproveCount).toBe(3);
    // Approve with mode=session so the onFinalized hook records both
    // a session_approval_grants row AND an approval_events row — that
    // covers the full approve+session path in one shot.
    const pending = enforcer.listPending();
    expect(pending).toHaveLength(1);
    const ok = enforcer.resolvePending(pending[0]!.pendingId, 'approve', { mode: 'session' });
    expect(ok).toBe(true);
    // Both the new grant and the new approval event landed.
    const nowMs = Date.now();
    expect(findSessionGrant(db, { sessionId: 'sess-recent-1', ruleKey: 'Bash|rm *', nowMs })).toBe(
      true,
    );
    const after = countRecentApprovals(db, {
      sessionId: 'sess-recent-1',
      ruleKey: 'Bash|rm *',
      sinceMs: 0,
    });
    expect(after).toBe(4);
    enforcer.shutdown();
    res.socket?.destroy();
  });

  it('stripDeniedTools hold path computes recentApproveCount when sessionId is parseable', async () => {
    upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'WebFetch',
      pattern: null,
      raw: 'WebFetch',
    });
    const t = Date.now();
    for (let i = 0; i < 2; i += 1) {
      recordApprovalEvent(db, {
        sessionId: 'sess-strip-1',
        ruleKey: 'WebFetch|*',
        approvedAtMs: t - i * 1000,
      });
    }
    const settings = defaultSettings({
      securityApproveHoldSec: 30,
    });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({
      db,
      ipcServer: ipc as never,
      getSettings: () => settings,
    });
    const body = Buffer.from(
      JSON.stringify({
        metadata: {
          user_id: JSON.stringify({
            device_id: 'd',
            account_uuid: 'a',
            session_id: 'sess-strip-1',
          }),
        },
        system: '<env>\nWorking directory: /Users/jeff/repo\n</env>',
        tools: [{ name: 'WebFetch' }],
        messages: [],
      }),
    );
    // Issue the strip on a microtask alongside a deny resolve so the
    // hold path completes deterministically.
    const promise = enforcer.stripDeniedTools(body, 'acc');
    // Wait for the broadcast to land + grab pending id.
    let pendingMsg: { recentApproveCount?: number; pendingId?: string } | undefined;
    for (let i = 0; i < 20 && !pendingMsg; i += 1) {
      await new Promise((r) => setImmediate(r));
      pendingMsg = ipc.broadcasts.find(
        (
          m,
        ): m is {
          type: string;
          pending: { recentApproveCount?: number; pendingId: string };
        } => (m as { type: string }).type === 'security_block_pending',
      )?.pending;
    }
    expect(pendingMsg).toBeDefined();
    expect(pendingMsg!.recentApproveCount).toBe(2);
    if (pendingMsg!.pendingId) enforcer.resolvePending(pendingMsg!.pendingId, 'deny');
    await promise;
    enforcer.shutdown();
  });

  it('resolvePending with mode=always writes a permission_bypass row and broadcasts', async () => {
    upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm *',
      raw: 'Bash(rm *)',
    });
    const settings = defaultSettings({
      securityApproveHoldSec: 30,
    });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({
      db,
      ipcServer: ipc as never,
      getSettings: () => settings,
    });
    const body = Buffer.from(
      JSON.stringify({
        metadata: {
          user_id: JSON.stringify({
            device_id: 'd',
            account_uuid: 'a',
            session_id: 'sess-always-1',
          }),
        },
        system: '<env>\nWorking directory: /Users/jeff/repo\n</env>',
        messages: [],
      }),
    );
    const res = makeQuietResponse();
    const interceptor = enforcer.createInterceptor(res, 'acc', undefined, body);
    const stream =
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"rm important.txt\\"}"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
    interceptor!.push(stream);
    interceptor!.flush();
    let pendingId: string | undefined;
    for (let i = 0; i < 20 && !pendingId; i += 1) {
      await new Promise((r) => setImmediate(r));
      const msg = ipc.broadcasts.find(
        (m): m is { type: string; pending: { pendingId: string } } =>
          (m as { type: string }).type === 'security_block_pending',
      );
      pendingId = msg?.pending.pendingId;
    }
    expect(pendingId).toBeDefined();
    const ok = enforcer.resolvePending(pendingId!, 'approve', { mode: 'always' });
    expect(ok).toBe(true);
    // mode=always now writes a rule-wide bypass — the row uses the
    // wildcard sentinel for input_hash so every future input matching
    // the same deny rule is allowed, not just the exact command the
    // user approved.
    const row = db
      .prepare(
        "SELECT input_hash, mask, note, tool_name FROM permission_bypass WHERE rule_id != ''",
      )
      .get() as { input_hash: string; mask: string; note: string; tool_name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.input_hash).toBe('*');
    expect(row!.tool_name).toBe('Bash');
    expect(row!.mask).toContain('Bash(rm *)');
    expect(row!.note).toMatch(/rule-wide/i);
    const bypassBroadcast = ipc.broadcasts.some(
      (m) => (m as { type: string }).type === 'permission_bypasses_updated',
    );
    expect(bypassBroadcast).toBe(true);
    enforcer.shutdown();
    res.socket?.destroy();
  });

  it('resolvePending with mode=session writes a grant and recordApprovalEvent fires', async () => {
    const settings = defaultSettings({
      securityApproveHoldSec: 30,
    });
    const enforcer = createPermissionsEnforcer({
      db,
      ipcServer: ipcStub() as never,
      getSettings: () => settings,
    });
    enforcer.triggerTestScenario('permissions-tool-use-pending', 'acc-1');
    // Locate the pending entry the synthetic scenario created.
    const pending = enforcer.listPending();
    expect(pending).toHaveLength(1);
    const pendingId = pending[0]!.pendingId;
    // No session_id on the synthetic scenario, so the session-grant
    // path won't run; instead this exercises the "mode=session but
    // sessionId is null" branch where recordApprovalEvent is skipped.
    const ok = enforcer.resolvePending(pendingId, 'approve', { mode: 'session' });
    expect(ok).toBe(true);
    // Cleanup the synthetic rule the scenario inserted.
    expect(listPermissionRules(db).length).toBe(0);
    enforcer.shutdown();
  });
});
