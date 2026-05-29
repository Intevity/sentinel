import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  IncomingMessage,
  ServerResponse,
  ClientRequest,
  IncomingHttpHeaders,
  RequestOptions,
} from 'http';
import { DEFAULT_SETTINGS } from './settings.js';
import type { Settings } from '@claude-sentinel/shared';

vi.mock('https', () => ({ request: vi.fn() }));

let mockedSettings: Settings = { ...DEFAULT_SETTINGS };
vi.mock('./settings.js', async () => {
  const actual = await vi.importActual<typeof import('./settings.js')>('./settings.js');
  return {
    ...actual,
    loadSettings: () => mockedSettings,
  };
});

import { createProxyServer } from './proxy.js';
import type { IpcServer } from './ipc.js';
import type Database from 'better-sqlite3';
import * as https from 'https';

type HttpsRequestMock = (
  opts: RequestOptions,
  cb?: (res: IncomingMessage) => void,
) => ClientRequest;
const httpsRequestMock =
  https.request as unknown as import('vitest').MockedFunction<HttpsRequestMock>;

function makeMockDb(): Database.Database {
  return {
    prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ lastInsertRowid: 1 }) }),
  } as unknown as Database.Database;
}

function makeMockIpc(): IpcServer {
  return {
    broadcast: vi.fn(),
    onMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    connectedClients: 0,
  } as unknown as IpcServer;
}

function makeReq(body: string, headers: IncomingHttpHeaders = {}): IncomingMessage {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const req = {
    url: '/v1/messages',
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
      ...headers,
    } as IncomingHttpHeaders,
    on: (event: string, cb: (arg?: unknown) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event]?.push(cb);
      return req;
    },
    off: (event: string, cb: (arg?: unknown) => void) => {
      listeners[event] = (listeners[event] ?? []).filter((fn) => fn !== cb);
      return req;
    },
    emit: (event: string, arg?: unknown) => listeners[event]?.forEach((cb) => cb(arg)),
  } as unknown as IncomingMessage;
  setImmediate(() => {
    req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

function makeRes(): { res: ServerResponse } {
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(),
    write: vi.fn(),
    pipe: vi.fn(),
  } as unknown as ServerResponse;
  return { res };
}

interface CapturedUpstream {
  opts: RequestOptions | null;
  bodyChunks: Buffer[];
}

function stubUpstream(): CapturedUpstream {
  const captured: CapturedUpstream = { opts: null, bodyChunks: [] };
  const listenersMap: Record<string, Array<(arg?: unknown) => void>> = {};
  const mockProxyRes = {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
      listenersMap[event] = listenersMap[event] ?? [];
      listenersMap[event]?.push(cb);
      return mockProxyRes;
    }),
    pipe: vi.fn(),
  };
  httpsRequestMock.mockImplementation((opts, cb) => {
    captured.opts = opts;
    if (cb) {
      setTimeout(() => {
        cb(mockProxyRes as unknown as IncomingMessage);
        setTimeout(() => {
          listenersMap['data']?.forEach((fn) => fn(Buffer.from('{"ok":true}')));
          listenersMap['end']?.forEach((fn) => fn());
        }, 5);
      }, 5);
    }
    return {
      on: vi.fn().mockReturnThis(),
      write: vi.fn((chunk: Buffer) => {
        captured.bodyChunks.push(chunk);
      }),
      end: vi.fn((chunk?: Buffer) => {
        if (chunk) captured.bodyChunks.push(chunk);
      }),
      destroy: vi.fn(),
      setTimeout: vi.fn(),
    } as unknown as ClientRequest;
  });
  return captured;
}

async function drive(
  server: ReturnType<typeof createProxyServer>,
  req: IncomingMessage,
): Promise<ServerResponse> {
  const handler = (
    server as unknown as {
      listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
    }
  ).listeners('request')[0];
  const { res } = makeRes();
  handler?.(req, res);
  await new Promise((r) => setTimeout(r, 40));
  return res;
}

describe('proxy cache TTL override', () => {
  let db: Database.Database;
  let ipcServer: IpcServer;
  let otelHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = makeMockDb();
    ipcServer = makeMockIpc();
    otelHandler = vi.fn().mockResolvedValue(undefined);
    httpsRequestMock.mockReset();
    mockedSettings = { ...DEFAULT_SETTINGS };
  });

  it('rewrites cache_control.ttl to "1h" on every ephemeral block when the setting is on', async () => {
    mockedSettings = { ...DEFAULT_SETTINGS, cacheTtlForceOneHour: true };
    const captured = stubUpstream();

    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      system: [
        { type: 'text', text: 'instr', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'extra', cache_control: { type: 'ephemeral', ttl: '5m' } },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = makeReq(body);
    const server = createProxyServer({ db, ipcServer }, otelHandler);
    await drive(server, req);

    const sent = Buffer.concat(captured.bodyChunks).toString('utf-8');
    const parsed = JSON.parse(sent) as { system: Array<Record<string, unknown>> };
    expect(parsed.system[0]!['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(parsed.system[1]!['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });

    // Content-Length header in the forwarded request must match what we sent.
    const forwarded = (captured.opts?.headers ?? {}) as Record<string, unknown>;
    expect(Number(forwarded['content-length'])).toBe(Buffer.byteLength(sent, 'utf-8'));

    // Beta header is present.
    const beta = forwarded['anthropic-beta'];
    expect(typeof beta === 'string' ? beta : '').toContain('extended-cache-ttl-2025-04-11');

    server.close();
  });

  it('leaves the body untouched when the setting is off', async () => {
    mockedSettings = { ...DEFAULT_SETTINGS, cacheTtlForceOneHour: false };
    const captured = stubUpstream();

    const body = JSON.stringify({
      system: [{ type: 'text', text: 'instr', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = makeReq(body);
    const server = createProxyServer({ db, ipcServer }, otelHandler);
    await drive(server, req);

    const sent = Buffer.concat(captured.bodyChunks).toString('utf-8');
    expect(JSON.parse(sent)).toEqual(JSON.parse(body));
    const forwarded = (captured.opts?.headers ?? {}) as Record<string, unknown>;
    expect(forwarded['anthropic-beta']).toBeUndefined();
    server.close();
  });

  it('appends to an existing anthropic-beta header rather than clobbering it', async () => {
    mockedSettings = { ...DEFAULT_SETTINGS, cacheTtlForceOneHour: true };
    const captured = stubUpstream();

    const body = JSON.stringify({
      system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = makeReq(body, { 'anthropic-beta': 'some-other-beta-2025-01-01' });
    const server = createProxyServer({ db, ipcServer }, otelHandler);
    await drive(server, req);

    const forwarded = (captured.opts?.headers ?? {}) as Record<string, unknown>;
    const beta = String(forwarded['anthropic-beta'] ?? '');
    expect(beta).toContain('some-other-beta-2025-01-01');
    expect(beta).toContain('extended-cache-ttl-2025-04-11');
    server.close();
  });

  it('does not duplicate the beta token when already present', async () => {
    mockedSettings = { ...DEFAULT_SETTINGS, cacheTtlForceOneHour: true };
    const captured = stubUpstream();

    const body = JSON.stringify({
      system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = makeReq(body, { 'anthropic-beta': 'extended-cache-ttl-2025-04-11' });
    const server = createProxyServer({ db, ipcServer }, otelHandler);
    await drive(server, req);

    const forwarded = (captured.opts?.headers ?? {}) as Record<string, unknown>;
    const beta = String(forwarded['anthropic-beta'] ?? '');
    expect(beta.match(/extended-cache-ttl-2025-04-11/g)).toHaveLength(1);
    server.close();
  });
});
