/**
 * opencode surface IPC handlers against a running daemon:
 * get_opencode_config_state, activate_opencode, deactivate_opencode, and the
 * opencode leg of get_surface_state. Real daemon + real Unix-socket IPC + a
 * temp home (SENTINEL_TEST_HOME) that opencode-config.ts resolves through.
 * No mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { startTestDaemon, type TestDaemon } from './index.test-helpers.js';
import { OPENCODE_BASE_URL } from './opencode-config.js';
import type { OpencodeConfigDetails, SurfaceState } from '@sentinel/shared';

describe('opencode surface IPC', () => {
  let ctx: TestDaemon;

  /** Path of the global opencode config inside the daemon's temp home. */
  const configPath = (): string =>
    join(process.env.SENTINEL_TEST_HOME ?? '', '.config', 'opencode', 'opencode.json');

  const seedConfig = (contents: string, filename = 'opencode.json'): string => {
    const path = join(process.env.SENTINEL_TEST_HOME ?? '', '.config', 'opencode', filename);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
    return path;
  };

  beforeEach(async () => {
    ctx = await startTestDaemon();
  });
  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('get_opencode_config_state reports inactive with a resolvable path', async () => {
    const r = await ctx.request<OpencodeConfigDetails>({ type: 'get_opencode_config_state' });
    expect(r.success).toBe(true);
    expect(r.data?.state).toBe('inactive');
    expect(r.data?.baseUrl).toBeNull();
    expect(r.data?.configPath).toBe(configPath());
  });

  it('activate_opencode writes the /v1 base URL and flips the surface state', async () => {
    const r = await ctx.request<OpencodeConfigDetails>({ type: 'activate_opencode' });

    expect(r.success).toBe(true);
    expect(r.data?.state).toBe('active');
    expect(r.data?.baseUrl).toBe(OPENCODE_BASE_URL);
    expect(JSON.parse(readFileSync(configPath(), 'utf8'))).toEqual({
      provider: { anthropic: { options: { baseURL: OPENCODE_BASE_URL } } },
    });

    const surface = await ctx.request<SurfaceState>({ type: 'get_surface_state' });
    expect(surface.data?.opencode).toEqual({
      installed: true,
      activated: true,
      pluginOverride: false,
    });
  });

  it('deactivate_opencode removes the base URL and reports inactive', async () => {
    await ctx.request({ type: 'activate_opencode' });

    const r = await ctx.request<OpencodeConfigDetails>({ type: 'deactivate_opencode' });

    expect(r.success).toBe(true);
    expect(r.data?.state).toBe('inactive');
    expect(JSON.parse(readFileSync(configPath(), 'utf8'))).toEqual({});

    const surface = await ctx.request<SurfaceState>({ type: 'get_surface_state' });
    expect(surface.data?.opencode.activated).toBe(false);
  });

  it('preserves unrelated config keys across activate and deactivate', async () => {
    const path = seedConfig(
      JSON.stringify({ model: 'anthropic/claude-opus-4-8', mcp: { x: { type: 'local' } } }),
    );

    await ctx.request({ type: 'activate_opencode' });
    await ctx.request({ type: 'deactivate_opencode' });

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      model: 'anthropic/claude-opus-4-8',
      mcp: { x: { type: 'local' } },
    });
  });

  it('reports plugin-override and does not claim the surface is routed', async () => {
    // opencode-with-claude rewrites provider.anthropic.options.baseURL at
    // startup, so a written config is dead config — the surface must not read
    // as activated just because the file says so.
    seedConfig(JSON.stringify({ plugin: ['opencode-with-claude'] }));

    const r = await ctx.request<OpencodeConfigDetails>({ type: 'activate_opencode' });

    expect(r.data?.state).toBe('plugin-override');
    expect(r.data?.overridingPlugins).toEqual(['opencode-with-claude']);

    const surface = await ctx.request<SurfaceState>({ type: 'get_surface_state' });
    expect(surface.data?.opencode).toEqual({
      installed: true,
      activated: false,
      pluginOverride: true,
    });
  });

  it('refuses to rewrite a commented config and returns a snippet to paste', async () => {
    const original = '{\n  // keep me\n  "model": "anthropic/claude-opus-4-8"\n}\n';
    const path = seedConfig(original, 'opencode.jsonc');

    const r = await ctx.request<OpencodeConfigDetails>({ type: 'activate_opencode' });

    expect(r.data?.state).toBe('unwritable');
    expect(r.data?.manualSnippet).toContain(OPENCODE_BASE_URL);
    expect(readFileSync(path, 'utf8')).toBe(original);
  });
});
