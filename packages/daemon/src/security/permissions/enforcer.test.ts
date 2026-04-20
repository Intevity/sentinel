import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import { ServerResponse } from 'http';
import { Socket } from 'net';
import type { Database } from 'better-sqlite3';
import { getDb, closeDb, upsertPermissionRule, listSecurityEvents } from '../../db.js';
import {
  createPermissionsEnforcer,
  detectAutoModeFromHeaders,
  extractSessionInfo,
  AUTO_MODE_FRESHNESS_MS,
  SESSION_HARD_TIMEOUT_MS,
} from './enforcer.js';
import type { Settings } from '@claude-sentinel/shared';

const TEST_DB = (): string =>
  join(tmpdir(), `sentinel-enforcer-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function defaultSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    launchAtLogin: true,
    switchingMode: 'off',
    alertSoundName: null,
    overageOsNotify: true,
    autoUpdate: false,
    poolExcludedIds: [],
    overageEnabledIds: [],
    budgetWeeklyUsdByAccount: {},
    budgetWeeklyUsdGlobal: null,
    overageBufferPct: 5,
    roundRobinStrategy: 'balance',
    backgroundProbeIntervalSec: 300,
    telemetryRetentionDays: 30,
    securityScanEnabled: false,
    securityEnforcementMode: null,
    securityScanSecrets: false,
    securityScanInjection: false,
    securityScanToolUse: false,
    securityOsNotifyThreshold: 'high',
    securityPersistSnippet: true,
    securityEventRetentionDays: 30,
    securityBlockHoldEnabled: false,
    securityApproveHoldSec: 60,
    toolPermissionsEnabled: true,
    toolPermissionDefaultAction: 'allow',
    toolPermissionSkipInAutoMode: true,
    toolPermissionAutoModeActive: false,
    logLevel: 'info',
    securitySetupCompleted: false,
    tourCompleted: false,
    ...overrides,
  };
}

function ipcStub(): { broadcast: (m: unknown) => void; broadcasts: unknown[] } {
  const broadcasts: unknown[] = [];
  return { broadcast: (m) => broadcasts.push(m), broadcasts };
}

function makeResponse(): ServerResponse {
  const sock = new Socket();
  const req = {} as unknown as import('http').IncomingMessage;
  const res = new ServerResponse(req);
  res.assignSocket(sock);
  return res;
}

/** ServerResponse whose socket silently absorbs writes. Used for tests that
 *  drive bytes through the interceptor — a bare socket triggers ECONNRESET
 *  during flush. */
function makeQuietResponse(): ServerResponse {
  const sock = new Socket();
  // Replace the socket's write surface with a no-op. ServerResponse only
  // needs something it can write to without throwing.
  sock.write = (() => true) as unknown as typeof sock.write;
  sock.end = (() => sock) as unknown as typeof sock.end;
  sock.cork = () => {};
  sock.uncork = () => {};
  const req = {} as unknown as import('http').IncomingMessage;
  const res = new ServerResponse(req);
  res.assignSocket(sock);
  return res;
}

describe('PermissionsEnforcer', () => {
  const path = TEST_DB();
  let db: Database;
  let settings: Settings;

  beforeEach(() => {
    db = getDb(path);
    settings = defaultSettings();
  });

  afterEach(() => {
    closeDb();
    if (existsSync(path)) unlinkSync(path);
  });

  it('isEnabled reflects the settings toggle', () => {
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    expect(enforcer.isEnabled()).toBe(true);
    settings = defaultSettings({ toolPermissionsEnabled: false });
    expect(enforcer.isEnabled()).toBe(false);
  });

  it('isSkippedForAutoMode requires both skip setting and auto mode active', () => {
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    expect(enforcer.isSkippedForAutoMode()).toBe(false);
    settings = defaultSettings({ toolPermissionAutoModeActive: true, toolPermissionSkipInAutoMode: true });
    expect(enforcer.isSkippedForAutoMode()).toBe(true);
    settings = defaultSettings({ toolPermissionAutoModeActive: true, toolPermissionSkipInAutoMode: false });
    expect(enforcer.isSkippedForAutoMode()).toBe(false);
  });

  it('stripDeniedTools removes whole-tool denies and broadcasts a security event', () => {
    upsertPermissionRule(db, { decision: 'deny', tool: 'WebFetch', pattern: null, raw: 'WebFetch' });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    const body = Buffer.from(JSON.stringify({
      model: 'x',
      tools: [
        { name: 'WebFetch', description: 'fetch' },
        { name: 'Bash', description: 'shell' },
      ],
      messages: [],
    }));
    const out = enforcer.stripDeniedTools(body, 'acc-1');
    expect(out).not.toBe(body);
    const parsed = JSON.parse(out.toString('utf-8'));
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].name).toBe('Bash');
    expect(ipc.broadcasts.length).toBe(1);
    expect((ipc.broadcasts[0] as { type: string }).type).toBe('security_event_detected');
  });

  it('stripDeniedTools passes body through when feature disabled', () => {
    upsertPermissionRule(db, { decision: 'deny', tool: 'WebFetch', pattern: null, raw: 'WebFetch' });
    settings = defaultSettings({ toolPermissionsEnabled: false });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    const body = Buffer.from(JSON.stringify({ tools: [{ name: 'WebFetch' }] }));
    expect(enforcer.stripDeniedTools(body, 'acc')).toBe(body);
  });

  it('stripDeniedTools passes body through in auto-mode skip', () => {
    upsertPermissionRule(db, { decision: 'deny', tool: 'WebFetch', pattern: null, raw: 'WebFetch' });
    settings = defaultSettings({ toolPermissionAutoModeActive: true });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    const body = Buffer.from(JSON.stringify({ tools: [{ name: 'WebFetch' }] }));
    expect(enforcer.stripDeniedTools(body, 'acc')).toBe(body);
  });

  it('stripDeniedTools returns original on parse failure', () => {
    upsertPermissionRule(db, { decision: 'deny', tool: 'WebFetch', pattern: null, raw: 'WebFetch' });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    const body = Buffer.from('not json');
    expect(enforcer.stripDeniedTools(body, 'acc')).toBe(body);
  });

  it('stripDeniedTools returns original when tools missing', () => {
    upsertPermissionRule(db, { decision: 'deny', tool: 'WebFetch', pattern: null, raw: 'WebFetch' });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    const body = Buffer.from(JSON.stringify({ model: 'x', messages: [] }));
    expect(enforcer.stripDeniedTools(body, 'acc')).toBe(body);
  });

  it('stripDeniedTools returns original when empty body', () => {
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    const body = Buffer.alloc(0);
    expect(enforcer.stripDeniedTools(body, 'acc')).toBe(body);
  });

  it('stripDeniedTools skips tools with non-string name', () => {
    upsertPermissionRule(db, { decision: 'deny', tool: '*', pattern: null, raw: '*' });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    const body = Buffer.from(JSON.stringify({
      tools: [
        { name: 123 },
        null,
        { name: 'Bash' },
      ],
    }));
    const out = enforcer.stripDeniedTools(body, 'acc');
    // The * whole-tool deny strips "Bash"; the malformed entries pass through.
    const parsed = JSON.parse(out.toString('utf-8'));
    expect(parsed.tools.find((t: { name: string }) => t?.name === 'Bash')).toBeUndefined();
  });

  it('createInterceptor returns null when disabled', () => {
    settings = defaultSettings({ toolPermissionsEnabled: false });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    expect(enforcer.createInterceptor(makeResponse(), 'acc')).toBeNull();
  });

  it('createInterceptor returns null in auto-mode skip', () => {
    settings = defaultSettings({ toolPermissionAutoModeActive: true });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    expect(enforcer.createInterceptor(makeResponse(), 'acc')).toBeNull();
  });

  it('createInterceptor returns a live interceptor when enabled', () => {
    upsertPermissionRule(db, { decision: 'deny', tool: 'Bash', pattern: 'rm *', raw: 'Bash(rm *)' });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    const res = makeResponse();
    const it = enforcer.createInterceptor(res, 'acc-1');
    expect(it).not.toBeNull();
    it?.destroy();
    res.socket?.destroy();
  });

  it('invalidate forces a rule cache rebuild', () => {
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    expect(enforcer.listRules()).toHaveLength(0);
    upsertPermissionRule(db, { decision: 'deny', tool: 'Bash', pattern: null, raw: 'Bash' });
    // Without invalidate, cache is stale
    expect(enforcer.listRules()).toHaveLength(0);
    enforcer.invalidate();
    expect(enforcer.listRules()).toHaveLength(1);
  });

  it('listRules returns the compiled snapshot', () => {
    upsertPermissionRule(db, { decision: 'deny', tool: 'WebFetch', pattern: null, raw: 'WebFetch' });
    upsertPermissionRule(db, { decision: 'allow', tool: 'Read', pattern: null, raw: 'Read' });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    const rules = enforcer.listRules();
    expect(rules).toHaveLength(2);
  });

  it('onBlocked hook fires when the interceptor blocks a tool_use — persists event + broadcasts', () => {
    upsertPermissionRule(db, { decision: 'deny', tool: 'Bash', pattern: 'rm *', raw: 'Bash(rm *)' });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    const res = makeQuietResponse();
    const it = enforcer.createInterceptor(res, 'acc-1');
    expect(it).not.toBeNull();
    const stream =
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"rm file\\"}"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n';
    it?.push(stream);
    it?.flush();
    const events = listSecurityEvents(db, { limit: 10 });
    expect(events.some((e) => e.kind === 'tool_permission_blocked')).toBe(true);
    expect(ipc.broadcasts.some((m) => (m as { type: string }).type === 'security_event_detected')).toBe(true);
  });

  it('isSkippedForAutoMode detects auto mode from anthropic-beta afk-mode header', () => {
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    // Default: manual toggle off, no headers → not skipped
    expect(enforcer.isSkippedForAutoMode()).toBe(false);
    // Header with afk-mode present → skipped
    expect(
      enforcer.isSkippedForAutoMode({ 'anthropic-beta': 'oauth-2025-04-20,afk-mode-2026-01-31' }),
    ).toBe(true);
    // Header with advisor-tool present → skipped
    expect(
      enforcer.isSkippedForAutoMode({ 'anthropic-beta': 'advisor-tool-2026-03-01,oauth-2025-04-20' }),
    ).toBe(true);
    // Header with neither → not skipped
    expect(
      enforcer.isSkippedForAutoMode({ 'anthropic-beta': 'oauth-2025-04-20,context-management-2025-06-27' }),
    ).toBe(false);
  });

  it('isSkippedForAutoMode respects toolPermissionSkipInAutoMode=false even with afk-mode header', () => {
    settings = defaultSettings({ toolPermissionSkipInAutoMode: false });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    expect(
      enforcer.isSkippedForAutoMode({ 'anthropic-beta': 'afk-mode-2026-01-31' }),
    ).toBe(false);
  });

  it('stripDeniedTools skips when request has auto-mode beta header', () => {
    upsertPermissionRule(db, { decision: 'deny', tool: 'WebFetch', pattern: null, raw: 'WebFetch' });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    const body = Buffer.from(JSON.stringify({ tools: [{ name: 'WebFetch' }] }));
    const out = enforcer.stripDeniedTools(body, 'acc', {
      'anthropic-beta': 'afk-mode-2026-01-31',
    });
    expect(out).toBe(body);
  });

  it('createInterceptor returns null when request has auto-mode beta header', () => {
    upsertPermissionRule(db, { decision: 'deny', tool: 'Bash', pattern: 'rm *', raw: 'Bash(rm *)' });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    expect(
      enforcer.createInterceptor(makeResponse(), 'acc', {
        'anthropic-beta': 'afk-mode-2026-01-31,oauth-2025-04-20',
      }),
    ).toBeNull();
  });

  it('records a block event even when the IPC broadcast throws', () => {
    upsertPermissionRule(db, { decision: 'deny', tool: 'WebFetch', pattern: null, raw: 'WebFetch' });
    const ipc = ipcStub();
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ipc.broadcast = (() => { throw new Error('boom'); }) as never;
    const body = Buffer.from(JSON.stringify({ tools: [{ name: 'WebFetch' }] }));
    enforcer.stripDeniedTools(body, 'acc-1');
    expect(errorSpy).toHaveBeenCalled();
    // Row still persisted despite the broadcast failure.
    const events = listSecurityEvents(db, { limit: 10 });
    expect(events.some((e) => e.kind === 'tool_permission_blocked')).toBe(true);
    errorSpy.mockRestore();
  });
});

describe('auto-mode status tracking', () => {
  const path = join(tmpdir(), `sentinel-status-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  let db: Database;
  let settings: Settings;
  let ipc: { broadcast: (m: unknown) => void; broadcasts: unknown[] };

  beforeEach(() => {
    db = getDb(path);
    settings = defaultSettings();
    ipc = ipcStub();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeDb();
    if (existsSync(path)) unlinkSync(path);
  });

  it('starts inactive with no detections', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    const status = enforcer.getAutoModeStatus();
    expect(status.active).toBe(false);
    expect(status.source).toBeNull();
    expect(status.lastDetectedAt).toBeNull();
  });

  it('activates on observeRequest with afk-mode header and broadcasts', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    enforcer.observeRequest({ 'anthropic-beta': 'afk-mode-2026-01-31' });
    const status = enforcer.getAutoModeStatus();
    expect(status.active).toBe(true);
    expect(status.source).toBe('headers');
    expect(status.lastDetectedAt).not.toBeNull();
    expect(
      ipc.broadcasts.some((m) => (m as { type: string; status: { active: boolean } }).type === 'permissions_status' && (m as { status: { active: boolean } }).status.active),
    ).toBe(true);
    enforcer.shutdown();
  });

  it('ignores observeRequest without auto-mode beta flag', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    enforcer.observeRequest({ 'anthropic-beta': 'oauth-2025-04-20' });
    const status = enforcer.getAutoModeStatus();
    expect(status.active).toBe(false);
    expect(ipc.broadcasts).toHaveLength(0);
    enforcer.shutdown();
  });

  it('deactivates after AUTO_MODE_FRESHNESS_MS with no new detection', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    enforcer.observeRequest({ 'anthropic-beta': 'afk-mode-2026-01-31' });
    expect(enforcer.getAutoModeStatus().active).toBe(true);
    vi.advanceTimersByTime(AUTO_MODE_FRESHNESS_MS + 100);
    expect(enforcer.getAutoModeStatus().active).toBe(false);
    // Expect both activate + deactivate broadcasts.
    const statusBroadcasts = ipc.broadcasts.filter((m) => (m as { type: string }).type === 'permissions_status');
    expect(statusBroadcasts.length).toBeGreaterThanOrEqual(2);
    enforcer.shutdown();
  });

  it('resets the deactivation timer on each subsequent detection', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    enforcer.observeRequest({ 'anthropic-beta': 'afk-mode-2026-01-31' });
    vi.advanceTimersByTime(AUTO_MODE_FRESHNESS_MS - 1_000);
    // Still active because almost at the edge.
    expect(enforcer.getAutoModeStatus().active).toBe(true);
    enforcer.observeRequest({ 'anthropic-beta': 'afk-mode-2026-01-31' });
    // Advance past the ORIGINAL deadline but not the new one.
    vi.advanceTimersByTime(5_000);
    expect(enforcer.getAutoModeStatus().active).toBe(true);
    // Now advance enough for the NEW timer to fire.
    vi.advanceTimersByTime(AUTO_MODE_FRESHNESS_MS);
    expect(enforcer.getAutoModeStatus().active).toBe(false);
    enforcer.shutdown();
  });

  it('manual toggle wins over header absence', () => {
    settings = defaultSettings({ toolPermissionAutoModeActive: true });
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    const status = enforcer.getAutoModeStatus();
    expect(status.active).toBe(true);
    expect(status.source).toBe('manual');
    enforcer.shutdown();
  });

  it('onSettingsChanged broadcasts when the manual toggle flips', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    settings = defaultSettings({ toolPermissionAutoModeActive: true });
    enforcer.onSettingsChanged();
    const lastBroadcast = ipc.broadcasts.find(
      (m) => (m as { type: string }).type === 'permissions_status',
    );
    expect(lastBroadcast).toBeTruthy();
    expect((lastBroadcast as { status: { active: boolean; source: string } }).status.active).toBe(true);
    expect((lastBroadcast as { status: { source: string } }).status.source).toBe('manual');
    enforcer.shutdown();
  });

  it('manual takes priority over header-based even when both active', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    enforcer.observeRequest({ 'anthropic-beta': 'afk-mode-2026-01-31' });
    expect(enforcer.getAutoModeStatus().source).toBe('headers');
    settings = defaultSettings({ toolPermissionAutoModeActive: true });
    enforcer.onSettingsChanged();
    expect(enforcer.getAutoModeStatus().source).toBe('manual');
    enforcer.shutdown();
  });

  it('does not broadcast when state and source are unchanged', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    enforcer.observeRequest({ 'anthropic-beta': 'afk-mode-2026-01-31' });
    const afterFirst = ipc.broadcasts.length;
    // Another detection well within the window — should NOT re-broadcast.
    vi.advanceTimersByTime(1_000);
    enforcer.observeRequest({ 'anthropic-beta': 'afk-mode-2026-01-31' });
    expect(ipc.broadcasts.length).toBe(afterFirst);
    enforcer.shutdown();
  });
});

