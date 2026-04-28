import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import {
  getDb,
  closeDb,
  insertSecurityEvent,
  listIncidentReplay,
  type InsertSecurityEvent,
} from '../db.js';
import { createIncidentReplayRecorder } from './incident-replay.js';

const NEW_DB = () =>
  join(tmpdir(), `sentinel-replay-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function ev(overrides: Partial<InsertSecurityEvent> = {}): InsertSecurityEvent {
  return {
    ts: Date.now(),
    accountId: 'acc-a',
    sessionId: null,
    direction: 'outbound',
    severity: 'medium',
    kind: 'secret',
    detectorId: 'd',
    confidence: 0.9,
    title: 't',
    reason: 'r',
    matchMask: null,
    matchHash: `m-${Math.random().toString(36).slice(2)}`,
    contextHash: null,
    snippet: null,
    sourceHint: null,
    details: null,
    blocked: false,
    provenance: 'file-read',
    ...overrides,
  };
}

describe('incident replay recorder', () => {
  let path: string;
  beforeEach(() => {
    path = NEW_DB();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(path)) unlinkSync(path);
  });

  it('recordSessionMessage is a no-op when sessionId is empty', () => {
    const db = getDb(NEW_DB());
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    recorder.recordSessionMessage('', { role: 'user', text: 'discarded' });
    expect(recorder._peek('')).toEqual([]);
  });

  it('redacts secrets at push time', () => {
    const db = getDb(path);
    const recorder = createIncidentReplayRecorder({
      db,
      // Identity-style redactor that uppercases inputs containing
      // "SECRET" — this lets us prove redact runs at push time
      // without depending on the real detector regexes.
      redact: (s) => s.replace(/SECRET-[A-Z0-9]+/g, '[REDACTED:secret]'),
    });
    recorder.recordSessionMessage('s1', { role: 'user', text: 'hello SECRET-ABC123 world' });
    const buf = recorder._peek('s1');
    expect(buf).toHaveLength(1);
    expect(buf[0]!.text).toBe('hello [REDACTED:secret] world');
  });

  it('caps the per-session buffer (FIFO)', () => {
    const db = getDb(path);
    const recorder = createIncidentReplayRecorder({
      db,
      redact: (s) => s,
      perSessionBufferSize: 3,
    });
    for (let i = 0; i < 5; i++) {
      recorder.recordSessionMessage('s1', { role: 'user', text: `msg-${i}` });
    }
    const buf = recorder._peek('s1');
    expect(buf).toHaveLength(3);
    expect(buf.map((m) => m.text)).toEqual(['msg-2', 'msg-3', 'msg-4']);
  });

  it('evicts the LRU session when maxSessions is exceeded', () => {
    const db = getDb(path);
    const recorder = createIncidentReplayRecorder({
      db,
      redact: (s) => s,
      maxSessions: 2,
    });
    recorder.recordSessionMessage('s1', { role: 'user', text: 'a' });
    recorder.recordSessionMessage('s2', { role: 'user', text: 'b' });
    recorder.recordSessionMessage('s3', { role: 'user', text: 'c' });
    expect(recorder._peek('s1')).toEqual([]);
    expect(recorder._peek('s2')).toHaveLength(1);
    expect(recorder._peek('s3')).toHaveLength(1);
  });

  it('captureForEvent writes the buffer into incident_replays keyed by event id', () => {
    const db = getDb(path);
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    recorder.recordSessionMessage('s1', { role: 'user', text: 'hello' });
    recorder.recordSessionMessage('s1', {
      role: 'tool_use',
      text: '{"command":"ls"}',
      tool: 'Bash',
    });
    const { id: eventId } = insertSecurityEvent(db, ev());
    recorder.captureForEvent('s1', eventId);
    const replay = listIncidentReplay(db, eventId);
    expect(replay).not.toBeNull();
    expect(replay!.eventId).toBe(eventId);
    expect(replay!.messages).toHaveLength(2);
    expect(replay!.messages[0]!.role).toBe('user');
    expect(replay!.messages[0]!.text).toBe('hello');
    expect(replay!.messages[1]!.role).toBe('tool_use');
    expect(replay!.messages[1]!.tool).toBe('Bash');
  });

  it('captureForEvent is a no-op when sessionId is null/empty', () => {
    const db = getDb(path);
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    const { id: eventId } = insertSecurityEvent(db, ev());
    recorder.captureForEvent(null, eventId);
    recorder.captureForEvent('', eventId);
    recorder.captureForEvent(undefined, eventId);
    expect(listIncidentReplay(db, eventId)).toBeNull();
  });

  it('captureForEvent is a no-op when buffer is empty', () => {
    const db = getDb(path);
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    const { id: eventId } = insertSecurityEvent(db, ev());
    recorder.captureForEvent('unknown-session', eventId);
    expect(listIncidentReplay(db, eventId)).toBeNull();
  });

  it('captureForEventByAccount uses the most-recently-recorded session for that account', () => {
    const db = getDb(path);
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    recorder.recordSessionMessage('sA', { role: 'user', text: 'first' }, 'acc-a');
    recorder.recordSessionMessage('sB', { role: 'user', text: 'newest' }, 'acc-a');
    expect(recorder._lastSessionFor('acc-a')).toBe('sB');
    const { id: eventId } = insertSecurityEvent(db, ev());
    recorder.captureForEventByAccount('acc-a', eventId);
    const replay = listIncidentReplay(db, eventId);
    expect(replay).not.toBeNull();
    expect(replay!.messages[0]!.text).toBe('newest');
  });

  it('captureForEventByAccount is a no-op for unknown accountId', () => {
    const db = getDb(path);
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    const { id: eventId } = insertSecurityEvent(db, ev());
    recorder.captureForEventByAccount('never-seen', eventId);
    expect(listIncidentReplay(db, eventId)).toBeNull();
  });

  it('_clear empties both per-session and per-account state', () => {
    const db = getDb(path);
    const recorder = createIncidentReplayRecorder({ db, redact: (s) => s });
    recorder.recordSessionMessage('s1', { role: 'user', text: 'x' }, 'acc-a');
    expect(recorder._peek('s1')).toHaveLength(1);
    expect(recorder._lastSessionFor('acc-a')).toBe('s1');
    recorder._clear();
    expect(recorder._peek('s1')).toEqual([]);
    expect(recorder._lastSessionFor('acc-a')).toBeNull();
  });
});
