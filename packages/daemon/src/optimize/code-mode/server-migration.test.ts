import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import {
  disableNativeServer,
  restoreNativeServer,
  isNativeDisabled,
  readNativeServerEntry,
  findNativeServerEntries,
} from './server-migration.js';
import { readClaudeState } from '../../claude-state.js';

/** A realistic server entry carrying a secret header — restore must be
 *  byte-identical, including the secret. */
const GH_ENTRY = {
  type: 'http',
  url: 'https://api.githubcopilot.com/mcp/',
  headers: { Authorization: 'Bearer ghp_secret123' },
};
const STDIO_ENTRY = {
  command: 'npx',
  args: ['-y', 'some-mcp'],
  env: { API_KEY: 'sk-secret' },
};

function claudeJson(): Record<string, unknown> {
  return readClaudeState() as unknown as Record<string, unknown>;
}

describe('server-migration (user + local scopes, ~/.claude.json)', () => {
  let jsonPath: string;
  let prev: string | undefined;

  beforeEach(() => {
    jsonPath = join(tmpdir(), `sentinel-claude-${randomUUID()}.json`);
    prev = process.env.CLAUDE_SENTINEL_TEST_CLAUDE_JSON;
    process.env.CLAUDE_SENTINEL_TEST_CLAUDE_JSON = jsonPath;
    writeFileSync(
      jsonPath,
      JSON.stringify({
        oauthAccount: { emailAddress: 'a@b.c' },
        mcpServers: { github: GH_ENTRY, keepme: { type: 'http', url: 'x' } },
        projects: {
          '/repo': {
            mcpServers: { mongo: STDIO_ENTRY, other: { command: 'x' } },
            disabledMcpServers: ['already-off'],
            allowedTools: ['Bash'],
          },
        },
      }),
    );
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDE_SENTINEL_TEST_CLAUDE_JSON;
    else process.env.CLAUDE_SENTINEL_TEST_CLAUDE_JSON = prev;
    if (existsSync(jsonPath)) rmSync(jsonPath);
  });

  it('user scope: disable removes the entry, returns it verbatim, preserves unowned keys', () => {
    const ref = { server: 'github', scope: 'user' as const, directory: null };
    expect(readNativeServerEntry(ref)).toEqual(GH_ENTRY);
    expect(isNativeDisabled(ref)).toBe(false);

    const { originalEntry } = disableNativeServer(ref);
    expect(originalEntry).toEqual(GH_ENTRY);
    expect(isNativeDisabled(ref)).toBe(true);

    const state = claudeJson();
    const servers = state['mcpServers'] as Record<string, unknown>;
    expect('github' in servers).toBe(false);
    expect(servers['keepme']).toEqual({ type: 'http', url: 'x' });
    expect(state['oauthAccount']).toEqual({ emailAddress: 'a@b.c' });
  });

  it('user scope: restore puts the stashed entry back byte-identically', () => {
    const ref = { server: 'github', scope: 'user' as const, directory: null };
    const { originalEntry } = disableNativeServer(ref);
    restoreNativeServer({ ...ref, originalEntry });
    expect(isNativeDisabled(ref)).toBe(false);
    const servers = claudeJson()['mcpServers'] as Record<string, unknown>;
    // Byte-identical via deep equality including the secret header.
    expect(servers['github']).toEqual(GH_ENTRY);
  });

  it('local scope: disable moves the name into disabledMcpServers and out of mcpServers', () => {
    const ref = { server: 'mongo', scope: 'local' as const, directory: '/repo' };
    const { originalEntry } = disableNativeServer(ref);
    expect(originalEntry).toEqual(STDIO_ENTRY);

    const project = (claudeJson()['projects'] as Record<string, Record<string, unknown>>)['/repo']!;
    expect('mongo' in (project['mcpServers'] as Record<string, unknown>)).toBe(false);
    expect(project['disabledMcpServers']).toEqual(['already-off', 'mongo']);
    // Unowned project keys preserved.
    expect(project['allowedTools']).toEqual(['Bash']);
    expect((project['mcpServers'] as Record<string, unknown>)['other']).toEqual({ command: 'x' });
  });

  it('local scope: disable is idempotent on the disabled list (no duplicate names)', () => {
    const ref = { server: 'mongo', scope: 'local' as const, directory: '/repo' };
    const { originalEntry } = disableNativeServer(ref);
    restoreNativeServer({ ...ref, originalEntry });
    disableNativeServer(ref);
    const project = (claudeJson()['projects'] as Record<string, Record<string, unknown>>)['/repo']!;
    expect((project['disabledMcpServers'] as string[]).filter((s) => s === 'mongo')).toHaveLength(
      1,
    );
  });

  it('local scope: restore re-adds the entry and clears the disabled marker', () => {
    const ref = { server: 'mongo', scope: 'local' as const, directory: '/repo' };
    const { originalEntry } = disableNativeServer(ref);
    restoreNativeServer({ ...ref, originalEntry });
    const project = (claudeJson()['projects'] as Record<string, Record<string, unknown>>)['/repo']!;
    expect((project['mcpServers'] as Record<string, unknown>)['mongo']).toEqual(STDIO_ENTRY);
    expect(project['disabledMcpServers']).toEqual(['already-off']);
  });

  it('throws on disabling a server that is not present (and writes nothing)', () => {
    const before = readFileSync(jsonPath, 'utf-8');
    expect(() => disableNativeServer({ server: 'ghost', scope: 'user', directory: null })).toThrow(
      /not found in mcpServers at user scope/,
    );
    expect(() =>
      disableNativeServer({ server: 'ghost', scope: 'local', directory: '/repo' }),
    ).toThrow(/not found in mcpServers at local scope \(\/repo\)/);
    expect(readFileSync(jsonPath, 'utf-8')).toBe(before);
  });

  it('throws on local scope without a directory', () => {
    expect(() => disableNativeServer({ server: 'mongo', scope: 'local', directory: null })).toThrow(
      /requires a directory/,
    );
  });

  it('findNativeServerEntries discovers single-scope servers and returns [] for unknown ones', () => {
    expect(findNativeServerEntries('github')).toEqual([
      { scope: 'user', directory: null, entry: GH_ENTRY },
    ]);
    expect(findNativeServerEntries('mongo')).toEqual([
      { scope: 'local', directory: '/repo', entry: STDIO_ENTRY },
    ]);
    expect(findNativeServerEntries('ghost')).toEqual([]);
  });

  it('findNativeServerEntries finds the same server across every scope, user first', () => {
    writeFileSync(
      jsonPath,
      JSON.stringify({
        mcpServers: { multi: { type: 'http', url: 'global' } },
        projects: {
          '/a': { mcpServers: { multi: { type: 'http', url: 'a' } } },
          '/b': { mcpServers: { multi: { type: 'http', url: 'b' } } },
        },
      }),
    );
    expect(findNativeServerEntries('multi')).toEqual([
      { scope: 'user', directory: null, entry: { type: 'http', url: 'global' } },
      { scope: 'local', directory: '/a', entry: { type: 'http', url: 'a' } },
      { scope: 'local', directory: '/b', entry: { type: 'http', url: 'b' } },
    ]);
  });

  it('refuses to act on a malformed ~/.claude.json (throws, file untouched)', () => {
    // readClaudeState propagates the parse error — the right call here:
    // treating a corrupt file as empty and then writing would clobber the
    // user's entire config with `{}` plus our edit.
    writeFileSync(jsonPath, '{not json');
    expect(() =>
      disableNativeServer({ server: 'github', scope: 'user', directory: null }),
    ).toThrow();
    expect(readFileSync(jsonPath, 'utf-8')).toBe('{not json');
  });
});

