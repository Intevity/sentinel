/**
 * Optimize feature: install / uninstall flow end-to-end through the
 * full daemon (real IPC over Unix socket, real SQLite, real fs).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { startTestDaemon, type TestDaemon } from './index.test-helpers.js';

describe('Optimize IPC end-to-end', () => {
  let ctx: TestDaemon;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('list_installed_subagents returns [] on a fresh daemon', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<unknown[]>({ type: 'list_installed_subagents' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('get_curated_library returns six entries with stable ids', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<Array<{ curatedId: string }>>({ type: 'get_curated_library' });
    expect(r.success).toBe(true);
    const ids = (r.data ?? []).map((s) => s.curatedId).sort();
    expect(ids).toEqual([
      'diff-pre-pass',
      'file-explorer',
      'log-analyzer',
      'output-formatter',
      'repo-mapper',
      'test-runner-parser',
    ]);
  });

  it('install_curated_subagent writes the .md file and inserts a row', async () => {
    ctx = await startTestDaemon();
    const agentsDir = process.env['CLAUDE_SENTINEL_TEST_AGENTS_DIR']!;

    const r = await ctx.request<{ name: string; mdPath: string }>({
      type: 'install_curated_subagent',
      curatedId: 'file-explorer',
    });
    expect(r.success).toBe(true);
    expect(r.data?.name).toBe('file-explorer');

    const mdPath = join(agentsDir, 'file-explorer.md');
    expect(existsSync(mdPath)).toBe(true);
    const onDisk = readFileSync(mdPath, 'utf8');
    expect(onDisk).toContain('name: file-explorer');
    expect(onDisk).toContain('model: haiku');

    // list_installed_subagents now includes it.
    const r2 = await ctx.request<Array<{ name: string; source: string }>>({
      type: 'list_installed_subagents',
    });
    expect(r2.success).toBe(true);
    const found = (r2.data ?? []).find((s) => s.name === 'file-explorer');
    expect(found?.source).toBe('curated');
  });

  it('install_curated_subagent broadcasts subagent_installed', async () => {
    ctx = await startTestDaemon();
    await ctx.request({
      type: 'install_curated_subagent',
      curatedId: 'log-analyzer',
    });
    const installed = await ctx.waitForBroadcast<{
      type: 'subagent_installed';
      name: string;
      curatedId: string;
    }>((m) => m.type === 'subagent_installed', 2000);
    expect(installed.name).toBe('log-analyzer');
  });

  it('install_curated_subagent fails with unknown curated id', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'install_curated_subagent',
      curatedId: 'definitely-not-a-real-id',
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('unknown curated id');
  });

  it('uninstall_subagent removes the file and soft-deletes the row', async () => {
    ctx = await startTestDaemon();
    const agentsDir = process.env['CLAUDE_SENTINEL_TEST_AGENTS_DIR']!;
    await ctx.request({
      type: 'install_curated_subagent',
      curatedId: 'repo-mapper',
    });
    const mdPath = join(agentsDir, 'repo-mapper.md');
    expect(existsSync(mdPath)).toBe(true);

    const r = await ctx.request({ type: 'uninstall_subagent', name: 'repo-mapper' });
    expect(r.success).toBe(true);
    expect(existsSync(mdPath)).toBe(false);

    const r2 = await ctx.request<Array<{ name: string }>>({
      type: 'list_installed_subagents',
    });
    expect((r2.data ?? []).find((s) => s.name === 'repo-mapper')).toBeUndefined();
  });

  it('get_agents_sync_status returns active=true after start', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<{ active: boolean }>({ type: 'get_agents_sync_status' });
    expect(r.success).toBe(true);
    expect(r.data?.active).toBe(true);
  });

  it('install records an optimization_events row with kind=installed', async () => {
    ctx = await startTestDaemon();
    await ctx.request({
      type: 'install_curated_subagent',
      curatedId: 'test-runner-parser',
    });
    const inspect = new Database(ctx.dbPath, { readonly: true });
    try {
      const rows = inspect
        .prepare('SELECT * FROM optimization_events WHERE kind = ?')
        .all('installed') as Array<Record<string, unknown>>;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]?.['curated_id']).toBe('test-runner-parser');
    } finally {
      inspect.close();
    }
  });

  it('get_optimization_opportunities returns []', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<unknown[]>({ type: 'get_optimization_opportunities' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('get_optimization_metrics returns zeroed totals on a fresh daemon', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<{
      totals: {
        savingsUsdRealized: number;
        savingsUsdPotential: number;
        opportunities: number;
        installs: number;
      };
      bySubagent: Array<{
        curatedId: string;
        savingsRealized: number;
        savingsPotential: number;
        opportunities: number;
      }>;
    }>({
      type: 'get_optimization_metrics',
      days: 0,
    });
    expect(r.success).toBe(true);
    expect(r.data?.totals.installs).toBe(0);
    expect(r.data?.totals.savingsUsdRealized).toBe(0);
    expect(r.data?.totals.savingsUsdPotential).toBe(0);
    // bySubagent is the new contract surface for per-row attribution
    // badges; on a fresh daemon there's no opportunity data yet.
    expect(r.data?.bySubagent).toEqual([]);
  });

  it('get_optimization_metrics counts active installs (the original header bug)', async () => {
    ctx = await startTestDaemon();
    // Install two curated subagents.
    await ctx.request({ type: 'install_curated_subagent', curatedId: 'file-explorer' });
    await ctx.request({ type: 'install_curated_subagent', curatedId: 'log-analyzer' });

    const r = await ctx.request<{ totals: { installs: number } }>({
      type: 'get_optimization_metrics',
      days: 0,
    });
    expect(r.success).toBe(true);
    expect(r.data?.totals.installs).toBe(2);

    // After uninstall, count drops.
    await ctx.request({ type: 'uninstall_subagent', name: 'log-analyzer' });
    const r2 = await ctx.request<{ totals: { installs: number } }>({
      type: 'get_optimization_metrics',
      days: 0,
    });
    expect(r2.data?.totals.installs).toBe(1);
  });

  it('run_optimization_analysis returns success', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'run_optimization_analysis' });
    expect(r.success).toBe(true);
  });

  it('dismiss_optimization records an optimization_events row with kind=dismissed', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'dismiss_optimization',
      curatedId: 'file-explorer',
      pattern: 'short_turn_after_large_read',
    });
    expect(r.success).toBe(true);
    const inspect = new Database(ctx.dbPath, { readonly: true });
    try {
      const rows = inspect
        .prepare('SELECT * FROM optimization_events WHERE kind = ? AND curated_id = ?')
        .all('dismissed', 'file-explorer') as Array<Record<string, unknown>>;
      expect(rows.length).toBe(1);
      expect(rows[0]?.['pattern']).toBe('short_turn_after_large_read');
    } finally {
      inspect.close();
    }
  });
});