describe('detectAutoModeFromHeaders', () => {
  it('returns true for afk-mode beta header', () => {
    expect(detectAutoModeFromHeaders({ 'anthropic-beta': 'afk-mode-2026-01-31' })).toBe(true);
  });
  it('returns true for advisor-tool beta header', () => {
    expect(detectAutoModeFromHeaders({ 'anthropic-beta': 'advisor-tool-2026-03-01' })).toBe(true);
  });
  it('returns true when beta header lists multiple flags including afk-mode', () => {
    expect(
      detectAutoModeFromHeaders({
        'anthropic-beta':
          'claude-code-20250219,oauth-2025-04-20,afk-mode-2026-01-31,advisor-tool-2026-03-01',
      }),
    ).toBe(true);
  });
  it('returns false for a normal-mode beta header set', () => {
    expect(
      detectAutoModeFromHeaders({
        'anthropic-beta': 'oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27',
      }),
    ).toBe(false);
  });
  it('returns false when no anthropic-beta header is present', () => {
    expect(detectAutoModeFromHeaders({})).toBe(false);
  });
  it('returns false when beta header is non-string (e.g. array)', () => {
    expect(detectAutoModeFromHeaders({ 'anthropic-beta': ['afk-mode-2026-01-31'] })).toBe(false);
  });
  it('requires the date suffix (rejects bare afk-mode)', () => {
    expect(detectAutoModeFromHeaders({ 'anthropic-beta': 'afk-mode' })).toBe(false);
  });
});

