/**
 * Integration: the code-mode MCP client manager against real fake servers —
 * an HTTP MCP server on a real loopback listener and a stdio MCP server
 * spawned as a real child process. No mocks; the SDK client under test is
 * the production one.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  startFakeMcpHttpServer,
  writeFakeMcpStdioScript,
  FAKE_MCP_TOOLS,
  type FakeMcpHttpServer,
} from '@claude-sentinel/test-harness';
import { createMcpClientManager, type McpClientManager } from './mcp-client-manager.js';

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
      resolveEntry: (server) => entries[server],
      isAllowed: (server) => allowed.includes(server),
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
    expect(parsed[0]?.text).toMatch(
      /truncated by Claude Sentinel: \d+ bytes exceeded the 1024-byte/,
    );
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
      resolveEntry: (server) =>
        server === 'fakestdio'
          ? { command: process.execPath, args: [script.path], env }
          : undefined,
      isAllowed: (server) => server === 'fakestdio',
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
});
