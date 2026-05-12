import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import {
  getDb,
  closeDb,
  insertSecurityEvent,
  purgeSecurityEventsOlderThan,
  walkChain,
  computePayloadHash,
  clearSecurityEvents,
  type InsertSecurityEvent,
} from './db.js';

const NEW_DB = () =>
  join(tmpdir(), `sentinel-chain-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function ev(overrides: Partial<InsertSecurityEvent> = {}): InsertSecurityEvent {
  return {
    ts: Date.now(),
    accountId: 'acc-a',
    sessionId: null,
    direction: 'outbound',
    severity: 'medium',
    kind: 'secret',
    detectorId: 'aws-access-key',
    confidence: 0.92,
    title: 't',
    reason: 'r',
    matchMask: 'AKIA[...]XYZ',
    matchHash: `m-${Math.random().toString(36).slice(2)}`,
    contextHash: 'c',
    snippet: '[REDACTED:secret]',
    sourceHint: 's',
    details: null,
    blocked: false,
    provenance: 'file-read',
    ...overrides,
  };
}

describe('security_events hash chain', () => {
  let path: string;
  beforeEach(() => {
    path = NEW_DB();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(path)) unlinkSync(path);
  });

  it('first insert seeds with empty prev_hash and a real payload_hash', () => {
    const db = getDb(path);
    const { id } = insertSecurityEvent(db, ev());
    const row = db
      .prepare('SELECT prev_hash, payload_hash FROM security_events WHERE id = ?')
      .get(id) as { prev_hash: string; payload_hash: string };
    expect(row.prev_hash).toBe('');
    expect(row.payload_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('each subsequent insert links prev_hash to the previous row payload_hash', () => {
    const db = getDb(path);
    const ids = [
      insertSecurityEvent(db, ev({ matchHash: 'm1' })).id,
      insertSecurityEvent(db, ev({ matchHash: 'm2' })).id,
      insertSecurityEvent(db, ev({ matchHash: 'm3' })).id,
    ];
    const rows = db
      .prepare(
        'SELECT id, prev_hash, payload_hash FROM security_events WHERE id IN (?, ?, ?) ORDER BY id ASC',
      )
      .all(ids[0], ids[1], ids[2]) as Array<{
      id: number;
      prev_hash: string;
      payload_hash: string;
    }>;
    expect(rows[0]!.prev_hash).toBe('');
    expect(rows[1]!.prev_hash).toBe(rows[0]!.payload_hash);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.payload_hash);
  });

  it('walkChain returns ok and the tip payload_hash matches the last insert', () => {
    const db = getDb(path);
    insertSecurityEvent(db, ev({ matchHash: 'a' }));
    insertSecurityEvent(db, ev({ matchHash: 'b' }));
    const last = insertSecurityEvent(db, ev({ matchHash: 'c' }));
    const tipPayload = (
      db.prepare('SELECT payload_hash FROM security_events WHERE id = ?').get(last.id) as {
        payload_hash: string;
      }
    ).payload_hash;
    const result = walkChain(db);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.eventCount).toBe(3);
      expect(result.summaryCount).toBe(0);
      expect(result.tipPayloadHash).toBe(tipPayload);
    }
  });

  it('dedup updates do not break the chain (mutable columns only)', () => {
    const db = getDb(path);
    const e = ev({ matchHash: 'dup-m' });
    const first = insertSecurityEvent(db, e);
    const second = insertSecurityEvent(db, e);
    expect(first.id).toBe(second.id); // dedup hit
    const result = walkChain(db);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.eventCount).toBe(1);
  });

  it('dedup propagates a fresh resolution onto a previously-unresolved row', () => {
    const db = getDb(path);
    // First insert is observe-only: no resolution, not blocked, not approved.
    const initial = insertSecurityEvent(db, ev({ matchHash: 'resolve-m' }));
    const before = db
      .prepare('SELECT approved, resolution FROM security_events WHERE id = ?')
      .get(initial.id) as { approved: number; resolution: string | null };
    expect(before.resolution).toBeNull();
    expect(before.approved).toBe(0);

    // Same match comes back through finalizePending('user_approve'): the
    // dedup branch must carry both `approved=1` and `resolution='user_approve'`.
    insertSecurityEvent(
      db,
      ev({ matchHash: 'resolve-m', approved: true, resolution: 'user_approve' }),
    );
    const after = db
      .prepare('SELECT approved, resolution FROM security_events WHERE id = ?')
      .get(initial.id) as { approved: number; resolution: string | null };
    expect(after.approved).toBe(1);
    expect(after.resolution).toBe('user_approve');
  });

  it('dedup keeps an existing resolution sticky against a later observe-only hit', () => {
    const db = getDb(path);
    // Start with an already-approved row.
    const first = insertSecurityEvent(
      db,
      ev({ matchHash: 'sticky-m', approved: true, resolution: 'user_approve' }),
    );
    // Later observe-only hit (no resolution, not approved) must not clear
    // the existing "Allowed by you" badge.
    insertSecurityEvent(db, ev({ matchHash: 'sticky-m' }));
    const row = db
      .prepare('SELECT approved, resolution FROM security_events WHERE id = ?')
      .get(first.id) as { approved: number; resolution: string | null };
    expect(row.approved).toBe(1);
    expect(row.resolution).toBe('user_approve');
  });

  it('retention sweep with one summary bridges the chain', () => {
    const db = getDb(path);
    const oldTs = Date.now() - 1_000_000;
    insertSecurityEvent(db, ev({ matchHash: 'old1', ts: oldTs }));
    insertSecurityEvent(db, ev({ matchHash: 'old2', ts: oldTs + 1 }));
    const survivor = insertSecurityEvent(db, ev({ matchHash: 'fresh' }));
    const cutoff = oldTs + 100;
    const purged = purgeSecurityEventsOlderThan(db, cutoff);
    expect(purged).toBe(2);
    const summary = db
      .prepare(
        'SELECT prev_hash, payload_hash, count, reason, deleted_hashes_json, last_payload_hash FROM security_events_daily_summary',
      )
      .get() as {
      prev_hash: string;
      payload_hash: string;
      count: number;
      reason: string;
      deleted_hashes_json: string;
      last_payload_hash: string;
    };
    expect(summary.count).toBe(2);
    expect(summary.reason).toBe('retention');
    const deletedHashes = JSON.parse(summary.deleted_hashes_json) as string[];
    expect(deletedHashes).toHaveLength(2);
    const survivorRow = db
      .prepare('SELECT prev_hash FROM security_events WHERE id = ?')
      .get(survivor.id) as { prev_hash: string };
    // Survivor's prev_hash still points at the most recently deleted
    // row's payload_hash (which is recorded in summary.last_payload_hash
    // and in deleted_hashes_json). The walker uses that lookup to
    // verify the linkage without needing to re-write any survivor row.
    expect(survivorRow.prev_hash).toBe(summary.last_payload_hash);
    expect(deletedHashes).toContain(survivorRow.prev_hash);
    const result = walkChain(db);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.eventCount).toBe(1);
      expect(result.summaryCount).toBe(1);
    }
  });

  it('a new insert after retention threads from the latest summary tip', () => {
    const db = getDb(path);
    insertSecurityEvent(db, ev({ matchHash: 'a', ts: 1000 }));
    insertSecurityEvent(db, ev({ matchHash: 'b', ts: 2000 }));
    purgeSecurityEventsOlderThan(db, 9999);
    expect(db.prepare('SELECT count(*) AS n FROM security_events').get()).toEqual({ n: 0 });
    const summary = db.prepare('SELECT payload_hash FROM security_events_daily_summary').get() as {
      payload_hash: string;
    };
    const fresh = insertSecurityEvent(db, ev({ matchHash: 'c', ts: Date.now() }));
    const freshRow = db
      .prepare('SELECT prev_hash FROM security_events WHERE id = ?')
      .get(fresh.id) as { prev_hash: string };
    expect(freshRow.prev_hash).toBe(summary.payload_hash);
    expect(walkChain(db).ok).toBe(true);
  });

  it('clearSecurityEvents writes a clear summary and the chain stays valid', () => {
    const db = getDb(path);
    insertSecurityEvent(db, ev({ matchHash: 'x' }));
    insertSecurityEvent(db, ev({ matchHash: 'y' }));
    const removed = clearSecurityEvents(db);
    expect(removed).toBe(2);
    const summary = db.prepare('SELECT reason, count FROM security_events_daily_summary').get() as {
      reason: string;
      count: number;
    };
    expect(summary.reason).toBe('clear_all');
    expect(summary.count).toBe(2);
    expect(walkChain(db).ok).toBe(true);
  });

  it('computePayloadHash is deterministic and order-independent', () => {
    const a = computePayloadHash({
      ts: 100,
      accountId: 'a',
      sessionId: null,
      direction: 'outbound',
      severity: 'medium',
      kind: 'secret',
      detectorId: 'd',
      confidence: 0.5,
      title: 't',
      reason: 'r',
      matchMask: null,
      matchHash: 'h',
      contextHash: null,
      snippet: null,
      sourceHint: null,
      detailsJson: null,
      provenance: 'file-read',
      prevHash: '',
    });
    const b = computePayloadHash({
      // same logical content, different field order in source code
      prevHash: '',
      provenance: 'file-read',
      detailsJson: null,
      sourceHint: null,
      snippet: null,
      contextHash: null,
      matchHash: 'h',
      matchMask: null,
      reason: 'r',
      title: 't',
      confidence: 0.5,
      detectorId: 'd',
      kind: 'secret',
      severity: 'medium',
      direction: 'outbound',
      sessionId: null,
      accountId: 'a',
      ts: 100,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Sanity: a different field flips the hash.
    const c = computePayloadHash({
      ts: 100,
      accountId: 'a',
      sessionId: null,
      direction: 'outbound',
      severity: 'medium',
      kind: 'secret',
      detectorId: 'd',
      confidence: 0.5,
      title: 't',
      reason: 'r',
      matchMask: null,
      matchHash: 'h',
      contextHash: null,
      snippet: null,
      sourceHint: null,
      detailsJson: null,
      provenance: 'tool-use', // <- changed (was file-read)
      prevHash: '',
    });
    expect(c).not.toBe(a);
    // Quick sanity-check vs raw sha256: any 64-char hex output of sha256.
    expect(createHash('sha256').update('anything').digest('hex')).toMatch(/^[0-9a-f]{64}$/);
  });
});
