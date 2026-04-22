import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  IncomingMessage,
  ServerResponse,
  ClientRequest,
  IncomingHttpHeaders,
  RequestOptions,
} from 'http';
import { OverageStateMachine } from './overage.js';

// Mock the https module to avoid real network calls
vi.mock('https', () => ({
  request: vi.fn(),
}));

import {
  createProxyServer,
  DAEMON_PORT,
  ANTHROPIC_HOST,
  summarizeOverageHeaders,
  extractRequestModel,
  isSonnetModel,
} from './proxy.js';
import type { IpcServer } from './ipc.js';
import { RateLimitStore } from './rate-limit-store.js';
import { RequestAccountMap } from './request-account-map.js';
import type Database from 'better-sqlite3';
import * as https from 'https';

// Typed helper to avoid TypeScript overload ambiguity when mocking https.request
type HttpsRequestMock = (
  opts: RequestOptions,
  cb?: (res: IncomingMessage) => void,
) => ClientRequest;
const httpsRequestMock =
  https.request as unknown as import('vitest').MockedFunction<HttpsRequestMock>;

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
      authorization: 'Bearer test-token',
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
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as unknown as ClientRequest;
    });

    const rateLimitStore = new RateLimitStore();
    const server = createProxyServer(
      {
        db,
        ipcServer,
        rateLimitStore,
        activeToken: { value: 'primary-token' },
        activeAccountId: { value: 'primary-id' },
        tokenProvider: () => ({ token: 'rotated-token', accountId: 'rotated-id' }),
      },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

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

  it('x-sentinel-probe-token/-account headers override activeToken and tokenProvider, then are stripped before upstream', async () => {
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
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as unknown as ClientRequest;
    });

    const rateLimitStore = new RateLimitStore();
    const server = createProxyServer(
      {
        db,
        ipcServer,
        rateLimitStore,
        activeToken: { value: 'primary-token' },
        activeAccountId: { value: 'primary-id' },
        tokenProvider: () => ({ token: 'rotated-token', accountId: 'rotated-id' }),
      },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST');
    req.headers['x-sentinel-probe-token'] = 'probe-token';
    req.headers['x-sentinel-probe-account'] = 'probe-account';
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 50));

    // Probe headers must win over both activeToken and tokenProvider.
    expect(capturedHeaders['authorization']).toBe('Bearer probe-token');
    // Attribution must use the probe account.
    expect(rateLimitStore.getAll('probe-account')).toHaveLength(1);
    expect(rateLimitStore.getAll('primary-id')).toHaveLength(0);
    expect(rateLimitStore.getAll('rotated-id')).toHaveLength(0);
    // Internal headers must NOT leak upstream.
    expect(capturedHeaders['x-sentinel-probe-token']).toBeUndefined();
    expect(capturedHeaders['x-sentinel-probe-account']).toBeUndefined();
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
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as unknown as ClientRequest;
    });

    const server = createProxyServer(
      {
        db,
        ipcServer,
        activeToken: { value: 'primary-token' },
        activeAccountId: { value: 'primary-id' },
        tokenProvider: () => null,
      },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 50));

    expect(capturedHeaders['authorization']).toBe('Bearer primary-token');
    server.close();
  });

  it('handles /health GET request', () => {
    const server = createProxyServer({ db, ipcServer }, otelHandler);
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/health', 'GET', '');
    const { res } = makeRes();

    let writtenBody = '';
    (res as unknown as { end: (data?: string) => void }).end = (data?: string) => {
      writtenBody = data ?? '';
    };
    let code = 0;
    (res as unknown as { writeHead: (c: number) => void }).writeHead = (c: number) => {
      code = c;
    };

    handler?.(req, res);
    expect(code).toBe(200);
    expect(writtenBody).toContain('ok');
    server.close();
  });

  it('routes OTEL paths to otelHandler', async () => {
    const server = createProxyServer({ db, ipcServer }, otelHandler);
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/metrics', 'POST');
    const { res } = makeRes();

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 50));

    expect(otelHandler).toHaveBeenCalledOnce();
    server.close();
  });

  it('routes /v1/logs to otelHandler', async () => {
    const server = createProxyServer({ db, ipcServer }, otelHandler);
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

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
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq(
      '/v1/messages',
      'POST',
      JSON.stringify({ model: 'claude-opus-4', messages: [] }),
    );
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
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

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
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/metrics', 'POST');
    let code = 200;
    const res = {
      writeHead: (c: number) => {
        code = c;
      },
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
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST');
    let code = 200;
    const res = {
      writeHead: (c: number) => {
        code = c;
      },
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
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

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
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

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
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

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
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/unknown-path', 'GET', '');
    let code = 200;
    const res = {
      writeHead: (c: number) => {
        code = c;
      },
      end: vi.fn(),
    } as unknown as ServerResponse;

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 100));
    expect(code).toBe(502);
    server.close();
  });

  it('records request-id → rotated-account mapping from upstream response headers', async () => {
    // Round-robin attribution for OTEL events. The proxy must store each
    // response's `request-id` → per-request account so OtelReceiver can
    // re-bucket api_request events to the token that actually served them.
    const requestAccountMap = new RequestAccountMap();
    const mockProxyRes = {
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'request-id': 'req_01AbCDeF',
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

    const server = createProxyServer(
      {
        db,
        ipcServer,
        activeToken: { value: 'primary-token' },
        activeAccountId: { value: 'primary-id' },
        tokenProvider: () => ({ token: 'rotated-token', accountId: 'rotated-id' }),
        requestAccountMap,
      },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    handler?.(makeReq('/v1/messages', 'POST'), makeRes().res);
    await new Promise((r) => setTimeout(r, 100));

    expect(requestAccountMap.get('req_01AbCDeF')).toBe('rotated-id');
    server.close();
  });

  it('skips request-id map write when the header is absent', async () => {
    const requestAccountMap = new RequestAccountMap();
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
      } as unknown as ClientRequest;
    });

    const server = createProxyServer(
      {
        db,
        ipcServer,
        activeToken: { value: 'primary-token' },
        activeAccountId: { value: 'primary-id' },
        requestAccountMap,
      },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    handler?.(makeReq('/v1/messages', 'POST'), makeRes().res);
    await new Promise((r) => setTimeout(r, 100));

    expect(requestAccountMap.size()).toBe(0);
    server.close();
  });

  it('handles request-id arriving as an array header (takes first value)', async () => {
    const requestAccountMap = new RequestAccountMap();
    const mockProxyRes = {
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        'request-id': ['req_first', 'req_ignored'],
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

    const server = createProxyServer(
      {
        db,
        ipcServer,
        activeToken: { value: 'primary-token' },
        activeAccountId: { value: 'primary-id' },
        requestAccountMap,
      },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    handler?.(makeReq('/v1/messages', 'POST'), makeRes().res);
    await new Promise((r) => setTimeout(r, 100));

    expect(requestAccountMap.get('req_first')).toBe('primary-id');
    expect(requestAccountMap.get('req_ignored')).toBeNull();
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
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

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
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    // Fire two requests back-to-back; only one broadcast should go out
    handler?.(makeReq('/v1/messages'), makeRes().res);
    await new Promise((r) => setTimeout(r, 50));
    handler?.(makeReq('/v1/messages'), makeRes().res);
    await new Promise((r) => setTimeout(r, 100));

    const rlCalls = vi
      .mocked(ipcServer.broadcast)
      .mock.calls.filter(([m]) => (m as { type: string }).type === 'rate_limits_updated');
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
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST');
    const { res } = makeRes();

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 100));

    expect(vi.mocked(ipcServer.broadcast)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'overage_entered', resetsAt: null }),
    );
    server.close();
  });

  it('returns a 403 and does not forward when securityScanner.scanOutbound blocks', async () => {
    const scanner = {
      scanOutbound: vi.fn(() => ({
        action: 'block_immediate',
        blockReason: 'AWS access key',
        findings: [],
      })),
      startResponseTap: vi.fn(() => null),
    };
    const server = createProxyServer(
      { db, ipcServer, securityScanner: scanner as never },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq(
      '/v1/messages',
      'POST',
      JSON.stringify({ messages: [{ role: 'user', content: 'AKIA' }] }),
    );
    const { res } = makeRes();
    let writtenBody = '';
    let code = 0;
    (res as unknown as { writeHead: (c: number) => void }).writeHead = (c: number) => {
      code = c;
    };
    (res as unknown as { end: (data?: string) => void }).end = (data?: string) => {
      writtenBody = data ?? '';
    };

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 30));

    expect(code).toBe(403);
    expect(writtenBody).toContain('Blocked by Claude Sentinel');
    expect(writtenBody).toContain('AWS access key');
    expect(httpsRequestMock).not.toHaveBeenCalled();
    expect(scanner.scanOutbound).toHaveBeenCalledOnce();
    server.close();
  });

  it('held-block + approve forwards the request upstream', async () => {
    let resolveOutcome: ((o: 'approve' | 'deny' | 'timeout') => void) | null = null;
    const scanner = {
      scanOutbound: vi.fn(() => ({
        action: 'pending',
        pendingId: 'abc',
        blockReason: 'AWS access key',
        findings: [],
      })),
      awaitPendingResolution: vi.fn(
        () =>
          new Promise<'approve' | 'deny' | 'timeout'>((resolve) => {
            resolveOutcome = resolve;
          }),
      ),
      resolvePending: vi.fn(() => true),
      listPending: vi.fn(() => []),
      startResponseTap: vi.fn(() => null),
    };

    const capturedUpstream: Record<string, unknown> = {};
    const mockProxyRes = {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'end') setTimeout(cb, 5);
        return mockProxyRes;
      }),
      pipe: vi.fn(),
    };
    httpsRequestMock.mockImplementation((opts, cb) => {
      Object.assign(capturedUpstream, opts);
      if (cb) setTimeout(() => cb(mockProxyRes as unknown as IncomingMessage), 5);
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as unknown as ClientRequest;
    });

    const server = createProxyServer(
      { db, ipcServer, securityScanner: scanner as never },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];
    const req = makeReq('/v1/messages', 'POST');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 20));

    // The proxy is now waiting on awaitPendingResolution. Upstream hasn't
    // been called yet.
    expect(httpsRequestMock).not.toHaveBeenCalled();
    expect(resolveOutcome).not.toBeNull();

    // Approve. Proxy should fall through to upstream forwarding.
    resolveOutcome!('approve');
    await new Promise((r) => setTimeout(r, 30));
    expect(httpsRequestMock).toHaveBeenCalled();
    server.close();
  });

  it('held-block + deny synthesizes a 403', async () => {
    let resolveOutcome: ((o: 'approve' | 'deny' | 'timeout') => void) | null = null;
    const scanner = {
      scanOutbound: vi.fn(() => ({
        action: 'pending',
        pendingId: 'abc',
        blockReason: 'AWS access key',
        findings: [],
      })),
      awaitPendingResolution: vi.fn(
        () =>
          new Promise<'approve' | 'deny' | 'timeout'>((resolve) => {
            resolveOutcome = resolve;
          }),
      ),
      resolvePending: vi.fn(() => true),
      listPending: vi.fn(() => []),
      startResponseTap: vi.fn(() => null),
    };
    const server = createProxyServer(
      { db, ipcServer, securityScanner: scanner as never },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];
    const req = makeReq('/v1/messages', 'POST');
    const { res } = makeRes();
    let code = 0;
    let writtenBody = '';
    (res as unknown as { writeHead: (c: number) => void }).writeHead = (c: number) => {
      code = c;
    };
    (res as unknown as { end: (data?: string) => void }).end = (data?: string) => {
      writtenBody = data ?? '';
    };

    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 20));
    resolveOutcome!('deny');
    await new Promise((r) => setTimeout(r, 20));

    expect(code).toBe(403);
    expect(writtenBody).toContain('Blocked by Claude Sentinel');
    expect(httpsRequestMock).not.toHaveBeenCalled();
    server.close();
  });

  it('feeds response chunks to a security tap and flushes at end', async () => {
    const pushed: Buffer[] = [];
    let flushCount = 0;
    const tap = {
      push: (chunk: Buffer) => pushed.push(chunk),
      flush: () => {
        flushCount++;
      },
      destroy: vi.fn(),
    };
    const scanner = {
      scanOutbound: vi.fn(() => ({ action: 'allow', findings: [] })),
      startResponseTap: vi.fn(() => tap),
    };

    // Mock an SSE response that emits two data chunks before end.
    const dataListeners: Array<(c: Buffer) => void> = [];
    const endListeners: Array<() => void> = [];
    const mockProxyRes = {
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        if (event === 'data') dataListeners.push(cb as (c: Buffer) => void);
        if (event === 'end') endListeners.push(cb as () => void);
        return mockProxyRes;
      }),
      pipe: vi.fn(),
    };
    httpsRequestMock.mockImplementation((_opts, cb) => {
      if (cb) setTimeout(() => cb(mockProxyRes as unknown as IncomingMessage), 5);
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as unknown as ClientRequest;
    });

    const server = createProxyServer(
      { db, ipcServer, securityScanner: scanner as never },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];
    const req = makeReq('/v1/messages', 'POST');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 20));

    // Simulate two SSE chunks and stream end.
    dataListeners.forEach((cb) => cb(Buffer.from('data: {"type":"ping"}\n\n')));
    dataListeners.forEach((cb) => cb(Buffer.from('data: {"type":"pong"}\n\n')));
    endListeners.forEach((cb) => cb());

    expect(pushed).toHaveLength(2);
    expect(flushCount).toBe(1);
    server.close();
  });

  it('skips the tap when the response is gzipped', async () => {
    const tap = { push: vi.fn(), flush: vi.fn(), destroy: vi.fn() };
    const scanner = {
      scanOutbound: vi.fn(() => ({ action: 'allow', findings: [] })),
      startResponseTap: vi.fn(() => tap),
    };
    const mockProxyRes = {
      statusCode: 200,
      headers: { 'content-encoding': 'gzip' },
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'end') setTimeout(cb, 5);
        return mockProxyRes;
      }),
      pipe: vi.fn(),
    };
    httpsRequestMock.mockImplementation((_opts, cb) => {
      if (cb) setTimeout(() => cb(mockProxyRes as unknown as IncomingMessage), 5);
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as unknown as ClientRequest;
    });

    const server = createProxyServer(
      { db, ipcServer, securityScanner: scanner as never },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];
    const req = makeReq('/v1/messages', 'POST');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 30));

    expect(tap.destroy).toHaveBeenCalled();
    expect(tap.push).not.toHaveBeenCalled();
    expect(mockProxyRes.pipe).toHaveBeenCalled();
    server.close();
  });

  it('short-circuits with 503 + Retry-After when the active account is paused', async () => {
    const server = createProxyServer(
      {
        db,
        ipcServer,
        activeToken: { value: 'tok' },
        activeAccountId: { value: 'paused-acct' },
        getPausedAccountIds: () => new Set(['paused-acct']),
        getSessionResetAt: () => Math.floor(Date.now() / 1000) + 600, // 10 min from now
      },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST');
    let code = 0;
    let capturedHeaders: Record<string, unknown> = {};
    let bodyStr = '';
    const res = {
      writeHead: (c: number, hdrs?: unknown) => {
        code = c;
        if (hdrs && typeof hdrs === 'object') capturedHeaders = hdrs as Record<string, unknown>;
      },
      end: (data?: string) => {
        bodyStr = data ?? '';
      },
      write: vi.fn(),
      pipe: vi.fn(),
    } as unknown as ServerResponse;

    handler?.(req, res);
    // /v1/messages POSTs buffer the body before gating so the Sonnet
    // check can see the model — yield for the readBody microtask.
    await new Promise((r) => setTimeout(r, 30));
    // Upstream must NOT be called.
    expect(httpsRequestMock).not.toHaveBeenCalled();
    expect(code).toBe(503);
    expect(capturedHeaders['Retry-After']).toBeDefined();
    // Retry-After is seconds in delta form.
    const retry = Number(capturedHeaders['Retry-After']);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(600);
    const parsed = JSON.parse(bodyStr);
    expect(parsed.error?.type).toBe('sentinel_budget_paused');
    server.close();
  });

  it('falls back to 300s Retry-After when no 5h reset is known', async () => {
    const server = createProxyServer(
      {
        db,
        ipcServer,
        activeToken: { value: 'tok' },
        activeAccountId: { value: 'paused-acct' },
        getPausedAccountIds: () => new Set(['paused-acct']),
        getSessionResetAt: () => null,
      },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST');
    let capturedHeaders: Record<string, unknown> = {};
    const res = {
      writeHead: (_c: number, hdrs?: unknown) => {
        if (hdrs && typeof hdrs === 'object') capturedHeaders = hdrs as Record<string, unknown>;
      },
      end: vi.fn(),
      write: vi.fn(),
    } as unknown as ServerResponse;

    handler?.(req, res);
    // Async path — wait for readBody to resolve before asserting.
    await new Promise((r) => setTimeout(r, 30));
    expect(Number(capturedHeaders['Retry-After'])).toBe(300);
    server.close();
  });

  it('does not short-circuit requests to non-Anthropic paths when paused', async () => {
    const server = createProxyServer(
      {
        db,
        ipcServer,
        activeToken: { value: 'tok' },
        activeAccountId: { value: 'paused-acct' },
        getPausedAccountIds: () => new Set(['paused-acct']),
        getSessionResetAt: () => null,
      },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    // Health check — pause gate fires BEFORE the path check, so this
    // currently also returns 503. Worth documenting the behaviour so future
    // refactors are intentional.
    const req = makeReq('/health', 'GET', '');
    let code = 0;
    const res = {
      writeHead: (c: number) => {
        code = c;
      },
      end: vi.fn(),
      write: vi.fn(),
    } as unknown as ServerResponse;
    handler?.(req, res);
    // Health has no credential-selection so is not paused. /health returns 200.
    expect(code).toBe(200);
    server.close();
  });
});

describe('createProxyServer cache TTL capture', () => {
  let realDb: Database.Database;
  let ipcServer: IpcServer;
  let otelHandler: ReturnType<typeof vi.fn>;
  let broadcastCalls: Array<{ type: string }>;

  beforeEach(async () => {
    const BetterSqlite = (await import('better-sqlite3')).default;
    realDb = new BetterSqlite(':memory:') as unknown as Database.Database;
    const { SCHEMA } = await import('./db.js');
    (realDb as unknown as { exec: (sql: string) => void }).exec(SCHEMA);
    broadcastCalls = [];
    ipcServer = {
      broadcast: (msg: { type: string }) => broadcastCalls.push(msg),
      onMessage: vi.fn(),
      start: vi.fn(),
      close: vi.fn(),
      connectedClients: 0,
    } as unknown as IpcServer;
    otelHandler = vi.fn().mockResolvedValue(undefined);
    httpsRequestMock.mockReset();
  });

  function reqWithBody(body: unknown): IncomingMessage {
    const bytes = JSON.stringify(body);
    return makeReq('/v1/messages', 'POST', bytes);
  }

  function setupUpstream(params: { contentType: string; chunks: string[] }): {
    dataListeners: Array<(c: Buffer) => void>;
    endListeners: Array<() => void>;
  } {
    const dataListeners: Array<(c: Buffer) => void> = [];
    const endListeners: Array<() => void> = [];
    const mockProxyRes = {
      statusCode: 200,
      headers: { 'content-type': params.contentType },
      on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        if (event === 'data') dataListeners.push(cb as (c: Buffer) => void);
        if (event === 'end') endListeners.push(cb as () => void);
        return mockProxyRes;
      }),
      pipe: vi.fn(),
    };
    httpsRequestMock.mockImplementation((_opts, cb) => {
      if (cb) setTimeout(() => cb(mockProxyRes as unknown as IncomingMessage), 5);
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as unknown as ClientRequest;
    });
    // Deliver chunks after the upstream handler has been installed.
    setTimeout(() => {
      for (const chunk of params.chunks) {
        dataListeners.forEach((cb) => cb(Buffer.from(chunk)));
      }
      endListeners.forEach((cb) => cb());
    }, 15);
    return { dataListeners, endListeners };
  }

  it('inserts a cache_ttl_events row from an SSE message_delta usage payload', async () => {
    const body = {
      model: 'claude-sonnet-4-6',
      system: [
        { type: 'text', text: 'instr', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'tail', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { user_id: JSON.stringify({ session_id: 'sess-ABC', account_uuid: 'u1' }) },
    };
    setupUpstream({
      contentType: 'text/event-stream',
      chunks: [
        `data: ${JSON.stringify({
          type: 'message_start',
          message: {
            model: 'claude-sonnet-4-6',
            usage: { input_tokens: 1 },
          },
        })}\n\n`,
        `data: ${JSON.stringify({
          type: 'message_delta',
          usage: {
            input_tokens: 1,
            cache_creation: {
              ephemeral_5m_input_tokens: 1000,
              ephemeral_1h_input_tokens: 2000,
            },
            cache_read_input_tokens: 500,
            output_tokens: 42,
          },
        })}\n\n`,
      ],
    });

    const server = createProxyServer(
      {
        db: realDb,
        ipcServer,
        activeToken: { value: 't' },
        activeAccountId: { value: 'acct-1' },
      },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];
    const req = reqWithBody(body);
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 80));

    const rows = realDb.prepare('SELECT * FROM cache_ttl_events').all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: 'acct-1',
      session_id: 'sess-ABC',
      model: 'claude-sonnet-4-6',
      req_markers_5m: 1,
      req_markers_1h: 1,
      cache_create_5m: 1000,
      cache_create_1h: 2000,
      cache_read: 500,
      input_tokens: 1,
    });
    // Cost fields: 1000 tokens 5m = 1000/1e6 * 3 * 1.25 = 0.00375
    expect(rows[0]?.['cost_5m_write']).toBeCloseTo(0.00375, 6);
    // 2000 tokens 1h = 2000/1e6 * 3 * 2.0 = 0.012
    expect(rows[0]?.['cost_1h_write']).toBeCloseTo(0.012, 6);
    // 500 tokens read = 500/1e6 * 3 * 0.1 = 0.00015
    expect(rows[0]?.['cost_read']).toBeCloseTo(0.00015, 6);
    expect(broadcastCalls.some((c) => c.type === 'metrics_updated')).toBe(true);

    server.close();
  });

  it('skips the insert when no usage arrives in the response', async () => {
    setupUpstream({
      contentType: 'text/event-stream',
      chunks: ['data: {"type":"ping"}\n\n'],
    });
    const server = createProxyServer(
      {
        db: realDb,
        ipcServer,
        activeToken: { value: 't' },
        activeAccountId: { value: 'acct-2' },
      },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];
    const req = reqWithBody({ model: 'm', messages: [] });
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 60));

    const rows = realDb.prepare('SELECT COUNT(*) AS n FROM cache_ttl_events').get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
    server.close();
  });

  it('falls back to JSON parsing for non-SSE responses', async () => {
    const responsePayload = JSON.stringify({
      model: 'claude-opus-4-7',
      usage: {
        input_tokens: 4,
        cache_creation: {
          ephemeral_5m_input_tokens: 10,
          ephemeral_1h_input_tokens: 0,
        },
        cache_read_input_tokens: 7,
        output_tokens: 1,
      },
    });
    setupUpstream({
      contentType: 'application/json',
      chunks: [responsePayload],
    });
    const server = createProxyServer(
      {
        db: realDb,
        ipcServer,
        activeToken: { value: 't' },
        activeAccountId: { value: 'acct-3' },
      },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];
    const req = reqWithBody({
      model: 'claude-opus-4-7',
      messages: [],
      metadata: { user_id: JSON.stringify({ session_id: 'sess-JSON' }) },
    });
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 60));

    const row = realDb.prepare('SELECT * FROM cache_ttl_events').get() as Record<string, unknown>;
    expect(row).toMatchObject({
      account_id: 'acct-3',
      session_id: 'sess-JSON',
      model: 'claude-opus-4-7',
      cache_create_5m: 10,
      cache_create_1h: 0,
      cache_read: 7,
    });
    server.close();
  });

  it('skips count_tokens paths', async () => {
    setupUpstream({
      contentType: 'application/json',
      chunks: [
        JSON.stringify({
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 0 },
        }),
      ],
    });
    const server = createProxyServer(
      {
        db: realDb,
        ipcServer,
        activeToken: { value: 't' },
        activeAccountId: { value: 'acct-4' },
      },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];
    const req = makeReq('/v1/messages/count_tokens', 'POST', '{}');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 60));

    const rows = realDb.prepare('SELECT COUNT(*) AS n FROM cache_ttl_events').get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
    server.close();
  });

  it('debounces the metrics_updated broadcast to one per window per account', async () => {
    const sseChunk = `data: ${JSON.stringify({
      type: 'message_delta',
      usage: { cache_read_input_tokens: 1 },
    })}\n\n`;

    const server = createProxyServer(
      {
        db: realDb,
        ipcServer,
        activeToken: { value: 't' },
        activeAccountId: { value: 'acct-debounce' },
      },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    // Two back-to-back requests against the SAME server — the second must
    // NOT fire a second metrics_updated inside the 1 s debounce window.
    for (let i = 0; i < 2; i++) {
      setupUpstream({ contentType: 'text/event-stream', chunks: [sseChunk] });
      const req = makeReq('/v1/messages', 'POST', '{}');
      const { res } = makeRes();
      handler?.(req, res);
      await new Promise((r) => setTimeout(r, 40));
    }
    const metricsFires = broadcastCalls.filter((c) => c.type === 'metrics_updated').length;
    expect(metricsFires).toBe(1);

    const rowCount = (
      realDb.prepare('SELECT COUNT(*) AS n FROM cache_ttl_events').get() as { n: number }
    ).n;
    expect(rowCount).toBe(2);
    server.close();
  });
});

