/**
 * Retrieval MCP install/uninstall/status IPC flow end-to-end through the full
 * daemon (real IPC, real ~/.claude.json via the test env override).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpInstallRecord, RetrievalMcpStatus, Settings } from '@sentinel/shared';
import { startTestDaemon, type TestDaemon } from './index.test-helpers.js';

describe('Retrieval MCP IPC end-to-end', () => {
  let ctx: TestDaemon;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  it('reports no installs and disabled on a fresh daemon', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<RetrievalMcpStatus>({ type: 'get_retrieval_mcp_status' });
    expect(r.success).toBe(true);
    expect(r.data?.enabled).toBe(false);
    expect(r.data?.installs).toEqual([]);
    expect(r.data?.toolName).toBe('mcp__sentinel__retrieve');
    expect(r.data?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('installs at user scope: writes ~/.claude.json, enables retrieval, status reflects it', async () => {
    ctx = await startTestDaemon();
    const claudeJsonPath = process.env['SENTINEL_TEST_CLAUDE_JSON']!;

    const install = await ctx.request<{
      configPath: string;
      toolName: string;
      restartRequired: boolean;
    }>({
      type: 'install_retrieval_mcp',
      scope: 'user',
    });
    expect(install.success).toBe(true);
    expect(install.data?.toolName).toBe('mcp__sentinel__retrieve');
    expect(install.data?.restartRequired).toBe(true);

    // The config file now has the sentinel server entry.
    const cfg = JSON.parse(readFileSync(claudeJsonPath, 'utf-8')) as {
      mcpServers?: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    const entry = cfg.mcpServers?.['sentinel'];
    expect(entry?.type).toBe('http');
    expect(entry?.url).toMatch(/\/mcp$/);
    expect(entry?.headers?.['Authorization']).toMatch(/^Bearer [0-9a-f]{64}$/);

    // Settings flipped on, and status reflects the install.
    const settings = await ctx.request<Settings>({ type: 'get_settings' });
    expect(settings.data?.compressionRetrievalEnabled).toBe(true);

    const status = await ctx.request<RetrievalMcpStatus>({ type: 'get_retrieval_mcp_status' });
    expect(status.data?.enabled).toBe(true);
    expect(status.data?.installs).toEqual([
      expect.objectContaining({ scope: 'user', directory: null }),
    ]);
  });

  it('install at local/project requires a directory', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'install_retrieval_mcp', scope: 'local' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/directory is required/i);
  });

  it('installs at project scope into a chosen directory, then uninstalls', async () => {
    ctx = await startTestDaemon();
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-proj-ipc-'));
    tmpDirs.push(dir);

    const install = await ctx.request<{ configPath: string }>({
      type: 'install_retrieval_mcp',
      scope: 'project',
      directory: dir,
    });
    expect(install.success).toBe(true);
    expect(install.data?.configPath).toBe(join(dir, '.mcp.json'));
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true);

    let status = await ctx.request<RetrievalMcpStatus>({ type: 'get_retrieval_mcp_status' });
    expect(status.data?.installs).toEqual([
      expect.objectContaining({ scope: 'project', directory: dir }),
    ]);

    const uninstall = await ctx.request({
      type: 'uninstall_retrieval_mcp',
      scope: 'project',
      directory: dir,
    });
    expect(uninstall.success).toBe(true);

    status = await ctx.request<RetrievalMcpStatus>({ type: 'get_retrieval_mcp_status' });
    expect(status.data?.installs).toEqual([]);
    // The .mcp.json no longer contains the sentinel entry.
    const cfg = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8')) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(cfg.mcpServers?.['sentinel']).toBeUndefined();
  });

  // Reads permissions.allow from the test-redirected ~/.claude/settings.json —
  // the only scope Claude Code consults for SUBAGENTS. Missing file → [].
  const settingsAllow = (): string[] => {
    const p = process.env['SENTINEL_TEST_CLAUDE_SETTINGS_FILE']!;
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as {
      permissions?: { allow?: unknown };
    };
    const allow = parsed.permissions?.allow;
    return Array.isArray(allow) ? allow.filter((x): x is string => typeof x === 'string') : [];
  };

  it('auto-allows mcp__sentinel__retrieve in the DB AND settings.json on install, and removes it on uninstall', async () => {
    // Default settings → claudeCodeSyncEnabled is false, so the rule reaches
    // Claude Code ONLY via the direct settings.json write (sync's push is off).
    // This is the exact path that was broken: the rule lived in the DB but never
    // in settings.json, so subagents kept prompting.
    ctx = await startTestDaemon();
    const raws = async (): Promise<string[]> => {
      const r = await ctx.request<Array<{ raw: string; decision: string }>>({
        type: 'list_permission_rules',
      });
      return (r.data ?? []).map((x) => x.raw);
    };
    expect(await raws()).not.toContain('mcp__sentinel__retrieve');
    expect(settingsAllow()).not.toContain('mcp__sentinel__retrieve');

    await ctx.request({ type: 'install_retrieval_mcp', scope: 'user' });
    const afterInstall = await ctx.request<Array<{ raw: string; decision: string }>>({
      type: 'list_permission_rules',
    });
    expect(afterInstall.data).toContainEqual(
      expect.objectContaining({ raw: 'mcp__sentinel__retrieve', decision: 'allow' }),
    );
    // The real fix: it's now in the file the subagent permission check reads.
    expect(settingsAllow()).toContain('mcp__sentinel__retrieve');

    await ctx.request({ type: 'uninstall_retrieval_mcp', scope: 'user' });
    expect(await raws()).not.toContain('mcp__sentinel__retrieve');
    expect(settingsAllow()).not.toContain('mcp__sentinel__retrieve');
  });

  it("preserves the user's other settings.json keys when seeding the retrieve allow", async () => {
    ctx = await startTestDaemon({
      claudeSettings: {
        model: 'opusplan',
        permissions: { allow: ['Bash(ls)'], deny: ['Read(secret)'] },
      },
    });
    await ctx.request({ type: 'install_retrieval_mcp', scope: 'user' });

    const p = process.env['SENTINEL_TEST_CLAUDE_SETTINGS_FILE']!;
    const after = JSON.parse(readFileSync(p, 'utf8')) as {
      model?: string;
      permissions?: { allow?: string[]; deny?: string[] };
    };
    expect(after.permissions?.allow).toContain('mcp__sentinel__retrieve');
    expect(after.permissions?.allow).toContain('Bash(ls)'); // pre-existing kept
    expect(after.permissions?.deny).toEqual(['Read(secret)']); // untouched
    expect(after.model).toBe('opusplan'); // untouched
  });

  it('self-heals a prior-session retrieval install into settings.json on startup (no install call)', async () => {
    // A user who installed retrieval in a previous session has the DB rule but,
    // with sync off, never got the settings.json entry. Re-assert it at startup.
    ctx = await startTestDaemon({ settings: { compressionRetrievalEnabled: true } });
    expect(settingsAllow()).toContain('mcp__sentinel__retrieve');
  });

  it('self-heals the code-mode curl allow into settings.json on startup when code mode is on', async () => {
    ctx = await startTestDaemon({ settings: { codeModeEnabled: true } });
    expect(
      settingsAllow().some((r) =>
        /^Bash\(curl -s -X POST http:\/\/127\.0\.0\.1:\d+\/code-mode\/call:\*\)$/.test(r),
      ),
    ).toBe(true);
  });

  it('status prunes a recorded install whose config was removed externally', async () => {
    ctx = await startTestDaemon();
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-proj-prune-'));
    tmpDirs.push(dir);
    await ctx.request({ type: 'install_retrieval_mcp', scope: 'project', directory: dir });
    // Delete the .mcp.json out from under the daemon.
    rmSync(join(dir, '.mcp.json'));
    const status = await ctx.request<RetrievalMcpStatus>({ type: 'get_retrieval_mcp_status' });
    // The record is no longer verified present, so it's filtered from the view.
    expect((status.data?.installs as McpInstallRecord[]).some((i) => i.directory === dir)).toBe(
      false,
    );
  });
});
