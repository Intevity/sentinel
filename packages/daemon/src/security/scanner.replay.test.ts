import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import {
  closeDb,
  getDb,
  insertSecurityEvent,
  listIncidentReplay,
  type InsertSecurityEvent,
} from '../db.js';
import { createSecurityScanner } from './scanner.js';
import { createIncidentReplayRecorder } from './incident-replay.js';
import type { Settings } from '@claude-sentinel/shared';

const NEW_DB = () =>
  join(tmpdir(), `sentinel-replay-scanner-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function defaultSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    launchAtLogin: false,
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
    securityScanEnabled: true,
    securityEnforcementMode: 'block_high',
    securityScanSecrets: true,
    securityScanInjection: false,
    securityScanToolUse: true,
    securityOsNotifyThreshold: 'high',
    securityPersistSnippet: true,
    securityContextVerbosity: 'standard',
    securityEventRetentionDays: 30,
    securityApproveHoldSec: 60,
    detectorOverrides: {},
    toolPermissionsEnabled: false,
    toolPermissionDefaultAction: 'allow',
    toolPermissionSkipInAutoMode: false,
    toolPermissionAutoModeActive: false,
    denyPrivateNetworkByDefault: false,
    toolPermissionResolveSymlinks: false,
    securityOversizedThresholdMb: 4,
    securityScanOversizedSync: true,
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
    ...overrides,
  };
}

function ipcStub(): { broadcast: (m: unknown) => void; broadcasts: unknown[] } {
  const broadcasts: unknown[] = [];
  return { broadcast: (m) => broadcasts.push(m), broadcasts };
}

describe('scanner — Sprint 8 incident replay wiring', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = NEW_DB();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('feeds tool_use messages from the request body into the recorder when sessionId + setting are on', () => {
    const db = getDb(dbPath);
    const ipc = ipcStub();
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    const scanner = createSecurityScanner({
      db,
      ipcServer: ipc as never,
      getSettings: () => defaultSettings(),
      incidentReplay: recorder,
    });
    const body = Buffer.from(
      JSON.stringify({
        messages: [
          { role: 'user', content: 'hello world' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will run a command' },
              { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
            ],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', content: 'output of ls' }],
          },
        ],
      }),
    );
    scanner.scanOutbound(body, 'acc-a', 'sess-1');
    const buf = recorder._peek('sess-1');
    expect(buf.length).toBe(4);
    expect(buf[0]!.role).toBe('user');
    expect(buf[0]!.text).toBe('hello world');
    expect(buf[1]!.role).toBe('assistant');
    expect(buf[1]!.text).toBe('I will run a command');
    expect(buf[2]!.role).toBe('tool_use');
    expect(buf[2]!.tool).toBe('Bash');
    expect(buf[3]!.role).toBe('tool_result');
    expect(buf[3]!.text).toBe('output of ls');
    expect(recorder._lastSessionFor('acc-a')).toBe('sess-1');
  });

  it('does not record into the buffer when securityIncidentReplay is off', () => {
    const db = getDb(dbPath);
    const ipc = ipcStub();
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    const scanner = createSecurityScanner({
      db,
      ipcServer: ipc as never,
      getSettings: () => defaultSettings({ securityIncidentReplay: false }),
      incidentReplay: recorder,
    });
    const body = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }));
    scanner.scanOutbound(body, 'acc-a', 'sess-1');
    expect(recorder._peek('sess-1')).toEqual([]);
  });

  it('does not record into the buffer when sessionId is null/undefined', () => {
    const db = getDb(dbPath);
    const ipc = ipcStub();
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    const scanner = createSecurityScanner({
      db,
      ipcServer: ipc as never,
      getSettings: () => defaultSettings(),
      incidentReplay: recorder,
    });
    const body = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));
    scanner.scanOutbound(body, 'acc-a');
    expect(recorder._peek('sess-1')).toEqual([]);
  });

  it('handles edge-case message shapes (non-array messages, malformed entries, non-string tool_result content)', () => {
    const db = getDb(dbPath);
    const ipc = ipcStub();
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    const scanner = createSecurityScanner({
      db,
      ipcServer: ipc as never,
      getSettings: () => defaultSettings(),
      incidentReplay: recorder,
    });
    // (a) `messages` not an array — entire walk skipped.
    scanner.scanOutbound(Buffer.from(JSON.stringify({ messages: 'not an array' })), 'acc-a', 's1');
    expect(recorder._peek('s1')).toEqual([]);
    // (b) malformed entries inside `messages` are skipped, valid ones still recorded.
    // (c) tool_result whose content is an object (not a string) — exercises
    //     the JSON.stringify branch in recordRequestForReplay.
    scanner.scanOutbound(
      Buffer.from(
        JSON.stringify({
          messages: [
            null, // skipped
            { role: 42 }, // role not a string — skipped
            { role: 'user', content: ['only tool_use here', { type: 'tool_use', name: 'X' }] }, // first arr entry skipped (string in array, no type), second tool_use captured
            {
              role: 'user',
              content: [
                { type: 'tool_result', content: { stdout: 'hi', code: 0 } },
                { type: 'text', text: 'plain text' },
                { type: 'unknown_block_type', text: 'ignored' },
              ],
            },
          ],
        }),
      ),
      'acc-a',
      's2',
    );
    const buf = recorder._peek('s2');
    // Expected captures: tool_use X, tool_result (stringified), text 'plain text'
    expect(buf.map((m) => m.role)).toEqual(['tool_use', 'tool_result', 'user']);
    expect(buf[1]!.text).toContain('"stdout"');
  });

  it('captureForEventByAccount fires after a high-severity block and writes the replay row', () => {
    const db = getDb(dbPath);
    const ipc = ipcStub();
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    const scanner = createSecurityScanner({
      db,
      ipcServer: ipc as never,
      getSettings: () => defaultSettings(),
      incidentReplay: recorder,
    });
    // First pass populates the per-account session buffer.
    const benignBody = Buffer.from(
      JSON.stringify({ messages: [{ role: 'user', content: 'just a check' }] }),
    );
    scanner.scanOutbound(benignBody, 'acc-a', 'sess-1');
    expect(recorder._lastSessionFor('acc-a')).toBe('sess-1');
    // Now manually fire a high-severity event (skipping the live
    // detector path since detector outputs in a unit test are
    // brittle) — the recorder's captureForEventByAccount is what we
    // want to verify works after a fresh session has been recorded.
    const event: InsertSecurityEvent = {
      ts: Date.now(),
      accountId: 'acc-a',
      sessionId: null,
      direction: 'outbound',
      severity: 'high',
      kind: 'secret',
      detectorId: 'd',
      confidence: 0.95,
      title: 't',
      reason: 'r',
      matchMask: null,
      matchHash: 'h',
      contextHash: null,
      snippet: null,
      sourceHint: null,
      details: null,
      blocked: true,
      provenance: 'file-read',
    };
    const { id } = insertSecurityEvent(db, event);
    recorder.captureForEventByAccount('acc-a', id);
    const replay = listIncidentReplay(db, id);
    expect(replay).not.toBeNull();
    expect(replay!.messages[0]!.text).toBe('just a check');
  });

  it('end-to-end: scanOutbound triggers a real finding and the capture path runs through persistAndBroadcast', () => {
    const db = getDb(dbPath);
    const ipc = ipcStub();
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    const scanner = createSecurityScanner({
      db,
      ipcServer: ipc as never,
      // Replay enabled, block_medium_high so a medium finding still triggers capture.
      getSettings: () => defaultSettings({ securityEnforcementMode: 'block_medium_high' }),
      incidentReplay: recorder,
    });
    // Body containing a Read tool_use for a real-shaped AWS access key.
    // The detector treats this as a file-read finding (provenance:
    // 'file-read'), which clears the block-mode gate and exercises
    // persistAndBroadcast's capture branch.
    const body = Buffer.from(
      JSON.stringify({
        messages: [
          { role: 'user', content: 'recent context message' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                name: 'Read',
                input: { file_path: '/tmp/secrets.txt' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                content: 'AKIA2J47K9LM3PQR5XYZ',
              },
            ],
          },
        ],
      }),
    );
    const decision = scanner.scanOutbound(body, 'acc-a', 'sess-replay');
    // Force-hold: the block routes through a pending entry. Resolve
    // it (deny) so the finalize path runs persistAndBroadcast, which
    // is what writes the replay row.
    if (decision.action === 'pending') {
      scanner.resolvePending(decision.pendingId, 'deny');
    }
    // The buffer was populated by recordRequestForReplay and the
    // capture should have fired against the resulting event id.
    const events = ipc.broadcasts
      .map((m) => m as { type: string; eventId?: number })
      .filter((m) => m.type === 'security_event_detected' && m.eventId !== undefined);
    expect(events.length).toBeGreaterThan(0);
    const replay = listIncidentReplay(db, events[0]!.eventId!);
    expect(replay).not.toBeNull();
    expect(replay!.messages.length).toBeGreaterThan(0);
  });
});
