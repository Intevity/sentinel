/**
 * Code-mode migration flow end-to-end through the full daemon: real IPC,
 * real ~/.claude.json (test env override), real fake MCP server, real
 * workspace + skill files in the test workdir, and a real HTTP round trip
 * against the daemon's /code-mode/call endpoint.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeModeStatus, McpContextCosts, Settings } from '@sentinel/shared';
import {
  startFakeMcpHttpServer,
  FAKE_MCP_TOOLS,
  type FakeMcpHttpServer,
} from '@sentinel/test-harness';
import { startTestDaemon, type TestDaemon } from './index.test-helpers.js';
import { getOrCreateCodeModeToken } from './optimize/code-mode/code-mode-token.js';

const SERVER_ENTRY_HEADERS = { 'X-Fake-Key': 'fake-secret-value' };

describe('code-mode IPC end-to-end', () => {
  let ctx: TestDaemon;
  let fakeMcp: FakeMcpHttpServer | null = null;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
    if (fakeMcp) await fakeMcp.close();
    fakeMcp = null;
  });

  function claudeJson(): Record<string, unknown> {
    return JSON.parse(readFileSync(ctx.claudeJsonPath, 'utf-8')) as Record<string, unknown>;
  }

  it('reports disabled status with no migrations on a fresh daemon', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<CodeModeStatus>({ type: 'get_code_mode_status' });
    expect(r.success).toBe(true);
    expect(r.data?.enabled).toBe(false);
    expect(r.data?.skillInstalled).toBe(false);
    expect(r.data?.migrations).toEqual([]);
    expect(r.data?.endpointUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/code-mode\/call$/);
  });

  it('migrates a server: verify → workspace → skill → disable → callable via the endpoint → revert', async () => {
    fakeMcp = await startFakeMcpHttpServer();
    const entry = { type: 'http', url: fakeMcp.url, headers: SERVER_ENTRY_HEADERS };
    ctx = await startTestDaemon({
      claudeState: { mcpServers: { fakemcp: entry } },
    });
    const workspaceDir = join(ctx.workdir, 'code-mode');

    // Migrate.
    const migrate = await ctx.request<{
      restartRequired: boolean;
      workspaceDir: string;
      toolCount: number;
      entriesDisabled: number;
    }>({ type: 'migrate_server_to_code_mode', server: 'fakemcp' });
    expect(migrate.success).toBe(true);
    expect(migrate.data?.restartRequired).toBe(true);
    expect(migrate.data?.toolCount).toBe(FAKE_MCP_TOOLS.length);
    expect(migrate.data?.entriesDisabled).toBe(1);

    // Native entry removed from claude.json.
    expect((claudeJson()['mcpServers'] as Record<string, unknown>)['fakemcp']).toBeUndefined();

    // Workspace files exist and carry no secrets.
    const indexMd = readFileSync(join(workspaceDir, 'servers', 'fakemcp', 'index.md'), 'utf-8');
    expect(indexMd).toContain('## Tools (4)');
    const echoMd = readFileSync(
      join(workspaceDir, 'servers', 'fakemcp', 'tools', 'echo.md'),
      'utf-8',
    );
    expect(echoMd).toContain('Echo the arguments back as JSON text');
    expect(indexMd + echoMd).not.toContain('fake-secret-value');

    // Skill installed under the test home; token file 0600 and not inlined.
    const skillPath = join(ctx.workdir, '.claude', 'skills', 'sentinel-code-mode', 'SKILL.md');
    const skill = readFileSync(skillPath, 'utf-8');
    expect(skill).toContain('fakemcp');
    expect(skill).not.toContain('fake-secret-value');
    const tokenFile = join(workspaceDir, '.token');
    expect(readFileSync(tokenFile, 'utf-8').trim()).toBe(getOrCreateCodeModeToken());
    expect(skill).not.toContain(getOrCreateCodeModeToken());
    if (process.platform !== 'win32') {
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    }

    // Settings recorded. The stash keeps only non-secret config: the header
    // moves to the keychain, so settings.json never holds the credential.
    const settings = await ctx.request<Settings>({ type: 'get_settings' });
    expect(settings.data?.codeModeEnabled).toBe(true);
    expect(settings.data?.codeModeMigrations).toHaveLength(1);
    expect(settings.data?.codeModeMigrations[0]).toMatchObject({
      server: 'fakemcp',
      scope: 'user',
      directory: null,
      originalEntry: { type: 'http', url: fakeMcp.url },
      secretKeys: ['headers.X-Fake-Key'],
      // Realized-savings baseline is snapshotted at migration time so the
      // request count starts from zero rather than the day bucket.
      baselineNativeRequests: expect.any(Number),
      baselineServerRequests: expect.any(Number),
    });
    expect(settings.data?.codeModeMigrations[0]?.secretRef).toMatch(/^fakemcp-[0-9a-f]{32}$/);
    expect(readFileSync(ctx.settingsPath, 'utf-8')).not.toContain('fake-secret-value');

    // Status: one un-drifted migration.
    const status = await ctx.request<CodeModeStatus>({ type: 'get_code_mode_status' });
    expect(status.data?.enabled).toBe(true);
    expect(status.data?.migrations).toEqual([
      expect.objectContaining({ server: 'fakemcp', drifted: false }),
    ]);

    // Bridge round trip through the daemon's real HTTP server.
    const call = await fetch(`http://127.0.0.1:${ctx.daemonPort}/code-mode/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getOrCreateCodeModeToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ server: 'fakemcp', tool: 'add', args: { a: 20, b: 22 } }),
    });
    expect(call.status).toBe(200);
    expect(await call.json()).toEqual({
      ok: true,
      isError: false,
      truncated: false,
      content: [{ type: 'text', text: '42' }],
    });

    // Audit row visible over IPC.
    const audit = await ctx.request<Array<{ server: string; tool: string; ok: boolean }>>({
      type: 'get_code_mode_audit',
    });
    expect(audit.data).toEqual([
      expect.objectContaining({ server: 'fakemcp', tool: 'add', ok: true }),
    ]);

    // Insights mark the server bridged.
    const costs = await ctx.request<McpContextCosts>({ type: 'get_mcp_context_costs' });
    const insight = costs.data?.insights.find((i) => i.server === 'fakemcp');
    expect(insight?.bridgeStatus).toBe('bridged');

    // Revert: entry restored byte-identically (including the secret header),
    // skill + workspace cleaned up, settings flipped back.
    const revert = await ctx.request({
      type: 'revert_server_from_code_mode',
      server: 'fakemcp',
    });
    expect(revert.success).toBe(true);
    expect((claudeJson()['mcpServers'] as Record<string, unknown>)['fakemcp']).toEqual(entry);
    expect(existsSync(join(workspaceDir, 'servers', 'fakemcp'))).toBe(false);
    expect(existsSync(skillPath)).toBe(false);
    const after = await ctx.request<Settings>({ type: 'get_settings' });
    expect(after.data?.codeModeEnabled).toBe(false);
    expect(after.data?.codeModeMigrations).toEqual([]);
  });

  it('refuses to migrate when the server cannot be verified, leaving the config untouched', async () => {
    // Point the entry at a port nothing listens on.
    const entry = { type: 'http', url: 'http://127.0.0.1:1/mcp' };
    ctx = await startTestDaemon({
      claudeState: { mcpServers: { deadmcp: entry } },
    });
    const migrate = await ctx.request({
      type: 'migrate_server_to_code_mode',
      server: 'deadmcp',
    });
    expect(migrate.success).toBe(false);
    expect(migrate.error).toMatch(/Could not connect to 'deadmcp'/);
    expect(migrate.error).toMatch(/left untouched/);
    expect((claudeJson()['mcpServers'] as Record<string, unknown>)['deadmcp']).toEqual(entry);
    const status = await ctx.request<CodeModeStatus>({ type: 'get_code_mode_status' });
    expect(status.data?.migrations).toEqual([]);
  });

  it('errors on migrating a server that is not configured', async () => {
    ctx = await startTestDaemon();
    const migrate = await ctx.request({
      type: 'migrate_server_to_code_mode',
      server: 'ghost',
    });
    expect(migrate.success).toBe(false);
    expect(migrate.error).toMatch(/'ghost' not found in ~\/.claude.json/);
  });

  it('flags drift when the user hand-restores a migrated entry', async () => {
    fakeMcp = await startFakeMcpHttpServer();
    const entry = { type: 'http', url: fakeMcp.url };
    ctx = await startTestDaemon({
      claudeState: { mcpServers: { fakemcp: entry } },
    });
    await ctx.request({ type: 'migrate_server_to_code_mode', server: 'fakemcp' });

    // Hand-edit claude.json: put the entry back.
    const state = claudeJson();
    (state['mcpServers'] as Record<string, unknown>)['fakemcp'] = entry;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(ctx.claudeJsonPath, JSON.stringify(state, null, 2));

    const status = await ctx.request<CodeModeStatus>({ type: 'get_code_mode_status' });
    expect(status.data?.migrations).toEqual([
      expect.objectContaining({ server: 'fakemcp', drifted: true }),
    ]);
  });

  it('plain disable/enable round-trips a server without bridging it', async () => {
    const entry = { command: 'npx', args: ['-y', 'some-mcp'], env: { KEY: 'v' } };
    ctx = await startTestDaemon({
      claudeState: { mcpServers: { plain: entry } },
    });

    const disable = await ctx.request({
      type: 'disable_mcp_server',
      server: 'plain',
      scope: 'user',
    });
    expect(disable.success).toBe(true);
    expect((claudeJson()['mcpServers'] as Record<string, unknown>)['plain']).toBeUndefined();

    // Disabled, NOT bridged: the endpoint must refuse it even with the token.
    const call = await fetch(`http://127.0.0.1:${ctx.daemonPort}/code-mode/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getOrCreateCodeModeToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ server: 'plain', tool: 'echo', args: {} }),
    });
    expect(call.status).toBe(403);

    const enable = await ctx.request({
      type: 'enable_mcp_server',
      server: 'plain',
      scope: 'user',
    });
    expect(enable.success).toBe(true);
    expect((claudeJson()['mcpServers'] as Record<string, unknown>)['plain']).toEqual(entry);

    // A second enable has no stash left.
    const again = await ctx.request({
      type: 'enable_mcp_server',
      server: 'plain',
      scope: 'user',
    });
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/No stashed entry/);
  });

  it('requires a directory for non-user scopes on disable', async () => {
    ctx = await startTestDaemon();
    const d = await ctx.request({ type: 'disable_mcp_server', server: 's', scope: 'local' });
    expect(d.success).toBe(false);
    expect(d.error).toMatch(/directory is required/);
  });

  it('errors on reverting a server with no recorded migration', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({
      type: 'revert_server_from_code_mode',
      server: 'nope',
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No recorded code-mode migration for 'nope'\./);
  });

  it('migrates every scope at once (global + project entries) and reverts them all', async () => {
    fakeMcp = await startFakeMcpHttpServer();
    const globalEntry = { type: 'http', url: fakeMcp.url, headers: SERVER_ENTRY_HEADERS };
    const projEntryA = { type: 'http', url: fakeMcp.url };
    const projEntryB = { type: 'http', url: fakeMcp.url, headers: { 'X-Proj': 'b' } };
    ctx = await startTestDaemon({
      claudeState: {
        mcpServers: { fakemcp: globalEntry },
        projects: {
          '/proj/a': { mcpServers: { fakemcp: projEntryA } },
          '/proj/b': { mcpServers: { fakemcp: projEntryB }, disabledMcpServers: [] },
        },
      },
    });

    const migrate = await ctx.request<{ entriesDisabled: number }>({
      type: 'migrate_server_to_code_mode',
      server: 'fakemcp',
    });
    expect(migrate.success).toBe(true);
    // Claude Code resolves local-over-global: all three entries must go.
    expect(migrate.data?.entriesDisabled).toBe(3);

    const state = claudeJson();
    expect((state['mcpServers'] as Record<string, unknown>)['fakemcp']).toBeUndefined();
    const projects = state['projects'] as Record<string, Record<string, unknown>>;
    expect(
      (projects['/proj/a']!['mcpServers'] as Record<string, unknown>)['fakemcp'],
    ).toBeUndefined();
    expect(
      (projects['/proj/b']!['mcpServers'] as Record<string, unknown>)['fakemcp'],
    ).toBeUndefined();
    // Local-scope disables leave the canonical disabled marker.
    expect(projects['/proj/a']!['disabledMcpServers']).toEqual(['fakemcp']);
    expect(projects['/proj/b']!['disabledMcpServers']).toEqual(['fakemcp']);

    const status = await ctx.request<CodeModeStatus>({ type: 'get_code_mode_status' });
    expect(status.data?.migrations).toHaveLength(3);

    // Re-running with nothing left to bridge refuses clearly.
    const again = await ctx.request({ type: 'migrate_server_to_code_mode', server: 'fakemcp' });
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/already bridged/);

    // Revert restores every entry byte-identically and clears the markers.
    const revert = await ctx.request({ type: 'revert_server_from_code_mode', server: 'fakemcp' });
    expect(revert.success).toBe(true);
    const after = claudeJson();
    expect((after['mcpServers'] as Record<string, unknown>)['fakemcp']).toEqual(globalEntry);
    const afterProjects = after['projects'] as Record<string, Record<string, unknown>>;
    expect((afterProjects['/proj/a']!['mcpServers'] as Record<string, unknown>)['fakemcp']).toEqual(
      projEntryA,
    );
    expect((afterProjects['/proj/b']!['mcpServers'] as Record<string, unknown>)['fakemcp']).toEqual(
      projEntryB,
    );
    expect(afterProjects['/proj/a']!['disabledMcpServers']).toEqual([]);
    expect(afterProjects['/proj/b']!['disabledMcpServers']).toEqual([]);
    const status2 = await ctx.request<CodeModeStatus>({ type: 'get_code_mode_status' });
    expect(status2.data?.migrations).toEqual([]);
  });

  it('re-running migrate bridges entries added since the first migration', async () => {
    fakeMcp = await startFakeMcpHttpServer();
    const entry = { type: 'http', url: fakeMcp.url };
    ctx = await startTestDaemon({
      claudeState: { mcpServers: { fakemcp: entry } },
    });
    const first = await ctx.request<{ entriesDisabled: number }>({
      type: 'migrate_server_to_code_mode',
      server: 'fakemcp',
    });
    expect(first.data?.entriesDisabled).toBe(1);

    // A project entry appears AFTER the first migration (e.g. the user added
    // the server to a new project) — exactly the partial-bridge situation.
    const state = claudeJson();
    state['projects'] = { '/proj/new': { mcpServers: { fakemcp: entry } } };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(ctx.claudeJsonPath, JSON.stringify(state, null, 2));

    const second = await ctx.request<{ entriesDisabled: number }>({
      type: 'migrate_server_to_code_mode',
      server: 'fakemcp',
    });
    expect(second.success).toBe(true);
    expect(second.data?.entriesDisabled).toBe(1);
    const status = await ctx.request<CodeModeStatus>({ type: 'get_code_mode_status' });
    expect(status.data?.migrations).toHaveLength(2);

    // One revert restores both.
    await ctx.request({ type: 'revert_server_from_code_mode', server: 'fakemcp' });
    const after = claudeJson();
    expect((after['mcpServers'] as Record<string, unknown>)['fakemcp']).toEqual(entry);
    const proj = (after['projects'] as Record<string, Record<string, unknown>>)['/proj/new']!;
    expect((proj['mcpServers'] as Record<string, unknown>)['fakemcp']).toEqual(entry);
  });

  // ─── Subagent bridge: CLAUDE.md block + endpoint allow rule ──────────

  function claudeMdPath(): string {
    return join(ctx.workdir, '.claude', 'CLAUDE.md');
  }
  async function ruleRaws(): Promise<string[]> {
    const r = await ctx.request<Array<{ raw: string; decision: string }>>({
      type: 'list_permission_rules',
    });
    return (r.data ?? []).map((x) => x.raw);
  }

  it('writes the CLAUDE.md bridge block + endpoint allow rule on migrate, and removes them on revert', async () => {
    fakeMcp = await startFakeMcpHttpServer();
    const entry = { type: 'http', url: fakeMcp.url };
    ctx = await startTestDaemon({ claudeState: { mcpServers: { fakemcp: entry } } });
    const curlRule = `Bash(curl -s -X POST http://127.0.0.1:${ctx.daemonPort}/code-mode/call:*)`;

    await ctx.request({ type: 'migrate_server_to_code_mode', server: 'fakemcp' });

    const md = readFileSync(claudeMdPath(), 'utf-8');
    expect(md).toContain('BEGIN SENTINEL CODE-MODE (managed)');
    expect(md).toContain('fakemcp');
    expect(md).toContain(`http://127.0.0.1:${ctx.daemonPort}/code-mode/call`);

    const settings = await ctx.request<Settings>({ type: 'get_settings' });
    expect(settings.data?.codeModeClaudeMdInstalled).toBe(true);

    const status = await ctx.request<CodeModeStatus>({ type: 'get_code_mode_status' });
    expect(status.data?.claudeMdBlock).toEqual({ present: true, upToDate: true });

    expect(await ruleRaws()).toContain(curlRule);

    await ctx.request({ type: 'revert_server_from_code_mode', server: 'fakemcp' });
    expect(readFileSync(claudeMdPath(), 'utf-8')).not.toContain('BEGIN SENTINEL CODE-MODE');
    expect(await ruleRaws()).not.toContain(curlRule);
    const status2 = await ctx.request<CodeModeStatus>({ type: 'get_code_mode_status' });
    expect(status2.data?.claudeMdBlock).toEqual({ present: false, upToDate: true });
  });

  it('preloads sentinel-code-mode into installed Bash-capable curated agents while bridged', async () => {
    fakeMcp = await startFakeMcpHttpServer();
    const entry = { type: 'http', url: fakeMcp.url };
    ctx = await startTestDaemon({ claudeState: { mcpServers: { fakemcp: entry } } });
    const agentPath = join(ctx.workdir, 'agents', 'file-explorer.md');

    // Install a Bash-capable curated agent — skill-free by default.
    await ctx.request({ type: 'install_curated_subagent', curatedId: 'file-explorer' });
    expect(readFileSync(agentPath, 'utf-8')).not.toMatch(/^skills:/m);

    // Migrating a server preloads the skill into it.
    await ctx.request({ type: 'migrate_server_to_code_mode', server: 'fakemcp' });
    expect(readFileSync(agentPath, 'utf-8')).toMatch(/^skills: \[sentinel-code-mode\]$/m);

    // Reverting the last server strips it again (no dangling skills reference).
    await ctx.request({ type: 'revert_server_from_code_mode', server: 'fakemcp' });
    expect(readFileSync(agentPath, 'utf-8')).not.toMatch(/^skills:/m);
  });

  it('repairs a hand-deleted CLAUDE.md block, preserving user content', async () => {
    fakeMcp = await startFakeMcpHttpServer();
    const entry = { type: 'http', url: fakeMcp.url };
    ctx = await startTestDaemon({ claudeState: { mcpServers: { fakemcp: entry } } });
    await ctx.request({ type: 'migrate_server_to_code_mode', server: 'fakemcp' });

    // User wipes the block, leaving their own note.
    writeFileSync(claudeMdPath(), '# only my notes\n');
    const drift = await ctx.request<CodeModeStatus>({ type: 'get_code_mode_status' });
    expect(drift.data?.claudeMdBlock.present).toBe(false);

    const repair = await ctx.request<{ repaired: boolean }>({ type: 'repair_code_mode_bridge' });
    expect(repair.data?.repaired).toBe(true);
    const md = readFileSync(claudeMdPath(), 'utf-8');
    expect(md).toContain('# only my notes');
    expect(md).toContain('BEGIN SENTINEL CODE-MODE');
    const status = await ctx.request<CodeModeStatus>({ type: 'get_code_mode_status' });
    expect(status.data?.claudeMdBlock).toEqual({ present: true, upToDate: true });
  });

  it('repair is a no-op when code mode is disabled', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request<{ repaired: boolean }>({ type: 'repair_code_mode_bridge' });
    expect(r.success).toBe(true);
    expect(r.data?.repaired).toBe(false);
  });

  it('self-heals a missing CLAUDE.md block at startup when migrations already exist', async () => {
    ctx = await startTestDaemon({
      settings: {
        codeModeEnabled: true,
        codeModeSkillInstalled: true,
        // Claims installed, but no file exists on disk → startup detects drift.
        codeModeClaudeMdInstalled: true,
        codeModeMigrations: [
          {
            server: 'preexisting',
            scope: 'user',
            directory: null,
            originalEntry: { type: 'http', url: 'http://example.invalid' },
            migratedAt: 1,
            baselineNativeRequests: 0,
            baselineServerRequests: 0,
          },
        ],
      },
    });
    const md = readFileSync(claudeMdPath(), 'utf-8');
    expect(md).toContain('BEGIN SENTINEL CODE-MODE');
    expect(md).toContain('preexisting');
    const status = await ctx.request<CodeModeStatus>({ type: 'get_code_mode_status' });
    expect(status.data?.claudeMdBlock).toEqual({ present: true, upToDate: true });
  });
});

/**
 * Credential lifecycle for an already-bridged server. Bridging deletes the
 * native entry and moves its env/headers into the keychain, so this is the only
 * path a user has to rotate a token — and the reason the flow must verify
 * before it writes.
 */
