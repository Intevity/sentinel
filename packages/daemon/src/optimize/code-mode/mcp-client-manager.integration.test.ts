/**
 * Integration: the code-mode MCP client manager against real fake servers —
 * an HTTP MCP server on a real loopback listener and a stdio MCP server
 * spawned as a real child process. No mocks; the SDK client under test is
 * the production one.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  startFakeMcpHttpServer,
  writeFakeMcpStdioScript,
  writeFakeMcpStdioScriptWithStderr,
  FAKE_MCP_TOOLS,
  type FakeMcpHttpServer,
} from '@sentinel/test-harness';
import { redactSecretsInString } from '../../security/detectors.js';
import { createMcpClientManager, type McpClientManager } from './mcp-client-manager.js';

/** Adapt a bare `(server) => entry` resolver to the manager's ResolvedEntry
 *  contract. These tests configure one record per server, so the server name is
 *  a fine cache key. */
function byServer(fn: (server: string) => unknown) {
  return (server: string) => {
    const entry = fn(server);
    return entry === undefined ? undefined : { key: server, entry };
  };
}

describe('mcp-client-manager (HTTP transport)', () => {
  let fake: FakeMcpHttpServer | null = null;
  let manager: McpClientManager | null = null;
  let cleanupScript: (() => void) | null = null;

  afterEach(async () => {
    await manager?.stopAll();
    await fake?.close();
    cleanupScript?.();
    fake = null;
    manager = null;
    cleanupScript = null;
  });

  function managerFor(
    entries: Record<string, unknown>,
    allowed: string[] = Object.keys(entries),
    extra: Partial<Parameters<typeof createMcpClientManager>[0]> = {},
  ): McpClientManager {
    manager = createMcpClientManager({
      resolveEntry: byServer((server) => entries[server]),
      isAllowed: (server) => allowed.includes(server),
      redact: redactSecretsInString,
      ...extra,
    });
    return manager;
  }

  it('lists the canned tools end-to-end', async () => {
    fake = await startFakeMcpHttpServer();
    const m = managerFor({ fakehttp: { type: 'http', url: fake.url } });
    const tools = await m.listTools('fakehttp');
    expect(tools.map((t) => t.name)).toEqual(FAKE_MCP_TOOLS.map((t) => t.name));
    const echo = tools.find((t) => t.name === 'echo');
    expect(echo?.description).toBe('Echo the arguments back as JSON text');
    expect(echo?.inputSchema).toMatchObject({ type: 'object' });
  });

  it('round-trips a tool call: args reach the server, result comes back', async () => {
    fake = await startFakeMcpHttpServer();
    const m = managerFor({ fakehttp: { type: 'http', url: fake.url } });
    const result = await m.call('fakehttp', 'add', { a: 19, b: 23 });
    expect(result.isError).toBe(false);
    expect(result.truncated).toBe(false);
    expect(JSON.parse(result.contentJson)).toEqual([{ type: 'text', text: '42' }]);
    expect(fake.calls).toEqual([{ tool: 'add', args: { a: 19, b: 23 } }]);
  });

  it('forwards configured auth headers (server rejects without them)', async () => {
    fake = await startFakeMcpHttpServer({ requireToken: 'srv-secret' });
    const m = managerFor({
      authed: {
        type: 'http',
        url: fake.url,
        headers: { Authorization: 'Bearer srv-secret' },
      },
      unauthed: { type: 'http', url: fake.url },
    });
    const ok = await m.call('authed', 'echo', { text: 'hi' });
    expect(JSON.parse(ok.contentJson)).toEqual([
      { type: 'text', text: JSON.stringify({ echo: { text: 'hi' } }) },
    ]);
    await expect(m.call('unauthed', 'echo', {})).rejects.toThrow();
  });

  it('rejects calls to servers outside the allowlist without connecting', async () => {
    fake = await startFakeMcpHttpServer();
    const m = managerFor({ fakehttp: { type: 'http', url: fake.url } }, [] /* nothing allowed */);
    await expect(m.call('fakehttp', 'echo', {})).rejects.toThrow(
      "MCP server 'fakehttp' is not bridged to code mode",
    );
    await expect(m.listTools('fakehttp')).rejects.toThrow('not bridged');
    expect(m.connectedCount()).toBe(0); // gate fires before any connection
  });

  it('verify works without the allowlist gate and returns the live tools', async () => {
    fake = await startFakeMcpHttpServer();
    const availability: Array<[string, boolean]> = [];
    const m = managerFor({ fakehttp: { type: 'http', url: fake.url } }, [], {
      onAvailability: (s, a) => availability.push([s, a]),
    });
    const v = await m.verify('fakehttp');
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.tools.map((t) => t.name)).toEqual(FAKE_MCP_TOOLS.map((t) => t.name));
      expect(v.tools[0]?.inputSchema).toMatchObject({ type: 'object' });
    }
    expect(availability).toContainEqual(['fakehttp', true]);
  });

  it('flags unavailability when a connected server dies mid-call, not just on connect', async () => {
    fake = await startFakeMcpHttpServer();
    const availability: Array<[string, boolean]> = [];
    const m = managerFor({ fakehttp: { type: 'http', url: fake.url } }, ['fakehttp'], {
      onAvailability: (s, a) => availability.push([s, a]),
    });
    await m.listTools('fakehttp');
    expect(availability).toEqual([['fakehttp', true]]);

    await fake.close();
    fake = null;
    await expect(m.call('fakehttp', 'add', { a: 1, b: 2 })).rejects.toThrow();

    // Availability used to flip only on a failed CONNECT, so a server that
    // connected and then died kept showing as healthy in the UI.
    expect(availability).toEqual([
      ['fakehttp', true],
      ['fakehttp', false],
    ]);
    // The broken client is dropped, and the reason survives it.
    expect(m.connectedCount()).toBe(0);
    const runtime = await m.runtime();
    expect(runtime[0]?.server).toBe('fakehttp');
    expect(runtime[0]?.lastError ?? '').not.toBe('');
  });

  it('clears a recorded failure once the server answers again', async () => {
    fake = await startFakeMcpHttpServer();
    const m = managerFor({ fakehttp: { type: 'http', url: fake.url } }, ['fakehttp']);
    await m.listTools('fakehttp');
    await m.call('fakehttp', 'fail', {});
    expect((await m.runtime())[0]?.lastError).toBeNull();
  });

  it('verify reports a clear failure for an unknown server and flags unavailability', async () => {
    const availability: Array<[string, boolean]> = [];
    const m = managerFor({}, [], { onAvailability: (s, a) => availability.push([s, a]) });
    const v = await m.verify('ghost');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/No usable config entry/);
  });

  it('verify reports a clear failure for an entry with neither command nor url', async () => {
    const m = managerFor({ junk: { note: 'nothing useful' } }, []);
    const v = await m.verify('junk');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/neither a command nor a url/);
  });

  it('caps oversized results with an explicit truncation marker', async () => {
    fake = await startFakeMcpHttpServer();
    const m = managerFor({ fakehttp: { type: 'http', url: fake.url } }, ['fakehttp'], {
      maxResultBytes: 1024,
    });
    const result = await m.call('fakehttp', 'blob', { bytes: 10_000 });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeGreaterThan(10_000);
    const parsed = JSON.parse(result.contentJson) as Array<{ type: string; text: string }>;
    expect(parsed[0]?.text).toMatch(/truncated by Sentinel: \d+ bytes exceeded the 1024-byte/);
  });

  it('surfaces isError results without throwing', async () => {
    fake = await startFakeMcpHttpServer();
    const m = managerFor({ fakehttp: { type: 'http', url: fake.url } });
    const result = await m.call('fakehttp', 'fail', {});
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.contentJson)).toEqual([
      { type: 'text', text: 'deliberate failure from fake MCP server' },
    ]);
  });

  it('reuses one connection across calls and shuts it down when idle', async () => {
    fake = await startFakeMcpHttpServer();
    const m = managerFor({ fakehttp: { type: 'http', url: fake.url } }, ['fakehttp'], {
      idleShutdownMs: 150,
    });
    await m.call('fakehttp', 'echo', {});
    await m.call('fakehttp', 'echo', {});
    expect(m.connectedCount()).toBe(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(m.connectedCount()).toBe(0);
    // Next call transparently reconnects.
    const again = await m.call('fakehttp', 'add', { a: 1, b: 1 });
    expect(JSON.parse(again.contentJson)).toEqual([{ type: 'text', text: '2' }]);
  });

  it('stopAll closes every client and refuses new connections', async () => {
    fake = await startFakeMcpHttpServer();
    const m = managerFor({ fakehttp: { type: 'http', url: fake.url } });
    await m.call('fakehttp', 'echo', {});
    expect(m.connectedCount()).toBe(1);
    await m.stopAll();
    expect(m.connectedCount()).toBe(0);
    await expect(m.call('fakehttp', 'echo', {})).rejects.toThrow('shut down');
  });
});