// ── Sonnet-aware request-model helpers ───────────────────────────────────────

describe('extractRequestModel', () => {
  it('returns the model string for a well-formed body', () => {
    const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }));
    expect(extractRequestModel(body)).toBe('claude-sonnet-4-6');
  });

  it('returns null for an empty body', () => {
    expect(extractRequestModel(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(extractRequestModel(Buffer.from('{ not json'))).toBeNull();
  });

  it('returns null when the model field is missing', () => {
    expect(extractRequestModel(Buffer.from(JSON.stringify({ messages: [] })))).toBeNull();
  });

  it('returns null when the model field is not a string', () => {
    expect(extractRequestModel(Buffer.from(JSON.stringify({ model: 42 })))).toBeNull();
  });

  it('returns null for an empty-string model', () => {
    expect(extractRequestModel(Buffer.from(JSON.stringify({ model: '' })))).toBeNull();
  });
});

describe('isSonnetModel', () => {
  it.each([
    ['claude-sonnet-4-6', true],
    ['claude-3-5-sonnet-20241022', true],
    ['CLAUDE-SONNET-5-x', true],
    ['claude-opus-4-7', false],
    ['claude-haiku-4-5', false],
    [null, false],
    ['', false],
  ])('isSonnetModel(%j) === %s', (input, expected) => {
    expect(isSonnetModel(input)).toBe(expected);
  });
});

