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
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  lstatSync,
  statSync,
  chmodSync,
  readdirSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  activateOpencode,
  classifyOpencodeConfig,
  deactivateOpencode,
  hasJsonComments,
  inspectOpencodeConfig,
  jsoncToJson,
  opencodeBaseUrl,
  opencodeStatePath,
  opencodeConfigPath,
  resolveOpencodeInstallMarkers,
} from './opencode-config.js';

let home: string;
const ORIGINAL_DAEMON_PORT = process.env.SENTINEL_TEST_DAEMON_PORT;

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
  delete process.env.SENTINEL_TEST_DAEMON_PORT;
});

afterEach(() => {
  if (ORIGINAL_DAEMON_PORT === undefined) delete process.env.SENTINEL_TEST_DAEMON_PORT;
  else process.env.SENTINEL_TEST_DAEMON_PORT = ORIGINAL_DAEMON_PORT;
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
    expect(classifyOpencodeConfig(withBaseUrl(opencodeBaseUrl()), null).state).toBe('active');
  });

  it('does NOT report active for a Sentinel URL missing the /v1 path', () => {
    // The AI SDK appends `/messages`, so this URL produces `/messages` and
    // Anthropic 404s it. Reporting `active` would hide the card behind a green
    // state on a config that cannot work; it must stay actionable so Enable
    // rewrites the URL.
    const r = classifyOpencodeConfig(withBaseUrl('http://127.0.0.1:47284'), null);
    expect(r.state).not.toBe('active');
    expect(r.state).toBe('foreign-base-url');
  });

  it('accepts a routed URL with a trailing slash after /v1', () => {
    expect(classifyOpencodeConfig(withBaseUrl('http://127.0.0.1:47284/v1/'), null).state).toBe(
      'active',
    );
  });

  it('does not report active for a deeper path under the Sentinel origin', () => {
    expect(
      classifyOpencodeConfig(withBaseUrl('http://127.0.0.1:47284/v1/messages'), null).state,
    ).toBe('foreign-base-url');
  });

  it('reports foreign-base-url when pointed elsewhere', () => {
    const r = classifyOpencodeConfig(withBaseUrl('http://127.0.0.1:3456'), null);
    expect(r.state).toBe('foreign-base-url');
    expect(r.baseUrl).toBe('http://127.0.0.1:3456');
  });

  it('reports plugin-override even when the file points at Sentinel', () => {
    const r = classifyOpencodeConfig(
      { ...withBaseUrl(opencodeBaseUrl()), plugin: ['opencode-with-claude'] },
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
    const r = classifyOpencodeConfig(withBaseUrl(opencodeBaseUrl()), '{ // hi\n}');
    expect(r.state).toBe('active');
  });

  it('reports unwritable when the config could not be parsed', () => {
    const r = classifyOpencodeConfig(null, '{ broken');
    expect(r.state).toBe('unwritable');
    expect(r.unwritableReason).toBe('unparseable');
  });

  it('names comments as the reason only when there are comments', () => {
    expect(classifyOpencodeConfig({}, '{ // hi\n}').unwritableReason).toBe('comments');
    expect(classifyOpencodeConfig({}, '{}').unwritableReason).toBeNull();
  });
});

