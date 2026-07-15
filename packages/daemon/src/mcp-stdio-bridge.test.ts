import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { runMcpStdioBridge } from './mcp-stdio-bridge.js';

/** Minimal real HTTP stand-in for the daemon's stateless /mcp endpoint:
 *  requests echo a JSON-RPC result carrying what the server saw; notifications
 *  (no id) return 202 with an empty body, like the SDK transport. */
let server: Server;
let url: string;
let seenAuth: Array<string | undefined>;
let respondWith: ((body: string) => { status: number; body: string }) | null;

beforeEach(async () => {
  seenAuth = [];
  respondWith = null;
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf-8')));
    req.on('end', () => {
      seenAuth.push(req.headers.authorization);
      if (respondWith) {
        const r = respondWith(body);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(r.body);
        return;
      }
      const msg = JSON.parse(body) as { id?: unknown; method?: string };
      if (msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echoed: msg.method } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Drive the bridge with a fixed set of stdin lines and return stdout lines. */
async function drive(lines: string[], bridgeUrl = url, token = 'tok-1'): Promise<string[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = runMcpStdioBridge(bridgeUrl, token, { input, output });
  for (const l of lines) input.write(`${l}\n`);
  input.end();
  await done;
  const text = output.read()?.toString('utf-8') ?? '';
  return text.split('\n').filter((l: string) => l.trim().length > 0);
}

describe('runMcpStdioBridge', () => {
  it('relays a request and writes the endpoint JSON response as one line', async () => {
    const out = await drive([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { echoed: 'tools/list' },
    });
  });

  it('sends the bearer token on every relay', async () => {
    await drive(
      [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      ],
      url,
      'secret-token',
    );
    expect(seenAuth).toEqual(['Bearer secret-token', 'Bearer secret-token']);
  });

  it('writes nothing for notifications (202 empty body)', async () => {
    const out = await drive([
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ]);
    expect(out).toEqual([]);
  });

  it('synthesizes a JSON-RPC error with the request id on HTTP failure', async () => {
    respondWith = () => ({ status: 500, body: 'boom' });
    const out = await drive([JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call' })]);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!) as { id: number; error: { code: number; message: string } };
    expect(parsed.id).toBe(7);
    expect(parsed.error.code).toBe(-32603);
    expect(parsed.error.message).toContain('HTTP 500');
  });

  it('synthesizes a JSON-RPC error when the daemon is unreachable', async () => {
    // Point at a port nothing listens on: real connection refusal, no mocks.
    const out = await drive(
      [JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call' })],
      'http://127.0.0.1:1/mcp',
    );
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!) as { id: number; error: { message: string } };
    expect(parsed.id).toBe(9);
    expect(parsed.error.message).toContain('unreachable');
  });

  it('stays silent on HTTP failure for notifications and ignores non-JSON lines', async () => {
    respondWith = () => ({ status: 500, body: 'boom' });
    const out = await drive([
      'not json at all',
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled' }),
      '',
    ]);
    expect(out).toEqual([]);
  });
});
