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

  it('get_curated_library returns the curated entries with stable ids', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<Array<{ curatedId: string }>>({ type: 'get_curated_library' });
    expect(r.success).toBe(true);
    const ids = (r.data ?? []).map((s) => s.curatedId).sort();
    expect(ids).toEqual([
      'dep-tracer',
      'diff-pre-pass',
      'file-explorer',
      'log-analyzer',
      'output-formatter',
      'repo-mapper',
      'test-failure-investigator',
      'test-runner-parser',
      'web-fetcher',
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

  it('list_optimization_events returns measured rows with hydrated source calls', async () => {
    ctx = await startTestDaemon();

    // Seed a tool_call and a measured optimization_event referencing it,
    // then verify list_optimization_events can resolve the linkage end-
    // to-end through the IPC.
    const seed = new Database(ctx.dbPath);
    try {
      const ts = Date.now();
      const tcInfo = seed
        .prepare(
          `INSERT INTO tool_calls
             (ts, account_id, session_id, request_id, request_seq_in_session,
              tool_use_id, tool_name, file_path, input_size_bytes,
              response_size_bytes, was_quoted_in_later_turn, denied, model)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ts,
          'acct-x',
          'sess-x',
          'req-x',
          1,
          'toolu_x',
          'Read',
          '/seed.ts',
          50,
          99_000,
          0,
          0,
          'claude-opus-4-7',
        );
      const tcId = Number(tcInfo.lastInsertRowid);
      seed
        .prepare(
          `INSERT INTO optimization_events
             (ts, account_id, session_id, curated_id, kind, pattern,
              savings_usd, actual_input_tokens, actual_cached_tokens,
              actual_cost_usd, hypothetical_cost_usd, source_tool_call_ids)
           VALUES (?, ?, ?, ?, 'measured', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ts,
          'acct-x',
          'sess-x',
          'file-explorer',
          'short_turn_after_large_read',
          0.42,
          1000,
          0,
          0.5,
          0.08,
          JSON.stringify([tcId]),
        );
    } finally {
      seed.close();
    }

    const r = await ctx.request<{
      events: Array<{
        curatedId: string;
        savingsUsd: number | null;
        realized: boolean;
        sourceCalls: Array<{ filePath: string | null; responseSizeBytes: number | null }>;
      }>;
    }>({ type: 'list_optimization_events' });
    expect(r.success).toBe(true);
    expect(r.data?.events).toHaveLength(1);
    const ev = r.data?.events[0];
    expect(ev?.curatedId).toBe('file-explorer');
    expect(ev?.savingsUsd).toBe(0.42);
    expect(ev?.realized).toBe(false);
    expect(ev?.sourceCalls).toHaveLength(1);
    expect(ev?.sourceCalls[0]?.filePath).toBe('/seed.ts');
    expect(ev?.sourceCalls[0]?.responseSizeBytes).toBe(99_000);
  });

  it('get_context_inventory returns the empty shape on a fresh daemon', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<{
      mcpServers: unknown[];
      claudeMdFiles: unknown[];
      memoryDirs: unknown[];
      plugins: unknown[];
      globalSubagents: unknown[];
    }>({ type: 'get_context_inventory' });
    expect(r.success).toBe(true);
    // The test daemon's home/CLAUDE_JSON env vars point at empty fixture
    // dirs, so every section must be a (possibly empty) array.
    expect(Array.isArray(r.data?.mcpServers)).toBe(true);
    expect(Array.isArray(r.data?.claudeMdFiles)).toBe(true);
    expect(Array.isArray(r.data?.memoryDirs)).toBe(true);
    expect(Array.isArray(r.data?.plugins)).toBe(true);
    expect(Array.isArray(r.data?.globalSubagents)).toBe(true);
  });

  it('get_context_inventory surfaces installed subagents in globalSubagents', async () => {
    ctx = await startTestDaemon();
    await ctx.request({ type: 'install_curated_subagent', curatedId: 'file-explorer' });
    const r = await ctx.request<{
      globalSubagents: Array<{ name: string; source: string }>;
    }>({ type: 'get_context_inventory' });
    expect(r.success).toBe(true);
    const names = (r.data?.globalSubagents ?? []).map((s) => s.name);
    expect(names).toContain('file-explorer');
    const fe = r.data?.globalSubagents.find((s) => s.name === 'file-explorer');
    expect(fe?.source).toBe('curated');
  });

  it('list_optimization_events filter realized=true narrows to install-covered events', async () => {
    ctx = await startTestDaemon();
    // Install file-explorer first so subagent_installs.installed_at <
    // the seeded event's ts. Without this, the LEFT JOIN's CASE returns 0.
    await ctx.request({ type: 'install_curated_subagent', curatedId: 'file-explorer' });

    const seed = new Database(ctx.dbPath);
    try {
      const ts = Date.now() + 5_000;
      seed
        .prepare(
          `INSERT INTO optimization_events
             (ts, account_id, session_id, curated_id, kind, pattern,
              savings_usd, source_tool_call_ids)
           VALUES (?, ?, ?, 'file-explorer', 'measured', ?, ?, '[]')`,
        )
        .run(ts, 'acct-x', 'sess-x', 'short_turn_after_large_read', 0.21);
      seed
        .prepare(
          `INSERT INTO optimization_events
             (ts, account_id, session_id, curated_id, kind, pattern,
              savings_usd, source_tool_call_ids)
           VALUES (?, ?, ?, 'log-analyzer', 'measured', ?, ?, '[]')`,
        )
        .run(ts, 'acct-x', 'sess-x', 'bash_log_parse', 0.34);
    } finally {
      seed.close();
    }

    const realizedR = await ctx.request<{
      events: Array<{ curatedId: string; realized: boolean }>;
    }>({ type: 'list_optimization_events', realized: true });
    expect(realizedR.success).toBe(true);
    const realizedEvents = realizedR.data?.events ?? [];
    expect(realizedEvents.every((e) => e.realized)).toBe(true);
    expect(realizedEvents.some((e) => e.curatedId === 'file-explorer')).toBe(true);
    expect(realizedEvents.some((e) => e.curatedId === 'log-analyzer')).toBe(false);

    const potentialR = await ctx.request<{
      events: Array<{ curatedId: string; realized: boolean }>;
    }>({ type: 'list_optimization_events', realized: false });
    const potentialEvents = potentialR.data?.events ?? [];
    expect(potentialEvents.every((e) => !e.realized)).toBe(true);
    expect(potentialEvents.some((e) => e.curatedId === 'log-analyzer')).toBe(true);
  });
});
