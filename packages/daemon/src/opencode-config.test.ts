/**
 * opencode provider-config management. Real filesystem via a per-test temp home
 * (SENTINEL_TEST_HOME) — the same seam production resolves through.
 *
 * The cases that matter most are the ones where writing would do damage:
 * a commented config (a JSON round-trip would delete the comments) and a config
 * whose base URL a plugin rewrites at runtime (writing succeeds but changes
 * nothing, so the UI must not claim success).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  OPENCODE_BASE_URL,
  activateOpencode,
  classifyOpencodeConfig,
  deactivateOpencode,
  hasJsonComments,
  inspectOpencodeConfig,
  opencodeConfigPath,
  resolveOpencodeInstallMarkers,
} from './opencode-config.js';

let home: string;

/** Write a global opencode config; returns its path. */
function seedConfig(contents: string, filename = 'opencode.json'): string {
  const path = join(home, '.config', 'opencode', filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  return path;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sentinel-oc-home-'));
  process.env.SENTINEL_TEST_HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG;
});

afterEach(() => {
  delete process.env.SENTINEL_TEST_HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG;
  rmSync(home, { recursive: true, force: true });
});

describe('opencodeConfigPath', () => {
  it('defaults to opencode.json under the config dir', () => {
    expect(opencodeConfigPath()).toBe(join(home, '.config', 'opencode', 'opencode.json'));
  });

  it('prefers an existing opencode.jsonc', () => {
    const path = seedConfig('{}', 'opencode.jsonc');
    expect(opencodeConfigPath()).toBe(path);
  });

  it('honors OPENCODE_CONFIG over both', () => {
    seedConfig('{}', 'opencode.jsonc');
    process.env.OPENCODE_CONFIG = '/custom/where.json';
    expect(opencodeConfigPath()).toBe('/custom/where.json');
  });
});

describe('hasJsonComments', () => {
  it.each([
    ['line comment', '{\n  // hi\n  "a": 1\n}', true],
    ['block comment', '{ /* hi */ "a": 1 }', true],
    ['no comments', '{ "a": 1 }', false],
    // The reason this is not a regex: every base URL in the file contains `//`.
    ['url inside a string', '{ "baseURL": "http://127.0.0.1:47284/v1" }', false],
    ['escaped quote then url', '{ "a": "say \\"hi\\" http://x" }', false],
    ['comment after a url', '{ "baseURL": "http://x" } // trailing', true],
  ])('%s → %s', (_label, text, expected) => {
    expect(hasJsonComments(text)).toBe(expected);
  });
});

describe('classifyOpencodeConfig', () => {
  const withBaseUrl = (url: string): Record<string, unknown> => ({
    provider: { anthropic: { options: { baseURL: url } } },
  });

  it('reports inactive for an empty config', () => {
    expect(classifyOpencodeConfig({}, null).state).toBe('inactive');
  });

  it('reports active when pointed at Sentinel', () => {
    expect(classifyOpencodeConfig(withBaseUrl(OPENCODE_BASE_URL), null).state).toBe('active');
  });

  it('reports foreign-base-url when pointed elsewhere', () => {
    const r = classifyOpencodeConfig(withBaseUrl('http://127.0.0.1:3456'), null);
    expect(r.state).toBe('foreign-base-url');
    expect(r.baseUrl).toBe('http://127.0.0.1:3456');
  });

  it('reports plugin-override even when the file points at Sentinel', () => {
    const r = classifyOpencodeConfig(
      { ...withBaseUrl(OPENCODE_BASE_URL), plugin: ['opencode-with-claude'] },
      null,
    );
    expect(r.state).toBe('plugin-override');
    expect(r.overridingPlugins).toEqual(['opencode-with-claude']);
  });

  it('matches a version-pinned plugin entry', () => {
    const r = classifyOpencodeConfig({ plugin: ['opencode-with-claude@1.8.0'] }, null);
    expect(r.state).toBe('plugin-override');
  });

  it('ignores unrelated plugins', () => {
    expect(classifyOpencodeConfig({ plugin: ['some-other-plugin'] }, null).state).toBe('inactive');
  });

  it('reports unwritable for a commented, not-yet-routed config', () => {
    expect(classifyOpencodeConfig({}, '{ // hi\n}').state).toBe('unwritable');
  });

  it('reports active for a commented config that already points at Sentinel', () => {
    // Nothing to write, so the comments are not a problem.
    const r = classifyOpencodeConfig(withBaseUrl(OPENCODE_BASE_URL), '{ // hi\n}');
    expect(r.state).toBe('active');
  });

  it('reports unwritable when the config could not be parsed', () => {
    expect(classifyOpencodeConfig(null, '{ broken').state).toBe('unwritable');
  });
});

