import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startProxyWithFake, type StartedProxy } from './proxy.test-helpers.js';
import { CompressionStatsStore } from './optimize/compress/compression-stats-db.js';
import { createRetrieveMcpHandler } from './optimize/compress/mcp-retrieve-server.js';

const TOKEN = 'test-mcp-bearer-token';

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function tmpStorePath(): string {
  return join(tmpdir(), `sentinel-mcp-int-${randomUUID()}.db`);
}

describe('retrieval MCP endpoint (real SDK client round-trip)', () => {
  let started: StartedProxy | null = null;
  let store: CompressionStatsStore | null = null;
  let storePath: string | null = null;
  const clients: Client[] = [];

  afterEach(async () => {
    for (const c of clients) {
      try {
        await c.close();
      } catch {
        /* already closed */
      }
    }
    clients.length = 0;
    if (started) await started.cleanup();
    if (store) store.close();
    if (storePath) {
      for (const s of ['', '-wal', '-shm']) {
        if (existsSync(storePath + s)) rmSync(storePath + s);
      }
    }
    started = null;
    store = null;
    storePath = null;
  });

  async function startWithRetrievals(
    seed: Array<{ id: string; original: string }>,
  ): Promise<{ url: string }> {
    storePath = tmpStorePath();
    store = new CompressionStatsStore({ dbPath: storePath });
    store.enqueueRetrievals(
      seed.map((s) => ({
        id: s.id,
        ts: Date.now(),
        accountId: 'acc-1',
        requestId: 'req-1',
        ruleId: 'log_truncate' as const,
        original: s.original,
      })),
    );
    store.flush();
    const liveStore = store;
    const mcpHandler = createRetrieveMcpHandler({
      getRetrieval: (id) => liveStore.getRetrieval(id),
      getToken: () => TOKEN,
    });
    started = await startProxyWithFake({ mcpHandler });
    return { url: `http://127.0.0.1:${started.proxyPort}/mcp` };
  }

  function connectClient(url: string, token: string): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    // Cast bridges an exactOptionalPropertyTypes mismatch (sessionId?: string
    // vs string | undefined) between the concrete transport and Transport.
    return client
      .connect(transport as unknown as Parameters<typeof client.connect>[0])
      .then(() => client);
  }

  it('initializes, lists the retrieve tool, and returns a seeded original', async () => {
    const { url } = await startWithRetrievals([
      { id: 'seed-1', original: 'the full elided log output\nline two\nline three' },
    ]);
    const client = await connectClient(url, TOKEN);

    const tools = await client.listTools();
    const retrieve = tools.tools.find((t) => t.name === 'retrieve');
    expect(retrieve).toBeDefined();
    expect(retrieve?.inputSchema).toMatchObject({
      type: 'object',
      required: ['id'],
    });
    // retrieve is read-only, and must load eagerly (not defer via ToolSearch)
    // so Claude Code's permission check consults the allow rule / PreToolUse
    // hook instead of prompting every call (bug #28580).
    expect(retrieve?.annotations?.readOnlyHint).toBe(true);
    expect((retrieve?._meta as Record<string, unknown> | undefined)?.['anthropic/alwaysLoad']).toBe(
      true,
    );

    const result = (await client.callTool({
      name: 'retrieve',
      arguments: { id: 'seed-1' },
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toBe('the full elided log output\nline two\nline three');
  });

  it('returns isError for an unknown id', async () => {
    const { url } = await startWithRetrievals([{ id: 'known', original: 'x' }]);
    const client = await connectClient(url, TOKEN);
    const result = (await client.callTool({
      name: 'retrieve',
      arguments: { id: 'does-not-exist' },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('does-not-exist');
  });

  it('returns isError for a missing id argument', async () => {
    const { url } = await startWithRetrievals([{ id: 'known', original: 'x' }]);
    const client = await connectClient(url, TOKEN);
    const result = (await client.callTool({ name: 'retrieve', arguments: {} })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('id');
  });

  it('returns isError for an unknown tool name', async () => {
    const { url } = await startWithRetrievals([{ id: 'known', original: 'x' }]);
    const client = await connectClient(url, TOKEN);
    const result = (await client.callTool({ name: 'bogus', arguments: {} })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Unknown tool');
  });

  it('rejects a client presenting the wrong bearer token (401)', async () => {
    const { url } = await startWithRetrievals([{ id: 'known', original: 'x' }]);
    await expect(connectClient(url, 'wrong-token')).rejects.toThrow();
  });

  it('returns 401 to a raw POST with no Authorization header', async () => {
    const { url } = await startWithRetrievals([{ id: 'known', original: 'x' }]);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it('returns a JSON-RPC parse error (400) for a malformed body with a valid token', async () => {
    const { url } = await startWithRetrievals([{ id: 'known', original: 'x' }]);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: '{ not valid json',
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: { code?: number } };
    expect(json.error?.code).toBe(-32700);
  });
});
