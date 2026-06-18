import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  IncomingMessage,
  ServerResponse,
  ClientRequest,
  IncomingHttpHeaders,
  RequestOptions,
} from 'http';
import { DEFAULT_SETTINGS } from './settings.js';
import type { Settings } from '@sentinel/shared';

// Mock the https module so no real network calls escape the test.
vi.mock('https', () => ({
  request: vi.fn(),
}));

// Override loadSettings so the capture code path is active for these tests
// without touching the user's real ~/.sentinel/settings.json.
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
import type { RequestLogStore, RequestLogRecord } from './request-log-db.js';
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
    prepare: vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ lastInsertRowid: 1 }),
    }),
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

function makeReq(url: string, method = 'POST', body = '{"hello":"world"}'): IncomingMessage {
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

function makeRes(): { res: ServerResponse } {
  const res = {
    writeHead: vi.fn(),
    end: vi.fn(),
    write: vi.fn(),
    pipe: vi.fn(),
    // The proxy's activity tracker (idle gate for silent auto-updates)
    // registers a `close` listener on every upstream-bound response. A real
    // ServerResponse is an EventEmitter; this stub only needs the method to
    // exist — these tests never assert on in-flight counts.
    once: (_event: string, _cb: () => void) => res,
  } as unknown as ServerResponse;
  return { res };
}

function makeFakeStore(): {
  store: RequestLogStore;
  records: RequestLogRecord[];
} {
  const records: RequestLogRecord[] = [];
  const store: RequestLogStore = {
    enqueue: (r: RequestLogRecord) => {
      records.push(r);
    },
    flush: vi.fn(),
    get: vi.fn(),
    purgeOlderThan: vi.fn(),
    clearAll: vi.fn(),
    close: vi.fn(),
  } as unknown as RequestLogStore;
  return { store, records };
}

describe('proxy request capture', () => {
  let db: Database.Database;
  let ipcServer: IpcServer;
  let otelHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = makeMockDb();
    ipcServer = makeMockIpc();
    otelHandler = vi.fn().mockResolvedValue(undefined);
    httpsRequestMock.mockReset();
    mockedSettings = {
      ...DEFAULT_SETTINGS,
      requestLoggingEnabled: true,
      requestLogMaxBodyKb: 256,
      requestLogCaptureResponse: true,
      requestLogRedactAuthHeaders: true,
    };
  });

  function stubUpstream(
    chunks: Buffer[] = [],
    statusCode = 200,
    headers: Record<string, string> = { 'content-type': 'application/json' },
  ) {
    const listenersMap: Record<string, Array<(arg?: unknown) => void>> = {};
    const mockProxyRes = {
      statusCode,
      headers,
      on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        listenersMap[event] = listenersMap[event] ?? [];
        listenersMap[event]?.push(cb);
        return mockProxyRes;
      }),
      pipe: vi.fn(),
    };
    httpsRequestMock.mockImplementation((_opts, cb) => {
      if (cb) {
        setTimeout(() => {
          cb(mockProxyRes as unknown as IncomingMessage);
          // Fire data chunks, then end.
          setTimeout(() => {
            for (const chunk of chunks) {
              listenersMap['data']?.forEach((fn) => fn(chunk));
            }
            listenersMap['end']?.forEach((fn) => fn());
          }, 5);
        }, 5);
      }
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      } as unknown as ClientRequest;
    });
    return mockProxyRes;
  }

  it('records a request with full body + headers when capture is enabled', async () => {
    const { store, records } = makeFakeStore();
    stubUpstream([Buffer.from('{"ok":true}')]);

    const server = createProxyServer({ db, ipcServer, requestLogStore: store }, otelHandler);
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 40));

    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.method).toBe('POST');
    expect(rec.urlPath).toBe('/v1/messages');
    expect(rec.statusCode).toBe(200);
    expect(rec.requestBody?.toString('utf-8')).toContain('hello');
    expect(rec.requestBodySize).toBeGreaterThan(0);
    // Auth header is redacted because redactAuth is true.
    expect(rec.requestHeaders['authorization']).toBe('[REDACTED]');
    // Response body was captured.
    expect(rec.responseBody?.toString('utf-8')).toBe('{"ok":true}');
    expect(rec.responseBodySize).toBe(11);
    expect(rec.errorMessage).toBeNull();
    server.close();
  });

  it('skips capture entirely for sentinel probe requests', async () => {
    const { store, records } = makeFakeStore();
    stubUpstream();

    const server = createProxyServer({ db, ipcServer, requestLogStore: store }, otelHandler);
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages');
    req.headers['user-agent'] = 'sentinel-probe/1.0';
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 40));

    expect(records).toHaveLength(0);
    server.close();
  });

  it('truncates request body when it exceeds the configured cap', async () => {
    const { store, records } = makeFakeStore();
    mockedSettings = { ...mockedSettings, requestLogMaxBodyKb: 0 };
    // requestLogMaxBodyKb * 1024 = 0 — any body overflows.
    stubUpstream([Buffer.from('ok')]);

    const server = createProxyServer({ db, ipcServer, requestLogStore: store }, otelHandler);
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages', 'POST', '{"longer":"body-payload"}');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 40));

    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.requestBodyTruncated).toBe(true);
    // The captured slice is `subarray(0, maxBodyBytes=0)` → empty Buffer.
    expect(rec.requestBody?.length).toBe(0);
    // Response body capture also truncates, since the cap applies to both.
    expect(rec.responseBodyTruncated).toBe(true);
    server.close();
  });

  it('skips response body capture when captureResponse is false', async () => {
    const { store, records } = makeFakeStore();
    mockedSettings = { ...mockedSettings, requestLogCaptureResponse: false };
    stubUpstream([Buffer.from('{"ok":true}')]);

    const server = createProxyServer({ db, ipcServer, requestLogStore: store }, otelHandler);
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 40));

    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.responseBody).toBeNull();
    expect(rec.responseBodySize).toBeNull();
    server.close();
  });

  it('records authorization when redactAuth is off', async () => {
    const { store, records } = makeFakeStore();
    mockedSettings = { ...mockedSettings, requestLogRedactAuthHeaders: false };
    stubUpstream();

    const server = createProxyServer({ db, ipcServer, requestLogStore: store }, otelHandler);
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 40));

    expect(records).toHaveLength(1);
    expect(records[0]!.requestHeaders['authorization']).toBe('Bearer test-token');
    server.close();
  });

  it('captures errorMessage when the upstream request emits an error', async () => {
    const { store, records } = makeFakeStore();

    // Upstream: emit an error on the ClientRequest instead of the response.
    const reqListeners: Record<string, Array<(arg?: unknown) => void>> = {};
    httpsRequestMock.mockImplementation((_opts, _cb) => {
      const clientReq = {
        on: (event: string, cb: (arg?: unknown) => void) => {
          reqListeners[event] = reqListeners[event] ?? [];
          reqListeners[event]?.push(cb);
          return clientReq;
        },
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      } as unknown as ClientRequest;
      setTimeout(() => {
        reqListeners['error']?.forEach((fn) => fn(new Error('upstream went away')));
      }, 10);
      return clientReq;
    });

    const server = createProxyServer({ db, ipcServer, requestLogStore: store }, otelHandler);
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 40));

    expect(records).toHaveLength(1);
    expect(records[0]!.errorMessage).toContain('upstream went away');
    expect(records[0]!.statusCode).toBeNull();
    expect(records[0]!.durationMs).toBeNull();
    server.close();
  });

  it('aborts the upstream request when no data flows within the idle timeout', async () => {
    const { store, records } = makeFakeStore();

    // Upstream accepts the connection but never replies. Capture the
    // idle-timeout callback registered by the proxy so we can fire it
    // deterministically instead of waiting 60s.
    const reqListeners: Record<string, Array<(arg?: unknown) => void>> = {};
    // Boxed so TS sees the assignment from inside the mock closure — a
    // bare `let timeoutHandler = null` confuses control-flow analysis.
    const handlerBox: { fn: (() => void) | null } = { fn: null };
    httpsRequestMock.mockImplementation((_opts, _cb) => {
      const clientReq = {
        on: (event: string, cb: (arg?: unknown) => void) => {
          reqListeners[event] = reqListeners[event] ?? [];
          reqListeners[event]?.push(cb);
          return clientReq;
        },
        write: vi.fn(),
        end: vi.fn(),
        destroy: (err?: Error) => {
          if (err) reqListeners['error']?.forEach((fn) => fn(err));
        },
        setTimeout: (_ms: number, cb: () => void) => {
          handlerBox.fn = cb;
          return clientReq;
        },
      } as unknown as ClientRequest;
      return clientReq;
    });

    const server = createProxyServer({ db, ipcServer, requestLogStore: store }, otelHandler);
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages');
    const { res } = makeRes();
    handler?.(req, res);
    // Let the body-buffering + dispatch settle so setTimeout has been called.
    await new Promise((r) => setTimeout(r, 20));
    expect(handlerBox.fn).not.toBeNull();
    // Fire the idle-timeout callback — proxy.ts destroys proxyReq with a
    // descriptive Error, which the error handler captures and rejects.
    handlerBox.fn?.();
    await new Promise((r) => setTimeout(r, 20));

    expect(records).toHaveLength(1);
    expect(records[0]!.errorMessage).toContain('upstream idle timeout');
    expect(records[0]!.errorMessage).toContain('60s');
    expect(records[0]!.statusCode).toBeNull();
    expect(records[0]!.durationMs).toBeNull();
    server.close();
  });

  it('flags the capture as an SSE response when content-encoding is absent', async () => {
    const { store, records } = makeFakeStore();
    stubUpstream([Buffer.from('event: message_start\ndata: {}\n\n')], 200, {
      'content-type': 'text/event-stream',
    });

    const server = createProxyServer({ db, ipcServer, requestLogStore: store }, otelHandler);
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 40));

    expect(records).toHaveLength(1);
    expect(records[0]!.isSse).toBe(true);
    server.close();
  });

  it('does not flag as SSE when upstream set a content-encoding header', async () => {
    const { store, records } = makeFakeStore();
    stubUpstream([Buffer.from('gzipped-bytes')], 200, {
      'content-type': 'text/event-stream',
      'content-encoding': 'gzip',
    });

    const server = createProxyServer({ db, ipcServer, requestLogStore: store }, otelHandler);
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 40));

    expect(records).toHaveLength(1);
    expect(records[0]!.isSse).toBe(false);
    server.close();
  });

  it('does not capture anything when requestLoggingEnabled is false', async () => {
    const { store, records } = makeFakeStore();
    mockedSettings = { ...mockedSettings, requestLoggingEnabled: false };
    stubUpstream();

    const server = createProxyServer({ db, ipcServer, requestLogStore: store }, otelHandler);
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];

    const req = makeReq('/v1/messages');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 40));

    expect(records).toHaveLength(0);
    server.close();
  });

  it('captures response body in multi-chunk streams, truncating the second chunk partially', async () => {
    const { store, records } = makeFakeStore();
    // Cap of 12 bytes — first chunk (11 bytes) fits, second chunk overflows
    // part-way, hitting the partial-copy branch in captureChunk.
    mockedSettings = {
      ...mockedSettings,
      requestLoggingEnabled: true,
      requestLogMaxBodyKb: 1,
    };
    // Override maxBodyBytes by monkey-patching the settings value (kb * 1024).
    // Instead, just feed a cap-exceeding payload split across three chunks.
    // With 1 KB cap, send ~600B + ~600B — first fits, second partially fits
    // only if the cap is hit mid-second; but 600+600=1200 > 1024.
    stubUpstream([
      Buffer.from('a'.repeat(600)),
      Buffer.from('b'.repeat(600)),
      Buffer.from('c'.repeat(600)),
    ]);

    const server = createProxyServer({ db, ipcServer, requestLogStore: store }, otelHandler);
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];
    const req = makeReq('/v1/messages');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 40));

    expect(records).toHaveLength(1);
    const rec = records[0]!;
    expect(rec.responseBodyTruncated).toBe(true);
    // Captured bytes should be exactly at the cap.
    expect(rec.responseBody?.length).toBe(1024);
    // But bodySize reflects the full wire size.
    expect(rec.responseBodySize).toBe(1800);
    server.close();
  });

  it('captures requests when a permissions interceptor is installed on the response', async () => {
    const { store, records } = makeFakeStore();
    stubUpstream([Buffer.from('event: ping\ndata: {}\n\n')], 200, {
      'content-type': 'text/event-stream',
    });

    // Fake enforcer that creates an interceptor — exercises the
    // `interceptor !== null` branch of the capture path.
    const interceptor = {
      push: vi.fn(),
      flush: vi.fn(),
      destroy: vi.fn(),
      awaitSettlement: vi.fn(() => Promise.resolve()),
    };
    const enforcer = {
      isEnabled: () => false,
      isSkippedForAutoMode: () => false,
      observeRequest: vi.fn(),
      stripDeniedTools: vi.fn(),
      createInterceptor: vi.fn(() => interceptor),
      resolvePending: vi.fn(() => false),
      listPending: vi.fn(() => []),
      invalidate: vi.fn(),
      listRules: vi.fn(() => []),
      getAutoModeStatus: vi.fn(() => ({
        active: false,
        source: null,
        lastDetectedAt: null,
        activeSessionCount: 0,
        totalSessionCount: 0,
      })),
      stopProcessPoll: vi.fn(),
    };
    const server = createProxyServer(
      {
        db,
        ipcServer,
        requestLogStore: store,
        permissionsEnforcer: enforcer as never,
      },
      otelHandler,
    );
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];
    const req = makeReq('/v1/messages');
    const { res } = makeRes();
    handler?.(req, res);
    // awaitSettlement is awaited after the upstream end fires; give
    // the microtask a couple of ticks to land before assertions.
    await new Promise((r) => setTimeout(r, 80));

    expect(interceptor.push).toHaveBeenCalled();
    expect(interceptor.flush).toHaveBeenCalled();
    expect(interceptor.awaitSettlement).toHaveBeenCalled();
    expect(records).toHaveLength(1);
    server.close();
  });

  it('captures errorMessage on proxyRes "error" when no tap / interceptor is installed', async () => {
    const { store, records } = makeFakeStore();

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
    httpsRequestMock.mockImplementation((_opts, cb) => {
      if (cb) {
        setTimeout(() => {
          cb(mockProxyRes as unknown as IncomingMessage);
          setTimeout(() => {
            listenersMap['error']?.forEach((fn) => fn(new Error('stream reset')));
          }, 5);
        }, 5);
      }
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
      } as unknown as ClientRequest;
    });

    const server = createProxyServer({ db, ipcServer, requestLogStore: store }, otelHandler);
    const handler = (
      server as unknown as {
        listeners: (e: string) => Array<(r: IncomingMessage, s: ServerResponse) => void>;
      }
    ).listeners('request')[0];
    const req = makeReq('/v1/messages');
    const { res } = makeRes();
    handler?.(req, res);
    await new Promise((r) => setTimeout(r, 40));

    expect(records).toHaveLength(1);
    expect(records[0]!.errorMessage).toContain('stream reset');
    server.close();
  });
});
