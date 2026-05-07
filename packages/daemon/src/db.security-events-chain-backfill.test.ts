import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  join(tmpdir(), `sentinel-backfill-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

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

/**
 * Seed N rows with valid hashes via the proper insert path, then reach in
 * with the test sweep-gate escape hatch and zero out the chain columns.
 * This simulates the production state of rows that pre-dated the
 * `security_events_chain_v1` ALTER (which added the columns with `DEFAULT
 * ''` but did not backfill historical rows). Also clears the
 * `security_events_chain_backfill_v1` marker so the next `getDb()` open
 * actually runs the backfill block instead of short-circuiting.
 */
function seedLegacyChainState(
  path: string,
  count: number,
  baseTs: number = Date.now() - 1_000_000,
): void {
  const db = getDb(path);
  for (let i = 0; i < count; i++) {
    insertSecurityEvent(db, ev({ matchHash: `legacy-${i}`, ts: baseTs + i }));
  }
  _setSweepActiveForTests(true);
  db.prepare("UPDATE security_events SET prev_hash = '', payload_hash = ''").run();
  _setSweepActiveForTests(false);
  db.prepare("DELETE FROM _migrations WHERE name = 'security_events_chain_backfill_v1'").run();
  closeDb();
}

describe('security_events_chain_backfill_v1 migration', () => {
  let path: string;
  beforeEach(() => {
    path = NEW_DB();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(path)) unlinkSync(path);
  });

  it('rehydrates pre-chain rows: row 1 has empty prev_hash, each subsequent links to the prior payload_hash', () => {
    seedLegacyChainState(path, 5);
    const db = getDb(path);
    const rows = db
      .prepare('SELECT id, prev_hash, payload_hash FROM security_events ORDER BY id ASC')
      .all() as Array<{ id: number; prev_hash: string; payload_hash: string }>;
    expect(rows).toHaveLength(5);
    expect(rows[0]!.prev_hash).toBe('');
    expect(rows[0]!.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.payload_hash);
      expect(rows[i]!.payload_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[i]!.payload_hash).not.toBe(rows[i - 1]!.payload_hash);
    }
    const result = walkChain(db);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.eventCount).toBe(5);
      expect(result.tipPayloadHash).toBe(rows[4]!.payload_hash);
    }
    const marker = db
      .prepare("SELECT 1 AS ok FROM _migrations WHERE name = 'security_events_chain_backfill_v1'")
      .get() as { ok: number } | undefined;
    expect(marker?.ok).toBe(1);
  });

  it('is idempotent: a second open does not rewrite already-backfilled hashes', () => {
    seedLegacyChainState(path, 3);
    const first = getDb(path);
    const before = first
      .prepare('SELECT id, prev_hash, payload_hash FROM security_events ORDER BY id ASC')
      .all() as Array<{ id: number; prev_hash: string; payload_hash: string }>;
    closeDb();

    const second = getDb(path);
    const after = second
      .prepare('SELECT id, prev_hash, payload_hash FROM security_events ORDER BY id ASC')
      .all() as Array<{ id: number; prev_hash: string; payload_hash: string }>;
    expect(after).toEqual(before);
    expect(walkChain(second).ok).toBe(true);
  });

  it('preserves post-chain rows byte-identical and only touches empty-hash rows', () => {
    // Seed via the proper insert path so all rows have valid hashes,
    // then zero out only the first 3 to simulate a partial pre-chain era.
    const db = getDb(path);
    const baseTs = Date.now() - 1_000_000;
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { id } = insertSecurityEvent(db, ev({ matchHash: `mix-${i}`, ts: baseTs + i }));
      ids.push(id);
    }
    _setSweepActiveForTests(true);
    db.prepare(
      "UPDATE security_events SET prev_hash = '', payload_hash = '' WHERE id IN (?, ?, ?)",
    ).run(ids[0], ids[1], ids[2]);
    _setSweepActiveForTests(false);
    const postChainBefore = db
      .prepare(
        'SELECT id, prev_hash, payload_hash FROM security_events WHERE id IN (?, ?) ORDER BY id ASC',
      )
      .all(ids[3], ids[4]) as Array<{ id: number; prev_hash: string; payload_hash: string }>;
    db.prepare("DELETE FROM _migrations WHERE name = 'security_events_chain_backfill_v1'").run();
    closeDb();

    const reopened = getDb(path);
    const postChainAfter = reopened
      .prepare(
        'SELECT id, prev_hash, payload_hash FROM security_events WHERE id IN (?, ?) ORDER BY id ASC',
      )
      .all(ids[3], ids[4]) as Array<{ id: number; prev_hash: string; payload_hash: string }>;
    expect(postChainAfter).toEqual(postChainBefore);
    const preChain = reopened
      .prepare(
        'SELECT id, prev_hash, payload_hash FROM security_events WHERE id IN (?, ?, ?) ORDER BY id ASC',
      )
      .all(ids[0], ids[1], ids[2]) as Array<{
      id: number;
      prev_hash: string;
      payload_hash: string;
    }>;
    expect(preChain[0]!.prev_hash).toBe('');
    expect(preChain[0]!.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(preChain[1]!.prev_hash).toBe(preChain[0]!.payload_hash);
    expect(preChain[2]!.prev_hash).toBe(preChain[1]!.payload_hash);
  });

  it('is a no-op on an empty database (no log output, marker recorded)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const db = getDb(path);
      const backfillLogs = logSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('security_events_chain_backfill_v1'));
      expect(backfillLogs).toHaveLength(0);
      const marker = db
        .prepare("SELECT 1 AS ok FROM _migrations WHERE name = 'security_events_chain_backfill_v1'")
        .get() as { ok: number } | undefined;
      expect(marker?.ok).toBe(1);
      const result = walkChain(db);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.eventCount).toBe(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('heals torn state: payload_hash empty + prev_hash non-empty garbage', () => {
    const db = getDb(path);
    const baseTs = Date.now() - 1_000_000;
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const { id } = insertSecurityEvent(db, ev({ matchHash: `torn-${i}`, ts: baseTs + i }));
      ids.push(id);
    }
    _setSweepActiveForTests(true);
    db.prepare("UPDATE security_events SET prev_hash = ?, payload_hash = '' WHERE id = ?").run(
      'garbage'.repeat(9).slice(0, 64),
      ids[0],
    );
    db.prepare(
      "UPDATE security_events SET prev_hash = '', payload_hash = '' WHERE id IN (?, ?)",
    ).run(ids[1], ids[2]);
    _setSweepActiveForTests(false);
    db.prepare("DELETE FROM _migrations WHERE name = 'security_events_chain_backfill_v1'").run();
    closeDb();

    const reopened = getDb(path);
    const rows = reopened
      .prepare(
        'SELECT id, prev_hash, payload_hash FROM security_events WHERE id IN (?, ?, ?) ORDER BY id ASC',
      )
      .all(ids[0], ids[1], ids[2]) as Array<{
      id: number;
      prev_hash: string;
      payload_hash: string;
    }>;
    expect(rows[0]!.prev_hash).toBe('');
    expect(rows[0]!.prev_hash).not.toContain('garbage');
    expect(rows[0]!.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[1]!.prev_hash).toBe(rows[0]!.payload_hash);
    expect(rows[2]!.prev_hash).toBe(rows[1]!.payload_hash);
    expect(walkChain(reopened).ok).toBe(true);
  });

  it('produces hashes that match a fresh recomputation from row data', () => {
    seedLegacyChainState(path, 4);
    const db = getDb(path);
    const rows = db
      .prepare(
        `SELECT id, ts, account_id, session_id, direction, severity, kind,
                detector_id, confidence, title, reason, match_mask, match_hash,
                context_hash, snippet, source_hint, details_json, provenance,
                prev_hash, payload_hash
           FROM security_events ORDER BY id ASC`,
      )
      .all() as Array<{
      id: number;
      ts: number;
      account_id: string;
      session_id: string | null;
      direction: string;
      severity: string;
      kind: string;
      detector_id: string;
      confidence: number;
      title: string;
      reason: string;
      match_mask: string | null;
      match_hash: string;
      context_hash: string | null;
      snippet: string | null;
      source_hint: string | null;
      details_json: string | null;
      provenance: string;
      prev_hash: string;
      payload_hash: string;
    }>;
    for (const r of rows) {
      const recomputed = computePayloadHash({
        ts: r.ts,
        accountId: r.account_id,
        sessionId: r.session_id,
        direction: r.direction,
        severity: r.severity,
        kind: r.kind,
        detectorId: r.detector_id,
        confidence: r.confidence,
        title: r.title,
        reason: r.reason,
        matchMask: r.match_mask,
        matchHash: r.match_hash,
        contextHash: r.context_hash,
        snippet: r.snippet,
        sourceHint: r.source_hint,
        detailsJson: r.details_json,
        provenance: r.provenance,
        prevHash: r.prev_hash,
      });
      expect(recomputed).toBe(r.payload_hash);
    }
  });

  it('restores the sweep gate after backfill (subsequent external UPDATEs are still rejected)', () => {
    seedLegacyChainState(path, 2);
    const db = getDb(path);
    expect(walkChain(db).ok).toBe(true);
    expect(() => {
      db.prepare('UPDATE security_events SET payload_hash = ? WHERE id = 1').run('a'.repeat(64));
    }).toThrowError(/append-only/);
    expect(() => {
      db.prepare('UPDATE security_events SET blocked = 1 WHERE id = 1').run();
    }).toThrowError(/append-only/);
  });

  it('logs the count when rehydrating but stays silent on a clean DB', () => {
    seedLegacyChainState(path, 7);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      getDb(path);
      const backfillLogs = logSpy.mock.calls
        .map((call) => String(call[0] ?? ''))
        .filter((line) => line.includes('security_events_chain_backfill_v1'));
      expect(backfillLogs).toHaveLength(1);
      expect(backfillLogs[0]).toMatch(
        /security_events_chain_backfill_v1: rehydrated chain for 7 pre-chain row\(s\)/,
      );
    } finally {
      logSpy.mockRestore();
    }
  });
});
