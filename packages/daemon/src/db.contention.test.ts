import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import type { Database } from 'better-sqlite3';
import { closeDb, getDb, insertSecurityEvent, listSecurityEvents } from './db.js';

// Sprint 10: stress the security_events write path. better-sqlite3 is
// synchronous so "concurrency" here is rapid sequential calls — the
// contract being pinned is "no events dropped under burst load" plus
// "dedup correctly attributes every hit".

const NEW_DB = (): string =>
  join(tmpdir(), `sentinel-contention-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function makeBaseEvent(over: Partial<Parameters<typeof insertSecurityEvent>[1]> = {}) {
  return {
    ts: Date.now(),
    accountId: 'acct-1',
    sessionId: null,
    direction: 'outbound' as const,
    severity: 'medium' as const,
    kind: 'secret' as const,
    detectorId: 'aws-access-key',
    confidence: 0.95,
    title: 'AWS access key',
    reason: 'AKIA prefix',
    matchMask: 'AKIA…',
    matchHash: 'baseline-hash',
    contextHash: null,
    snippet: null,
    sourceHint: null,
    details: null,
    blocked: false,
    provenance: 'tool-use' as const,
    ...over,
  };
}

describe('Sprint 10 — security_events DB contention', () => {
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    dbPath = NEW_DB();
    db = getDb(dbPath);
  });

  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('100 distinct events all land — none dropped under burst', () => {
    const N = 100;
    let inserted = 0;
    for (let i = 0; i < N; i++) {
      const result = insertSecurityEvent(
        db,
        makeBaseEvent({
          // Distinct matchHash + detectorId combination so each event
          // is a unique dedup key — no collapsing into a single row.
          matchHash: `hash-${i}`,
          detectorId: `det-${i % 10}`,
        }),
      );
      if (result.isNew) inserted += 1;
    }
    expect(inserted).toBe(N);
    expect(listSecurityEvents(db).length).toBe(N);
  });

  it('100 identical events collapse into one row with occurrences=100', () => {
    // Same matchHash + detectorId + accountId → all but the first hit
    // the dedup branch and bump occurrences. Verifies that no event is
    // silently dropped: we count via occurrences.
    const N = 100;
    let newRows = 0;
    let dedupHits = 0;
    for (let i = 0; i < N; i++) {
      const result = insertSecurityEvent(db, makeBaseEvent({ matchHash: 'collapse' }));
      if (result.isNew) newRows += 1;
      else dedupHits += 1;
    }
    expect(newRows).toBe(1);
    expect(dedupHits).toBe(N - 1);
    const rows = listSecurityEvents(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrences).toBe(N);
  });

  it('mixed burst: 50 distinct + 50 identical attribute correctly', () => {
    // The realistic shape: a flood of identical findings (same secret
    // re-detected across rapid requests) interleaved with one-off
    // findings. Verifies no leakage between buckets.
    let distinctNew = 0;
    let identicalNew = 0;
    let identicalDedup = 0;
    for (let i = 0; i < 50; i++) {
      const r = insertSecurityEvent(db, makeBaseEvent({ matchHash: `unique-${i}` }));
      if (r.isNew) distinctNew += 1;
    }
    for (let i = 0; i < 50; i++) {
      const r = insertSecurityEvent(db, makeBaseEvent({ matchHash: 'shared' }));
      if (r.isNew) identicalNew += 1;
      else identicalDedup += 1;
    }
    expect(distinctNew).toBe(50);
    expect(identicalNew).toBe(1);
    expect(identicalDedup).toBe(49);
    const rows = listSecurityEvents(db);
    expect(rows).toHaveLength(51);
    const shared = rows.find((r) => r.matchHash === 'shared');
    expect(shared!.occurrences).toBe(50);
  });
});
