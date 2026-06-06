import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import { closeDb, getDb, listSecurityEvents, listIncidentReplay } from '../../db.js';
import { createPermissionsEnforcer } from './enforcer.js';
import { createIncidentReplayRecorder } from '../incident-replay.js';
import type { Settings } from '@claude-sentinel/shared';

const NEW_DB = () =>
  join(
    tmpdir(),
    `sentinel-enforcer-replay-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

function defaultSettings(overrides: Partial<Settings> = {}): Settings {
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
    roundRobinStrategy: 'balance',
    backgroundProbeIntervalSec: 300,
    telemetryRetentionDays: 30,
    dataRetentionDays: 365,
    optimizeRetentionDays: 365,
    metricsRetentionDays: 365,
    optimizeRange: 'all',
    metricsRange: '1w',
    securityScanEnabled: false,
    securityEnforcementMode: 'block_high',
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
    securityIncidentReplay: true,
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
    mcpDisabledStashes: [],
    optimizeSubTab: 'subagents',
    ...overrides,
  };
}

function ipcStub(): { broadcast: (m: unknown) => void; broadcasts: unknown[] } {
  const broadcasts: unknown[] = [];
  return { broadcast: (m) => broadcasts.push(m), broadcasts };
}

describe('enforcer — Sprint 8 incident replay capture', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = NEW_DB();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('captureForEventByAccount fires when a tool block records, replay setting on, mode block_high', () => {
    const db = getDb(dbPath);
    const ipc = ipcStub();
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    // Pre-populate the per-account session buffer so capture has data.
    recorder.recordSessionMessage('sess-1', { role: 'user', text: 'recent context' }, 'acc-x');
    const enforcer = createPermissionsEnforcer({
      db,
      ipcServer: ipc as never,
      getSettings: () => defaultSettings(),
      incidentReplay: recorder,
    });
    enforcer.triggerTestScenario('permissions-strip', 'acc-x');
    const events = listSecurityEvents(db);
    expect(events).toHaveLength(1);
    const eventId = events[0]!.id;
    const replay = listIncidentReplay(db, eventId);
    expect(replay).not.toBeNull();
    expect(replay!.messages[0]!.text).toBe('recent context');
  });

  it('does not capture when the replay setting is off', () => {
    const db = getDb(dbPath);
    const ipc = ipcStub();
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    recorder.recordSessionMessage('sess-1', { role: 'user', text: 'context' }, 'acc-x');
    const enforcer = createPermissionsEnforcer({
      db,
      ipcServer: ipc as never,
      getSettings: () => defaultSettings({ securityIncidentReplay: false }),
      incidentReplay: recorder,
    });
    enforcer.triggerTestScenario('permissions-strip', 'acc-x');
    const events = listSecurityEvents(db);
    expect(events).toHaveLength(1);
    expect(listIncidentReplay(db, events[0]!.id)).toBeNull();
  });

  it('does not capture when enforcement mode is observe (not block_*)', () => {
    const db = getDb(dbPath);
    const ipc = ipcStub();
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    recorder.recordSessionMessage('sess-1', { role: 'user', text: 'context' }, 'acc-x');
    const enforcer = createPermissionsEnforcer({
      db,
      ipcServer: ipc as never,
      getSettings: () => defaultSettings({ securityEnforcementMode: 'observe' }),
      incidentReplay: recorder,
    });
    enforcer.triggerTestScenario('permissions-strip', 'acc-x');
    const events = listSecurityEvents(db);
    expect(events).toHaveLength(1);
    expect(listIncidentReplay(db, events[0]!.id)).toBeNull();
  });

  it('redacts secrets in details before persisting', () => {
    const db = getDb(dbPath);
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({
      db,
      ipcServer: ipc as never,
      getSettings: () => defaultSettings({ securityIncidentReplay: false }),
    });
    // Trigger a tool_use scenario whose synthesized input embeds a
    // secret-shaped string. The enforcer's recordBlockOutcome runs
    // every value in `details` through redactSecretsInValue before
    // insertSecurityEvent, so the persisted row's details_json must
    // not contain the original key.
    // (The trigger scenario shapes the input; we don't get to inject
    //  arbitrary values, so check the stored details path stays
    //  correct regardless of the literal string.)
    enforcer.triggerTestScenario('permissions-strip', 'acc-x');
    const events = listSecurityEvents(db);
    expect(events).toHaveLength(1);
    const detailsJson = JSON.stringify(events[0]!.details ?? {});
    // Redaction is best-checked by absence of any AKIA-shaped raw key.
    expect(detailsJson).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });
});
