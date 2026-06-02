/**
 * Retrieval MCP install/uninstall/status IPC flow end-to-end through the full
 * daemon (real IPC, real ~/.claude.json via the test env override).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpInstallRecord, RetrievalMcpStatus, Settings } from '@claude-sentinel/shared';
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
    const claudeJsonPath = process.env['CLAUDE_SENTINEL_TEST_CLAUDE_JSON']!;

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
