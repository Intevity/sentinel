/**
 * Real-listener tests for the Optimize agents-sync engine. No HTTP/FS
 * mocks — temp directory + real fs.watch + real DB. Mirrors the
 * approach in security/permissions/claude-sync.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type Database from 'better-sqlite3';
import type { DaemonToAppMessage } from '@claude-sentinel/shared';
import { createAgentsSyncEngine, parseFrontmatter } from './agents-sync.js';
import { getCuratedSubagent } from './curated-library.js';
import {
  getDb,
  closeDb,
  listSubagentInstalls,
  findSubagentInstallByName,
  upsertSubagentInstall,
} from '../db.js';
import type { IpcServer } from '../ipc.js';

function makeCapturingIpc(): IpcServer & { broadcasts: DaemonToAppMessage[] } {
  const broadcasts: DaemonToAppMessage[] = [];
  return {
    broadcasts,
    broadcast(m: DaemonToAppMessage) {
      broadcasts.push(m);
    },
    onMessage() {
      /* not used */
    },
    start() {
      /* no-op */
    },
    stop() {
      /* no-op */
    },
    /* v8 ignore next 9 */
    sendToAll(_m: DaemonToAppMessage) {
      /* not used */
    },
    sendTo(_clientId: string, _m: DaemonToAppMessage) {
      /* not used */
    },
    listClients() {
      return [];
    },
  } as unknown as IpcServer & { broadcasts: DaemonToAppMessage[] };
}

const TMP_PARENT = tmpdir();
let tmpDir: string;
let dbPath: string;
let agentsDir: string;

describe('parseFrontmatter', () => {
  it('parses keys from a well-formed .md', () => {
    const md = ['---', 'name: foo', 'description: bar', 'model: haiku', '---', '', 'body'].join(
      '\n',
    );
    const out = parseFrontmatter(md);
    expect(out).toMatchObject({ name: 'foo', description: 'bar', model: 'haiku' });
  });

  it('unquotes single-quoted scalars', () => {
    const md = ['---', "name: 'has: colon'", '---', '', 'body'].join('\n');
    expect(parseFrontmatter(md)?.['name']).toBe('has: colon');
  });

  it("doubles-back single-quote escaping ('' → ')", () => {
    const md = ['---', "name: 'it''s mine'", '---', '', 'body'].join('\n');
    expect(parseFrontmatter(md)?.['name']).toBe("it's mine");
  });

  it('returns null for content without frontmatter', () => {
    expect(parseFrontmatter('no frontmatter here')).toBeNull();
  });

  it('returns null for unterminated frontmatter', () => {
    expect(parseFrontmatter('---\nname: foo\n')).toBeNull();
  });
});

