import { describe, it, expect, vi } from 'vitest';
import type { IsolationPolicy } from '@sentinel/shared';
import {
  createSandboxRuntime,
  toShellLine,
  type SandboxManagerLike,
  type SandboxRuntimeDeps,
} from './sandbox-runtime.js';
import type { SandboxProbe } from './capability.js';

function policy(overrides: Partial<IsolationPolicy> = {}): IsolationPolicy {
  return {
    enabled: true,
    syncToClaudeCode: false,
    enforceCodeMode: true,
    network: { allowedDomains: ['example.com'], deniedDomains: [] },
    filesystem: { allowWrite: ['~/.cache'], denyWrite: [], denyRead: [], allowRead: [] },
    credentials: { files: [], envVars: [] },
    ...overrides,
  };
}

const FULL_DARWIN: SandboxProbe = {
  sandboxExec: true,
  ripgrep: true,
  bubblewrap: false,
  socat: false,
  seccomp: false,
  srtWin: false,
};

function fakeManager(): SandboxManagerLike & {
  initialize: ReturnType<typeof vi.fn>;
  wrapWithSandboxArgv: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
} {
  return {
    initialize: vi.fn(async () => {}),
    wrapWithSandboxArgv: vi.fn(async (cmdline: string) => ({
      argv: ['/usr/bin/sandbox-exec', '-p', 'profile', '/bin/sh', '-c', cmdline],
      env: { HTTP_PROXY: 'http://127.0.0.1:3128', DROPPED: undefined },
    })),
    reset: vi.fn(async () => {}),
  };
}

function make(overrides: Partial<SandboxRuntimeDeps> & { policy?: IsolationPolicy } = {}): {
  rt: ReturnType<typeof createSandboxRuntime>;
  manager: ReturnType<typeof fakeManager>;
} {
  const manager = fakeManager();
  let current = overrides.policy ?? policy();
  const rt = createSandboxRuntime({
    getPolicy: overrides.getPolicy ?? (() => current),
    manager: overrides.manager ?? manager,
    platform: overrides.platform ?? 'darwin',
    probe: overrides.probe ?? (() => FULL_DARWIN),
    ...(overrides.platformPaths ? { platformPaths: overrides.platformPaths } : {}),
  });
  // expose setter via closure trick
  (rt as unknown as { setPolicy: (p: IsolationPolicy) => void }).setPolicy = (p) => {
    current = p;
  };
  return { rt, manager };
}

describe('toShellLine', () => {
  it('leaves simple tokens unquoted and quotes the tricky ones', () => {
    expect(toShellLine('npx', ['mcp-server', '--port', '8080'])).toBe('npx mcp-server --port 8080');
    expect(toShellLine('my cmd', ['a b', "it's", '*.ts', ''])).toBe(
      `'my cmd' 'a b' 'it'\\''s' '*.ts' ''`,
    );
  });
});

describe('createSandboxRuntime defaults', () => {
  it('falls back to the real manager, platform, and probe when omitted', () => {
    // No manager/platform/probe/platformPaths injected — exercises the
    // default-coalescing branches. getStatus runs the real best-effort probe
    // for the host platform but never touches the manager.
    const rt = createSandboxRuntime({ getPolicy: () => policy({ enabled: false }) });
    const status = rt.getStatus();
    expect(status.platform).toBe(process.platform);
    expect(['full', 'network-only', 'unavailable']).toContain(status.capability);
  });
});

describe('createSandboxRuntime.getStatus', () => {
  it('reports the computed capability for the platform', () => {
    const { rt } = make();
    expect(rt.getStatus().capability).toBe('full');
  });

  it('reports unavailable when the probe lacks deps', () => {
    const { rt } = make({ probe: () => ({ ...FULL_DARWIN, sandboxExec: false }) });
    expect(rt.getStatus().capability).toBe('unavailable');
  });
});

