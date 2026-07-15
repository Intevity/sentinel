import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  activateDesktop,
  deactivateDesktop,
  inspectDesktopConfig,
  classifyDesktopConfig,
  canonHashDesktopDrift,
  resolveDesktopUserDataBase,
  desktopConfigLibraryDir,
  installDesktopMcpServer,
  uninstallDesktopMcpServer,
  SENTINEL_DESKTOP_ENTRY_NAME,
  DESKTOP_GATEWAY_DUMMY_KEY,
  DESKTOP_MCP_SERVER_NAME,
} from './claude-desktop-config.js';
import { SENTINEL_BASE_URL } from './claude-otel-config.js';

describe('resolveDesktopUserDataBase (cross-platform, pure)', () => {
  const home = '/home/u';
  it('macOS → Application Support/Claude-3p', () => {
    expect(resolveDesktopUserDataBase('darwin', {}, home)).toBe(
      '/home/u/Library/Application Support/Claude-3p',
    );
  });
  it('Windows → %LOCALAPPDATA%\\Claude-3p when set', () => {
    expect(
      resolveDesktopUserDataBase('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, home),
    ).toBe(join('C:\\Users\\u\\AppData\\Local', 'Claude-3p'));
  });
  it('Windows → AppData/Local fallback when LOCALAPPDATA unset', () => {
    expect(resolveDesktopUserDataBase('win32', {}, home)).toBe(
      join(home, 'AppData', 'Local', 'Claude-3p'),
    );
  });
  it('Linux → $XDG_CONFIG_HOME/Claude-3p when set', () => {
    expect(resolveDesktopUserDataBase('linux', { XDG_CONFIG_HOME: '/cfg' }, home)).toBe(
      '/cfg/Claude-3p',
    );
  });
  it('Linux → ~/.config/Claude-3p when XDG unset', () => {
    expect(resolveDesktopUserDataBase('linux', {}, home)).toBe('/home/u/.config/Claude-3p');
  });
});

describe('classifyDesktopConfig (pure)', () => {
  const gw = (baseUrl: string, provider = 'gateway') => ({
    inferenceProvider: provider,
    inferenceGatewayBaseUrl: baseUrl,
    inferenceGatewayApiKey: 'x',
    inferenceGatewayAuthScheme: 'bearer',
  });
  it('null meta → not-installed', () => {
    expect(classifyDesktopConfig(null, null).state).toBe('not-installed');
  });
  it('meta without appliedId → inactive', () => {
    expect(classifyDesktopConfig({ appliedId: '', entries: [] }, null).state).toBe('inactive');
  });
  it('appliedId set but config missing → inactive', () => {
    const d = classifyDesktopConfig({ appliedId: 'abc', entries: [{ id: 'abc' }] }, null);
    expect(d.state).toBe('inactive');
    expect(d.appliedId).toBe('abc');
  });
  it('gateway pointing at Sentinel → active', () => {
    const d = classifyDesktopConfig(
      { appliedId: 'a', entries: [{ id: 'a' }] },
      gw(SENTINEL_BASE_URL),
    );
    expect(d.state).toBe('active');
    expect(d.appliedBaseUrl).toBe(SENTINEL_BASE_URL);
    expect(d.appliedProvider).toBe('gateway');
  });
  it('gateway pointing elsewhere → foreign-gateway', () => {
    const d = classifyDesktopConfig(
      { appliedId: 'a', entries: [{ id: 'a' }] },
      gw('https://other-gateway.example.com'),
    );
    expect(d.state).toBe('foreign-gateway');
    expect(d.appliedBaseUrl).toBe('https://other-gateway.example.com');
  });
  it('non-gateway provider → inactive', () => {
    const d = classifyDesktopConfig(
      { appliedId: 'a', entries: [{ id: 'a' }] },
      gw(SENTINEL_BASE_URL, 'anthropic'),
    );
    expect(d.state).toBe('inactive');
    expect(d.appliedProvider).toBe('anthropic');
  });
  it('recognizes the older localhost endpoint form as Sentinel', () => {
    const d = classifyDesktopConfig(
      { appliedId: 'a', entries: [{ id: 'a' }] },
      gw('http://localhost:47284'),
    );
    expect(d.state).toBe('active');
  });
});

describe('canonHashDesktopDrift', () => {
  it('is stable and differs on state change', () => {
    const a = {
      state: 'active' as const,
      appliedId: 'x',
      appliedBaseUrl: SENTINEL_BASE_URL,
      appliedProvider: 'gateway',
    };
    const b = { ...a, state: 'inactive' as const };
    expect(canonHashDesktopDrift(a)).toBe(canonHashDesktopDrift({ ...a }));
    expect(canonHashDesktopDrift(a)).not.toBe(canonHashDesktopDrift(b));
  });
});

describe('activate / deactivate / inspect (real files)', () => {
  let workdir: string;
  let libDir: string;
  const prevEnv = process.env.SENTINEL_TEST_CLAUDE_DESKTOP_DIR;

  const readMeta = () =>
    JSON.parse(readFileSync(join(libDir, '_meta.json'), 'utf8')) as {
      appliedId: string;
      entries: Array<{ id: string; name?: string }>;
    };
  const readConfig = (id: string) =>
    JSON.parse(readFileSync(join(libDir, `${id}.json`), 'utf8')) as Record<string, unknown>;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'desktop-cfg-'));
    libDir = join(workdir, 'configLibrary');
    process.env.SENTINEL_TEST_CLAUDE_DESKTOP_DIR = libDir;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.SENTINEL_TEST_CLAUDE_DESKTOP_DIR;
    else process.env.SENTINEL_TEST_CLAUDE_DESKTOP_DIR = prevEnv;
    rmSync(workdir, { recursive: true, force: true });
  });

  it('desktopConfigLibraryDir honors the test seam', () => {
    expect(desktopConfigLibraryDir()).toBe(libDir);
  });

  it('activate on a clean machine writes both files and points appliedId at us', async () => {
    const { details, configId } = await activateDesktop(null);
    expect(details.state).toBe('active');
    const meta = readMeta();
    expect(meta.appliedId).toBe(configId);
    expect(meta.entries).toContainEqual({ id: configId, name: SENTINEL_DESKTOP_ENTRY_NAME });
    const cfg = readConfig(configId);
    expect(cfg).toEqual({
      inferenceProvider: 'gateway',
      inferenceGatewayBaseUrl: SENTINEL_BASE_URL,
      inferenceGatewayApiKey: DESKTOP_GATEWAY_DUMMY_KEY,
      inferenceGatewayAuthScheme: 'bearer',
    });
    // inspect agrees
    expect((await inspectDesktopConfig()).state).toBe('active');
  });

  it('activate is idempotent when given the recorded id (no duplicate entries)', async () => {
    const first = await activateDesktop(null);
    const second = await activateDesktop(first.configId);
    expect(second.configId).toBe(first.configId);
    const meta = readMeta();
    expect(meta.entries.filter((e) => e.id === first.configId)).toHaveLength(1);
  });

  it('activate preserves a pre-existing non-Sentinel config and its entry', async () => {
    mkdirSync(libDir, { recursive: true });
    writeFileSync(
      join(libDir, 'foreign.json'),
      JSON.stringify({
        inferenceProvider: 'gateway',
        inferenceGatewayBaseUrl: 'https://corp.example',
      }),
    );
    writeFileSync(
      join(libDir, '_meta.json'),
      JSON.stringify({ appliedId: 'foreign', entries: [{ id: 'foreign', name: 'Corp' }] }),
    );
    const { configId } = await activateDesktop(null);
    const meta = readMeta();
    expect(meta.appliedId).toBe(configId); // we became active
    expect(meta.entries).toContainEqual({ id: 'foreign', name: 'Corp' }); // theirs preserved
    expect(existsSync(join(libDir, 'foreign.json'))).toBe(true);
  });

  it('activate reuses an existing entry named "Sentinel" when no id is recorded', async () => {
    mkdirSync(libDir, { recursive: true });
    writeFileSync(
      join(libDir, '_meta.json'),
      JSON.stringify({
        appliedId: '',
        entries: [{ id: 'legacy-sentinel-id', name: SENTINEL_DESKTOP_ENTRY_NAME }],
      }),
    );
    const { configId } = await activateDesktop(null);
    expect(configId).toBe('legacy-sentinel-id');
  });

  it('deactivate removes our entry+file and clears appliedId, preserving others', async () => {
    // pre-existing foreign config + our active config
    mkdirSync(libDir, { recursive: true });
    writeFileSync(join(libDir, 'foreign.json'), JSON.stringify({ inferenceProvider: 'anthropic' }));
    writeFileSync(
      join(libDir, '_meta.json'),
      JSON.stringify({ appliedId: 'foreign', entries: [{ id: 'foreign', name: 'Corp' }] }),
    );
    const { configId } = await activateDesktop(null);
    expect(existsSync(join(libDir, `${configId}.json`))).toBe(true);

    const details = await deactivateDesktop(configId);
    // appliedId was ours → repointed to the remaining foreign entry
    const meta = readMeta();
    expect(meta.appliedId).toBe('foreign');
    expect(meta.entries).toEqual([{ id: 'foreign', name: 'Corp' }]);
    expect(existsSync(join(libDir, `${configId}.json`))).toBe(false);
    expect(details.state).toBe('inactive'); // foreign is anthropic provider
  });

  it('deactivate when we are the only entry clears appliedId to empty', async () => {
    const { configId } = await activateDesktop(null);
    const details = await deactivateDesktop(configId);
    const meta = readMeta();
    expect(meta.appliedId).toBe('');
    expect(meta.entries).toEqual([]);
    expect(details.state).toBe('inactive');
  });

  it('deactivate matches our entry by name when no id is recorded', async () => {
    await activateDesktop(null);
    const details = await deactivateDesktop(null); // no id → match by name
    expect(readMeta().entries).toEqual([]);
    expect(details.state).toBe('inactive');
  });

  it('deactivate on a machine with no configLibrary → not-installed', async () => {
    expect((await deactivateDesktop(null)).state).toBe('not-installed');
  });

  it('inspect on a clean machine → not-installed', async () => {
    expect((await inspectDesktopConfig()).state).toBe('not-installed');
  });

  it('inspect tolerates corrupt JSON (treats as not-installed)', async () => {
    mkdirSync(libDir, { recursive: true });
    writeFileSync(join(libDir, '_meta.json'), '{ not json');
    expect((await inspectDesktopConfig()).state).toBe('not-installed');
  });

  // ─── Sentinel MCP entry (stdio bridge) in claude_desktop_config.json ──────

  describe('installDesktopMcpServer / uninstallDesktopMcpServer', () => {
    const spec = {
      command: '/apps/sentinel-daemon',
      args: ['mcp-stdio'],
      url: 'http://127.0.0.1:47284/mcp',
      token: 'tok-123',
    };
    const appCfgPath = () => join(workdir, 'claude_desktop_config.json');
    const readAppCfg = () =>
      JSON.parse(readFileSync(appCfgPath(), 'utf8')) as {
        mcpServers?: Record<
          string,
          { command: string; args: string[]; env: Record<string, string> }
        >;
        [k: string]: unknown;
      };

    it('creates the file with the sentinel entry when absent', async () => {
      expect(await installDesktopMcpServer(spec)).toBe(true);
      const cfg = readAppCfg();
      expect(cfg.mcpServers?.[DESKTOP_MCP_SERVER_NAME]).toEqual({
        command: '/apps/sentinel-daemon',
        args: ['mcp-stdio'],
        env: { SENTINEL_MCP_URL: spec.url, SENTINEL_MCP_TOKEN: spec.token },
      });
    });

    it('preserves foreign keys and other MCP servers on install', async () => {
      writeFileSync(
        appCfgPath(),
        JSON.stringify({
          deploymentMode: '3p',
          preferences: { sidebarMode: 'epitaxy' },
          mcpServers: { other: { command: 'other-bin' } },
        }),
      );
      expect(await installDesktopMcpServer(spec)).toBe(true);
      const cfg = readAppCfg();
      expect(cfg.deploymentMode).toBe('3p');
      expect(cfg.preferences).toEqual({ sidebarMode: 'epitaxy' });
      expect(cfg.mcpServers?.other).toEqual({ command: 'other-bin' });
      expect(cfg.mcpServers?.[DESKTOP_MCP_SERVER_NAME]?.command).toBe('/apps/sentinel-daemon');
    });

    it('is idempotent: re-install with the same spec reports no change', async () => {
      expect(await installDesktopMcpServer(spec)).toBe(true);
      expect(await installDesktopMcpServer(spec)).toBe(false);
    });

    it('refreshes the entry when the token or binary path changes', async () => {
      await installDesktopMcpServer(spec);
      expect(await installDesktopMcpServer({ ...spec, token: 'tok-456' })).toBe(true);
      expect(readAppCfg().mcpServers?.[DESKTOP_MCP_SERVER_NAME]?.env.SENTINEL_MCP_TOKEN).toBe(
        'tok-456',
      );
      expect(
        await installDesktopMcpServer({ ...spec, token: 'tok-456', command: '/new/bin' }),
      ).toBe(true);
      expect(readAppCfg().mcpServers?.[DESKTOP_MCP_SERVER_NAME]?.command).toBe('/new/bin');
    });

    it('uninstall removes only the sentinel entry', async () => {
      writeFileSync(
        appCfgPath(),
        JSON.stringify({ mcpServers: { other: { command: 'other-bin' } } }),
      );
      await installDesktopMcpServer(spec);
      expect(await uninstallDesktopMcpServer()).toBe(true);
      const cfg = readAppCfg();
      expect(cfg.mcpServers?.[DESKTOP_MCP_SERVER_NAME]).toBeUndefined();
      expect(cfg.mcpServers?.other).toEqual({ command: 'other-bin' });
    });

    it('uninstall with no file or no entry is a no-op', async () => {
      expect(await uninstallDesktopMcpServer()).toBe(false);
      writeFileSync(appCfgPath(), JSON.stringify({ deploymentMode: '3p' }));
      expect(await uninstallDesktopMcpServer()).toBe(false);
      expect(readAppCfg().deploymentMode).toBe('3p');
    });
  });
});