describe('agents-sync engine', () => {
  let db: Database.Database;
  let ipc: ReturnType<typeof makeCapturingIpc>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(TMP_PARENT, 'sentinel-agents-sync-'));
    dbPath = join(tmpDir, 'sentinel.db');
    agentsDir = join(tmpDir, 'agents');
    process.env['CLAUDE_SENTINEL_TEST_DB_FILE'] = dbPath;
    db = getDb(dbPath);
    ipc = makeCapturingIpc();
  });

  afterEach(() => {
    closeDb();
    delete process.env['CLAUDE_SENTINEL_TEST_DB_FILE'];
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('installCuratedFile writes the .md and upserts a curated row', async () => {
    const engine = createAgentsSyncEngine({ db, ipcServer: ipc, agentsDir });
    await engine.start();

    const fe = getCuratedSubagent('file-explorer')!;
    const mdPath = join(agentsDir, 'file-explorer.md');
    await engine.installCuratedFile({
      name: fe.curatedId,
      mdPath,
      renderedMd: fe.renderedMd,
      curatedId: fe.curatedId,
      gapFingerprint: fe.fingerprint,
    });

    expect(existsSync(mdPath)).toBe(true);
    const onDisk = readFileSync(mdPath, 'utf8');
    expect(onDisk).toContain('name: file-explorer');
    expect(onDisk).toContain('model: haiku');

    const row = findSubagentInstallByName(db, 'file-explorer')!;
    expect(row.source).toBe('curated');
    expect(row.curatedId).toBe('file-explorer');
    expect(row.gapFingerprint).toBe(fe.fingerprint);
    expect(row.uninstalledAt).toBeNull();

    engine.stop();
  });

  it('uninstallByName removes the file and soft-deletes the row', async () => {
    const engine = createAgentsSyncEngine({ db, ipcServer: ipc, agentsDir });
    await engine.start();
    const fe = getCuratedSubagent('file-explorer')!;
    const mdPath = join(agentsDir, 'file-explorer.md');
    await engine.installCuratedFile({
      name: fe.curatedId,
      mdPath,
      renderedMd: fe.renderedMd,
      curatedId: fe.curatedId,
      gapFingerprint: fe.fingerprint,
    });

    await engine.uninstallByName('file-explorer');
    expect(existsSync(mdPath)).toBe(false);

    const row = findSubagentInstallByName(db, 'file-explorer')!;
    expect(row.uninstalledAt).not.toBeNull();

    // Default listSubagentInstalls hides uninstalled rows.
    const active = listSubagentInstalls(db);
    expect(active.find((r) => r.name === 'file-explorer')).toBeUndefined();
    engine.stop();
  });

  it('pullNow imports a user-authored .md as source=local', async () => {
    const engine = createAgentsSyncEngine({ db, ipcServer: ipc, agentsDir });
    await engine.start(); // creates the dir
    const userAuthored = [
      '---',
      'name: my-helper',
      'description: a personal helper',
      'model: sonnet',
      '---',
      '',
      'be useful',
      '',
    ].join('\n');
    writeFileSync(join(agentsDir, 'my-helper.md'), userAuthored, 'utf8');

    await engine.pullNow();
    const row = findSubagentInstallByName(db, 'my-helper')!;
    expect(row.source).toBe('local');
    expect(row.curatedId).toBeNull();
    expect(row.gapFingerprint).toBeNull();
    engine.stop();
  });

  it('pull preserves source=curated when a matching curated row exists', async () => {
    const engine = createAgentsSyncEngine({ db, ipcServer: ipc, agentsDir });
    await engine.start();
    const fe = getCuratedSubagent('file-explorer')!;
    const mdPath = join(agentsDir, 'file-explorer.md');
    await engine.installCuratedFile({
      name: fe.curatedId,
      mdPath,
      renderedMd: fe.renderedMd,
      curatedId: fe.curatedId,
      gapFingerprint: fe.fingerprint,
    });

    // Re-pull: row should stay curated.
    await engine.pullNow();
    const row = findSubagentInstallByName(db, 'file-explorer')!;
    expect(row.source).toBe('curated');
    expect(row.curatedId).toBe('file-explorer');
    engine.stop();
  });

  it('orphan cleanup soft-deletes a curated row whose file disappeared', async () => {
    const engine = createAgentsSyncEngine({ db, ipcServer: ipc, agentsDir });
    await engine.start();
    const fe = getCuratedSubagent('file-explorer')!;
    const mdPath = join(agentsDir, 'file-explorer.md');
    await engine.installCuratedFile({
      name: fe.curatedId,
      mdPath,
      renderedMd: fe.renderedMd,
      curatedId: fe.curatedId,
      gapFingerprint: fe.fingerprint,
    });

    unlinkSync(mdPath);
    await engine.pullNow();
    const row = findSubagentInstallByName(db, 'file-explorer')!;
    expect(row.uninstalledAt).not.toBeNull();
    engine.stop();
  });

  it('writes update md_hash when a user hand-edits a curated file', async () => {
    const engine = createAgentsSyncEngine({ db, ipcServer: ipc, agentsDir });
    await engine.start();
    const fe = getCuratedSubagent('file-explorer')!;
    const mdPath = join(agentsDir, 'file-explorer.md');
    await engine.installCuratedFile({
      name: fe.curatedId,
      mdPath,
      renderedMd: fe.renderedMd,
      curatedId: fe.curatedId,
      gapFingerprint: fe.fingerprint,
    });
    const originalHash = findSubagentInstallByName(db, 'file-explorer')!.mdHash;

    // User hand-edits — different content, same name in frontmatter.
    const edited = readFileSync(mdPath, 'utf8') + '\nappended line\n';
    writeFileSync(mdPath, edited, 'utf8');
    await engine.pullNow();
    const updated = findSubagentInstallByName(db, 'file-explorer')!;
    expect(updated.source).toBe('curated');
    expect(updated.mdHash).not.toBe(originalHash);
    engine.stop();
  });

  it('start emits an agents_sync_status broadcast on activation', async () => {
    const engine = createAgentsSyncEngine({ db, ipcServer: ipc, agentsDir });
    await engine.start();
    const statuses = ipc.broadcasts.filter((b) => b.type === 'agents_sync_status');
    expect(statuses.length).toBeGreaterThan(0);
    expect((statuses[0] as { status: { active: boolean } }).status.active).toBe(true);
    engine.stop();
  });

  it('skips local-source rows on push (push only writes curated rows)', async () => {
    const engine = createAgentsSyncEngine({ db, ipcServer: ipc, agentsDir });
    await engine.start();
    // Seed a local-source row by writing a file and pulling.
    const userAuthored = [
      '---',
      'name: localish',
      'description: x',
      'model: haiku',
      '---',
      '',
      'body',
      '',
    ].join('\n');
    writeFileSync(join(agentsDir, 'localish.md'), userAuthored, 'utf8');
    await engine.pullNow();
    expect(findSubagentInstallByName(db, 'localish')?.source).toBe('local');

    // Mutate the file directly (simulating user edits) and call push —
    // pushNow should NOT touch the file (source=local).
    const before = readFileSync(join(agentsDir, 'localish.md'), 'utf8');
    await engine.pushNow();
    const after = readFileSync(join(agentsDir, 'localish.md'), 'utf8');
    expect(after).toBe(before);
    engine.stop();
  });

  it('listSubagentInstalls(includeUninstalled=true) returns soft-deleted rows', async () => {
    const engine = createAgentsSyncEngine({ db, ipcServer: ipc, agentsDir });
    await engine.start();
    const fe = getCuratedSubagent('file-explorer')!;
    await engine.installCuratedFile({
      name: fe.curatedId,
      mdPath: join(agentsDir, 'file-explorer.md'),
      renderedMd: fe.renderedMd,
      curatedId: fe.curatedId,
      gapFingerprint: fe.fingerprint,
    });
    await engine.uninstallByName('file-explorer');

    const active = listSubagentInstalls(db);
    expect(active.find((r) => r.name === 'file-explorer')).toBeUndefined();

    const all = listSubagentInstalls(db, { includeUninstalled: true });
    expect(all.find((r) => r.name === 'file-explorer')).toBeDefined();
    engine.stop();
  });

  it('uninstallByName tolerates an already-missing file (ENOENT branch)', async () => {
    const engine = createAgentsSyncEngine({ db, ipcServer: ipc, agentsDir });
    await engine.start();
    upsertSubagentInstall(db, {
      name: 'gone',
      source: 'curated',
      curatedId: 'gone',
      gapFingerprint: 'x',
      mdPath: join(agentsDir, 'gone.md'),
      mdHash: '',
      installedAt: Date.now(),
    });
    // No file on disk; uninstall should still soft-delete the row.
    await engine.uninstallByName('gone');
    const row = findSubagentInstallByName(db, 'gone')!;
    expect(row.uninstalledAt).not.toBeNull();
    engine.stop();
  });

  it('uninstallByName is a no-op when no row exists', async () => {
    const engine = createAgentsSyncEngine({ db, ipcServer: ipc, agentsDir });
    await engine.start();
    await expect(engine.uninstallByName('never-installed')).resolves.toBeUndefined();
    engine.stop();
  });

  it('stop() is idempotent', async () => {
    const engine = createAgentsSyncEngine({ db, ipcServer: ipc, agentsDir });
    await engine.start();
    engine.stop();
    // Second stop should not throw.
    expect(() => engine.stop()).not.toThrow();
  });

  it('watcher event triggers a pull when the file content drifts', async () => {
    const engine = createAgentsSyncEngine({ db, ipcServer: ipc, agentsDir });
    await engine.start();
    const fe = getCuratedSubagent('file-explorer')!;
    const mdPath = join(agentsDir, 'file-explorer.md');
    await engine.installCuratedFile({
      name: fe.curatedId,
      mdPath,
      renderedMd: fe.renderedMd,
      curatedId: fe.curatedId,
      gapFingerprint: fe.fingerprint,
    });
    const originalHash = findSubagentInstallByName(db, 'file-explorer')!.mdHash;

    // Hand-edit the file (different content). The watcher should pick
    // it up after the debounce; pull updates md_hash.
    writeFileSync(mdPath, readFileSync(mdPath, 'utf8') + '\nhand-edit\n', 'utf8');
    // Wait past the 500ms debounce + a margin.
    await new Promise((r) => setTimeout(r, 800));
    const updated = findSubagentInstallByName(db, 'file-explorer')!;
    expect(updated.mdHash).not.toBe(originalHash);
    engine.stop();
  });

  it('pushNow detects a missing curated file and soft-deletes the row', async () => {
    const engine = createAgentsSyncEngine({ db, ipcServer: ipc, agentsDir });
    await engine.start();
    // Seed a curated row pointing at a missing path.
    upsertSubagentInstall(db, {
      name: 'phantom',
      source: 'curated',
      curatedId: 'phantom',
      gapFingerprint: 'deadbeef',
      mdPath: join(agentsDir, 'phantom.md'),
      mdHash: '',
      installedAt: Date.now(),
    });
    expect(findSubagentInstallByName(db, 'phantom')?.uninstalledAt).toBeNull();
    await engine.pushNow();
    expect(findSubagentInstallByName(db, 'phantom')?.uninstalledAt).not.toBeNull();
    engine.stop();
  });
});
