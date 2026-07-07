import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import type { Database } from 'better-sqlite3';
import {
  closeDb,
  getDb,
  upsertPermissionRule,
  deletePermissionRule,
  listSecurityEvents,
} from '../../db.js';
import { createPermissionsEnforcer } from './enforcer.js';
import type { Settings, PermissionRule } from '@sentinel/shared';

// Sprint 10: pin the contract that mutations during in-flight requests
// — settings flips, rule deletes — do not corrupt the in-flight
// evaluation. The enforcer captures its snapshot at the start of the
// request (compiled rules + matchedRule pushed into the pending
// entry); subsequent DB / settings mutations only affect later
// requests.

const NEW_DB = (): string =>
  join(tmpdir(), `sentinel-enforcer-race-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function defaultSettings(over: Partial<Settings> = {}): Settings {
  return {
    launchAtLogin: true,
    switchingMode: 'off',
    alertSoundName: null,
    overageOsNotify: false,
    autoUpdate: false,
    alternateApiUrl: null,
    poolExcludedIds: [],
    reauthIncognitoDefault: true,
    overageEnabledIds: [],
    budgetWeeklyUsdByAccount: {},
    budgetWeeklyUsdGlobal: null,
    overageBufferPct: 5,
    backgroundProbeIntervalSec: 300,
    telemetryRetentionDays: 30,
    dataRetentionDays: 365,
    optimizeRetentionDays: 365,
    metricsRetentionDays: 365,
    optimizeRange: 'all',
    metricsRange: '1w',
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
    toolPermissionSkipInAutoMode: false,
    toolPermissionAutoModeActive: false,
    securityOversizedThresholdMb: 1,
    securityScanOversizedSync: false,
    securityMuteScanDeferred: false,
    securityMuteScanTruncated: false,
    securityMuteScanSkipped: false,
    lastScanBenchmark: null,
    claudeCodeSyncEnabled: false,
    claudeDesktopConfigId: null,
    isolationPolicy: {
      enabled: false,
      syncToClaudeCode: false,
      enforceCodeMode: false,
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
      credentials: { files: [], envVars: [] },
    },
    securityIncidentReplay: false,
    logLevel: 'info',
    requestLoggingEnabled: false,
    requestLogRetentionDays: 7,
    requestLogMaxBodyKb: 256,
    requestLogCaptureResponse: true,
    requestLogRedactAuthHeaders: true,
    cacheTtlForceOneHour: false,
    securitySetupCompleted: true,
    tourCompleted: true,
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
    codeModeEnabled: false,
    codeModeMigrations: [],
    codeModeSkillInstalled: false,
    codeModeClaudeMdInstalled: false,
    mcpDisabledStashes: [],
    optimizeSubTab: 'subagents',
    securitySubTab: 'scanning',
    dataSubTab: 'retention',
    ...over,
  };
}

function ipcStub(): { broadcast: (m: unknown) => void; broadcasts: unknown[] } {
  const broadcasts: unknown[] = [];
  return { broadcast: (m) => broadcasts.push(m), broadcasts };
}

/** Build a minimal request body with one Bash tool advertised so the
 *  strip path has something to match. */
function bodyWithBashTool(): Buffer {
  return Buffer.from(
    JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 8,
      tools: [{ name: 'Bash', description: 'run shell commands' }],
      messages: [{ role: 'user', content: 'do something' }],
    }),
    'utf-8',
  );
}

describe('Sprint 10 — enforcer race-condition contract', () => {
  let dbPath: string;
  let db: Database;
  let settings: Settings;
  let denyRule: PermissionRule;

  beforeEach(() => {
    dbPath = NEW_DB();
    db = getDb(dbPath);
    settings = defaultSettings();
    denyRule = upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: null,
      raw: 'Bash',
      priority: 0,
    });
  });

  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('settings flipped during a hold: snapshot honors the begin-time setting', async () => {
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({
      db,
      ipcServer: ipc as never,
      getSettings: () => settings,
    });

    // Kick off the strip; it will see hold enabled, register a pending,
    // and start awaiting the user.
    const stripPromise = enforcer.stripDeniedTools(bodyWithBashTool(), 'acct-1');

    // Wait for the pending to register (broadcasts include the
    // security_block_pending event; pendingId is in there).
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pendings = enforcer.listPending();
    expect(pendings.length).toBe(1);
    const pendingId = pendings[0]!.pendingId;

    // Mutation in-flight: turn the entire permission system off via
    // settings. A subsequent request would now skip enforcement —
    // but THIS request's pending must still resolve correctly.
    settings = defaultSettings({ toolPermissionsEnabled: false });

    // User approves. The original body must come back unchanged
    // (tools array intact), confirming the snapshot survived the
    // settings flip.
    expect(enforcer.resolvePending(pendingId, 'approve')).toBe(true);
    const result = await stripPromise;
    const parsed = JSON.parse(result.toString('utf-8'));
    expect(Array.isArray(parsed.tools)).toBe(true);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].name).toBe('Bash');

    // Subsequent request DOES see the new setting — enforcement off,
    // body passes through without ever entering a hold. This double-
    // checks that the snapshot semantics are per-request, not global.
    const second = await enforcer.stripDeniedTools(bodyWithBashTool(), 'acct-1');
    const secondParsed = JSON.parse(second.toString('utf-8'));
    expect(secondParsed.tools).toHaveLength(1);
    expect(enforcer.listPending()).toHaveLength(0); // no new pending opened

    enforcer.shutdown();
  });

  it('rule deleted between match and pending-resolve: matchedRule snapshot survives', async () => {
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({
      db,
      ipcServer: ipc as never,
      getSettings: () => settings,
    });

    const stripPromise = enforcer.stripDeniedTools(bodyWithBashTool(), 'acct-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pendings = enforcer.listPending();
    expect(pendings.length).toBe(1);
    const pendingId = pendings[0]!.pendingId;
    // The pending broadcast carries the matchedRule's raw text — that's
    // the snapshot we're verifying survives the delete.
    expect(pendings[0]!.matchMask).toBe(denyRule.raw);

    // Mutation in-flight: delete the rule from the DB and force a
    // cache invalidate as the IPC handler would. The pending entry
    // already holds its own copy of matchedRule.
    expect(deletePermissionRule(db, denyRule.id)).toBe(true);
    enforcer.invalidate();

    // User denies. The pending finalizes, onFinalized writes the
    // security event row. The audit row must reference the original
    // rule (its raw / detector id / outcome) even though the rule
    // row no longer exists in the DB.
    expect(enforcer.resolvePending(pendingId, 'deny')).toBe(true);
    const result = await stripPromise;
    // Tools array stripped — body has no Bash tool now.
    const parsed = JSON.parse(result.toString('utf-8'));
    expect(parsed.tools).toEqual([]);

    // Audit row exists and points at the original rule's identity.
    const events = listSecurityEvents(db, { accountId: 'acct-1' });
    expect(events.length).toBeGreaterThan(0);
    const blocked = events.find((e) => e.detectorId === 'tool_permission_blocked');
    expect(blocked).toBeDefined();
    expect(blocked!.matchMask).toContain('Bash');

    enforcer.shutdown();
  });

  it('rule deleted then approve: still forwards original tools', async () => {
    // Same race as above but the user picks approve. Snapshot must
    // still drive forwarding; the deleted rule doesn't suddenly turn
    // into "no rule matched".
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({
      db,
      ipcServer: ipc as never,
      getSettings: () => settings,
    });
    const stripPromise = enforcer.stripDeniedTools(bodyWithBashTool(), 'acct-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pendingId = enforcer.listPending()[0]!.pendingId;

    expect(deletePermissionRule(db, denyRule.id)).toBe(true);
    enforcer.invalidate();

    expect(enforcer.resolvePending(pendingId, 'approve')).toBe(true);
    const result = await stripPromise;
    const parsed = JSON.parse(result.toString('utf-8'));
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].name).toBe('Bash');

    enforcer.shutdown();
  });
});
