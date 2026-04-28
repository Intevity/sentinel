import type Database from 'better-sqlite3';
import { insertIncidentReplay, type IncidentReplayMessage } from '../db.js';

/** Sprint 8 forensic incident replay: per-session ring buffer of recent
 *  tool-use messages. When a security event of severity ≥ medium fires
 *  under `block_high` / `block_medium_high` enforcement, the session's
 *  buffer is snapshotted into the `incident_replays` table keyed by
 *  event id. Buffer entries are redacted (via the caller-provided
 *  `redact` function) BEFORE storage, so a buffer leak via memory dump
 *  reveals only `[REDACTED:kind]` markers in place of secrets — same
 *  guarantee the persisted snapshot has.
 *
 *  The buffer is in-memory only. On daemon restart it is empty, which
 *  matches the user-visible behavior: the session that triggered the
 *  event is gone, so no surrounding context is recoverable. */
export interface ReplayMessageInput {
  /** 'user' | 'assistant' | 'tool_use' | 'tool_result' — opaque label
   *  for the UI; not parsed. */
  role: string;
  /** Free text. Will be passed through `redact` before being placed in
   *  the buffer. */
  text: string;
  /** When `role === 'tool_use'`, the tool name (e.g. 'Bash', 'Read').
   *  Stored alongside the text so the UI can render a tool badge. */
  tool?: string;
}

export interface IncidentReplayDeps {
  db: Database.Database;
  /** Redaction function. Sprint 8 wires `redactSecretsInString` from
   *  `detectors.ts`. Decoupled here so tests can inject an identity
   *  function and verify capture-time vs. push-time semantics. */
  redact: (text: string) => string;
  /** Tunable for tests. Production: 10. Lower numbers in tests let us
   *  exercise the eviction path without typing 11 messages. */
  perSessionBufferSize?: number;
  /** Max number of distinct session ids tracked. When the cap is
   *  reached, the oldest-touched session's buffer is evicted. Bounds
   *  memory at ~10 messages × 200 sessions ≈ 2k strings ≈ 200 KB. */
  maxSessions?: number;
}

export interface IncidentReplayRecorder {
  /** Push one redacted message into the session's ring buffer. The
   *  optional `accountId` lets us also remember "the most recent
   *  session id for this account" so a downstream scanner that only
   *  has the accountId can still trigger a capture against the most
   *  likely-relevant session. */
  recordSessionMessage(sessionId: string, msg: ReplayMessageInput, accountId?: string): void;
  /** Snapshot the session's current buffer into `incident_replays`.
   *  No-op if `sessionId` is null/empty or the buffer is empty. */
  captureForEvent(sessionId: string | null | undefined, eventId: number): void;
  /** Convenience for callers that only have the accountId in scope
   *  (the scanner's `persistAndBroadcast` is the canonical example —
   *  it doesn't see sessionInfo through its current API). Looks up
   *  the most-recently-recorded session for that account and calls
   *  `captureForEvent`. No-op if no session has been recorded for
   *  that account yet, or if its buffer is empty. */
  captureForEventByAccount(accountId: string, eventId: number): void;
  /** Test helper — current buffer for a session (or empty array). */
  _peek(sessionId: string): IncidentReplayMessage[];
  /** Test helper — last session id recorded for an account (or null). */
  _lastSessionFor(accountId: string): string | null;
  /** Test helper — drop all in-memory state. */
  _clear(): void;
}

export const DEFAULT_PER_SESSION_BUFFER_SIZE = 10;
export const DEFAULT_MAX_SESSIONS = 200;

export function createIncidentReplayRecorder(deps: IncidentReplayDeps): IncidentReplayRecorder {
  const perSessionCap = deps.perSessionBufferSize ?? DEFAULT_PER_SESSION_BUFFER_SIZE;
  const maxSessions = deps.maxSessions ?? DEFAULT_MAX_SESSIONS;
  // Map preserves insertion order; we use that as LRU. On every touch
  // (read or write of a session), we re-insert the entry so it moves
  // to the tail. Eviction removes the head.
  const buffers = new Map<string, IncidentReplayMessage[]>();
  // Per-account last-session cache. Updated on every recordSessionMessage
  // when the caller supplies an accountId. Used by
  // captureForEventByAccount so the scanner (which does not currently
  // have sessionInfo in its persistAndBroadcast API) can still trigger
  // a forensic capture against the most-likely-relevant session.
  const lastSessionByAccount = new Map<string, string>();

  const touch = (sessionId: string, buf: IncidentReplayMessage[]): void => {
    buffers.delete(sessionId);
    buffers.set(sessionId, buf);
    while (buffers.size > maxSessions) {
      const oldest = buffers.keys().next().value;
      // Defensive: a Map with size > maxSessions (>= 1) always has at
      // least one key, so the iterator's first value is never
      // undefined. The guard exists for type narrowing.
      /* v8 ignore next */
      if (oldest === undefined) break;
      buffers.delete(oldest);
    }
  };

  return {
    recordSessionMessage(sessionId, msg, accountId): void {
      if (!sessionId) return;
      const existing = buffers.get(sessionId) ?? [];
      const stored: IncidentReplayMessage = {
        ts: Date.now(),
        role: msg.role,
        text: deps.redact(msg.text),
      };
      if (msg.tool !== undefined) stored.tool = msg.tool;
      existing.push(stored);
      while (existing.length > perSessionCap) existing.shift();
      touch(sessionId, existing);
      if (accountId) lastSessionByAccount.set(accountId, sessionId);
    },
    captureForEvent(sessionId, eventId): void {
      if (!sessionId) return;
      const buf = buffers.get(sessionId);
      if (!buf || buf.length === 0) return;
      // Snapshot — copy to avoid the buffer mutating between the
      // serialize call and the SQL insert (theoretical with sync code,
      // but cheap to defend).
      const snapshot = buf.map((m) => ({ ...m }));
      insertIncidentReplay(deps.db, eventId, Date.now(), snapshot);
    },
    captureForEventByAccount(accountId, eventId): void {
      const sessionId = lastSessionByAccount.get(accountId);
      if (!sessionId) return;
      this.captureForEvent(sessionId, eventId);
    },
    _peek(sessionId): IncidentReplayMessage[] {
      return buffers.get(sessionId)?.slice() ?? [];
    },
    _lastSessionFor(accountId): string | null {
      return lastSessionByAccount.get(accountId) ?? null;
    },
    _clear(): void {
      buffers.clear();
      lastSessionByAccount.clear();
    },
  };
}
