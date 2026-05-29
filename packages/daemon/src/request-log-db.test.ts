import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync, rmSync, mkdtempSync } from 'fs';
import {
  RequestLogStore,
  getRequestLogStore,
  closeRequestLogStore,
  redactHeaders,
  type RequestLogRecord,
} from './request-log-db.js';

function makeRecord(overrides: Partial<RequestLogRecord> = {}): RequestLogRecord {
  const base: RequestLogRecord = {
    requestId: 'req-' + Math.random().toString(36).slice(2, 8),
    timestamp: Date.now(),
    durationMs: 120,
    method: 'POST',
    urlPath: '/v1/messages',
    statusCode: 200,
    requestHeaders: { 'content-type': 'application/json' },
    requestBody: Buffer.from('{"hello":"world"}'),
    requestBodyTruncated: false,
    requestBodySize: 16,
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: Buffer.from('{"ok":true}'),
    responseBodyTruncated: false,
    responseBodySize: 11,
    isSse: false,
    errorMessage: null,
  };
  return { ...base, ...overrides };
}

describe('RequestLogStore', () => {
  let dbPath: string;
  let store: RequestLogStore;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `sentinel-reqlog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
    );
    store = new RequestLogStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const p = dbPath + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it('creates parent directory if it does not exist', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'reqlog-mk-'));
    const nestedPath = join(tmpDir, 'nested', 'deep', 'r.db');
    const nestedStore = new RequestLogStore(nestedPath);
    nestedStore.close();
    expect(existsSync(nestedPath)).toBe(true);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enqueue + flush persists a record and get() returns it', () => {
    const rec = makeRecord({ requestId: 'abc123' });
    store.enqueue(rec);
    store.flush();

    const detail = store.get('abc123');
    expect(detail).not.toBeNull();
    expect(detail!.requestId).toBe('abc123');
    expect(detail!.method).toBe('POST');
    expect(detail!.urlPath).toBe('/v1/messages');
    expect(detail!.statusCode).toBe(200);
    expect(detail!.isSse).toBe(false);
    expect(detail!.request.body).toBe('{"hello":"world"}');
    expect(detail!.request.headers).toEqual({ 'content-type': 'application/json' });
    expect(detail!.response).not.toBeNull();
    expect(detail!.response!.body).toBe('{"ok":true}');
  });

  it('get() returns null for unknown request id', () => {
    expect(store.get('does-not-exist')).toBeNull();
  });

  it('get() flushes pending queued records before reading', () => {
    const rec = makeRecord({ requestId: 'queued-read' });
    store.enqueue(rec);
    // No explicit flush — get() should drain the queue itself.
    const detail = store.get('queued-read');
    expect(detail).not.toBeNull();
    expect(detail!.requestId).toBe('queued-read');
  });

  it('enqueue is a no-op after close()', () => {
    store.close();
    store.enqueue(makeRecord({ requestId: 'after-close' }));
    const fresh = new RequestLogStore(dbPath);
    expect(fresh.get('after-close')).toBeNull();
    fresh.close();
  });

  it('close() is idempotent', () => {
    store.close();
    expect(() => store.close()).not.toThrow();
  });

  it('flush() is a no-op when queue is empty', () => {
    expect(() => store.flush()).not.toThrow();
  });

  it('flushTimer fires and commits queued rows automatically', async () => {
    vi.useFakeTimers();
    try {
      const fakeStore = new RequestLogStore(dbPath + '.timer');
      try {
        fakeStore.enqueue(makeRecord({ requestId: 'timer-1' }));
        // No immediate flush — timer is set for 100ms.
        vi.advanceTimersByTime(150);
        // After the timer fires, the row should be readable.
        const detail = fakeStore.get('timer-1');
        expect(detail).not.toBeNull();
      } finally {
        fakeStore.close();
        for (const suffix of ['', '-wal', '-shm']) {
          const p = dbPath + '.timer' + suffix;
          if (existsSync(p)) unlinkSync(p);
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('batches multiple enqueues into a single flush', () => {
    for (let i = 0; i < 5; i++) {
      store.enqueue(makeRecord({ requestId: `batch-${i}`, timestamp: Date.now() - i }));
    }
    store.flush();

    for (let i = 0; i < 5; i++) {
      expect(store.get(`batch-${i}`)).not.toBeNull();
    }
  });

  it('persists null bodies and null status/duration fields', () => {
    store.enqueue(
      makeRecord({
        requestId: 'nulls',
        statusCode: null,
        durationMs: null,
        requestBody: null,
        responseHeaders: null,
        responseBody: null,
        responseBodySize: null,
        errorMessage: 'upstream connection reset',
      }),
    );
    store.flush();

    const detail = store.get('nulls');
    expect(detail).not.toBeNull();
    expect(detail!.statusCode).toBeNull();
    expect(detail!.durationMs).toBeNull();
    expect(detail!.request.body).toBe('');
    expect(detail!.response).toBeNull();
    expect(detail!.errorMessage).toBe('upstream connection reset');
  });

  it('preserves truncation flags across the round trip', () => {
    store.enqueue(
      makeRecord({
        requestId: 'trunc',
        requestBodyTruncated: true,
        responseBodyTruncated: true,
        isSse: true,
      }),
    );
    store.flush();

    const detail = store.get('trunc');
    expect(detail!.request.bodyTruncated).toBe(true);
    expect(detail!.response!.bodyTruncated).toBe(true);
    expect(detail!.isSse).toBe(true);
  });

  it('rowToDetail returns empty headers object when JSON is malformed', () => {
    // Insert a row directly with garbage JSON in the headers column.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawDb = (store as any).db;
    rawDb
      .prepare(
        `INSERT INTO request_logs (
          request_id, timestamp, method, url_path, request_headers, request_body_size
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('bad-json', Date.now(), 'GET', '/v1/messages', 'not valid json', 0);

    const detail = store.get('bad-json');
    expect(detail).not.toBeNull();
    expect(detail!.request.headers).toEqual({});
  });

  it('response with a body but malformed headers falls back to empty headers and bodySize=0', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawDb = (store as any).db;
    // Row has a response body (so hasResponse is true) but response_headers
    // is malformed JSON (safeJsonParse returns null). Exercises the
    // `responseHeaders ?? {}` and `responseBodySize ?? 0` fallbacks.
    rawDb
      .prepare(
        `INSERT INTO request_logs (
          request_id, timestamp, method, url_path, request_headers, request_body_size,
          response_headers, response_body
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'bad-resp-headers',
        Date.now(),
        'POST',
        '/v1/messages',
        '{}',
        0,
        'not-json{',
        Buffer.from('ok'),
      );
    const detail = store.get('bad-resp-headers');
    expect(detail!.response).not.toBeNull();
    expect(detail!.response!.headers).toEqual({});
    expect(detail!.response!.bodySize).toBe(0);
  });

  it('response is considered present when only headers were stored', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawDb = (store as any).db;
    rawDb
      .prepare(
        `INSERT INTO request_logs (
          request_id, timestamp, method, url_path, request_headers, request_body_size,
          response_headers, response_body_size
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'headers-only',
        Date.now(),
        'POST',
        '/v1/messages',
        JSON.stringify({ 'x-req': 'y' }),
        0,
        JSON.stringify({ 'x-resp': 'z' }),
        0,
      );

    const detail = store.get('headers-only');
    expect(detail!.response).not.toBeNull();
    expect(detail!.response!.headers).toEqual({ 'x-resp': 'z' });
    expect(detail!.response!.body).toBe('');
  });

  it('decodes invalid UTF-8 sequences with replacement character', () => {
    const invalid = Buffer.from([0xff, 0xfe, 0xfd]);
    store.enqueue(makeRecord({ requestId: 'bad-utf8', requestBody: invalid }));
    store.flush();
    const detail = store.get('bad-utf8');
    expect(detail!.request.body).toContain('�');
  });

  it('purgeOlderThan deletes rows before the cutoff and returns count', () => {
    const oldTs = 1000;
    const newTs = 9_000_000_000;
    store.enqueue(makeRecord({ requestId: 'old-1', timestamp: oldTs }));
    store.enqueue(makeRecord({ requestId: 'old-2', timestamp: oldTs + 1 }));
    store.enqueue(makeRecord({ requestId: 'new-1', timestamp: newTs }));
    store.flush();

    const deleted = store.purgeOlderThan(oldTs + 100);
    expect(deleted).toBe(2);
    expect(store.get('old-1')).toBeNull();
    expect(store.get('old-2')).toBeNull();
    expect(store.get('new-1')).not.toBeNull();
  });

  it('purgeOlderThan returns 0 when no rows match and skips VACUUM', () => {
    store.enqueue(makeRecord({ requestId: 'stays', timestamp: 9_000_000_000 }));
    store.flush();

    const deleted = store.purgeOlderThan(1000);
    expect(deleted).toBe(0);
    expect(store.get('stays')).not.toBeNull();
  });

  it('clearAll deletes every row and drops queued records', () => {
    store.enqueue(makeRecord({ requestId: 'persisted' }));
    store.flush();
    store.enqueue(makeRecord({ requestId: 'queued-but-dropped' }));

    const deleted = store.clearAll();
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(store.get('persisted')).toBeNull();
    expect(store.get('queued-but-dropped')).toBeNull();
  });

  it('getSummaries returns metadata-only rows for the requested ids', () => {
    store.enqueue(
      makeRecord({
        requestId: 'sum-ok',
        statusCode: 200,
        durationMs: 1234,
        isSse: true,
        errorMessage: null,
      }),
    );
    store.enqueue(
      makeRecord({
        requestId: 'sum-err',
        statusCode: null,
        durationMs: null,
        isSse: false,
        errorMessage: 'upstream idle timeout: no data for 60s',
      }),
    );
    store.flush();

    const summaries = store.getSummaries(['sum-ok', 'sum-err', 'never-existed']);
    // Missing ids are silently omitted — only the two real rows return.
    expect(summaries).toHaveLength(2);
    const byId = Object.fromEntries(summaries.map((s) => [s.requestId, s]));

    expect(byId['sum-ok']!.method).toBe('POST');
    expect(byId['sum-ok']!.urlPath).toBe('/v1/messages');
    expect(byId['sum-ok']!.statusCode).toBe(200);
    expect(byId['sum-ok']!.durationMs).toBe(1234);
    expect(byId['sum-ok']!.isSse).toBe(true);
    expect(byId['sum-ok']!.errorMessage).toBeNull();

    expect(byId['sum-err']!.statusCode).toBeNull();
    expect(byId['sum-err']!.durationMs).toBeNull();
    expect(byId['sum-err']!.isSse).toBe(false);
    expect(byId['sum-err']!.errorMessage).toBe('upstream idle timeout: no data for 60s');

    // Crucial privacy property: summaries deliberately have no `request`,
    // `response`, or any headers field — bodies + headers must NEVER
    // auto-attach to a public GitHub issue URL.
    expect(Object.keys(byId['sum-ok']!).sort()).toEqual(
      [
        'durationMs',
        'errorMessage',
        'isSse',
        'method',
        'requestId',
        'statusCode',
        'urlPath',
      ].sort(),
    );
  });

  it('getSummaries returns an empty array when called with no ids (avoids a useless DB query)', () => {
    expect(store.getSummaries([])).toEqual([]);
  });

  it('getSummaries flushes pending queued rows so a same-tick call still sees them', () => {
    store.enqueue(makeRecord({ requestId: 'sum-queued', statusCode: 500 }));
    // No explicit flush — getSummaries must drain the queue itself.
    const out = store.getSummaries(['sum-queued']);
    expect(out).toHaveLength(1);
    expect(out[0]!.statusCode).toBe(500);
  });

  it('clearAll clears the flush timer when one is pending', () => {
    vi.useFakeTimers();
    try {
      const tmp = new RequestLogStore(dbPath + '.clear-timer');
      try {
        tmp.enqueue(makeRecord({ requestId: 'about-to-flush' }));
        // A flush timer is now scheduled.
        tmp.clearAll();
        vi.advanceTimersByTime(500);
        // The previously-queued record should not have resurfaced.
        expect(tmp.get('about-to-flush')).toBeNull();
      } finally {
        tmp.close();
        for (const suffix of ['', '-wal', '-shm']) {
          const p = dbPath + '.clear-timer' + suffix;
          if (existsSync(p)) unlinkSync(p);
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('redactHeaders', () => {
  it('redacts always-sensitive headers regardless of redactAuth flag', () => {
    const out = redactHeaders(
      {
        'x-api-key': 'sk-live-abc',
        'proxy-authorization': 'Basic xyz',
        cookie: 'session=1',
        'set-cookie': 'a=b; HttpOnly',
        'content-type': 'application/json',
      },
      false,
    );
    expect(out['x-api-key']).toBe('[REDACTED]');
    expect(out['proxy-authorization']).toBe('[REDACTED]');
    expect(out.cookie).toBe('[REDACTED]');
    expect(out['set-cookie']).toBe('[REDACTED]');
    expect(out['content-type']).toBe('application/json');
  });

  it('redacts authorization only when redactAuth is true', () => {
    const left = redactHeaders({ authorization: 'Bearer abc' }, false);
    expect(left.authorization).toBe('Bearer abc');
    const redacted = redactHeaders({ authorization: 'Bearer abc' }, true);
    expect(redacted.authorization).toBe('[REDACTED]');
  });

  it('redact is case-insensitive on header names', () => {
    const out = redactHeaders({ 'X-API-Key': 'sk-live', Authorization: 'Bearer t' }, true);
    expect(out['X-API-Key']).toBe('[REDACTED]');
    expect(out.Authorization).toBe('[REDACTED]');
  });

  it('joins array-valued headers with comma-space', () => {
    const out = redactHeaders({ 'set-cookie': ['a=1', 'b=2'] }, false);
    expect(out['set-cookie']).toBe('[REDACTED]');
    const out2 = redactHeaders({ 'x-multi': ['one', 'two'] }, false);
    expect(out2['x-multi']).toBe('one, two');
  });

  it('skips undefined header values entirely', () => {
    const out = redactHeaders({ 'x-present': 'yes', 'x-absent': undefined }, false);
    expect(out['x-present']).toBe('yes');
    expect(Object.prototype.hasOwnProperty.call(out, 'x-absent')).toBe(false);
  });
});

describe('singleton accessor', () => {
  const singletonPath = join(tmpdir(), `sentinel-reqlog-singleton-${Date.now()}.db`);

  afterEach(() => {
    closeRequestLogStore();
    for (const suffix of ['', '-wal', '-shm']) {
      const p = singletonPath + suffix;
      if (existsSync(p)) unlinkSync(p);
    }
  });

  it('getRequestLogStore returns the same instance across calls', () => {
    const a = getRequestLogStore(singletonPath);
    const b = getRequestLogStore(singletonPath);
    expect(a).toBe(b);
  });

  it('closeRequestLogStore resets the singleton so the next call constructs fresh', () => {
    const a = getRequestLogStore(singletonPath);
    closeRequestLogStore();
    const b = getRequestLogStore(singletonPath);
    expect(a).not.toBe(b);
  });

  it('closeRequestLogStore is a no-op when nothing was ever created', () => {
    // Ensure no active singleton before the call.
    closeRequestLogStore();
    expect(() => closeRequestLogStore()).not.toThrow();
  });
});
