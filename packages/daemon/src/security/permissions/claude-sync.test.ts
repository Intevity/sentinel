import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import type { Database } from 'better-sqlite3';
import { getDb, closeDb, upsertPermissionRule, listPermissionRules } from '../../db.js';
import { createClaudeSyncEngine, type ClaudeSyncEngine } from './claude-sync.js';
import type { IpcServer } from '../../ipc.js';

/** Minimal IpcServer stub — the engine only calls `broadcast`. */
function makeIpcStub(): IpcServer {
  return {
    start: () => {},
    stop: () => {},
    broadcast: () => {},
  } as unknown as IpcServer;
}

function tmpRoot(): string {
  return join(tmpdir(), `sentinel-sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function writeSettings(
  path: string,
  perms: { allow?: string[]; deny?: string[]; ask?: string[] },
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    path,
    JSON.stringify({ ...extra, permissions: { allow: [], deny: [], ask: [], ...perms } }, null, 2),
  );
}

function readPerms(path: string): {
  allow: string[];
  deny: string[];
  ask: string[];
  raw: Record<string, unknown>;
} {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  } & Record<string, unknown>;
  const p = parsed.permissions ?? {};
  return {
    allow: p.allow ?? [],
    deny: p.deny ?? [],
    ask: p.ask ?? [],
    raw: parsed,
  };
}

describe('claude-sync pullNow', () => {
  let root: string;
  let settingsPath: string;
  let dbPath: string;
  let db: Database;
  let engine: ClaudeSyncEngine;

  beforeEach(() => {
    root = tmpRoot();
    mkdirSync(root, { recursive: true });
    settingsPath = join(root, 'settings.json');
    dbPath = join(root, 'sentinel.db');
    db = getDb(dbPath);
    engine = createClaudeSyncEngine({
      db,
      ipcServer: makeIpcStub(),
      invalidateRuleCache: () => {},
      settingsPath,
    });
  });

  afterEach(() => {
    closeDb();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('collapses triplicated file entries into a single DB row', async () => {
    writeSettings(settingsPath, {
      allow: ['Bash(git *)', 'Bash(git *)', 'Bash(git *)'],
      deny: ['Bash(rm -rf *)', 'Bash(rm -rf *)', 'Bash(rm -rf *)'],
    });
    await engine.pullNow('merge');
    const rows = listPermissionRules(db);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.raw === 'Bash(git *)')?.decision).toBe('allow');
    expect(rows.find((r) => r.raw === 'Bash(rm -rf *)')?.decision).toBe('deny');
  });

  it('updates decision in place when file re-classifies a rule across buckets', async () => {
    // Seed DB with rule under 'deny', matching what a beta user had.
    upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      source: 'local',
    });
    // File has the same raw under 'ask' — the user moved it.
    writeSettings(settingsPath, { ask: ['Bash(rm -rf *)'] });
    await engine.pullNow('merge');
    const rows = listPermissionRules(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision).toBe('ask');
    // ask rules are always Sentinel-owned (source='local') regardless
    // of pull mode, because the file never holds them after push.
    expect(rows[0]!.source).toBe('local');
  });

  it('flips source to claude-code in import mode (for allow/deny only)', async () => {
    upsertPermissionRule(db, {
      decision: 'allow',
      tool: 'Bash',
      pattern: 'git *',
      raw: 'Bash(git *)',
      source: 'local',
    });
    writeSettings(settingsPath, { deny: ['Bash(git *)'] });
    await engine.pullNow('import');
    const rows = listPermissionRules(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision).toBe('deny');
    expect(rows[0]!.source).toBe('claude-code');
  });

  it('forces source=local on ask rules even in import mode', async () => {
    writeSettings(settingsPath, { ask: ['Bash(rm -rf *)'] });
    await engine.pullNow('import');
    const rows = listPermissionRules(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision).toBe('ask');
    expect(rows[0]!.source).toBe('local');
  });

  it('deletes claude-code orphans but keeps local rules when file drops them', async () => {
    upsertPermissionRule(db, {
      decision: 'allow',
      tool: 'Bash',
      pattern: 'npm *',
      raw: 'Bash(npm *)',
      source: 'claude-code',
    });
    upsertPermissionRule(db, {
      decision: 'allow',
      tool: 'Bash',
      pattern: 'yarn *',
      raw: 'Bash(yarn *)',
      source: 'local',
    });
    writeSettings(settingsPath, { allow: [] });
    await engine.pullNow('merge');
    const rows = listPermissionRules(db);
    expect(rows.map((r) => r.raw).sort()).toEqual(['Bash(yarn *)']);
  });

  it('same raw in both ask and deny buckets resolves to deny (most restrictive wins)', async () => {
    writeSettings(settingsPath, {
      ask: ['Bash(rm -rf *)'],
      deny: ['Bash(rm -rf *)'],
    });
    await engine.pullNow('merge');
    const rows = listPermissionRules(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decision).toBe('deny');
  });
});

describe('claude-sync pushNow', () => {
  let root: string;
  let settingsPath: string;
  let dbPath: string;
  let db: Database;
  let engine: ClaudeSyncEngine;

  beforeEach(() => {
    root = tmpRoot();
    mkdirSync(root, { recursive: true });
    settingsPath = join(root, 'settings.json');
    dbPath = join(root, 'sentinel.db');
    db = getDb(dbPath);
    engine = createClaudeSyncEngine({
      db,
      ipcServer: makeIpcStub(),
      invalidateRuleCache: () => {},
      settingsPath,
    });
  });

  afterEach(() => {
    closeDb();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('writes one entry per rule — no duplication', async () => {
    upsertPermissionRule(db, {
      decision: 'allow',
      tool: 'Bash',
      pattern: 'git *',
      raw: 'Bash(git *)',
      source: 'local',
    });
    upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'sudo *',
      raw: 'Bash(sudo *)',
      source: 'local',
    });
    await engine.pushNow();
    const p = readPerms(settingsPath);
    expect(p.allow).toEqual(['Bash(git *)']);
    expect(p.deny).toEqual(['Bash(sudo *)']);
    expect(p.ask).toEqual([]);
  });

  it('never writes ask rules to the file (Sentinel-only)', async () => {
    upsertPermissionRule(db, {
      decision: 'ask',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      source: 'local',
    });
    upsertPermissionRule(db, {
      decision: 'allow',
      tool: 'Bash',
      pattern: 'git *',
      raw: 'Bash(git *)',
      source: 'local',
    });
    await engine.pushNow();
    const p = readPerms(settingsPath);
    // ask stays empty — the rule is Sentinel-only so that approval
    // prompts are managed in one place (future Slack / remote-approval
    // integrations plug into Sentinel, not Claude Code).
    expect(p.ask).toEqual([]);
    expect(p.allow).toEqual(['Bash(git *)']);
    // ...but the rule is still in Sentinel's DB.
    const rows = listPermissionRules(db);
    expect(rows.some((r) => r.raw === 'Bash(rm -rf *)' && r.decision === 'ask')).toBe(true);
  });

  it('strips ask rules from a file that previously contained them', async () => {
    // Pre-existing file state from a beta user, where ask was synced.
    writeSettings(settingsPath, {
      allow: ['Bash(git *)'],
      ask: ['Bash(rm -rf *)'],
    });
    upsertPermissionRule(db, {
      decision: 'allow',
      tool: 'Bash',
      pattern: 'git *',
      raw: 'Bash(git *)',
      source: 'local',
    });
    upsertPermissionRule(db, {
      decision: 'ask',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      source: 'local',
    });
    await engine.pushNow();
    const p = readPerms(settingsPath);
    expect(p.ask).toEqual([]);
    expect(p.allow).toEqual(['Bash(git *)']);
  });

  it('preserves non-permissions top-level keys when rewriting', async () => {
    writeSettings(
      settingsPath,
      { deny: ['stale-entry-that-will-be-overwritten'] },
      {
        env: { FOO: 'bar' },
        enabledPlugins: { 'example@marketplace': true },
      },
    );
    upsertPermissionRule(db, {
      decision: 'allow',
      tool: 'Read',
      pattern: null,
      raw: 'Read',
      source: 'local',
    });
    await engine.pushNow();
    const p = readPerms(settingsPath);
    expect(p.allow).toEqual(['Read']);
    expect(p.deny).toEqual([]);
    expect((p.raw as { env: { FOO: string } }).env.FOO).toBe('bar');
    expect((p.raw as { enabledPlugins: Record<string, boolean> }).enabledPlugins).toEqual({
      'example@marketplace': true,
    });
  });
});

describe('claude-sync upgrade migration', () => {
  let root: string;
  let settingsPath: string;
  let dbPath: string;
  let db: Database;
  let engine: ClaudeSyncEngine;

  beforeEach(() => {
    root = tmpRoot();
    mkdirSync(root, { recursive: true });
    settingsPath = join(root, 'settings.json');
    dbPath = join(root, 'sentinel.db');
    db = getDb(dbPath);
    engine = createClaudeSyncEngine({
      db,
      ipcServer: makeIpcStub(),
      invalidateRuleCache: () => {},
      settingsPath,
    });
  });

  afterEach(() => {
    closeDb();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('first start fixes a beta user whose file has triples and a cross-bucket disagreement with the DB', async () => {
    // Simulate a beta user's state: DB has deny|rm-rf as local, file
    // has ask|rm-rf triplicated (and other rules triplicated too).
    upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      source: 'local',
    });
    writeSettings(settingsPath, {
      allow: ['Bash(git *)', 'Bash(git *)', 'Bash(git *)'],
      deny: [],
      ask: ['Bash(rm -rf *)', 'Bash(rm -rf *)', 'Bash(rm -rf *)'],
    });
    await engine.start();
    // DB reconciles to file's intent: one row each, rm-rf now ask.
    const rows = listPermissionRules(db);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.raw === 'Bash(rm -rf *)')?.decision).toBe('ask');
    // File is now clean — no duplicates. And ask is stripped from
    // the file entirely (Sentinel-only), so the user won't get a
    // double prompt from Claude Code and Sentinel.
    const p = readPerms(settingsPath);
    expect(p.allow).toEqual(['Bash(git *)']);
    expect(p.ask).toEqual([]);
    // Marker persisted so migration won't re-run.
    const marker = db
      .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
      .get('claude_sync_file_wins_v1') as { ok: number } | undefined;
    expect(marker?.ok).toBe(1);
    // Ask rule's source is always 'local' regardless of pull mode —
    // the file never holds ask rules, so 'claude-code' would be a
    // lie. Allow/deny rules flip to claude-code during import (file
    // won) but ask stays Sentinel-owned.
    expect(rows.find((r) => r.raw === 'Bash(rm -rf *)')?.source).toBe('local');
    expect(rows.find((r) => r.raw === 'Bash(git *)')?.source).toBe('claude-code');
    engine.stop();
  });

  it('does not re-run when the marker is already present', async () => {
    db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
      'claude_sync_file_wins_v1',
      Date.now(),
    );
    // DB has a local allow rule whose decision disagrees with the
    // file's deny. If the migration were to re-run in import mode,
    // source would flip to claude-code. Since the marker is set,
    // start() falls through to the normal merge-mode initial pull,
    // which preserves local source.
    upsertPermissionRule(db, {
      decision: 'allow',
      tool: 'Bash',
      pattern: 'git *',
      raw: 'Bash(git *)',
      source: 'local',
    });
    writeSettings(settingsPath, { deny: ['Bash(git *)'] });
    await engine.start();
    const rows = listPermissionRules(db);
    expect(rows[0]!.decision).toBe('deny'); // still reconciles via normal pull
    expect(rows[0]!.source).toBe('local'); // but source stayed local
    engine.stop();
  });
});

describe('claude-sync wildcard-to-ask migration', () => {
  let root: string;
  let settingsPath: string;
  let dbPath: string;
  let db: Database;
  let engine: ClaudeSyncEngine;

  /** The seven raws the migration targets. A rule outside this list
   *  must never be flipped, even if it matches the "Bash(... *)" shape. */
  const TARGET_RAWS = [
    'Bash(rm -rf *)',
    'Bash(sudo *)',
    'Bash(chmod 777 *)',
    'Bash(curl * | bash)',
    'Bash(curl * | sh)',
    'Bash(wget * | bash)',
    'Bash(wget * | sh)',
  ];

  beforeEach(() => {
    root = tmpRoot();
    mkdirSync(root, { recursive: true });
    settingsPath = join(root, 'settings.json');
    dbPath = join(root, 'sentinel.db');
    db = getDb(dbPath);
    engine = createClaudeSyncEngine({
      db,
      ipcServer: makeIpcStub(),
      invalidateRuleCache: () => {},
      settingsPath,
    });
    // Isolate the wildcard-to-ask migration from the older upgrade
    // migration by pre-setting its marker. The two are independent
    // and run in sequence in start(); pinning the first lets these
    // tests observe the second's behavior in isolation.
    db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
      'claude_sync_file_wins_v1',
      Date.now(),
    );
  });

  afterEach(() => {
    closeDb();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('flips all 7 wildcard deny rules to ask on first start and leaves unrelated rules alone', async () => {
    // Seed each target raw as a plain deny, plus one unrelated deny
    // and one unrelated allow that must survive untouched.
    for (const raw of TARGET_RAWS) {
      const pattern = raw.slice('Bash('.length, -1);
      upsertPermissionRule(db, {
        decision: 'deny',
        tool: 'Bash',
        pattern,
        raw,
        source: 'local',
      });
    }
    upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'evil *',
      raw: 'Bash(evil *)',
      source: 'local',
    });
    upsertPermissionRule(db, {
      decision: 'allow',
      tool: 'Bash',
      pattern: 'git *',
      raw: 'Bash(git *)',
      source: 'local',
    });
    writeSettings(settingsPath, {});
    await engine.start();
    const rows = listPermissionRules(db);
    for (const raw of TARGET_RAWS) {
      const row = rows.find((r) => r.raw === raw);
      expect(row?.decision).toBe('ask');
      expect(row?.source).toBe('local');
    }
    // Untargeted rules stay as the user authored them.
    expect(rows.find((r) => r.raw === 'Bash(evil *)')?.decision).toBe('deny');
    expect(rows.find((r) => r.raw === 'Bash(git *)')?.decision).toBe('allow');
    engine.stop();
  });

  it('forces source=local when flipping a rule that was owned by the file', async () => {
    // Simulate a user who had Bash(sudo *) synced in from settings.json
    // as a claude-code-owned deny. The migration must take ownership
    // back because ask rules are Sentinel-only.
    upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'sudo *',
      raw: 'Bash(sudo *)',
      source: 'claude-code',
    });
    writeSettings(settingsPath, { deny: ['Bash(sudo *)'] });
    await engine.start();
    const row = listPermissionRules(db).find((r) => r.raw === 'Bash(sudo *)');
    expect(row?.decision).toBe('ask');
    expect(row?.source).toBe('local');
    engine.stop();
  });

  it('does not re-run after the marker is set, even if a target raw is re-added as deny', async () => {
    upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      source: 'local',
    });
    writeSettings(settingsPath, {});
    await engine.start();
    expect(listPermissionRules(db).find((r) => r.raw === 'Bash(rm -rf *)')?.decision).toBe('ask');
    engine.stop();

    // User (or some other path) hand-flips the rule back to deny. On
    // the next start, the migration must NOT fire again — otherwise
    // the user's intent would be silently overridden every restart.
    db.prepare("UPDATE permission_rules SET decision='deny' WHERE raw=?").run('Bash(rm -rf *)');
    const engine2 = createClaudeSyncEngine({
      db,
      ipcServer: makeIpcStub(),
      invalidateRuleCache: () => {},
      settingsPath,
    });
    await engine2.start();
    expect(listPermissionRules(db).find((r) => r.raw === 'Bash(rm -rf *)')?.decision).toBe('deny');
    engine2.stop();
  });

  it('leaves target raws already at decision=ask untouched', async () => {
    upsertPermissionRule(db, {
      decision: 'ask',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      source: 'local',
    });
    writeSettings(settingsPath, {});
    await engine.start();
    const row = listPermissionRules(db).find((r) => r.raw === 'Bash(rm -rf *)');
    expect(row?.decision).toBe('ask');
    expect(row?.source).toBe('local');
    engine.stop();
  });

  it('push after migration strips flipped raws from settings.json', async () => {
    // File mirrors what Claude Code would see before the migration:
    // all 7 as denies. Seed DB with the same state so the migration
    // has something to flip.
    for (const raw of TARGET_RAWS) {
      const pattern = raw.slice('Bash('.length, -1);
      upsertPermissionRule(db, {
        decision: 'deny',
        tool: 'Bash',
        pattern,
        raw,
        source: 'claude-code',
      });
    }
    writeSettings(settingsPath, { deny: [...TARGET_RAWS] });
    await engine.start();
    const p = readPerms(settingsPath);
    for (const raw of TARGET_RAWS) {
      expect(p.deny).not.toContain(raw);
      expect(p.ask).not.toContain(raw);
      expect(p.allow).not.toContain(raw);
    }
    engine.stop();
  });

  it('persists the marker even when no rows match, so a later-added deny is not retroactively flipped', async () => {
    // User has none of the target raws. The migration has nothing to
    // do right now, but we still mark it applied so a deny added
    // tomorrow (manually or from settings.json) is preserved as-is.
    upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'evil *',
      raw: 'Bash(evil *)',
      source: 'local',
    });
    writeSettings(settingsPath, {});
    await engine.start();
    const marker = db
      .prepare('SELECT 1 AS ok FROM _migrations WHERE name = ?')
      .get('wildcard_denies_to_ask_v1') as { ok: number } | undefined;
    expect(marker?.ok).toBe(1);
    engine.stop();

    // Now add a target raw as deny and restart. The migration is
    // already applied, so the new deny must stay as deny.
    upsertPermissionRule(db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      source: 'local',
    });
    const engine2 = createClaudeSyncEngine({
      db,
      ipcServer: makeIpcStub(),
      invalidateRuleCache: () => {},
      settingsPath,
    });
    await engine2.start();
    expect(listPermissionRules(db).find((r) => r.raw === 'Bash(rm -rf *)')?.decision).toBe('deny');
    engine2.stop();
  });
});
