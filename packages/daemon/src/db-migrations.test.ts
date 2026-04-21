import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import Database from 'better-sqlite3';
import { getDb, closeDb } from './db.js';

/** Seed a DB with an intentionally-pre-migration schema, then let getDb()
 *  run its migration block. Covers the conditional branches that only fire
 *  when an older column shape is found on disk.
 *
 *  Every column that appears in an index definition (and therefore must
 *  exist before the SCHEMA's `CREATE INDEX IF NOT EXISTS` runs) is present
 *  in the pre-migration shape; only the columns whose migrations we want to
 *  exercise are omitted. */
function seedLegacyDb(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE accounts (
        id           TEXT PRIMARY KEY,
        email        TEXT NOT NULL,
        display_name TEXT,
        org_uuid     TEXT,
        org_name     TEXT,
        plan_type    TEXT,
        created_at   INTEGER NOT NULL
      );
      CREATE TABLE rate_limits (
        account_id   TEXT NOT NULL,
        name         TEXT NOT NULL,
        status       TEXT,
        utilization  REAL,
        lim          INTEGER,
        remaining    INTEGER,
        reset_ts     INTEGER,
        last_updated INTEGER NOT NULL,
        PRIMARY KEY (account_id, name)
      );
      CREATE TABLE tool_events (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        ts             INTEGER NOT NULL,
        account_id     TEXT NOT NULL,
        session_id     TEXT,
        tool_name      TEXT NOT NULL,
        success        INTEGER NOT NULL,
        duration_ms    INTEGER,
        error          TEXT,
        decision_source TEXT
      );
      CREATE TABLE security_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              INTEGER NOT NULL,
        last_seen_ts    INTEGER NOT NULL,
        account_id      TEXT NOT NULL,
        session_id      TEXT,
        direction       TEXT NOT NULL,
        severity        TEXT NOT NULL,
        kind            TEXT NOT NULL,
        detector_id     TEXT NOT NULL,
        confidence      REAL NOT NULL,
        title           TEXT NOT NULL,
        reason          TEXT NOT NULL,
        match_mask      TEXT,
        match_hash      TEXT NOT NULL,
        context_hash    TEXT,
        snippet         TEXT,
        source_hint     TEXT,
        details_json    TEXT,
        occurrences     INTEGER NOT NULL DEFAULT 1,
        blocked         INTEGER NOT NULL DEFAULT 0,
        acknowledged    INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE alerts (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id              TEXT NOT NULL,
        threshold_pct           INTEGER NOT NULL,
        enabled                 INTEGER NOT NULL DEFAULT 1,
        last_triggered_reset_ts INTEGER,
        created_at              INTEGER NOT NULL
      );
      CREATE TABLE permission_rules (
        id          TEXT    PRIMARY KEY,
        decision    TEXT    NOT NULL CHECK(decision IN ('allow','deny')),
        tool        TEXT    NOT NULL,
        pattern     TEXT,
        raw         TEXT    NOT NULL,
        note        TEXT,
        enabled     INTEGER NOT NULL DEFAULT 1,
        priority    INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      );
    `);
    db.exec(
      "INSERT INTO accounts (id, email, created_at) VALUES ('legacy-uuid-1', 'old@example.com', 0)",
    );
    db.exec(
      "INSERT INTO permission_rules (id, decision, tool, raw, priority, created_at) VALUES ('r1', 'deny', 'Bash', 'Bash', 100, 0)",
    );
  } finally {
    db.close();
  }
}

describe('getDb migrations on a legacy database', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `sentinel-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
  });

  afterEach(() => {
    closeDb();
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it('adds account_uuid, removed, and color to a legacy accounts table and back-fills account_uuid', () => {
    seedLegacyDb(dbPath);
    const db = getDb(dbPath);
    const cols = db.pragma('table_info(accounts)') as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('account_uuid')).toBe(true);
    expect(names.has('removed')).toBe(true);
    expect(names.has('color')).toBe(true);
    const row = db.prepare('SELECT id, account_uuid FROM accounts').get() as {
      id: string;
      account_uuid: string;
    };
    expect(row.account_uuid).toBe('legacy-uuid-1');
  });

  it('adds in_use to a legacy rate_limits table', () => {
    seedLegacyDb(dbPath);
    const db = getDb(dbPath);
    const cols = db.pragma('table_info(rate_limits)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'in_use')).toBe(true);
  });

  it('adds decision_type to a legacy tool_events table', () => {
    seedLegacyDb(dbPath);
    const db = getDb(dbPath);
    const cols = db.pragma('table_info(tool_events)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'decision_type')).toBe(true);
  });

  it('adds approved + provenance columns to a legacy security_events table', () => {
    seedLegacyDb(dbPath);
    const db = getDb(dbPath);
    const cols = db.pragma('table_info(security_events)') as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('approved')).toBe(true);
    expect(names.has('provenance')).toBe(true);
  });

  it('adds scope + budget_scope columns to a legacy alerts table', () => {
    seedLegacyDb(dbPath);
    const db = getDb(dbPath);
    const cols = db.pragma('table_info(alerts)') as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has('scope')).toBe(true);
    expect(names.has('budget_scope')).toBe(true);
  });

  it('rebuilds permission_rules to drop the legacy allow/deny CHECK constraint and adds a source column', () => {
    seedLegacyDb(dbPath);
    const db = getDb(dbPath);
    const cols = db.pragma('table_info(permission_rules)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'source')).toBe(true);
    // After the rebuild, inserting an 'ask' rule must succeed (the legacy
    // CHECK constraint allowed only allow/deny).
    expect(() => {
      db.prepare(
        'INSERT INTO permission_rules (id, decision, tool, raw, priority, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('r-ask', 'ask', 'Bash', 'Bash(git *)', 100, Date.now(), 'local');
    }).not.toThrow();
    // Existing legacy row was preserved.
    const preserved = db.prepare('SELECT id FROM permission_rules WHERE id = ?').get('r1') as {
      id: string;
    };
    expect(preserved?.id).toBe('r1');
  });
});