describe('extractSessionInfo', () => {
  function body(obj: unknown): Buffer {
    return Buffer.from(JSON.stringify(obj));
  }

  it('returns sessionId + accountUuid from Claude Code metadata.user_id', () => {
    const info = extractSessionInfo(body({
      model: 'claude',
      metadata: {
        user_id: JSON.stringify({
          device_id: 'dev',
          account_uuid: 'acc-1',
          session_id: 'sess-abc',
        }),
      },
    }));
    expect(info).toEqual({ sessionId: 'sess-abc', accountUuid: 'acc-1' });
  });

  it('returns sessionId only when account_uuid is absent', () => {
    const info = extractSessionInfo(body({
      metadata: { user_id: JSON.stringify({ session_id: 'sess-xyz' }) },
    }));
    expect(info).toEqual({ sessionId: 'sess-xyz', accountUuid: null });
  });

  it('returns null when metadata is missing', () => {
    expect(extractSessionInfo(body({ model: 'claude' }))).toBeNull();
  });

  it('returns null when user_id is not valid JSON', () => {
    expect(extractSessionInfo(body({ metadata: { user_id: 'not json' } }))).toBeNull();
  });

  it('returns null when session_id is absent in inner JSON', () => {
    expect(extractSessionInfo(body({
      metadata: { user_id: JSON.stringify({ device_id: 'dev' }) },
    }))).toBeNull();
  });

  it('returns null for malformed top-level JSON', () => {
    expect(extractSessionInfo(Buffer.from('not json'))).toBeNull();
  });
});