describe('createSandboxRuntime.refresh', () => {
  it('initializes the manager when enforcement is on and the platform supports it', async () => {
    const { rt, manager } = make();
    await rt.refresh();
    expect(manager.initialize).toHaveBeenCalledTimes(1);
    const config = manager.initialize.mock.calls[0]![0];
    expect(config.network.allowedDomains).toEqual(['example.com']);
    expect(config.filesystem.allowWrite).toEqual(['~/.cache']);
  });

  it('does not initialize when the policy is disabled', async () => {
    const { rt, manager } = make({ policy: policy({ enabled: false }) });
    await rt.refresh();
    expect(manager.initialize).not.toHaveBeenCalled();
  });

  it('does not initialize when enforceCodeMode is off', async () => {
    const { rt, manager } = make({ policy: policy({ enforceCodeMode: false }) });
    await rt.refresh();
    expect(manager.initialize).not.toHaveBeenCalled();
  });

  it('does not initialize when the platform capability is unavailable', async () => {
    const { rt, manager } = make({ probe: () => ({ ...FULL_DARWIN, sandboxExec: false }) });
    await rt.refresh();
    expect(manager.initialize).not.toHaveBeenCalled();
  });

  it('is idempotent when the effective config is unchanged', async () => {
    const { rt, manager } = make();
    await rt.refresh();
    await rt.refresh();
    expect(manager.initialize).toHaveBeenCalledTimes(1);
  });

  it('re-initializes when the policy content changes', async () => {
    let current = policy();
    const { rt, manager } = make({ getPolicy: () => current });
    await rt.refresh();
    current = policy({ network: { allowedDomains: ['changed.com'], deniedDomains: [] } });
    await rt.refresh();
    expect(manager.initialize).toHaveBeenCalledTimes(2);
  });

  it('resets the manager when enforcement is turned off after being on', async () => {
    let current = policy();
    const { rt, manager } = make({ getPolicy: () => current });
    await rt.refresh();
    current = policy({ enforceCodeMode: false });
    await rt.refresh();
    expect(manager.reset).toHaveBeenCalledTimes(1);
  });
});

describe('createSandboxRuntime.wrapStdioCommand', () => {
  it('returns null (run unsandboxed) when not active', async () => {
    const { rt } = make();
    expect(await rt.wrapStdioCommand('npx', ['x'], {})).toBeNull();
  });

  it('wraps the command via the manager and merges the sandbox env', async () => {
    const { rt, manager } = make();
    await rt.refresh();
    const wrapped = await rt.wrapStdioCommand('npx', ['mcp', '--flag'], { PATH: '/usr/bin' });
    expect(manager.wrapWithSandboxArgv).toHaveBeenCalledWith('npx mcp --flag');
    expect(wrapped).toEqual({
      command: '/usr/bin/sandbox-exec',
      args: ['-p', 'profile', '/bin/sh', '-c', 'npx mcp --flag'],
      env: { PATH: '/usr/bin', HTTP_PROXY: 'http://127.0.0.1:3128' }, // DROPPED (undefined) filtered out
    });
  });

  it('degrades to null when the manager throws', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const manager = fakeManager();
    manager.wrapWithSandboxArgv.mockRejectedValueOnce(new Error('seatbelt boom'));
    const { rt } = make({ manager });
    await rt.refresh();
    expect(await rt.wrapStdioCommand('npx', [], {})).toBeNull();
    errSpy.mockRestore();
  });

  it('degrades to null when the manager returns an empty argv', async () => {
    const manager = fakeManager();
    manager.wrapWithSandboxArgv.mockResolvedValueOnce({ argv: [], env: {} });
    const { rt } = make({ manager });
    await rt.refresh();
    expect(await rt.wrapStdioCommand('npx', [], {})).toBeNull();
  });
});

describe('createSandboxRuntime.reset', () => {
  it('resets only when active', async () => {
    const { rt, manager } = make();
    await rt.reset();
    expect(manager.reset).not.toHaveBeenCalled();
    await rt.refresh();
    await rt.reset();
    expect(manager.reset).toHaveBeenCalledTimes(1);
  });
});