describe('activateOpencode', () => {
  it('creates the config with the /v1 suffix when none exists', async () => {
    const result = await activateOpencode();

    expect(result.state).toBe('active');
    // The suffix is load-bearing: the AI SDK appends `/messages`, so a base URL
    // without `/v1` produces a 404.
    expect(OPENCODE_BASE_URL).toBe('http://127.0.0.1:47284/v1');
    expect(readJson(opencodeConfigPath())).toEqual({
      provider: { anthropic: { options: { baseURL: OPENCODE_BASE_URL } } },
    });
  });

  it('preserves every other key in an existing config', async () => {
    const path = seedConfig(
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        model: 'anthropic/claude-opus-4-8',
        mcp: { 'mem0-local': { type: 'local', command: ['x'] } },
        permission: { external_directory: { '/Users/x/**': 'allow' } },
        provider: {
          'vllm-local': { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://x:8000' } },
        },
      }),
    );

    await activateOpencode();

    const written = readJson(path) as Record<string, Record<string, unknown>>;
    expect(written['$schema']).toBe('https://opencode.ai/config.json');
    expect(written['model']).toBe('anthropic/claude-opus-4-8');
    expect(written['mcp']).toEqual({ 'mem0-local': { type: 'local', command: ['x'] } });
    expect(written['permission']).toEqual({ external_directory: { '/Users/x/**': 'allow' } });
    expect(written['provider']!['vllm-local']).toEqual({
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'http://x:8000' },
    });
    expect(written['provider']!['anthropic']).toEqual({
      options: { baseURL: OPENCODE_BASE_URL },
    });
  });

  it('keeps sibling anthropic options such as the user apiKey', async () => {
    const path = seedConfig(
      JSON.stringify({
        provider: { anthropic: { options: { apiKey: '{env:ANTHROPIC_API_KEY}' } } },
      }),
    );

    await activateOpencode();

    const written = readJson(path) as Record<string, Record<string, Record<string, unknown>>>;
    expect(written['provider']!['anthropic']!['options']).toEqual({
      apiKey: '{env:ANTHROPIC_API_KEY}',
      baseURL: OPENCODE_BASE_URL,
    });
  });

  it('is idempotent', async () => {
    await activateOpencode();
    const first = readFileSync(opencodeConfigPath(), 'utf8');
    await activateOpencode();
    expect(readFileSync(opencodeConfigPath(), 'utf8')).toBe(first);
  });

  it('refuses to rewrite a commented config and offers a snippet instead', async () => {
    const original = '{\n  // my notes\n  "model": "anthropic/claude-opus-4-8"\n}\n';
    const path = seedConfig(original, 'opencode.jsonc');

    const result = await activateOpencode();

    expect(result.state).toBe('unwritable');
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(result.manualSnippet).toContain(OPENCODE_BASE_URL);
  });

  it('refuses to rewrite an unparseable config', async () => {
    const path = seedConfig('{ this is not json');
    const result = await activateOpencode();

    expect(result.state).toBe('unwritable');
    expect(readFileSync(path, 'utf8')).toBe('{ this is not json');
  });

  it('writes but reports plugin-override when a rewriting plugin is configured', async () => {
    const path = seedConfig(JSON.stringify({ plugin: ['opencode-with-claude'] }));

    const result = await activateOpencode();

    // The write lands, but the honest state is that opencode will ignore it.
    expect(readJson(path)['provider']).toEqual({
      anthropic: { options: { baseURL: OPENCODE_BASE_URL } },
    });
    expect(result.state).toBe('plugin-override');
    expect(result.overridingPlugins).toEqual(['opencode-with-claude']);
  });
});

