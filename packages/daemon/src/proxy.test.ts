import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage, ServerResponse, ClientRequest, IncomingHttpHeaders, RequestOptions } from 'http';
import { OverageStateMachine } from './overage.js';

// Mock the https module to avoid real network calls
vi.mock('https', () => ({
  request: vi.fn(),
}));

import { createProxyServer, DAEMON_PORT, ANTHROPIC_HOST, summarizeOverageHeaders } from './proxy.js';
import type { IpcServer } from './ipc.js';
import { RateLimitStore } from './rate-limit-store.js';
import type Database from 'better-sqlite3';
import * as https from 'https';

// Typed helper to avoid TypeScript overload ambiguity when mocking https.request
type HttpsRequestMock = (opts: RequestOptions, cb?: (res: IncomingMessage) => void) => ClientRequest;
const httpsRequestMock = https.request as unknown as import('vitest').MockedFunction<HttpsRequestMock>;

// Helper to create a minimal mock DB
function makeMockDb(): Database.Database {
  return {
    prepare: vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ lastInsertRowid: 1 }),
    }),
  } as unknown as Database.Database;
}

// Helper to create a mock IPC server
function makeMockIpc(): IpcServer {
  return {
    broadcast: vi.fn(),
    onMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    connectedClients: 0,
  } as unknown as IpcServer;
}