describe('server-migration (project scope, .mcp.json)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sentinel-mcpjson-'));
    writeFileSync(
      join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { shopify: { type: 'http', url: 'https://shopify.dev/mcp' } },
        unrelated: { keep: true },
      }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('disable + restore round-trips the entry and preserves unrelated keys', () => {
    const ref = { server: 'shopify', scope: 'project' as const, directory: dir };
    expect(isNativeDisabled(ref)).toBe(false);
    const { configPath, originalEntry } = disableNativeServer(ref);
    expect(configPath).toBe(join(dir, '.mcp.json'));
    expect(isNativeDisabled(ref)).toBe(true);

    let obj = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8')) as Record<string, unknown>;
    expect(obj['unrelated']).toEqual({ keep: true });
    expect(Object.keys(obj['mcpServers'] as Record<string, unknown>)).toEqual([]);

    restoreNativeServer({ ...ref, originalEntry });
    obj = JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf-8')) as Record<string, unknown>;
    expect((obj['mcpServers'] as Record<string, unknown>)['shopify']).toEqual({
      type: 'http',
      url: 'https://shopify.dev/mcp',
    });
    expect(isNativeDisabled(ref)).toBe(false);
  });

  it('treats a missing .mcp.json as "not present"', () => {
    const ref = { server: 'shopify', scope: 'project' as const, directory: join(dir, 'nope') };
    expect(isNativeDisabled(ref)).toBe(true);
    expect(() => disableNativeServer(ref)).toThrow(/not found/);
  });
});