describe('deactivateOpencode', () => {
  it('removes our base URL and prunes the objects it emptied', async () => {
    const path = seedConfig(JSON.stringify({ model: 'x' }));
    await activateOpencode();

    const result = await deactivateOpencode();

    expect(result.state).toBe('inactive');
    expect(readJson(path)).toEqual({ model: 'x' });
  });

  it('keeps sibling options and the provider entry', async () => {
    const path = seedConfig(
      JSON.stringify({ provider: { anthropic: { options: { apiKey: 'k' } } } }),
    );
    await activateOpencode();

    await deactivateOpencode();

    expect(readJson(path)).toEqual({ provider: { anthropic: { options: { apiKey: 'k' } } } });
  });

  it('leaves a foreign base URL alone', async () => {
    const path = seedConfig(
      JSON.stringify({
        provider: { anthropic: { options: { baseURL: 'http://127.0.0.1:3456' } } },
      }),
    );

    const result = await deactivateOpencode();

    expect(result.state).toBe('foreign-base-url');
    expect(readJson(path)).toEqual({
      provider: { anthropic: { options: { baseURL: 'http://127.0.0.1:3456' } } },
    });
  });

  it('is a no-op when no config exists', async () => {
    const result = await deactivateOpencode();
    expect(result.state).toBe('inactive');
    expect(existsSync(opencodeConfigPath())).toBe(false);
  });
});

describe('inspectOpencodeConfig', () => {
  it('surfaces the path even when nothing is configured', () => {
    const details = inspectOpencodeConfig();
    expect(details.state).toBe('inactive');
    expect(details.configPath).toBe(join(home, '.config', 'opencode', 'opencode.json'));
    expect(details.baseUrl).toBeNull();
    expect(details.manualSnippet).toBeNull();
  });

  it('reads a jsonc config without comments as ordinary JSON', async () => {
    seedConfig(JSON.stringify({ provider: {} }), 'opencode.jsonc');
    await activateOpencode();
    const details = inspectOpencodeConfig();
    expect(details.state).toBe('active');
    expect(details.baseUrl).toBe(OPENCODE_BASE_URL);
    expect(details.configPath.endsWith('opencode.jsonc')).toBe(true);
  });
});

describe('resolveOpencodeInstallMarkers', () => {
  it('covers config, home, and data dirs on macOS', () => {
    const markers = resolveOpencodeInstallMarkers('darwin', {}, '/Users/x');
    expect(markers).toEqual([
      '/Users/x/.config/opencode',
      '/Users/x/.opencode',
      '/Users/x/.local/share/opencode',
    ]);
  });

  it('honors XDG overrides on linux', () => {
    const markers = resolveOpencodeInstallMarkers(
      'linux',
      { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data' },
      '/home/x',
    );
    expect(markers).toContain('/cfg/opencode');
    expect(markers).toContain('/data/opencode');
  });

  it('adds the LOCALAPPDATA dir on windows', () => {
    const markers = resolveOpencodeInstallMarkers(
      'win32',
      { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      'C:\\Users\\x',
    );
    expect(markers.some((m) => m.includes('AppData'))).toBe(true);
  });

  it('omits the windows dir when LOCALAPPDATA is unset', () => {
    const markers = resolveOpencodeInstallMarkers('win32', {}, 'C:\\Users\\x');
    expect(markers.every((m) => !m.includes('AppData'))).toBe(true);
  });
});
