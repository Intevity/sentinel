import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import {
  getDb,
  closeDb,
  insertSecurityEvent,
  walkChain,
  computePayloadHash,
  _setSweepActiveForTests,
  type InsertSecurityEvent,
} from './db.js';

const NEW_DB = () =>
  join(tmpdir(), `sentinel-tamper-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function ev(overrides: Partial<InsertSecurityEvent> = {}): InsertSecurityEvent {
  return {
    ts: Date.now(),
    accountId: 'acc-a',
    sessionId: null,
    direction: 'outbound',
    severity: 'medium',
    kind: 'secret',
    detectorId: 'aws',
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

describe('security_events append-only triggers', () => {
  let path: string;
  beforeEach(() => {
    path = NEW_DB();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(path)) unlinkSync(path);
  });

  it('rejects manual UPDATE to chain-protected `blocked` column', () => {
    const db = getDb(path);
    const { id } = insertSecurityEvent(db, ev());
    expect(() => {
      db.prepare('UPDATE security_events SET blocked = 1 WHERE id = ?').run(id);
    }).toThrowError(/append-only/);
  });

  it('rejects manual UPDATE to chain-protected `payload_hash` column', () => {
    const db = getDb(path);
    const { id } = insertSecurityEvent(db, ev());
    expect(() => {
      db.prepare('UPDATE security_events SET payload_hash = ? WHERE id = ?').run(
        'deadbeef'.repeat(8),
        id,
      );
    }).toThrowError(/append-only/);
  });

  it('allows UPDATE to free-mutable bookkeeping columns (acknowledged, occurrences, last_seen_ts)', () => {
    const db = getDb(path);
    const { id } = insertSecurityEvent(db, ev());
    expect(() => {
      db.prepare('UPDATE security_events SET acknowledged = 1 WHERE id = ?').run(id);
    }).not.toThrow();
    expect(() => {
      db.prepare('UPDATE security_events SET occurrences = 5, last_seen_ts = ? WHERE id = ?').run(
        Date.now(),
        id,
      );
    }).not.toThrow();
    const row = db
      .prepare('SELECT acknowledged, occurrences FROM security_events WHERE id = ?')
      .get(id) as { acknowledged: number; occurrences: number };
    expect(row).toEqual({ acknowledged: 1, occurrences: 5 });
  });

  it('rejects external UPDATE to `approved` (gate-protected, dedup uses sweep)', () => {
    const db = getDb(path);
    const { id } = insertSecurityEvent(db, ev());
    expect(() => {
      db.prepare('UPDATE security_events SET approved = 1 WHERE id = ?').run(id);
    }).toThrowError(/append-only/);
  });

  it('rejects manual DELETE without sweep token', () => {
    const db = getDb(path);
    const { id } = insertSecurityEvent(db, ev());
    expect(() => {
      db.prepare('DELETE FROM security_events WHERE id = ?').run(id);
    }).toThrowError(/retention sweep/);
  });

  it('walkChain detects external payload_hash tampering and returns the offending row id', () => {
    const db = getDb(path);
    const { id: id1 } = insertSecurityEvent(db, ev({ matchHash: 'm1' }));
    insertSecurityEvent(db, ev({ matchHash: 'm2' }));
    insertSecurityEvent(db, ev({ matchHash: 'm3' }));
    // Simulate external tamper by setting the sweep token (as an
    // attacker who got past the trigger one way or another would,
    // but a real attack would corrupt the file via sqlite3 CLI which
    // can't get the token because TEMP scope is per-connection — see
    // the trigger comment in db.ts for the threat model). Here we
    // need to UPDATE without the trigger, so we use the same escape
    // hatch retention uses, then put a bogus payload_hash on row 1.
    _setSweepActiveForTests(true);
    db.prepare('UPDATE security_events SET payload_hash = ? WHERE id = ?').run('a'.repeat(64), id1);
    _setSweepActiveForTests(false);
    const result = walkChain(db);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAtRowId).toBe(id1);
      expect(result.reason).toMatch(/payload_hash/);
    }
  });

  it('walkChain detects an orphaned prev_hash reference', () => {
    const db = getDb(path);
    insertSecurityEvent(db, ev({ matchHash: 'a' }));
    const { id: id2 } = insertSecurityEvent(db, ev({ matchHash: 'b' }));
    insertSecurityEvent(db, ev({ matchHash: 'c' }));
    // Simulate an external tamper that broke id2's prev_hash to a
    // value no chain element has. Because prev_hash + payload_hash
    // are both chain-protected, we use the sweep-token escape to
    // reach in, AND we recompute the matching payload_hash so the
    // per-row hash check passes — isolating the failure to the
    // orphan-reference branch.
    _setSweepActiveForTests(true);
    const row2 = db.prepare('SELECT * FROM security_events WHERE id = ?').get(id2) as Record<
      string,
      unknown
    >;
    const newPrev = 'f'.repeat(64);
    db.prepare('UPDATE security_events SET prev_hash = ? WHERE id = ?').run(newPrev, id2);
    const newPayload = computePayloadHash({
      ts: row2['ts'] as number,
      accountId: row2['account_id'] as string,
      sessionId: (row2['session_id'] as string | null) ?? null,
      direction: row2['direction'] as string,
      severity: row2['severity'] as string,
      kind: row2['kind'] as string,
      detectorId: row2['detector_id'] as string,
      confidence: row2['confidence'] as number,
      title: row2['title'] as string,
      reason: row2['reason'] as string,
      matchMask: (row2['match_mask'] as string | null) ?? null,
      matchHash: row2['match_hash'] as string,
      contextHash: (row2['context_hash'] as string | null) ?? null,
      snippet: (row2['snippet'] as string | null) ?? null,
      sourceHint: (row2['source_hint'] as string | null) ?? null,
      detailsJson: (row2['details_json'] as string | null) ?? null,
      provenance: row2['provenance'] as string,
      prevHash: newPrev,
    });
    db.prepare('UPDATE security_events SET payload_hash = ? WHERE id = ?').run(newPayload, id2);
    _setSweepActiveForTests(false);
    const result = walkChain(db);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The id3 row's prev_hash now points at id2's old payload_hash,
      // which is no longer in the chain — that's the orphan we detect.
      // (id2's own row passes the internal check because we
      // recomputed its payload_hash to match its new prev_hash.)
      expect(result.reason).toMatch(/prev_hash/);
    }
  });
});
