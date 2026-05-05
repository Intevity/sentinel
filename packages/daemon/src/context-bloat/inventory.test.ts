import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { getDb, closeDb, insertToolCall, upsertSubagentInstall } from '../db.js';
import { buildContextInventory } from './inventory.js';

const TMP_DB = `/tmp/sentinel-inventory-${process.pid}-${Date.now()}.db`;

describe('buildContextInventory', () => {
  let db: Database.Database;
  let homeDir: string;
  let claudeJsonPath: string;
  let projectDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'sentinel-inv-home-'));
    projectDir = mkdtempSync(join(tmpdir(), 'sentinel-inv-proj-'));
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    claudeJsonPath = join(homeDir, '.claude.json');
    process.env['CLAUDE_SENTINEL_TEST_HOME'] = homeDir;
    process.env['CLAUDE_SENTINEL_TEST_CLAUDE_JSON'] = claudeJsonPath;
    process.env['CLAUDE_SENTINEL_TEST_DB_FILE'] = TMP_DB;
    db = getDb(TMP_DB);
    db.exec('DELETE FROM tool_calls; DELETE FROM subagent_installs');
  });
  afterEach(() => {
    closeDb();
    delete process.env['CLAUDE_SENTINEL_TEST_HOME'];
    delete process.env['CLAUDE_SENTINEL_TEST_CLAUDE_JSON'];
    delete process.env['CLAUDE_SENTINEL_TEST_DB_FILE'];
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    try {
      unlinkSync(TMP_DB);
    } catch {
      /* ignore */
    }
  });

  it('returns an empty inventory on a fresh user state', () => {
    const inv = buildContextInventory(db);
    expect(inv).toEqual({
      mcpServers: [],
      claudeMdFiles: [],
      memoryDirs: [],
      plugins: [],
      globalSubagents: [],
    });
  });

  it('joins MCP detection with 7-day cost stats and sorts by tokens desc', () => {
    writeFileSync(
      claudeJsonPath,
      JSON.stringify({
        projects: {
          [projectDir]: {
            mcpServers: { github: {}, atlassian: {} },
          },
        },
      }),
    );
    insertToolCall(db, {
      ts: Date.now(),
      accountId: 'a',
      sessionId: 's',
      requestId: 'r1',
      requestSeqInSession: 1,
      toolUseId: 'tu1',
      toolName: 'mcp__github__pr_read',
      filePath: null,
      inputSizeBytes: 200,
      responseSizeBytes: 80_000,
      denied: false,
      model: 'claude-opus-4-7',
    });
    insertToolCall(db, {
      ts: Date.now(),
      accountId: 'a',
      sessionId: 's',
      requestId: 'r2',
      requestSeqInSession: 2,
      toolUseId: 'tu2',
      toolName: 'mcp__atlassian__jira_search',
      filePath: null,
      inputSizeBytes: 50,
      responseSizeBytes: 4_000,
      denied: false,
      model: 'claude-opus-4-7',
    });
    const inv = buildContextInventory(db);
    expect(inv.mcpServers.map((s) => s.name)).toEqual(['github', 'atlassian']);
    expect(inv.mcpServers[0]?.recent7d.calls).toBe(1);
    expect(inv.mcpServers[0]?.recent7d.bytesOut).toBe(80_000);
    expect(inv.mcpServers[0]?.enabled).toBe(true);
    // Server with no calls still appears (with zeroed recent7d) when configured.
    expect(inv.mcpServers[1]?.recent7d.calls).toBe(1);
  });

  it('reports configured MCP servers even with zero recent activity', () => {
    writeFileSync(
      claudeJsonPath,
      JSON.stringify({
        projects: { [projectDir]: { mcpServers: { unused: {} } } },
      }),
    );
    const inv = buildContextInventory(db);
    expect(inv.mcpServers).toHaveLength(1);
    expect(inv.mcpServers[0]?.recent7d.calls).toBe(0);
    expect(inv.mcpServers[0]?.recent7d.estimatedTokens).toBe(0);
  });

  it('includes global CLAUDE.md and project memory dirs', () => {
    writeFileSync(join(homeDir, '.claude', 'CLAUDE.md'), 'global rules');
    writeFileSync(claudeJsonPath, JSON.stringify({ projects: { [projectDir]: {} } }));
    writeFileSync(join(projectDir, 'CLAUDE.md'), 'project rules');
    mkdirSync(join(homeDir, '.claude', 'projects', 'my-proj', 'memory'), {
      recursive: true,
    });
    writeFileSync(join(homeDir, '.claude', 'projects', 'my-proj', 'memory', 'a.md'), 'memory line');

    const inv = buildContextInventory(db);
    expect(inv.claudeMdFiles).toHaveLength(2);
    expect(inv.claudeMdFiles.map((f) => f.scope).sort()).toEqual(['global', 'project']);
    expect(inv.memoryDirs).toHaveLength(1);
    expect(inv.memoryDirs[0]?.projectId).toBe('my-proj');
    expect(inv.memoryDirs[0]?.fileCount).toBe(1);
  });

  it('reports enabled plugins from settings.json', () => {
    writeFileSync(
      join(homeDir, '.claude', 'settings.json'),
      JSON.stringify({
        enabledPlugins: { 'figma@1': true, 'review@2': true, 'old@0': false },
      }),
    );
    const inv = buildContextInventory(db);
    const names = inv.plugins.map((p) => p.name).sort();
    expect(names).toEqual(['figma@1', 'review@2']);
  });

  it('reports active subagents from the DB', () => {
    upsertSubagentInstall(db, {
      name: 'file-explorer',
      source: 'curated',
      curatedId: 'file-explorer',
      gapFingerprint: null,
      mdPath: '/tmp/fe.md',
      mdHash: 'h',
      installedAt: Date.now(),
    });
    upsertSubagentInstall(db, {
      name: 'my-local',
      source: 'local',
      curatedId: null,
      gapFingerprint: null,
      mdPath: '/tmp/my.md',
      mdHash: 'h2',
      installedAt: Date.now(),
    });
    const inv = buildContextInventory(db);
    expect(inv.globalSubagents).toHaveLength(2);
    const sources = inv.globalSubagents.map((s) => s.source).sort();
    expect(sources).toEqual(['curated', 'local']);
  });

  it('safely handles a corrupt claude.json without crashing', () => {
    writeFileSync(claudeJsonPath, '{not valid json');
    const inv = buildContextInventory(db);
    expect(inv.mcpServers).toEqual([]);
    expect(inv.claudeMdFiles).toEqual([]);
  });
});
