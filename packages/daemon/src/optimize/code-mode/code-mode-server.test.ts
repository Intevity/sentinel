/**
 * Integration: the `/code-mode/call` bridge endpoint, end to end — real proxy
 * route → real handler → real client manager → real fake MCP server — with
 * the audit trail landing in a real ContextCostStore.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { startFakeMcpHttpServer, type FakeMcpHttpServer } from '@claude-sentinel/test-harness';
import { startProxyWithFake, makeTestDbPath, type StartedProxy } from '../../proxy.test-helpers.js';
import { ContextCostStore } from '../../context-bloat/context-cost-db.js';
import { createMcpClientManager, type McpClientManager } from './mcp-client-manager.js';
import { createCodeModeHandler } from './code-mode-server.js';

const TOKEN = 'code-mode-test-token-0123456789abcdef';

describe('/code-mode/call endpoint', () => {
  let started: StartedProxy;
  let fakeMcp: FakeMcpHttpServer;
  let manager: McpClientManager;
  let store: ContextCostStore;
  let storePath: string;
  let enabled = true;

  beforeEach(async () => {
    enabled = true;
    fakeMcp = await startFakeMcpHttpServer();
    storePath = makeTestDbPath('code-mode-audit');
    store = new ContextCostStore({ dbPath: storePath });
    manager = createMcpClientManager({
      resolveEntry: (server) =>
        server === 'bridged' || server === 'unlisted'
          ? { type: 'http', url: fakeMcp.url }
          : undefined,
      isAllowed: (server) => server === 'bridged',
    });
    const codeModeHandler = createCodeModeHandler({
      manager,
      getToken: () => TOKEN,
      isEnabled: () => enabled,
      recordCall: (row) => store.recordCall(row),
    });
    started = await startProxyWithFake({ codeModeHandler });
  });

  afterEach(async () => {
    await manager.stopAll();
    await started.cleanup();
    await fakeMcp.close();
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(storePath + suffix)) rmSync(storePath + suffix);
    }
  });

  function callEndpoint(
    body: unknown,
    init: { token?: string; method?: string } = {},
  ): Promise<Response> {
    return fetch(`http://127.0.0.1:${started.proxyPort}/code-mode/call`, {
      method: init.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(init.token === undefined
          ? { Authorization: `Bearer ${TOKEN}` }
          : init.token === ''
            ? {}
            : { Authorization: `Bearer ${init.token}` }),
      },
      ...(init.method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
  }

  it('round-trips a tool call and writes an audit row (metadata only)', async () => {
    const res = await callEndpoint({ server: 'bridged', tool: 'add', args: { a: 40, b: 2 } });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload).toEqual({
      ok: true,
      isError: false,
      truncated: false,
      content: [{ type: 'text', text: '42' }],
    });

    const audit = store.getAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ server: 'bridged', tool: 'add', ok: true });
    expect(audit[0]!.bytesOut).toBeGreaterThan(0);
    // Privacy: the audit row shape has no argument or result fields at all.
    expect(Object.keys(audit[0]!).sort()).toEqual([
      'bytesOut',
      'durationMs',
      'ok',
      'server',
      'tool',
      'ts',
    ]);
  });

  it('401s on a missing or wrong bearer token without leaking detail', async () => {
    for (const token of ['', 'wrong-token']) {
      const res = await callEndpoint({ server: 'bridged', tool: 'add', args: {} }, { token });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' });
    }
    expect(store.getAudit()).toEqual([]); // unauthorized calls are not audited
  });

  it('403s for a server outside the allowlist and audits the refusal', async () => {
    const res = await callEndpoint({ server: 'unlisted', tool: 'echo', args: {} });
    expect(res.status).toBe(403);
    const payload = (await res.json()) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("'unlisted' is not bridged");
    const audit = store.getAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ server: 'unlisted', tool: 'echo', ok: false });
  });

  it('403s when code mode is disabled in settings', async () => {
    enabled = false;
    const res = await callEndpoint({ server: 'bridged', tool: 'add', args: { a: 1, b: 1 } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/disabled in Sentinel/);
  });

  it('405s non-POST methods (after auth)', async () => {
    const res = await callEndpoint(undefined, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('400s malformed bodies with a usage hint', async () => {
    for (const bad of [{}, { server: 'bridged' }, { tool: 'x' }, { server: '', tool: 'x' }]) {
      const res = await callEndpoint(bad);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('"server"');
    }
  });

  it('marks isError tool results ok:false in the audit but returns 200', async () => {
    const res = await callEndpoint({ server: 'bridged', tool: 'fail', args: {} });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { ok: boolean; isError: boolean };
    expect(payload.ok).toBe(true); // transport-level success
    expect(payload.isError).toBe(true); // tool-level failure
    expect(store.getAudit()[0]).toMatchObject({ tool: 'fail', ok: false });
  });

  it('502s when the upstream MCP server is unreachable', async () => {
    // No prior call in this test, so nothing is cached: closing the fake
    // makes the first connect attempt fail.
    await fakeMcp.close();
    const res = await callEndpoint({ server: 'bridged', tool: 'add', args: { a: 1, b: 1 } });
    expect(res.status).toBe(502);
    const payload = (await res.json()) as { ok: boolean };
    expect(payload.ok).toBe(false);
    expect(store.getAudit()[0]).toMatchObject({ server: 'bridged', tool: 'add', ok: false });
  });

  it('413s oversized request bodies', async () => {
    const res = await callEndpoint({
      server: 'bridged',
      tool: 'echo',
      args: { huge: 'y'.repeat(300 * 1024) },
    });
    expect(res.status).toBe(413);
  });
});