// Helper to make a mock IncomingMessage
function makeReq(url: string, method = 'POST', body = '{"test": true}'): IncomingMessage {
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
  const req = {
    url,
    method,
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer test-token',
    } as IncomingHttpHeaders,
    on: (event: string, cb: (arg?: unknown) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event]?.push(cb);
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

// Helper to make a mock ServerResponse
function makeRes(): { res: ServerResponse; statusCode: number; headers: Record<string, unknown> } {
  const state = { statusCode: 200, headers: {} as Record<string, unknown> };
  const res = {
    writeHead: (code: number, hdrs?: unknown) => {
      state.statusCode = code;
      if (hdrs && typeof hdrs === 'object') state.headers = hdrs as Record<string, unknown>;
    },
    end: vi.fn(),
    write: vi.fn(),
    pipe: vi.fn(),
  } as unknown as ServerResponse;
  return { res, ...state };
}

describe('proxy constants', () => {
  it('DAEMON_PORT is 47284', () => {
    expect(DAEMON_PORT).toBe(47284);
  });

  it('ANTHROPIC_HOST is api.anthropic.com', () => {
    expect(ANTHROPIC_HOST).toBe('api.anthropic.com');
  });
});

describe('summarizeOverageHeaders', () => {
  it('returns null when no tracked headers are present', () => {
    expect(summarizeOverageHeaders({ 'content-type': 'application/json' })).toBeNull();
  });

  it('renders the subset of tracked headers that are present', () => {
    const out = summarizeOverageHeaders({
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-in-use': 'true',
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
    });
    expect(out).toContain('overage-status=allowed');
    expect(out).toContain('overage-in-use=true');
    expect(out).toContain('5h-util=0.42');
  });

  it('handles array header values (takes first element)', () => {
    const out = summarizeOverageHeaders({
      'anthropic-ratelimit-unified-overage-in-use': ['true', 'ignored'],
    });
    expect(out).toBe('overage-in-use=true');
  });

  it('treats empty array as missing', () => {
    expect(
      summarizeOverageHeaders({ 'anthropic-ratelimit-unified-overage-in-use': [] }),
    ).toBeNull();
  });
});

describe('createProxyServer', () => {
  let db: Database.Database;
  let ipcServer: IpcServer;
  let otelHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = makeMockDb();
    ipcServer = makeMockIpc();
    otelHandler = vi.fn().mockResolvedValue(undefined);
    httpsRequestMock.mockReset();
  });

  it('returns an HTTP server instance', () => {
    const server = createProxyServer({ db, ipcServer }, otelHandler);
    expect(server).toBeDefined();
    expect(typeof server.listen).toBe('function');
    server.close();
  });

  it('tokenProvider takes precedence over activeToken for auth header and attribution', async () => {
    const capturedHeaders: Record<string, string> = {};
    const mockProxyRes = {
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-5h-utilization': '0.5',
        'anthropic-ratelimit-unified-5h-reset': '123',
      },
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'end') setTimeout(cb, 10);
        return mockProxyRes;
      }),
      pipe: vi.fn(),
    };

    httpsRequestMock.mockImplementation((opts, cb) => {
      Object.assign(capturedHeaders, opts.headers);
      if (cb) setTimeout(() => cb(mockProxyRes as unknown as IncomingMessage), 10);
      return { on: vi.fn().mockReturnThis(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as unknown as ClientRequest;
    });

    const rateLimitStore = new RateLimitStore();
    const server = createProxyServer({
      db,
      ipcServer,
      rateLimitStore,
      activeToken: { value: 'primary-token' },
      activeAccountId: { value: 'primary-id' },
      tokenProvider: () => ({ token: 'rotated-token', accountId: 'rotated-id' }),
    }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedHeaders['authorization']).toBe('Bearer rotated-token');
    // Rate limits must be attributed to the rotated account, not the primary.
    expect(rateLimitStore.getAll('rotated-id')).toHaveLength(1);
    expect(rateLimitStore.getAll('primary-id')).toHaveLength(0);
    server.close();
  });

  it('falls back to activeToken when tokenProvider returns null', async () => {
    const capturedHeaders: Record<string, string> = {};
    const mockProxyRes = {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'end') setTimeout(cb, 10);
        return mockProxyRes;
      }),
      pipe: vi.fn(),
    };

    httpsRequestMock.mockImplementation((opts, cb) => {
      Object.assign(capturedHeaders, opts.headers);
      if (cb) setTimeout(() => cb(mockProxyRes as unknown as IncomingMessage), 10);
      return { on: vi.fn().mockReturnThis(), write: vi.fn(), end: vi.fn(), destroy: vi.fn() } as unknown as ClientRequest;
    });

    const server = createProxyServer({
      db,
      ipcServer,
      activeToken: { value: 'primary-token' },
      activeAccountId: { value: 'primary-id' },
      tokenProvider: () => null,
    }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedHeaders['authorization']).toBe('Bearer primary-token');
    server.close();
  });

  it('handles /health GET request', () => {
    const server = createProxyServer({ db, ipcServer }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    const req = makeReq('/health', 'GET', '');
    const { res } = makeRes();

    let writtenBody = '';
    (res as unknown as { end: (data?: string) => void }).end = (data?: string) => { writtenBody = data ?? ''; };
    let code = 0;
    (res as unknown as { writeHead: (c: number) => void }).writeHead = (c: number) => { code = c; };

    handler?.(req, res);
    expect(code).toBe(200);
    expect(writtenBody).toContain('ok');
    server.close();
  });

  it('routes OTEL paths to otelHandler', async () => {
    const server = createProxyServer({ db, ipcServer }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    const req = makeReq('/v1/metrics', 'POST');
    const { res } = makeRes();

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 50));

    expect(otelHandler).toHaveBeenCalledOnce();
    server.close();
  });

  it('routes /v1/logs to otelHandler', async () => {
    const server = createProxyServer({ db, ipcServer }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    const req = makeReq('/v1/logs', 'POST');
    const { res } = makeRes();

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 50));

    expect(otelHandler).toHaveBeenCalledOnce();
    server.close();
  });

  it('proxies Anthropic API paths', async () => {
    // Mock https.request to return a successful response
    const mockProxyRes = {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'end') setTimeout(cb, 10);
        return mockProxyRes;
      }),
      pipe: vi.fn(),
    };

    httpsRequestMock.mockImplementation((_opts, cb) => {
      if (cb) setTimeout(() => cb(mockProxyRes as unknown as IncomingMessage), 10);
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as unknown as ClientRequest;
    });

    const server = createProxyServer({ db, ipcServer }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST', JSON.stringify({ model: 'claude-opus-4', messages: [] }));
    const { res } = makeRes();

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 100));

    expect(httpsRequestMock).toHaveBeenCalledOnce();
    const callOpts = httpsRequestMock.mock.calls[0]?.[0] as { hostname: string; path: string };
    expect(callOpts.hostname).toBe(ANTHROPIC_HOST);
    expect(callOpts.path).toBe('/v1/messages');
    server.close();
  });

  it('fires overage transition and broadcasts via IPC', async () => {
    const machine = new OverageStateMachine();

    const mockProxyRes = {
      statusCode: 200,
      headers: {
        'anthropic-ratelimit-unified-overage-status': 'allowed',
        'anthropic-ratelimit-unified-overage-reset': '1776700800',
        'anthropic-ratelimit-unified-overage-in-use': 'true',
      },
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'end') setTimeout(cb, 10);
        return mockProxyRes;
      }),
      pipe: vi.fn(),
    };

    httpsRequestMock.mockImplementation((_opts, cb) => {
      if (cb) setTimeout(() => cb(mockProxyRes as unknown as IncomingMessage), 10);
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
      } as unknown as ClientRequest;
    });

    const server = createProxyServer({ db, ipcServer, overageMachine: machine }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST');
    const { res } = makeRes();

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 100));

    expect(vi.mocked(ipcServer.broadcast)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'overage_entered' }),
    );
    server.close();
  });

  it('handles otelHandler error gracefully', async () => {
    otelHandler.mockRejectedValue(new Error('otel error'));

    const server = createProxyServer({ db, ipcServer }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    const req = makeReq('/v1/metrics', 'POST');
    let code = 200;
    const res = {
      writeHead: (c: number) => { code = c; },
      end: vi.fn(),
    } as unknown as ServerResponse;

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 100));
    expect(code).toBe(500);
    server.close();
  });

  it('handles https proxy error gracefully', async () => {
    httpsRequestMock.mockImplementation(() => {
      const mockReq = {
        on: vi.fn((event: string, cb: (e?: Error) => void) => {
          if (event === 'error') setTimeout(() => cb(new Error('connection refused')), 10);
          return mockReq;
        }),
        write: vi.fn(),
        end: vi.fn(),
      } as unknown as ClientRequest;
      return mockReq;
    });

    const server = createProxyServer({ db, ipcServer }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST');
    let code = 200;
    const res = {
      writeHead: (c: number) => { code = c; },
      end: vi.fn(),
      write: vi.fn(),
    } as unknown as ServerResponse;

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 100));
    expect(code).toBe(502);
    server.close();
  });

  it('fires overage disabled transition and broadcasts', async () => {
    const machine = new OverageStateMachine();

    const mockProxyRes = {
      statusCode: 200,
      headers: {
        'anthropic-ratelimit-unified-overage-status': 'disabled',
        'anthropic-ratelimit-unified-overage-disabled-reason': 'budget_exhausted',
      },
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'end') setTimeout(cb, 10);
        return mockProxyRes;
      }),
      pipe: vi.fn(),
    };

    httpsRequestMock.mockImplementation((_opts, cb) => {
      if (cb) setTimeout(() => cb(mockProxyRes as unknown as IncomingMessage), 10);
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
      } as unknown as ClientRequest;
    });

    const server = createProxyServer({ db, ipcServer, overageMachine: machine }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST');
    const { res } = makeRes();

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 100));

    expect(vi.mocked(ipcServer.broadcast)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'overage_disabled' }),
    );
    server.close();
  });

  it('fires overage exited transition', async () => {
    const machine = new OverageStateMachine();
    // First set it as in-use so the next call can transition to exited
    machine.handleHeaders('default', {
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-in-use': 'true',
    });

    const mockProxyRes = {
      statusCode: 200,
      headers: {
        'anthropic-ratelimit-unified-overage-status': 'allowed',
      },
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'end') setTimeout(cb, 10);
        return mockProxyRes;
      }),
      pipe: vi.fn(),
    };

    httpsRequestMock.mockImplementation((_opts, cb) => {
      if (cb) setTimeout(() => cb(mockProxyRes as unknown as IncomingMessage), 10);
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
      } as unknown as ClientRequest;
    });

    const server = createProxyServer({ db, ipcServer, overageMachine: machine }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST');
    const { res } = makeRes();

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 100));

    expect(vi.mocked(ipcServer.broadcast)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'overage_exited' }),
    );
    server.close();
  });

  it('proxies unknown paths to Anthropic (fallback)', async () => {
    const mockProxyRes = {
      statusCode: 200,
      headers: {},
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'end') setTimeout(cb, 10);
        return mockProxyRes;
      }),
      pipe: vi.fn(),
    };

    httpsRequestMock.mockImplementation((_opts, cb) => {
      if (cb) setTimeout(() => cb(mockProxyRes as unknown as IncomingMessage), 10);
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
      } as unknown as ClientRequest;
    });

    const server = createProxyServer({ db, ipcServer }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    // Use a path not in ANTHROPIC_PATHS or OTEL_PATHS
    const req = makeReq('/v1/some-future-endpoint', 'GET', '');
    const { res } = makeRes();

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 100));
    expect(httpsRequestMock).toHaveBeenCalledOnce();
    server.close();
  });

  it('handles default proxy error gracefully', async () => {
    httpsRequestMock.mockImplementation(() => {
      const mockReq = {
        on: vi.fn((event: string, cb: (e?: Error) => void) => {
          if (event === 'error') setTimeout(() => cb(new Error('network error')), 10);
          return mockReq;
        }),
        write: vi.fn(),
        end: vi.fn(),
      } as unknown as ClientRequest;
      return mockReq;
    });

    const server = createProxyServer({ db, ipcServer }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    const req = makeReq('/v1/unknown-path', 'GET', '');
    let code = 200;
    const res = {
      writeHead: (c: number) => { code = c; },
      end: vi.fn(),
    } as unknown as ServerResponse;

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 100));
    expect(code).toBe(502);
    server.close();
  });

  it('broadcasts rate_limits_updated when rate limit headers are present', async () => {
    const rateLimitStore = new RateLimitStore();

    const mockProxyRes = {
      statusCode: 200,
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-5h-reset': '1776362400',
      },
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'end') setTimeout(cb, 10);
        return mockProxyRes;
      }),
      pipe: vi.fn(),
    };

    httpsRequestMock.mockImplementation((_opts, cb) => {
      if (cb) setTimeout(() => cb(mockProxyRes as unknown as IncomingMessage), 10);
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
      } as unknown as ClientRequest;
    });

    const server = createProxyServer({ db, ipcServer, rateLimitStore }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST');
    const { res } = makeRes();

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 100));

    expect(vi.mocked(ipcServer.broadcast)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'rate_limits_updated' }),
    );
    server.close();
  });

  it('debounces rate_limits_updated broadcast within 2s window', async () => {
    const rateLimitStore = new RateLimitStore();

    const makeMockProxyRes = () => ({
      statusCode: 200,
      headers: {
        'anthropic-ratelimit-unified-5h-utilization': '0.50',
        'anthropic-ratelimit-unified-5h-reset': '1776362400',
      },
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'end') setTimeout(cb, 10);
        return makeMockProxyRes();
      }),
      pipe: vi.fn(),
    });

    httpsRequestMock.mockImplementation((_opts, cb) => {
      if (cb) setTimeout(() => cb(makeMockProxyRes() as unknown as IncomingMessage), 10);
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
      } as unknown as ClientRequest;
    });

    const server = createProxyServer({ db, ipcServer, rateLimitStore }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    // Fire two requests back-to-back; only one broadcast should go out
    handler?.(makeReq('/v1/messages'), makeRes().res);
    await new Promise((r) => setTimeout(r, 50));
    handler?.(makeReq('/v1/messages'), makeRes().res);
    await new Promise((r) => setTimeout(r, 100));

    const rlCalls = vi.mocked(ipcServer.broadcast).mock.calls.filter(
      ([m]) => (m as { type: string }).type === 'rate_limits_updated',
    );
    expect(rlCalls).toHaveLength(1);
    server.close();
  });

  it('overage entered with null resetsAt', async () => {
    const machine = new OverageStateMachine();

    const mockProxyRes = {
      statusCode: 200,
      headers: {
        'anthropic-ratelimit-unified-overage-status': 'allowed',
        'anthropic-ratelimit-unified-overage-in-use': 'true',
        // No reset header
      },
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'end') setTimeout(cb, 10);
        return mockProxyRes;
      }),
      pipe: vi.fn(),
    };

    httpsRequestMock.mockImplementation((_opts, cb) => {
      if (cb) setTimeout(() => cb(mockProxyRes as unknown as IncomingMessage), 10);
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
      } as unknown as ClientRequest;
    });

    const server = createProxyServer({ db, ipcServer, overageMachine: machine }, otelHandler);
    const handler = (server as unknown as { listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void> }).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST');
    const { res } = makeRes();

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 100));

    expect(vi.mocked(ipcServer.broadcast)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'overage_entered', resetsAt: null }),
    );
    server.close();
  });
});
