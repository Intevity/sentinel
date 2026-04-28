import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import {
  getDb,
  closeDb,
  insertSecurityEvent,
  insertNotification,
  listSecurityEvents,
  listNotifications,
  acknowledgeSecurityEvent,
  acknowledgeAllSecurityEvents,
  clearSecurityEvents,
  purgeSecurityEventsOlderThan,
  countUnacknowledgedSecurityEvents,
  purgeAccount,
  addSecurityAllowlist,
  removeSecurityAllowlist,
  listSecurityAllowlist,
  isSecurityAllowlisted,
  SECURITY_DEDUP_WINDOW_MS,
} from '../db.js';
import type { InsertSecurityEvent } from '../db.js';

const TEST_DB = () =>
  join(tmpdir(), `sentinel-sec-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function makeEvent(overrides: Partial<InsertSecurityEvent> = {}): InsertSecurityEvent {
  return {
    ts: Date.now(),
    accountId: 'acc-a',
    sessionId: null,
    direction: 'outbound',
    severity: 'high',
    kind: 'secret',
    detectorId: 'aws-access-key',
    confidence: 0.95,
    title: 'AWS access key',
    reason: 'reason',
    matchMask: 'AKIA[...]XYZ',
    matchHash: 'hash-a',
    contextHash: 'ctx-a',
    snippet: '[REDACTED:secret]',
    sourceHint: 'messages[0]',
    details: null,
    blocked: false,
    provenance: 'file-read',
    ...overrides,
  };
}

describe('security_events DB helpers', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = TEST_DB();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('inserts a new event and lists it back', () => {
    const db = getDb(dbPath);
    const { id, isNew } = insertSecurityEvent(db, makeEvent());
    expect(isNew).toBe(true);
    expect(id).toBeGreaterThan(0);
    const events = listSecurityEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(id);
    expect(events[0]!.acknowledged).toBe(false);
    expect(events[0]!.occurrences).toBe(1);
  });

  it('dedups identical events within the 1-hour window', () => {
    const db = getDb(dbPath);
    const e = makeEvent();
    const first = insertSecurityEvent(db, e);
    const second = insertSecurityEvent(db, e);
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);
    const events = listSecurityEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]!.occurrences).toBe(2);
  });

  it('creates a new row for a duplicate match_hash outside the dedup window', () => {
    const db = getDb(dbPath);
    const oldTs = Date.now() - SECURITY_DEDUP_WINDOW_MS - 1000;
    insertSecurityEvent(db, makeEvent({ ts: oldTs }));
    const second = insertSecurityEvent(db, makeEvent({ ts: Date.now() }));
    expect(second.isNew).toBe(true);
    expect(listSecurityEvents(db)).toHaveLength(2);
  });

  it('filters by accountId and minConfidence', () => {
    const db = getDb(dbPath);
    insertSecurityEvent(db, makeEvent({ accountId: 'acc-a', confidence: 0.95, matchHash: 'h1' }));
    insertSecurityEvent(db, makeEvent({ accountId: 'acc-b', confidence: 0.95, matchHash: 'h2' }));
    insertSecurityEvent(db, makeEvent({ accountId: 'acc-a', confidence: 0.5, matchHash: 'h3' }));
    const aOnly = listSecurityEvents(db, { accountId: 'acc-a' });
    expect(aOnly).toHaveLength(2);
    const highConf = listSecurityEvents(db, { minConfidence: 0.7 });
    expect(highConf).toHaveLength(2);
  });

  it('applies limit', () => {
    const db = getDb(dbPath);
    for (let i = 0; i < 5; i++) {
      insertSecurityEvent(db, makeEvent({ matchHash: `h-${i}` }));
    }
    expect(listSecurityEvents(db, { limit: 2 })).toHaveLength(2);
  });

  it('acknowledges a single event', () => {
    const db = getDb(dbPath);
    const { id } = insertSecurityEvent(db, makeEvent());
    expect(acknowledgeSecurityEvent(db, id)).toBe(true);
    expect(listSecurityEvents(db)[0]!.acknowledged).toBe(true);
    // Re-ack still returns true because the row exists — the UPDATE
    // statement doesn't gate on acknowledged=0.
    expect(acknowledgeSecurityEvent(db, id)).toBe(true);
    expect(acknowledgeSecurityEvent(db, 99999)).toBe(false);
  });

  it('acknowledges all events (optionally scoped)', () => {
    const db = getDb(dbPath);
    insertSecurityEvent(db, makeEvent({ accountId: 'acc-a', matchHash: 'h1' }));
    insertSecurityEvent(db, makeEvent({ accountId: 'acc-b', matchHash: 'h2' }));
    expect(acknowledgeAllSecurityEvents(db, 'acc-a')).toBe(1);
    expect(listSecurityEvents(db, { accountId: 'acc-a' })[0]!.acknowledged).toBe(true);
    expect(listSecurityEvents(db, { accountId: 'acc-b' })[0]!.acknowledged).toBe(false);
    // Global ack clears the rest.
    expect(acknowledgeAllSecurityEvents(db)).toBe(1);
  });

  it('clears events (scoped and global)', () => {
    const db = getDb(dbPath);
    insertSecurityEvent(db, makeEvent({ accountId: 'acc-a', matchHash: 'h1' }));
    insertSecurityEvent(db, makeEvent({ accountId: 'acc-b', matchHash: 'h2' }));
    expect(clearSecurityEvents(db, 'acc-a')).toBe(1);
    expect(listSecurityEvents(db)).toHaveLength(1);
    expect(clearSecurityEvents(db)).toBe(1);
    expect(listSecurityEvents(db)).toHaveLength(0);
  });

  it('purges events older than cutoff', () => {
    const db = getDb(dbPath);
    const now = Date.now();
    insertSecurityEvent(db, makeEvent({ ts: now - 40 * 24 * 60 * 60 * 1000, matchHash: 'old' }));
    insertSecurityEvent(db, makeEvent({ ts: now, matchHash: 'new' }));
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    expect(purgeSecurityEventsOlderThan(db, cutoff)).toBe(1);
    expect(listSecurityEvents(db)).toHaveLength(1);
  });

  it('counts unacknowledged events', () => {
    const db = getDb(dbPath);
    const { id } = insertSecurityEvent(db, makeEvent({ accountId: 'acc-a', matchHash: 'h1' }));
    insertSecurityEvent(db, makeEvent({ accountId: 'acc-a', matchHash: 'h2' }));
    insertSecurityEvent(db, makeEvent({ accountId: 'acc-b', matchHash: 'h3' }));
    expect(countUnacknowledgedSecurityEvents(db)).toBe(3);
    expect(countUnacknowledgedSecurityEvents(db, 'acc-a')).toBe(2);
    acknowledgeSecurityEvent(db, id);
    expect(countUnacknowledgedSecurityEvents(db, 'acc-a')).toBe(1);
  });

  it('purgeAccount also clears security events', () => {
    const db = getDb(dbPath);
    insertSecurityEvent(db, makeEvent({ accountId: 'acc-a', matchHash: 'h1' }));
    insertSecurityEvent(db, makeEvent({ accountId: 'acc-b', matchHash: 'h2' }));
    purgeAccount(db, 'acc-a');
    expect(listSecurityEvents(db)).toHaveLength(1);
    expect(listSecurityEvents(db)[0]!.accountId).toBe('acc-b');
  });

  it('round-trips details_json', () => {
    const db = getDb(dbPath);
    insertSecurityEvent(db, makeEvent({ details: { foo: 1, bar: [2, 3] } }));
    const events = listSecurityEvents(db);
    expect(events[0]!.details).toEqual({ foo: 1, bar: [2, 3] });
  });

  it('returns null details when JSON is corrupt', async () => {
    const db = getDb(dbPath);
    insertSecurityEvent(db, makeEvent());
    // Corrupt the stored JSON directly to exercise the parse-error
    // fallback. Sprint 8 made `details_json` chain-protected, so the
    // direct UPDATE has to flip the sweep gate (legitimate test-only
    // bypass; production code never writes details_json post-insert).
    const { _setSweepActiveForTests } = await import('../db.js');
    _setSweepActiveForTests(true);
    try {
      db.prepare('UPDATE security_events SET details_json = ? WHERE id = 1').run('not json');
    } finally {
      _setSweepActiveForTests(false);
    }
    expect(listSecurityEvents(db)[0]!.details).toBeNull();
  });
});

describe('security_allowlist DB helpers', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = TEST_DB();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('adds, lists, and removes allowlist entries', () => {
    const db = getDb(dbPath);
    const { id, deletedEvents, deletedNotifications } = addSecurityAllowlist(db, {
      matchHash: 'h1',
      detectorId: 'aws-access-key',
      matchMask: 'AKIA[redacted]',
      title: 'AWS access key',
      note: 'CI test account, fine to ignore',
    });
    expect(id).toBeGreaterThan(0);
    expect(deletedEvents).toBe(0);
    expect(deletedNotifications).toBe(0);

    const entries = listSecurityAllowlist(db);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.matchHash).toBe('h1');
    expect(entries[0]!.note).toBe('CI test account, fine to ignore');

    expect(isSecurityAllowlisted(db, 'h1', 'aws-access-key')).toBe(true);
    expect(isSecurityAllowlisted(db, 'h1', 'different-detector')).toBe(false);
    expect(isSecurityAllowlisted(db, 'different-hash', 'aws-access-key')).toBe(false);

    expect(removeSecurityAllowlist(db, id)).toBe(true);
    expect(listSecurityAllowlist(db)).toHaveLength(0);
    expect(isSecurityAllowlisted(db, 'h1', 'aws-access-key')).toBe(false);
  });

  it('is idempotent on duplicate (match_hash, detector_id) adds', () => {
    const db = getDb(dbPath);
    const first = addSecurityAllowlist(db, { matchHash: 'h1', detectorId: 'd1' });
    const second = addSecurityAllowlist(db, { matchHash: 'h1', detectorId: 'd1', note: 'later' });
    expect(second.id).toBe(first.id);
    expect(listSecurityAllowlist(db)).toHaveLength(1);
  });

  it('retroactively deletes existing matching events', () => {
    const db = getDb(dbPath);
    insertSecurityEvent(db, makeEvent({ matchHash: 'h1', detectorId: 'd1' }));
    insertSecurityEvent(db, makeEvent({ matchHash: 'h1', detectorId: 'd1', ts: Date.now() + 1 }));
    insertSecurityEvent(db, makeEvent({ matchHash: 'h2', detectorId: 'd1' }));
    expect(listSecurityEvents(db)).toHaveLength(2); // dedup collapsed h1 into one

    const { deletedEvents } = addSecurityAllowlist(db, { matchHash: 'h1', detectorId: 'd1' });
    expect(deletedEvents).toBeGreaterThan(0);
    const after = listSecurityEvents(db);
    expect(after).toHaveLength(1);
    expect(after[0]!.matchHash).toBe('h2');
  });

  it('retroactively deletes mirrored notifications', () => {
    const db = getDb(dbPath);
    const ts = Date.now();
    insertSecurityEvent(
      db,
      makeEvent({ ts, matchHash: 'h1', detectorId: 'd1', title: 'AWS access key' }),
    );
    insertNotification(db, {
      ts,
      accountId: 'acc-a',
      type: 'security_high',
      title: 'Security: AWS access key',
      body: 'AKIA…',
    });
    expect(listNotifications(db, {})).toHaveLength(1);

    const { deletedNotifications } = addSecurityAllowlist(db, {
      matchHash: 'h1',
      detectorId: 'd1',
    });
    expect(deletedNotifications).toBe(1);
    expect(listNotifications(db, {})).toHaveLength(0);
  });

  it('removeSecurityAllowlist returns false on unknown id', () => {
    const db = getDb(dbPath);
    expect(removeSecurityAllowlist(db, 99999)).toBe(false);
  });
});

describe('security_events — provenance column', () => {
  let dbPath: string;
  beforeEach(() => {
    dbPath = TEST_DB();
  });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('round-trips provenance through insert + list', () => {
    const db = getDb(dbPath);
    insertSecurityEvent(db, makeEvent({ matchHash: 'p1', provenance: 'file-read' }));
    insertSecurityEvent(db, makeEvent({ matchHash: 'p2', provenance: 'conversation' }));
    insertSecurityEvent(db, makeEvent({ matchHash: 'p3', provenance: 'tool-use' }));
    const rows = listSecurityEvents(db);
    const byHash = new Map(rows.map((r) => [r.matchHash, r.provenance]));
    expect(byHash.get('p1')).toBe('file-read');
    expect(byHash.get('p2')).toBe('conversation');
    expect(byHash.get('p3')).toBe('tool-use');
  });

  it('migrates an old DB that lacks the provenance column, defaulting rows to conversation', () => {
    // Build a "legacy" DB by running getDb, then dropping the column off
    // a clone. ALTER TABLE DROP COLUMN is sqlite 3.35+; better-sqlite3
    // bundles a recent sqlite so this is fine. After closeDb + reopen,
    // the migration path should re-ADD the column with the default.
    const db = getDb(dbPath);
    insertSecurityEvent(db, makeEvent({ matchHash: 'legacy', provenance: 'file-read' }));
    // Sprint 8's chain triggers reference `provenance`, so they have
    // to be dropped first or the ALTER DROP COLUMN errors with
    // "column referenced by trigger". Production code never drops
    // a column on a live DB; this is purely a test-time simulation
    // of a pre-migration schema.
    db.exec('DROP TRIGGER IF EXISTS trg_sec_no_update_chain');
    db.exec('DROP TRIGGER IF EXISTS trg_sec_no_delete');
    // Simulate a pre-migration schema: drop the column so the next open
    // has to ALTER it back in.
    db.exec('ALTER TABLE security_events DROP COLUMN provenance');
    closeDb();

    // Reopen — the migration should add the column back with the default.
    const db2 = getDb(dbPath);
    const rows = listSecurityEvents(db2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provenance).toBe('conversation');
  });
});
