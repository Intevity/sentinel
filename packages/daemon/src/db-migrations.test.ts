import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import Database from 'better-sqlite3';
import { getDb, closeDb, runDetectorTuningMigration } from './db.js';

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

  it('collapses duplicate permission_rules rows and adds UNIQUE index on raw (dedup_permission_rules_v1)', () => {
    // Seed a post-legacy shape (source column, no UNIQUE index) with
    // three rows that share the same raw — matches the shape produced
    // by the historical pullNow/upsert bug. The earliest row (smallest
    // created_at) is the one we expect to survive.
    {
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE permission_rules (
          id          TEXT    PRIMARY KEY,
          decision    TEXT    NOT NULL,
          tool        TEXT    NOT NULL,
          pattern     TEXT,
          raw         TEXT    NOT NULL,
          note        TEXT,
          enabled     INTEGER NOT NULL DEFAULT 1,
          priority    INTEGER NOT NULL,
          created_at  INTEGER NOT NULL,
          source      TEXT    NOT NULL DEFAULT 'local'
        );
      `);
      // Three deny rows with identical raw, differing ids + created_at.
      seed
        .prepare(
          'INSERT INTO permission_rules (id, decision, tool, pattern, raw, priority, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('r-a', 'deny', 'Bash', 'rm -rf *', 'Bash(rm -rf *)', 100, 100, 'local');
      seed
        .prepare(
          'INSERT INTO permission_rules (id, decision, tool, pattern, raw, priority, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('r-b', 'deny', 'Bash', 'rm -rf *', 'Bash(rm -rf *)', 100, 200, 'claude-code');
      seed
        .prepare(
          'INSERT INTO permission_rules (id, decision, tool, pattern, raw, priority, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('r-c', 'deny', 'Bash', 'rm -rf *', 'Bash(rm -rf *)', 100, 300, 'claude-code');
      // A second distinct rule, no duplicates — should be untouched.
      seed
        .prepare(
          'INSERT INTO permission_rules (id, decision, tool, pattern, raw, priority, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('r-other', 'allow', 'Read', null, 'Read', 100, 50, 'local');
      seed.close();
    }

    const db = getDb(dbPath);

    // Only the earliest row per raw survives.
    const remaining = db
      .prepare('SELECT id FROM permission_rules ORDER BY raw, id')
      .all() as Array<{ id: string }>;
    expect(remaining.map((r) => r.id).sort()).toEqual(['r-a', 'r-other']);

    // Marker is set so a subsequent open doesn't re-run the delete.
    const marker = db
      .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
      .get('dedup_permission_rules_v1') as { ok: number } | undefined;
    expect(marker?.ok).toBe(1);

    // UNIQUE index exists and enforces uniqueness on raw.
    const indexes = db.pragma('index_list(permission_rules)') as Array<{
      name: string;
      unique: number;
    }>;
    const uniqueRaw = indexes.find((i) => i.name === 'idx_perm_rules_raw_unique');
    expect(uniqueRaw?.unique).toBe(1);
    expect(() => {
      db.prepare(
        'INSERT INTO permission_rules (id, decision, tool, pattern, raw, priority, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('r-dup', 'ask', 'Bash', 'rm -rf *', 'Bash(rm -rf *)', 100, 400, 'local');
    }).toThrow(/UNIQUE/);
  });
});

describe('runDetectorTuningMigration (detector_tuning_v1)', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `sentinel-detector-tuning-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
  });
  afterEach(() => {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  /** Seed a row in security_events with the minimum required columns. */
  function seedEvent(
    db: Database.Database,
    opts: {
      detectorId: string;
      ts: number;
      blocked?: boolean;
      approved?: boolean;
      acknowledged?: boolean;
    },
  ): void {
    // Direct INSERT bypasses insertSecurityEvent / the chain trigger;
    // the migration only reads/writes regular columns so this is enough.
    // payload_hash is left at its DEFAULT ('' from the chain backfill
    // migration) — that's fine since we never walk the chain in these
    // tests. match_hash needs to be unique-ish so the dedup index
    // doesn't collapse rows.
    db.prepare(
      `INSERT INTO security_events
         (ts, last_seen_ts, account_id, direction, severity, kind,
          detector_id, confidence, title, reason, match_hash,
          occurrences, blocked, approved, acknowledged, provenance)
       VALUES (?, ?, 'acc-a', 'outbound', 'medium', 'prompt_injection',
               ?, 0.7, 'title', 'reason', ?, 1, ?, ?, ?, 'tool-result')`,
    ).run(
      opts.ts,
      opts.ts,
      opts.detectorId,
      `hash-${opts.detectorId}-${opts.ts}`,
      opts.blocked ? 1 : 0,
      opts.approved ? 1 : 0,
      opts.acknowledged ? 1 : 0,
    );
  }

  it('demotes detectors with >=20 events / 0 blocked / 0 approved in last 30 days', () => {
    const db = getDb(dbPath);
    const now = Date.now();
    // 25 noisy events for `noisy-rule` — never blocked, never approved.
    for (let i = 0; i < 25; i++) {
      seedEvent(db, { detectorId: 'noisy-rule', ts: now - i * 60_000 });
    }
    // 25 events for `loud-but-real-rule` — 2 of them blocked. Should NOT
    // be demoted because the rule has demonstrated value.
    for (let i = 0; i < 25; i++) {
      seedEvent(db, {
        detectorId: 'loud-but-real-rule',
        ts: now - i * 60_000,
        blocked: i < 2,
      });
    }
    // 5 events for `quiet-rule` — below the 20-event floor, should not
    // be demoted regardless of disposition.
    for (let i = 0; i < 5; i++) {
      seedEvent(db, { detectorId: 'quiet-rule', ts: now - i * 60_000 });
    }
    // 25 noisy events for `ancient-rule` but all older than 30 days —
    // out of the migration's window, should not be demoted.
    for (let i = 0; i < 25; i++) {
      seedEvent(db, {
        detectorId: 'ancient-rule',
        ts: now - 31 * 24 * 3600 * 1000 - i * 60_000,
      });
    }

    const result = runDetectorTuningMigration(db, now);
    expect(result).not.toBeNull();
    expect(result!.demotedIds).toEqual(['noisy-rule']);
    // 25 unacknowledged noisy rows → 25 acknowledged.
    expect(result!.acknowledgedRowCount).toBe(25);

    // Idempotent: second run returns null (marker present).
    const second = runDetectorTuningMigration(db, now);
    expect(second).toBeNull();

    // Marker recorded under _migrations.
    const marker = db
      .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
      .get('detector_tuning_v1') as { ok: number } | undefined;
    expect(marker?.ok).toBe(1);
  });

  it('only bulk-acknowledges still-unacknowledged rows of the demoted detectors', () => {
    const db = getDb(dbPath);
    const now = Date.now();
    // 25 noisy events, half already acknowledged → only 13 flips expected.
    for (let i = 0; i < 25; i++) {
      seedEvent(db, {
        detectorId: 'noisy-rule',
        ts: now - i * 60_000,
        acknowledged: i % 2 === 0, // i=0,2,4,…,24 already acked (13 of 25)
      });
    }
    const result = runDetectorTuningMigration(db, now);
    expect(result).not.toBeNull();
    // 25 total - 13 already acked = 12 flipped.
    expect(result!.acknowledgedRowCount).toBe(12);

    // Final state: every noisy-rule row is acknowledged=1.
    const counts = db
      .prepare(
        `SELECT SUM(CASE WHEN acknowledged=1 THEN 1 ELSE 0 END) AS acked,
                COUNT(*) AS total
           FROM security_events
          WHERE detector_id = 'noisy-rule'`,
      )
      .get() as { acked: number; total: number };
    expect(counts.acked).toBe(25);
    expect(counts.total).toBe(25);
  });

  it('returns demotedIds=[] when no rule meets the threshold (still marks migration applied)', () => {
    const db = getDb(dbPath);
    const now = Date.now();
    // Single rule, 19 events — one below threshold.
    for (let i = 0; i < 19; i++) {
      seedEvent(db, { detectorId: 'barely-quiet', ts: now - i * 60_000 });
    }
    const result = runDetectorTuningMigration(db, now);
    expect(result).not.toBeNull();
    expect(result!.demotedIds).toEqual([]);
    expect(result!.acknowledgedRowCount).toBe(0);
    // Idempotent on next run.
    expect(runDetectorTuningMigration(db, now)).toBeNull();
  });
});
