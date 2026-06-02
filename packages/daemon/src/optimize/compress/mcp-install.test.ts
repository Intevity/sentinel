import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import {
  installMcpServer,
  uninstallMcpServer,
  isMcpInstalled,
  buildMcpServerEntry,
  MCP_SERVER_NAME,
} from './mcp-install.js';
import { readClaudeState } from '../../claude-state.js';

const PORT = 47284;
const TOKEN = 'tok-abc';

function claudeJson(): Record<string, unknown> {
  return readClaudeState() as unknown as Record<string, unknown>;
}

describe('buildMcpServerEntry', () => {
  it('builds an http entry with the loopback url and bearer header', () => {
    expect(buildMcpServerEntry(PORT, TOKEN)).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:47284/mcp',
      headers: { Authorization: 'Bearer tok-abc' },
    });
  });
});

describe('mcp-install (user + local scopes, ~/.claude.json)', () => {
  let jsonPath: string;
  let prev: string | undefined;

  beforeEach(() => {
    jsonPath = join(tmpdir(), `sentinel-claude-${randomUUID()}.json`);
    prev = process.env.CLAUDE_SENTINEL_TEST_CLAUDE_JSON;
    process.env.CLAUDE_SENTINEL_TEST_CLAUDE_JSON = jsonPath;
    // Seed an existing file with unrelated keys to prove preservation.
    writeFileSync(
      jsonPath,
      JSON.stringify({
        oauthAccount: { emailAddress: 'a@b.c' },
        mcpServers: { other: { type: 'http', url: 'x' } },
      }),
    );
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDE_SENTINEL_TEST_CLAUDE_JSON;
    else process.env.CLAUDE_SENTINEL_TEST_CLAUDE_JSON = prev;
    if (existsSync(jsonPath)) rmSync(jsonPath);
  });

  it('user install adds top-level mcpServers.sentinel and preserves other keys', () => {
    const { configPath } = installMcpServer({
      scope: 'user',
      directory: null,
      port: PORT,
      token: TOKEN,
    });
    expect(configPath).toBe(jsonPath);
    const state = claudeJson();
    const servers = state['mcpServers'] as Record<string, unknown>;
    expect(servers[MCP_SERVER_NAME]).toEqual(buildMcpServerEntry(PORT, TOKEN));
    // Untouched siblings.
    expect(servers['other']).toEqual({ type: 'http', url: 'x' });
    expect(state['oauthAccount']).toEqual({ emailAddress: 'a@b.c' });
    expect(isMcpInstalled({ scope: 'user', directory: null })).toBe(true);
  });

  it('local install nests under projects[dir].mcpServers.sentinel', () => {
    const dir = '/home/me/project';
    installMcpServer({ scope: 'local', directory: dir, port: PORT, token: TOKEN });
    const projects = claudeJson()['projects'] as Record<string, Record<string, unknown>>;
    const servers = projects[dir]!['mcpServers'] as Record<string, unknown>;
    expect(servers[MCP_SERVER_NAME]).toEqual(buildMcpServerEntry(PORT, TOKEN));
    expect(isMcpInstalled({ scope: 'local', directory: dir })).toBe(true);
    // A different directory is not considered installed.
    expect(isMcpInstalled({ scope: 'local', directory: '/other' })).toBe(false);
  });

  it('user uninstall removes only the sentinel entry', () => {
    installMcpServer({ scope: 'user', directory: null, port: PORT, token: TOKEN });
    uninstallMcpServer({ scope: 'user', directory: null });
    const servers = claudeJson()['mcpServers'] as Record<string, unknown>;
    expect(servers[MCP_SERVER_NAME]).toBeUndefined();
    expect(servers['other']).toEqual({ type: 'http', url: 'x' }); // sibling kept
    expect(isMcpInstalled({ scope: 'user', directory: null })).toBe(false);
  });

  it('local uninstall removes the entry under projects[dir], keeping the project', () => {
    const dir = '/home/me/project';
    installMcpServer({ scope: 'local', directory: dir, port: PORT, token: TOKEN });
    uninstallMcpServer({ scope: 'local', directory: dir });
    const projects = claudeJson()['projects'] as Record<string, Record<string, unknown>>;
    // The project entry remains; only the sentinel server key is gone.
    expect(projects[dir]).toBeDefined();
    const servers = projects[dir]!['mcpServers'] as Record<string, unknown>;
    expect(servers[MCP_SERVER_NAME]).toBeUndefined();
    expect(isMcpInstalled({ scope: 'local', directory: dir })).toBe(false);
    // isMcpInstalled is false for a blank directory.
    expect(isMcpInstalled({ scope: 'local', directory: '' })).toBe(false);
  });

  it('local/project install throws without a directory', () => {
    expect(() =>
      installMcpServer({ scope: 'local', directory: null, port: PORT, token: TOKEN }),
    ).toThrow(/requires a directory/);
    expect(() =>
      installMcpServer({ scope: 'project', directory: '', port: PORT, token: TOKEN }),
    ).toThrow(/requires a directory/);
  });
});

describe('mcp-install (project scope, .mcp.json)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sentinel-proj-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a committable .mcp.json with the sentinel entry, preserving other keys', () => {
    const mcpPath = join(dir, '.mcp.json');
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { teamTool: { type: 'http', url: 'y' } }, $schema: 'x' }),
    );
    const { configPath } = installMcpServer({
      scope: 'project',
      directory: dir,
      port: PORT,
      token: TOKEN,
    });
    expect(configPath).toBe(mcpPath);
    const obj = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
    const servers = obj['mcpServers'] as Record<string, unknown>;
    expect(servers[MCP_SERVER_NAME]).toEqual(buildMcpServerEntry(PORT, TOKEN));
    expect(servers['teamTool']).toEqual({ type: 'http', url: 'y' });
    expect(obj['$schema']).toBe('x');
    expect(isMcpInstalled({ scope: 'project', directory: dir })).toBe(true);
  });

  it('creates .mcp.json when absent and uninstall removes the entry', () => {
    installMcpServer({ scope: 'project', directory: dir, port: PORT, token: TOKEN });
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true);
    uninstallMcpServer({ scope: 'project', directory: dir });
    expect(isMcpInstalled({ scope: 'project', directory: dir })).toBe(false);
  });

  it('isMcpInstalled is false for a directory with no .mcp.json', () => {
    expect(isMcpInstalled({ scope: 'project', directory: dir })).toBe(false);
    // uninstall on a missing file is a no-op (no throw).
    expect(() => uninstallMcpServer({ scope: 'project', directory: dir })).not.toThrow();
    // blank directory short-circuits the presence check.
    expect(isMcpInstalled({ scope: 'project', directory: '' })).toBe(false);
  });

  it('treats a malformed .mcp.json as empty and writes a valid one', () => {
    const mcpPath = join(dir, '.mcp.json');
    writeFileSync(mcpPath, '{ this is not json');
    installMcpServer({ scope: 'project', directory: dir, port: PORT, token: TOKEN });
    const obj = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
    expect((obj['mcpServers'] as Record<string, unknown>)[MCP_SERVER_NAME]).toEqual(
      buildMcpServerEntry(PORT, TOKEN),
    );
  });
});