describe('code-mode credentials', () => {
  let ctx: TestDaemon;
  let fakeMcp: FakeMcpHttpServer | null = null;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
    if (fakeMcp) await fakeMcp.close();
    fakeMcp = null;
  });

  function settingsFile(): Settings {
    return JSON.parse(readFileSync(ctx.settingsPath, 'utf-8')) as Settings;
  }
  function keychain(): Record<string, Record<string, string>> {
    return JSON.parse(readFileSync(ctx.keychainPath, 'utf-8')) as Record<
      string,
      Record<string, string>
    >;
  }
  function storedSecrets(): Record<string, string> {
    const slots = keychain()['Sentinel-code-mode-secrets'] ?? {};
    const first = Object.values(slots)[0];
    return first ? (JSON.parse(first) as Record<string, string>) : {};
  }

  /** Bridge the fake server with a secret header, the shape this flow exists
   *  for (an auth credential Sentinel now owns). */
  async function bridgeWithSecret(): Promise<void> {
    fakeMcp = await startFakeMcpHttpServer();
    ctx = await startTestDaemon({
      claudeState: {
        mcpServers: { fakemcp: { type: 'http', url: fakeMcp.url, headers: SERVER_ENTRY_HEADERS } },
      },
    });
    const m = await ctx.request({ type: 'migrate_server_to_code_mode', server: 'fakemcp' });
    expect(m.success).toBe(true);
  }

  it('moves the bridged entry’s secrets to the keychain, out of settings.json', async () => {
    await bridgeWithSecret();
    const raw = readFileSync(ctx.settingsPath, 'utf-8');
    expect(raw).not.toContain('fake-secret-value');
    const record = settingsFile().codeModeMigrations[0]!;
    expect(record.secretRef).toMatch(/^fakemcp-[0-9a-f]{32}$/);
    expect(record.secretKeys).toEqual(['headers.X-Fake-Key']);
    expect(record.originalEntry).toEqual({ type: 'http', url: fakeMcp!.url });
    // ...and the keychain is where it went.
    expect(storedSecrets()).toEqual({ headers: SERVER_ENTRY_HEADERS });
  });

  it('lists credential field names without exposing any value', async () => {
    await bridgeWithSecret();
    const r = await ctx.request<{
      server: string;
      records: Array<{ scope: string; secretKeys: string[]; nonSecret: { url?: string } }>;
    }>({ type: 'get_code_mode_credentials', server: 'fakemcp' });
    expect(r.success).toBe(true);
    expect(r.data?.records).toHaveLength(1);
    expect(r.data?.records[0]?.secretKeys).toEqual(['headers.X-Fake-Key']);
    expect(r.data?.records[0]?.nonSecret.url).toBe(fakeMcp!.url);
    // The whole point: no secret value in the payload.
    expect(JSON.stringify(r.data)).not.toContain('fake-secret-value');
  });

  it('errors listing credentials for a server that is not bridged', async () => {
    ctx = await startTestDaemon();
    const r = await ctx.request({ type: 'get_code_mode_credentials', server: 'nope' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/No recorded code-mode migration for 'nope'\./);
  });

  it('reveals one named value on explicit request', async () => {
    await bridgeWithSecret();
    const r = await ctx.request<{ value: string }>({
      type: 'reveal_code_mode_secret',
      server: 'fakemcp',
      scope: 'user',
      directory: null,
      key: 'headers.X-Fake-Key',
    });
    expect(r.success).toBe(true);
    expect(r.data?.value).toBe('fake-secret-value');
  });

  it('refuses to reveal an unknown field or an unbridged server', async () => {
    await bridgeWithSecret();
    const badKey = await ctx.request({
      type: 'reveal_code_mode_secret',
      server: 'fakemcp',
      scope: 'user',
      directory: null,
      key: 'env.NOPE',
    });
    expect(badKey.success).toBe(false);
    expect(badKey.error).toMatch(/No credential field 'env\.NOPE'/);

    const badScope = await ctx.request({
      type: 'reveal_code_mode_secret',
      server: 'fakemcp',
      scope: 'local',
      directory: '/nowhere',
      key: 'headers.X-Fake-Key',
    });
    expect(badScope.success).toBe(false);
    expect(badScope.error).toMatch(/No recorded code-mode migration/);
  });

  it('verifies a new credential against the server, then persists it and refreshes the docs', async () => {
    await bridgeWithSecret();
    const toolsDir = join(ctx.workdir, 'code-mode', 'servers', 'fakemcp', 'tools');
    const before = statSync(join(toolsDir, `${FAKE_MCP_TOOLS[0]!.name}.md`)).mtimeMs;
    // The fake accepts any key, so a changed value still verifies — what is
    // under test is that the new value is what gets stored and used.
    fakeMcp!.setRequiredHeader('X-Fake-Key', 'rotated-value');

    const r = await ctx.request<{
      verified: boolean;
      toolCount: number;
      recordsUpdated: number;
    }>({
      type: 'update_code_mode_credentials',
      server: 'fakemcp',
      target: 'all',
      changes: { 'headers.X-Fake-Key': 'rotated-value' },
    });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({
      verified: true,
      toolCount: FAKE_MCP_TOOLS.length,
      recordsUpdated: 1,
    });

    // New value in the keychain, nothing leaked into settings.
    expect(storedSecrets()).toEqual({ headers: { 'X-Fake-Key': 'rotated-value' } });
    expect(readFileSync(ctx.settingsPath, 'utf-8')).not.toContain('rotated-value');

    // Docs regenerated — the other thing that only happened on migrate before.
    expect(statSync(join(toolsDir, `${FAKE_MCP_TOOLS[0]!.name}.md`)).mtimeMs).toBeGreaterThan(
      before,
    );

    // And a real bridged call now succeeds against the rotated credential.
    const call = await fetch(`http://127.0.0.1:${ctx.daemonPort}/code-mode/call`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getOrCreateCodeModeToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ server: 'fakemcp', tool: FAKE_MCP_TOOLS[0]!.name, args: {} }),
    });
    expect(call.status).toBe(200);
    expect(((await call.json()) as { ok: boolean }).ok).toBe(true);
  });

  it('writes nothing when the new credential fails to verify', async () => {
    await bridgeWithSecret();
    // Server now demands a different key than what we are about to save.
    fakeMcp!.setRequiredHeader('X-Fake-Key', 'the-only-accepted-value');

    const r = await ctx.request({
      type: 'update_code_mode_credentials',
      server: 'fakemcp',
      target: 'all',
      changes: { 'headers.X-Fake-Key': 'wrong-value' },
    });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Could not connect to 'fakemcp'.*Nothing was saved\./s);

    // The old credential is untouched — this is the guarantee that makes the
    // dialog safe to use against a live bridge.
    expect(storedSecrets()).toEqual({ headers: SERVER_ENTRY_HEADERS });
    expect(settingsFile().codeModeMigrations[0]?.secretKeys).toEqual(['headers.X-Fake-Key']);
  });

  it('rejects an empty change set and an unmatched target', async () => {
    await bridgeWithSecret();
    const empty = await ctx.request({
      type: 'update_code_mode_credentials',
      server: 'fakemcp',
      target: 'all',
      changes: {},
    });
    expect(empty.success).toBe(false);
    expect(empty.error).toMatch(/No credential changes supplied\./);

    const unmatched = await ctx.request({
      type: 'update_code_mode_credentials',
      server: 'fakemcp',
      target: { scope: 'local', directory: '/nowhere' },
      changes: { 'headers.X-Fake-Key': 'v' },
    });
    expect(unmatched.success).toBe(false);
    expect(unmatched.error).toMatch(/matching that target/);
  });

  it('migrates pre-keychain inline secrets at startup, keeping them readable', async () => {
    ctx = await startTestDaemon({
      settings: {
        codeModeEnabled: true,
        codeModeMigrations: [
          {
            server: 'legacy',
            scope: 'user',
            directory: null,
            // The old on-disk shape: secrets inline in settings.json.
            originalEntry: {
              command: 'uvx',
              args: ['legacy-mcp'],
              env: { LEGACY_TOKEN: 'inline-secret' },
            },
            migratedAt: 1,
          },
        ],
      },
    });
    const raw = readFileSync(ctx.settingsPath, 'utf-8');
    expect(raw).not.toContain('inline-secret');
    const record = settingsFile().codeModeMigrations[0]!;
    expect(record.secretRef).toMatch(/^legacy-[0-9a-f]{32}$/);
    expect(record.secretKeys).toEqual(['env.LEGACY_TOKEN']);
    expect(record.originalEntry).toEqual({ command: 'uvx', args: ['legacy-mcp'] });
    // Still reachable — a lost credential here would be unrecoverable, since
    // bridging already deleted the native entry.
    expect(storedSecrets()).toEqual({ env: { LEGACY_TOKEN: 'inline-secret' } });
    // And the credentials IPC sees the migrated shape.
    const creds = await ctx.request<{ records: Array<{ secretKeys: string[] }> }>({
      type: 'get_code_mode_credentials',
      server: 'legacy',
    });
    expect(creds.data?.records[0]?.secretKeys).toEqual(['env.LEGACY_TOKEN']);
  });

  it('keeps a newer hand-added entry instead of overwriting it on revert', async () => {
    await bridgeWithSecret();
    // Simulate the user rotating the token the old way: re-add the server in
    // Claude Code's config while it is bridged.
    const rotated = {
      type: 'http',
      url: fakeMcp!.url,
      headers: { 'X-Fake-Key': 'rotated-by-hand' },
    };
    const state = JSON.parse(readFileSync(ctx.claudeJsonPath, 'utf-8')) as Record<string, unknown>;
    state['mcpServers'] = { ...(state['mcpServers'] as object), fakemcp: rotated };
    writeFileSync(ctx.claudeJsonPath, JSON.stringify(state, null, 2));

    const r = await ctx.request<{ keptExisting: number }>({
      type: 'revert_server_from_code_mode',
      server: 'fakemcp',
    });
    expect(r.success).toBe(true);
    expect(r.data?.keptExisting).toBe(1);

    // The hand-rotated credential survived; the stale stash did NOT win.
    const after = JSON.parse(readFileSync(ctx.claudeJsonPath, 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(after.mcpServers['fakemcp']).toEqual(rotated);
  });

  it('restores the stashed entry byte-identically when nothing was hand-added', async () => {
    await bridgeWithSecret();
    const original = { type: 'http', url: fakeMcp!.url, headers: SERVER_ENTRY_HEADERS };
    const r = await ctx.request<{ keptExisting: number }>({
      type: 'revert_server_from_code_mode',
      server: 'fakemcp',
    });
    expect(r.success).toBe(true);
    expect(r.data?.keptExisting).toBe(0);
    const after = JSON.parse(readFileSync(ctx.claudeJsonPath, 'utf-8')) as {
      mcpServers: Record<string, unknown>;
    };
    // Secrets rehydrated out of the keychain — a raw stash restore would have
    // dropped the headers entirely.
    expect(after.mcpServers['fakemcp']).toEqual(original);
    // Slot cleaned up.
    expect(keychain()['Sentinel-code-mode-secrets'] ?? {}).toEqual({});
  });
});