// ── Sonnet 7-day saturation short-circuit ────────────────────────────────────

describe('createProxyServer Sonnet 7-day gate', () => {
  let db: Database.Database;
  let ipcServer: IpcServer;

  beforeEach(() => {
    db = makeMockDb();
    ipcServer = makeMockIpc();
    httpsRequestMock.mockReset();
  });

  // Reuse the same mock-response/request shape as the paused-account tests.
  function setupMockUpstream(): void {
    const mockProxyRes = {
      statusCode: 200,
      headers: { 'content-type': 'application/json' } as IncomingHttpHeaders,
      on: vi.fn().mockReturnThis(),
      pipe: vi.fn().mockReturnThis(),
    } as unknown as IncomingMessage;
    const mockProxyReq = {
      on: vi.fn().mockReturnThis(),
      write: vi.fn(),
      end: vi.fn(),
    } as unknown as ClientRequest;
    httpsRequestMock.mockImplementation(
      (_opts: RequestOptions, cb?: (res: IncomingMessage) => void) => {
        if (cb) cb(mockProxyRes);
        return mockProxyReq;
      },
    );
  }

  function setSonnet(store: RateLimitStore, id: string, util: number, reset = 9_000): void {
    store.update(id, {
      'anthropic-ratelimit-unified-7d_sonnet-status': 'allowed',
      'anthropic-ratelimit-unified-7d_sonnet-utilization': String(util),
      'anthropic-ratelimit-unified-7d_sonnet-reset': String(reset),
    });
  }

  function invokeHandler(
    server: ReturnType<typeof createProxyServer>,
    req: IncomingMessage,
    res: ServerResponse,
  ): void {
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];
    handler?.(req, res);
  }

  it('returns 503 sentinel_sonnet_saturated on a Sonnet request when not opted in', async () => {
    const rateLimitStore = new RateLimitStore();
    setSonnet(rateLimitStore, 'hot', 1.0, Math.floor(Date.now() / 1000) + 900);

    const server = createProxyServer(
      {
        db,
        ipcServer,
        activeToken: { value: 'tok' },
        activeAccountId: { value: 'hot' },
        rateLimitStore,
        getOverageAllowedIds: () => new Set(), // not opted in
        getOverageBufferPct: () => 5,
      },
      vi.fn(),
    );

    const req = makeReq(
      '/v1/messages',
      'POST',
      JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
    );
    let code = 0;
    let bodyStr = '';
    let hdrs: Record<string, unknown> = {};
    const res = {
      writeHead: (c: number, h?: unknown) => {
        code = c;
        if (h && typeof h === 'object') hdrs = h as Record<string, unknown>;
      },
      end: (d?: string) => {
        bodyStr = d ?? '';
      },
      write: vi.fn(),
    } as unknown as ServerResponse;

    invokeHandler(server, req, res);
    await new Promise((r) => setTimeout(r, 30));

    expect(httpsRequestMock).not.toHaveBeenCalled();
    expect(code).toBe(503);
    expect(hdrs['Retry-After']).toBeDefined();
    const parsed = JSON.parse(bodyStr);
    expect(parsed.error?.type).toBe('sentinel_sonnet_saturated');
    server.close();
  });

  it('lets the Sonnet request through when the account is opted into overage', async () => {
    setupMockUpstream();
    const rateLimitStore = new RateLimitStore();
    setSonnet(rateLimitStore, 'hot', 1.0);

    const server = createProxyServer(
      {
        db,
        ipcServer,
        activeToken: { value: 'tok' },
        activeAccountId: { value: 'hot' },
        rateLimitStore,
        getOverageAllowedIds: () => new Set(['hot']), // opted in
        getOverageBufferPct: () => 5,
      },
      vi.fn(),
    );

    const req = makeReq(
      '/v1/messages',
      'POST',
      JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
    );
    const { res } = makeRes();
    invokeHandler(server, req, res);
    await new Promise((r) => setTimeout(r, 40));

    expect(httpsRequestMock).toHaveBeenCalled();
    server.close();
  });

  it('does not short-circuit Opus requests on a Sonnet-saturated account', async () => {
    setupMockUpstream();
    const rateLimitStore = new RateLimitStore();
    setSonnet(rateLimitStore, 'hot', 1.0);

    const server = createProxyServer(
      {
        db,
        ipcServer,
        activeToken: { value: 'tok' },
        activeAccountId: { value: 'hot' },
        rateLimitStore,
        getOverageAllowedIds: () => new Set(),
        getOverageBufferPct: () => 5,
      },
      vi.fn(),
    );

    const req = makeReq(
      '/v1/messages',
      'POST',
      JSON.stringify({ model: 'claude-opus-4-7', messages: [] }),
    );
    const { res } = makeRes();
    invokeHandler(server, req, res);
    await new Promise((r) => setTimeout(r, 40));

    expect(httpsRequestMock).toHaveBeenCalled();
    server.close();
  });

  it('does not short-circuit when Sonnet 7d util is below the threshold', async () => {
    setupMockUpstream();
    const rateLimitStore = new RateLimitStore();
    setSonnet(rateLimitStore, 'warm', 0.6);

    const server = createProxyServer(
      {
        db,
        ipcServer,
        activeToken: { value: 'tok' },
        activeAccountId: { value: 'warm' },
        rateLimitStore,
        getOverageAllowedIds: () => new Set(),
        getOverageBufferPct: () => 5,
      },
      vi.fn(),
    );

    const req = makeReq(
      '/v1/messages',
      'POST',
      JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
    );
    const { res } = makeRes();
    invokeHandler(server, req, res);
    await new Promise((r) => setTimeout(r, 40));

    expect(httpsRequestMock).toHaveBeenCalled();
    server.close();
  });

  it('does not short-circuit when the Sonnet window is missing from the store', async () => {
    setupMockUpstream();
    // Empty store — this account has never served a Sonnet request.
    const rateLimitStore = new RateLimitStore();

    const server = createProxyServer(
      {
        db,
        ipcServer,
        activeToken: { value: 'tok' },
        activeAccountId: { value: 'unprobed' },
        rateLimitStore,
        getOverageAllowedIds: () => new Set(),
        getOverageBufferPct: () => 5,
      },
      vi.fn(),
    );

    const req = makeReq(
      '/v1/messages',
      'POST',
      JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }),
    );
    const { res } = makeRes();
    invokeHandler(server, req, res);
    await new Promise((r) => setTimeout(r, 40));

    expect(httpsRequestMock).toHaveBeenCalled();
    server.close();
  });
});