describe('mcp-client-manager (stdio transport — real child process)', () => {
  let manager: McpClientManager | null = null;
  let cleanupScript: (() => void) | null = null;

  afterEach(async () => {
    await manager?.stopAll();
    cleanupScript?.();
    manager = null;
    cleanupScript = null;
  });

  function stdioManager(env: Record<string, string> = {}): McpClientManager {
    const script = writeFakeMcpStdioScript();
    cleanupScript = script.cleanup;
    manager = createMcpClientManager({
      resolveEntry: byServer((server) =>
        server === 'fakestdio'
          ? { command: process.execPath, args: [script.path], env }
          : undefined,
      ),
      isAllowed: (server) => server === 'fakestdio',
      redact: redactSecretsInString,
    });
    return manager;
  }

  it('spawns the script, lists tools, and round-trips a call', async () => {
    const m = stdioManager();
    const tools = await m.listTools('fakestdio');
    expect(tools.map((t) => t.name)).toEqual(FAKE_MCP_TOOLS.map((t) => t.name));
    const result = await m.call('fakestdio', 'echo', { from: 'stdio' });
    expect(JSON.parse(result.contentJson)).toEqual([
      { type: 'text', text: JSON.stringify({ echo: { from: 'stdio' } }) },
    ]);
  });

  it('surfaces a spawn-side failure as a verify error, never a crash', async () => {
    const m = stdioManager({ FAKE_MCP_EXIT_EARLY: '1' });
    const v = await m.verify('fakestdio');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error.length).toBeGreaterThan(0);
  });

  // The bug this fix targets: a GUI-launched daemon inherits a minimal PATH, so
  // a bare-name launcher (uvx/npx) fails to spawn. Simulate that by stripping
  // PATH down to a bogus dir and spawning the bare command `env` (which lives in
  // a dir augmentedPath() restores). Without the augmentation, the child env
  // would carry the bogus PATH and `env` would ENOENT — so this fails on regression.
  it.skipIf(process.platform === 'win32')(
    'rescues a bare-name spawn when the inherited PATH lacks the tool dir',
    async () => {
      const script = writeFakeMcpStdioScript();
      cleanupScript = script.cleanup;
      const original = process.env['PATH'];
      process.env['PATH'] = '/nonexistent-sentinel-pathdir';
      try {
        manager = createMcpClientManager({
          // `env` resolves via PATH, then execs node (absolute) on the script.
          resolveEntry: byServer((server) =>
            server === 'fakestdio'
              ? { command: 'env', args: [process.execPath, script.path] }
              : undefined,
          ),
          isAllowed: (server) => server === 'fakestdio',
          redact: redactSecretsInString,
        });
        const tools = await manager.listTools('fakestdio');
        expect(tools.map((t) => t.name)).toEqual(FAKE_MCP_TOOLS.map((t) => t.name));
      } finally {
        if (original === undefined) delete process.env['PATH'];
        else process.env['PATH'] = original;
      }
    },
  );

  // An explicit per-server env.PATH is an intentional override and must win over
  // the augmentation. Pinning it to a useless dir makes the bare `env` ENOENT,
  // which also exercises the clarified not-found message.
  it.skipIf(process.platform === 'win32')(
    'respects an explicit env.PATH and reports a clear not-found error',
    async () => {
      const script = writeFakeMcpStdioScript();
      cleanupScript = script.cleanup;
      manager = createMcpClientManager({
        resolveEntry: byServer((server) =>
          server === 'fakestdio'
            ? {
                command: 'env',
                args: [process.execPath, script.path],
                env: { PATH: '/nonexistent-sentinel-pathdir' },
              }
            : undefined,
        ),
        isAllowed: (server) => server === 'fakestdio',
        redact: redactSecretsInString,
      });
      const v = await manager.verify('fakestdio');
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.error).toContain("command 'env'");
        expect(v.error).toContain('not found on PATH');
      }
    },
  );
});