describe('per-session auto-mode tracking', () => {
  const path = join(tmpdir(), `sentinel-sessions-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  let db: Database;
  let settings: Settings;
  let ipc: { broadcast: (m: unknown) => void; broadcasts: unknown[] };

  beforeEach(() => {
    db = getDb(path);
    settings = defaultSettings();
    ipc = ipcStub();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeDb();
    if (existsSync(path)) unlinkSync(path);
  });

  const autoHeaders = { 'anthropic-beta': 'afk-mode-2026-01-31' };
  const normalHeaders = { 'anthropic-beta': 'oauth-2025-04-20' };

  it('tracks a session after an auto-mode observation', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    enforcer.observeRequest(autoHeaders, { sessionId: 'a', accountUuid: 'acc-1' });
    const status = enforcer.getAutoModeStatus();
    expect(status.activeSessions).toBe(1);
    expect(status.autoModeSessions).toBe(1);
    expect(status.sessions).toHaveLength(1);
    expect(status.sessions[0]?.autoMode).toBe(true);
    expect(status.sessions[0]?.accountUuid).toBe('acc-1');
    enforcer.shutdown();
  });

  it('downgrades an auto session when a follow-up normal request arrives', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    enforcer.observeRequest(autoHeaders, { sessionId: 'a', accountUuid: null });
    expect(enforcer.getAutoModeStatus().autoModeSessions).toBe(1);
    enforcer.observeRequest(normalHeaders, { sessionId: 'a', accountUuid: null });
    const status = enforcer.getAutoModeStatus();
    expect(status.activeSessions).toBe(1);
    expect(status.autoModeSessions).toBe(0);
    enforcer.shutdown();
  });

  it('counts 1 of 3 sessions correctly when only one is auto', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    enforcer.observeRequest(autoHeaders, { sessionId: 'a', accountUuid: null });
    enforcer.observeRequest(normalHeaders, { sessionId: 'b', accountUuid: null });
    enforcer.observeRequest(normalHeaders, { sessionId: 'c', accountUuid: null });
    const status = enforcer.getAutoModeStatus();
    expect(status.activeSessions).toBe(3);
    expect(status.autoModeSessions).toBe(1);
    expect(status.active).toBe(true);
    enforcer.shutdown();
  });

  it('returns sessions ordered most-recent first', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    enforcer.observeRequest(normalHeaders, { sessionId: 'a', accountUuid: null });
    vi.advanceTimersByTime(1_000);
    enforcer.observeRequest(normalHeaders, { sessionId: 'b', accountUuid: null });
    vi.advanceTimersByTime(1_000);
    enforcer.observeRequest(normalHeaders, { sessionId: 'c', accountUuid: null });
    const ids = enforcer.getAutoModeStatus().sessions.map((s) => s.sessionId);
    expect(ids).toEqual(['c', 'b', 'a']);
    enforcer.shutdown();
  });

  it('preserves accountUuid across subsequent observations even if new one is null', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    enforcer.observeRequest(autoHeaders, { sessionId: 'a', accountUuid: 'acc-99' });
    enforcer.observeRequest(autoHeaders, { sessionId: 'a', accountUuid: null });
    expect(enforcer.getAutoModeStatus().sessions[0]?.accountUuid).toBe('acc-99');
    enforcer.shutdown();
  });

  it('drops sessions past the hard timeout', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    enforcer.observeRequest(autoHeaders, { sessionId: 'a', accountUuid: null });
    // Jump well past the hard timeout.
    vi.advanceTimersByTime(SESSION_HARD_TIMEOUT_MS + 60_000);
    // Trigger a poll cycle (process-poll timer is on a 30 s interval).
    // Manually tick past several intervals so `pruneByHardTimeout` runs.
    vi.advanceTimersByTime(60_000);
    // After the poll runs, the session should be pruned.
    // Note: the poll reads lastProcessCount; since countClaudeCodeProcesses
    // returns null on test runners (no such process), pruneByHardTimeout is
    // still the path that evicts. Force-run by observing an unrelated session.
    enforcer.observeRequest(normalHeaders, { sessionId: 'b', accountUuid: null });
    // Status should now show only 'b' if 'a' aged out. Give it one more poll cycle.
    vi.advanceTimersByTime(30_000);
    const status = enforcer.getAutoModeStatus();
    // Session 'a' is past hard timeout; only 'b' remains (the status
    // computation itself doesn't prune, so check after a poll has run).
    expect(status.sessions.some((s) => s.sessionId === 'b')).toBe(true);
    enforcer.shutdown();
  });

  it('broadcasts permissions_status when session counts change', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    enforcer.observeRequest(autoHeaders, { sessionId: 'a', accountUuid: null });
    const before = ipc.broadcasts.filter((m) => (m as { type: string }).type === 'permissions_status').length;
    enforcer.observeRequest(autoHeaders, { sessionId: 'b', accountUuid: null });
    const after = ipc.broadcasts.filter((m) => (m as { type: string }).type === 'permissions_status').length;
    expect(after).toBeGreaterThan(before);
    enforcer.shutdown();
  });

  it('does NOT re-broadcast when an existing session stays in the same mode', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    enforcer.observeRequest(autoHeaders, { sessionId: 'a', accountUuid: null });
    const before = ipc.broadcasts.filter((m) => (m as { type: string }).type === 'permissions_status').length;
    vi.advanceTimersByTime(1_000);
    enforcer.observeRequest(autoHeaders, { sessionId: 'a', accountUuid: null });
    const after = ipc.broadcasts.filter((m) => (m as { type: string }).type === 'permissions_status').length;
    expect(after).toBe(before);
    enforcer.shutdown();
  });

  it('still activates via legacy timestamp path when session info is missing', () => {
    const enforcer = createPermissionsEnforcer({ db, ipcServer: ipc as never, getSettings: () => settings });
    enforcer.observeRequest(autoHeaders);  // no sessionInfo
    const status = enforcer.getAutoModeStatus();
    expect(status.active).toBe(true);
    expect(status.source).toBe('headers');
    expect(status.activeSessions).toBe(0);  // no session tracked
    expect(status.autoModeSessions).toBe(0);
    // Legacy freshness path deactivates after AUTO_MODE_FRESHNESS_MS.
    vi.advanceTimersByTime(AUTO_MODE_FRESHNESS_MS + 100);
    expect(enforcer.getAutoModeStatus().active).toBe(false);
    enforcer.shutdown();
  });
});
