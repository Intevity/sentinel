/**
 * Integration: the proxy's MCP definition-cost observer. A real proxy in
 * front of the fake Anthropic listener receives /v1/messages POSTs carrying
 * a tools[] array; the observer must record per-server definition costs into
 * a real ContextCostStore — and must stay silent when the kill switch
 * (`optimizeCaptureEnabled`) is off or the body carries no tools.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import {
  startProxyWithFake,
  postThroughProxy,
  patchTestSettings,
  makeTestDbPath,
  type StartedProxy,
} from './proxy.test-helpers.js';
import { ContextCostStore, NATIVE_SERVER_KEY } from './context-bloat/context-cost-db.js';

const bytesOf = (tool: unknown): number => Buffer.byteLength(JSON.stringify(tool), 'utf8');

const BASH_TOOL = { name: 'Bash', description: 'Run a command', input_schema: { type: 'object' } };
const GH_TOOL = {
  name: 'mcp__github__search_code',
  description: 'Search code across GitHub repositories using native search',
  input_schema: { type: 'object', properties: { query: { type: 'string' } } },
};
const MONGO_TOOL = {
  name: 'mcp__mongodb-mcp-server__find',
  description: 'Run a find query against a MongoDB collection',
  input_schema: { type: 'object', properties: { database: { type: 'string' } } },
};

function messagesBody(tools?: unknown[]): Record<string, unknown> {
  return {
    model: 'claude-opus-4-8',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'hello' }],
    ...(tools ? { tools } : {}),
  };
}

describe('proxy MCP definition-cost observer', () => {
  let started: StartedProxy;
  let store: ContextCostStore;
  let storePath: string;

  beforeEach(async () => {
    storePath = makeTestDbPath('context-cost-int');
    store = new ContextCostStore({ dbPath: storePath });
    started = await startProxyWithFake({
      settings: { optimizeCaptureEnabled: true },
      contextCostStore: store,
    });
  });

  afterEach(async () => {
    await started.cleanup();
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(storePath + suffix)) rmSync(storePath + suffix);
    }
  });

  it('records per-server definition costs for a tools[]-bearing messages POST', async () => {
    const res = await postThroughProxy(
      started.proxyPort,
      '/v1/messages',
      messagesBody([BASH_TOOL, GH_TOOL, MONGO_TOOL]),
    );
    expect(res.status).toBe(200);

    const aggs = store.getServerDefinitionCosts();
    const byServer = new Map(aggs.map((a) => [a.server, a]));
    expect(byServer.get('github')).toMatchObject({
      defBytesMax: bytesOf(GH_TOOL),
      toolCountMax: 1,
      requestCount: 1,
      toolNames: ['mcp__github__search_code'],
    });
    expect(byServer.get('mongodb-mcp-server')).toMatchObject({
      defBytesMax: bytesOf(MONGO_TOOL),
      toolCountMax: 1,
      requestCount: 1,
    });
    expect(byServer.get(NATIVE_SERVER_KEY)).toMatchObject({
      defBytesMax: bytesOf(BASH_TOOL),
      toolCountMax: 1,
      requestCount: 1,
    });
  });

  it('accumulates request_count across repeat requests', async () => {
    await postThroughProxy(started.proxyPort, '/v1/messages', messagesBody([GH_TOOL]));
    await postThroughProxy(started.proxyPort, '/v1/messages', messagesBody([GH_TOOL]));
    const gh = store.getServerDefinitionCosts().find((a) => a.server === 'github');
    expect(gh?.requestCount).toBe(2);
    expect(gh?.defBytesMax).toBe(bytesOf(GH_TOOL));
  });

  it('records nothing for a messages POST without tools', async () => {
    const res = await postThroughProxy(started.proxyPort, '/v1/messages', messagesBody());
    expect(res.status).toBe(200);
    expect(store.getServerDefinitionCosts()).toEqual([]);
  });

  it('records nothing when optimizeCaptureEnabled is off', async () => {
    patchTestSettings({ optimizeCaptureEnabled: false });
    const res = await postThroughProxy(started.proxyPort, '/v1/messages', messagesBody([GH_TOOL]));
    expect(res.status).toBe(200);
    expect(store.getServerDefinitionCosts()).toEqual([]);
  });

  it('records nothing for count_tokens requests even with tools present', async () => {
    await postThroughProxy(started.proxyPort, '/v1/messages/count_tokens', messagesBody([GH_TOOL]));
    expect(store.getServerDefinitionCosts()).toEqual([]);
  });

  it('survives a malformed JSON body without recording or failing the proxy', async () => {
    const res = await postThroughProxy(started.proxyPort, '/v1/messages', '{not json');
    // The fake upstream answers regardless; the observer must not throw.
    expect([200, 400]).toContain(res.status);
    expect(store.getServerDefinitionCosts()).toEqual([]);
  });
});