describe('mcp-client-manager (Leg B sandbox wrapping)', () => {
  let manager: McpClientManager | null = null;
  let cleanupScript: (() => void) | null = null;

  afterEach(async () => {
    await manager?.stopAll();
    cleanupScript?.();
    manager = null;
    cleanupScript = null;
  });

  it('invokes wrapStdioCommand with the resolved command/args/env and uses a pass-through wrapper', async () => {
    const script = writeFakeMcpStdioScript();
    cleanupScript = script.cleanup;
    const wrap = vi.fn(async (command: string, args: string[], env: Record<string, string>) => ({
      command,
      args,
      env,
    }));
    manager = createMcpClientManager({
      resolveEntry: byServer((server) =>
        server === 'fakestdio' ? { command: process.execPath, args: [script.path] } : undefined,
      ),
      isAllowed: (server) => server === 'fakestdio',
      redact: redactSecretsInString,
      wrapStdioCommand: wrap,
    });
    const tools = await manager.listTools('fakestdio');
    expect(tools.map((t) => t.name)).toEqual(FAKE_MCP_TOOLS.map((t) => t.name));
    expect(wrap).toHaveBeenCalledTimes(1);
    const [cmd, args, env] = wrap.mock.calls[0]!;
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual([script.path]);
    expect(env).toHaveProperty('PATH'); // augmented stdio env was passed through
  });

  it('spawns the wrapper return value, not the original (a broken wrapper fails to connect)', async () => {
    const script = writeFakeMcpStdioScript();
    cleanupScript = script.cleanup;
    manager = createMcpClientManager({
      resolveEntry: byServer((server) =>
        server === 'fakestdio' ? { command: process.execPath, args: [script.path] } : undefined,
      ),
      isAllowed: (server) => server === 'fakestdio',
      redact: redactSecretsInString,
      // Wrapper substitutes a non-existent binary: if the wrapped command is what
      // gets spawned (it should be), the connection fails.
      wrapStdioCommand: async () => ({
        command: '/nonexistent-sentinel-sandbox-binary',
        args: [],
        env: {},
      }),
    });
    const v = await manager.verify('fakestdio');
    expect(v.ok).toBe(false);
  });

  it('runs the child unsandboxed when the wrapper returns null (degrade path)', async () => {
    const script = writeFakeMcpStdioScript();
    cleanupScript = script.cleanup;
    manager = createMcpClientManager({
      resolveEntry: byServer((server) =>
        server === 'fakestdio' ? { command: process.execPath, args: [script.path] } : undefined,
      ),
      isAllowed: (server) => server === 'fakestdio',
      redact: redactSecretsInString,
      wrapStdioCommand: async () => null,
    });
    const tools = await manager.listTools('fakestdio');
    expect(tools.map((t) => t.name)).toEqual(FAKE_MCP_TOOLS.map((t) => t.name));
  });
  it('captures the child stderr tail, redacted, and keeps it after disconnect', async () => {
    // A server that starts fine and only announces its problem on stderr —
    // the shape of an expired-token 401, and previously discarded outright.
    const script = writeFakeMcpStdioScriptWithStderr([
      'INFO starting up',
      'ERROR 401 Unauthorized from Jira',
      'hint: token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 is expired',
    ]);
    cleanupScript = script.cleanup;
    manager = createMcpClientManager({
      resolveEntry: byServer((server) =>
        server === 'fakestdio' ? { command: process.execPath, args: [script.path] } : undefined,
      ),
      isAllowed: (server) => server === 'fakestdio',
      redact: redactSecretsInString,
    });
    const mgr = manager;
    await mgr.listTools('fakestdio');
    // Give the stderr reader a turn — the pipe is drained asynchronously.
    await vi.waitFor(() => {
      expect(mgr.lastStderr('fakestdio').length).toBeGreaterThan(0);
    });

    const tail = mgr.lastStderr('fakestdio');
    expect(tail.join('\n')).toContain('ERROR 401 Unauthorized from Jira');
    // Healthy-startup chatter is filtered out so it can't read as a fault.
    expect(tail.join('\n')).not.toContain('starting up');
    // The token in that hint must NOT survive into what the UI will render.
    expect(tail.join('\n')).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');

    // Survives the client going away: a crash-on-startup loop stays diagnosable.
    await manager.dropServer('fakestdio');
    expect(manager.connectedCount()).toBe(0);
    expect(manager.lastStderr('fakestdio').join('\n')).toContain('ERROR 401 Unauthorized');
  });

  it('reports an empty stderr tail for a quiet server', async () => {
    const script = writeFakeMcpStdioScript();
    cleanupScript = script.cleanup;
    manager = createMcpClientManager({
      resolveEntry: byServer((server) =>
        server === 'fakestdio' ? { command: process.execPath, args: [script.path] } : undefined,
      ),
      isAllowed: (server) => server === 'fakestdio',
      redact: redactSecretsInString,
    });
    await manager.listTools('fakestdio');
    expect(manager.lastStderr('fakestdio')).toEqual([]);
  });

  it('gives each config record its own child so scopes cannot share credentials', async () => {
    const script = writeFakeMcpStdioScript();
    cleanupScript = script.cleanup;
    // Same server name, two records — the situation that previously served one
    // scope's connection (and token) to every other scope.
    manager = createMcpClientManager({
      resolveEntry: (server, cwd) =>
        server === 'multi'
          ? {
              key: cwd === '/repo/b' ? 'record-b' : 'record-a',
              entry: { command: process.execPath, args: [script.path] },
            }
          : undefined,
      isAllowed: (server) => server === 'multi',
      redact: redactSecretsInString,
    });
    await manager.listTools('multi', '/repo/a');
    expect(manager.connectedCount()).toBe(1);
    await manager.listTools('multi', '/repo/b');
    expect(manager.connectedCount()).toBe(2);
    // Re-using a cwd reuses its own child rather than spawning a third.
    await manager.listTools('multi', '/repo/a');
    expect(manager.connectedCount()).toBe(2);
    // dropServer evicts every record for the server, not just one.
    await manager.dropServer('multi');
    expect(manager.connectedCount()).toBe(0);
  });
});