describe('activateOpencode', () => {
  it('creates the config with the /v1 suffix when none exists', async () => {
    const result = await activateOpencode();

    expect(result.state).toBe('active');
    // The suffix is load-bearing: the AI SDK appends `/messages`, so a base URL
    // without `/v1` produces a 404.
    expect(opencodeBaseUrl()).toBe('http://127.0.0.1:47284/v1');
    expect(readJson(opencodeConfigPath())).toEqual({
      provider: { anthropic: { options: { baseURL: opencodeBaseUrl() } } },
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
      options: { baseURL: opencodeBaseUrl() },
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
      baseURL: opencodeBaseUrl(),
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
    expect(result.manualSnippet).toContain(opencodeBaseUrl());
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
      anthropic: { options: { baseURL: opencodeBaseUrl() } },
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

  it('reads a config through block comments, while refusing to rewrite it', async () => {
    // Comments block the *write*, not the *read* — the state has to reflect the
    // real baseURL so the card reports accurately instead of "not configured".
    seedConfig(
      `{
  /* provider config
     spans two lines */
  "provider": { "anthropic": { "options": { "baseURL": "http://127.0.0.1:3456" } } }
}
`,
      'opencode.jsonc',
    );

    const details = inspectOpencodeConfig();

    expect(details.baseUrl).toBe('http://127.0.0.1:3456');
    // `unwritable` outranks `foreign-base-url` here on purpose: the actionable
    // fact is that Sentinel cannot write this file, so the card offers a snippet
    // rather than an Enable button that would refuse.
    expect(details.state).toBe('unwritable');
    expect(details.manualSnippet).toContain(opencodeBaseUrl());
  });

  it('reads a jsonc config without comments as ordinary JSON', async () => {
    seedConfig(JSON.stringify({ provider: {} }), 'opencode.jsonc');
    await activateOpencode();
    const details = inspectOpencodeConfig();
    expect(details.state).toBe('active');
    expect(details.baseUrl).toBe(opencodeBaseUrl());
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

describe('jsoncToJson', () => {
  it.each([
    ['object trailing comma', '{ "a": 1, }', { a: 1 }],
    ['array trailing comma', '{ "a": [1, 2,\n] }', { a: [1, 2] }],
    ['nested trailing commas', '{ "a": { "b": [1,], }, }', { a: { b: [1] } }],
    ['comma before a line comment', '{ "a": 1, // note\n}', { a: 1 }],
    ['comma before a block comment', '{ "a": 1, /* note */ }', { a: 1 }],
    ['comma-brace inside a string', '{ "a": ",}", "b": "x,]" }', { a: ',}', b: 'x,]' }],
  ])('%s', (_label, text, expected) => {
    expect(JSON.parse(jsoncToJson(text))).toEqual(expected);
  });

  it('keeps a comma that does not close anything', () => {
    expect(jsoncToJson('{ "a": 1, "b": 2 }')).toBe('{ "a": 1, "b": 2 }');
  });

  it('keeps a dangling comma at end of input (still invalid, not silently fixed)', () => {
    expect(jsoncToJson('[1,')).toBe('[1,');
  });
});

describe('trailing commas', () => {
  it('reads and rewrites a config whose only JSONC feature is a trailing comma', async () => {
    // Previously this failed JSON.parse and was reported as "contains comments".
    const path = seedConfig('{\n  "model": "anthropic/claude-opus-4-8",\n}\n', 'opencode.jsonc');

    expect(inspectOpencodeConfig().state).toBe('inactive');
    const result = await activateOpencode();

    expect(result.state).toBe('active');
    expect(readJson(path)).toEqual({
      model: 'anthropic/claude-opus-4-8',
      provider: { anthropic: { options: { baseURL: opencodeBaseUrl() } } },
    });
  });

  it('reports a genuine syntax error as unparseable, not as comments', () => {
    seedConfig('{ "model": }');
    const details = inspectOpencodeConfig();
    expect(details.state).toBe('unwritable');
    expect(details.unwritableReason).toBe('unparseable');
  });

  it('reports a commented config with the comments reason', () => {
    seedConfig('{\n  // mine\n  "model": "x",\n}\n', 'opencode.jsonc');
    const details = inspectOpencodeConfig();
    expect(details.unwritableReason).toBe('comments');
  });

  it('treats valid JSON that is not an object as unparseable', async () => {
    const path = seedConfig('[]');
    const result = await activateOpencode();
    expect(result.unwritableReason).toBe('unparseable');
    expect(readFileSync(path, 'utf8')).toBe('[]');
  });
});

describe('daemon port', () => {
  it('writes the port the daemon actually listens on', async () => {
    process.env.SENTINEL_TEST_DAEMON_PORT = '51234';

    const result = await activateOpencode();

    expect(opencodeBaseUrl()).toBe('http://127.0.0.1:51234/v1');
    expect(result.state).toBe('active');
    expect(readJson(opencodeConfigPath())).toEqual({
      provider: { anthropic: { options: { baseURL: 'http://127.0.0.1:51234/v1' } } },
    });
  });

  it('does not report a URL on another port as routed', () => {
    process.env.SENTINEL_TEST_DAEMON_PORT = '51234';
    seedConfig(
      JSON.stringify({
        provider: { anthropic: { options: { baseURL: 'http://127.0.0.1:47284/v1' } } },
      }),
    );
    expect(inspectOpencodeConfig().state).toBe('foreign-base-url');
  });

  it('repairs a default-port Sentinel URL without saving it as the user’s own', async () => {
    process.env.SENTINEL_TEST_DAEMON_PORT = '51234';
    const path = seedConfig(
      JSON.stringify({
        provider: { anthropic: { options: { baseURL: 'http://localhost:47284/v1' } } },
      }),
    );

    await activateOpencode();
    expect(existsSync(opencodeStatePath())).toBe(false);
    await deactivateOpencode();

    // Disable removes it rather than "restoring" Sentinel's own stale URL.
    expect(readJson(path)).toEqual({});
  });

  it('ignores a non-loopback host on the Sentinel port', () => {
    seedConfig(
      JSON.stringify({
        provider: { anthropic: { options: { baseURL: 'http://10.0.0.5:47284/v1' } } },
      }),
    );
    expect(inspectOpencodeConfig().state).toBe('foreign-base-url');
  });

  it('treats an unparseable base URL as foreign', () => {
    seedConfig(JSON.stringify({ provider: { anthropic: { options: { baseURL: 'not a url' } } } }));
    expect(inspectOpencodeConfig().state).toBe('foreign-base-url');
  });
});

describe('restoring the user’s own base URL', () => {
  const GATEWAY = 'https://llm-gateway.corp.example/anthropic/v1';
  const seedGateway = (extra: Record<string, unknown> = {}): string =>
    seedConfig(
      JSON.stringify({
        model: 'x',
        provider: { anthropic: { options: { baseURL: GATEWAY, apiKey: 'k' } } },
        ...extra,
      }),
    );

  it('saves a foreign base URL outside the opencode config on Enable', async () => {
    const path = seedGateway();

    const result = await activateOpencode();

    expect(result.state).toBe('active');
    expect(result.previousBaseUrl).toBe(GATEWAY);
    // The opencode file gets only the base URL — no Sentinel bookkeeping key
    // that opencode's schema would reject.
    expect(readJson(path)).toEqual({
      model: 'x',
      provider: { anthropic: { options: { baseURL: opencodeBaseUrl(), apiKey: 'k' } } },
    });
    expect(readJson(opencodeStatePath())).toEqual({ previousBaseUrls: { [path]: GATEWAY } });
  });

  it('restores it on Disable and forgets it', async () => {
    const path = seedGateway();
    await activateOpencode();

    const result = await deactivateOpencode();

    expect(result.state).toBe('foreign-base-url');
    expect(result.baseUrl).toBe(GATEWAY);
    expect(result.previousBaseUrl).toBeNull();
    expect(readJson(path)).toEqual({
      model: 'x',
      provider: { anthropic: { options: { baseURL: GATEWAY, apiKey: 'k' } } },
    });
    expect(readJson(opencodeStatePath())).toEqual({ previousBaseUrls: {} });
  });

  it('keeps the saved URL across a repeated Enable', async () => {
    const path = seedGateway();
    await activateOpencode();
    await activateOpencode();

    await deactivateOpencode();

    expect(readJson(path)['provider']).toEqual({
      anthropic: { options: { baseURL: GATEWAY, apiKey: 'k' } },
    });
  });

  it('removes the key on Disable when nothing was saved', async () => {
    const path = seedConfig(JSON.stringify({ model: 'x' }));
    await activateOpencode();
    expect(inspectOpencodeConfig().previousBaseUrl).toBeNull();

    await deactivateOpencode();

    expect(readJson(path)).toEqual({ model: 'x' });
    expect(existsSync(opencodeStatePath())).toBe(false);
  });

  it('drops a stale saved URL when Enable finds no base URL at all', async () => {
    // Enabled over the gateway, then the user deleted the key by hand.
    const path = seedGateway();
    await activateOpencode();
    writeFileSync(path, JSON.stringify({ model: 'x' }), 'utf8');

    await activateOpencode();
    await deactivateOpencode();

    expect(readJson(path)).toEqual({ model: 'x' });
    expect(readJson(opencodeStatePath())).toEqual({ previousBaseUrls: {} });
  });

  it('reports no previous URL once the file no longer points at Sentinel', async () => {
    const path = seedGateway();
    await activateOpencode();
    // The user repointed the file themselves; the saved entry is not live.
    writeFileSync(
      path,
      JSON.stringify({ provider: { anthropic: { options: { baseURL: 'http://other' } } } }),
      'utf8',
    );
    expect(inspectOpencodeConfig().previousBaseUrl).toBeNull();
  });

  it('keys saved URLs by config path', async () => {
    seedGateway();
    await activateOpencode();

    const other = join(home, 'elsewhere.json');
    process.env.OPENCODE_CONFIG = other;
    writeFileSync(other, '{}', 'utf8');
    await activateOpencode();
    await deactivateOpencode();

    // The other file never had a base URL; it must not inherit the gateway.
    expect(readJson(other)).toEqual({});
  });

  it.each([
    ['corrupt JSON', '{ nope'],
    ['wrong shape', JSON.stringify({ previousBaseUrls: ['x'] })],
    ['missing map', JSON.stringify({})],
  ])('recovers from a %s state file', async (_label, contents) => {
    mkdirSync(dirname(opencodeStatePath()), { recursive: true });
    writeFileSync(opencodeStatePath(), contents, 'utf8');
    const path = seedGateway();

    await activateOpencode();
    await deactivateOpencode();

    expect(readJson(path)['provider']).toEqual({
      anthropic: { options: { baseURL: GATEWAY, apiKey: 'k' } },
    });
  });

  it('ignores non-string entries in the state file', async () => {
    const path = seedConfig(JSON.stringify({}));
    mkdirSync(dirname(opencodeStatePath()), { recursive: true });
    writeFileSync(opencodeStatePath(), JSON.stringify({ previousBaseUrls: { [path]: 42 } }));

    await activateOpencode();
    await deactivateOpencode();

    expect(readJson(path)).toEqual({});
  });
});

describe('symlinked config', () => {
  it('writes through the link to its target and keeps the file mode', async () => {
    const realDir = mkdtempSync(join(tmpdir(), 'sentinel-oc-dotfiles-'));
    try {
      const target = join(realDir, 'opencode.json');
      writeFileSync(target, JSON.stringify({ model: 'x' }), 'utf8');
      chmodSync(target, 0o600);
      const link = join(home, '.config', 'opencode', 'opencode.json');
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link);

      await activateOpencode();
      await deactivateOpencode();
      await activateOpencode();

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readJson(target)).toEqual({
        model: 'x',
        provider: { anthropic: { options: { baseURL: opencodeBaseUrl() } } },
      });
      expect(statSync(target).mode & 0o777).toBe(0o600);
      // No temp files left next to either end of the link.
      expect(readdirSync(realDir)).toEqual(['opencode.json']);
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });

  it('creates the target of a dangling link rather than replacing the link', async () => {
    const realDir = mkdtempSync(join(tmpdir(), 'sentinel-oc-dotfiles-'));
    try {
      const target = join(realDir, 'opencode.json');
      const link = join(home, '.config', 'opencode', 'opencode.json');
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link);

      await activateOpencode();

      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readJson(target)).toEqual({
        provider: { anthropic: { options: { baseURL: opencodeBaseUrl() } } },
      });
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });
});

describe('config resolution edges', () => {
  it('honors XDG_CONFIG_HOME for the config dir', () => {
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    expect(opencodeConfigPath()).toBe(join(home, 'xdg', 'opencode', 'opencode.json'));
  });

  it('falls back to the real home directory without the test seam', () => {
    delete process.env.SENTINEL_TEST_HOME;
    expect(opencodeStatePath()).toBe(join(homedir(), '.sentinel', 'opencode-state.json'));
  });

  it('keeps escaped quotes inside strings while stripping trailing commas', () => {
    expect(JSON.parse(jsoncToJson('{ "a": "say \\"hi,}\\"", }'))).toEqual({ a: 'say "hi,}"' });
  });

  it('leaves an already-saved identical URL alone', async () => {
    const gateway = 'https://gw.example/v1';
    const path = seedConfig(
      JSON.stringify({ provider: { anthropic: { options: { baseURL: gateway } } } }),
    );
    mkdirSync(dirname(opencodeStatePath()), { recursive: true });
    const saved = `${JSON.stringify({ previousBaseUrls: { [path]: gateway } })}\n`;
    writeFileSync(opencodeStatePath(), saved, 'utf8');

    await activateOpencode();

    // Byte-identical: no rewrite when nothing changed.
    expect(readFileSync(opencodeStatePath(), 'utf8')).toBe(saved);
    await deactivateOpencode();
    expect(readJson(path)['provider']).toEqual({ anthropic: { options: { baseURL: gateway } } });
  });
});
