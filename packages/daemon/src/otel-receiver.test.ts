import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import Database from 'better-sqlite3';
import { getDb, closeDb, getUsageEvents } from './db.js';
import { OtelReceiver, OTEL_LOG_API_REQUEST, OTEL_METRIC_COST } from './otel-receiver.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TEST_DB = join(tmpdir(), `otel-test-${Date.now()}.db`);

function makeRequest(body: object, url: string = '/v1/metrics'): IncomingMessage {
  const bodyStr = JSON.stringify(body);
  const listeners: Record<string, Array<(arg?: unknown) => void>> = {};

  const req = {
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    on: (event: string, cb: (arg?: unknown) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event]?.push(cb);
      return req;
    },
    // Simulate immediate data + end
    emit: (event: string, arg?: unknown) => {
      listeners[event]?.forEach((cb) => cb(arg));
    },
  } as unknown as IncomingMessage;

  // Schedule data emission
  setImmediate(() => {
    req.emit('data', Buffer.from(bodyStr));
    req.emit('end');
  });

  return req;
}

describe('OtelReceiver', () => {
  let db: Database.Database;
  let receiver: OtelReceiver;

  beforeEach(() => {
    db = getDb(TEST_DB);
    receiver = new OtelReceiver(db);
  });

  afterEach(() => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  describe('handleMetrics', () => {
    it('returns 200 for empty metrics payload', async () => {
      const req = makeRequest({ resourceMetrics: [] });
      let code = 200;
      const mockRes = {
        writeHead: (c: number) => { code = c; },
        end: () => {},
      } as unknown as ServerResponse;

      await receiver.handleMetrics(req, mockRes);
      expect(code).toBe(200);
    });

    it('persists cost usage metric to DB', async () => {
      const payload = {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: OTEL_METRIC_COST,
                    sum: {
                      dataPoints: [
                        {
                          attributes: [
                            { key: 'user.account_uuid', value: { stringValue: 'acc-otel-1' } },
                            { key: 'model', value: { stringValue: 'claude-sonnet-4-6' } },
                            { key: 'session.id', value: { stringValue: 'sess-otel-1' } },
                          ],
                          asDouble: 0.05,
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      const req = makeRequest(payload);
      let code = 0;
      const mockRes = {
        writeHead: (c: number) => { code = c; },
        end: () => {},
      } as unknown as ServerResponse;

      await receiver.handleMetrics(req, mockRes);
      expect(code).toBe(200);

      const events = getUsageEvents(db, { accountId: 'acc-otel-1' });
      expect(events).toHaveLength(1);
      expect(events[0]?.model).toBe('claude-sonnet-4-6');
      expect(events[0]?.costUsd).toBe(0.05);
    });

    it('returns 400 for invalid JSON', async () => {
      const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
      const req = {
        url: '/v1/metrics',
        on: (event: string, cb: (arg?: unknown) => void) => {
          listeners[event] = listeners[event] ?? [];
          listeners[event]?.push(cb);
          return req;
        },
      } as unknown as IncomingMessage;

      setImmediate(() => {
        listeners['data']?.forEach((cb) => cb(Buffer.from('not-json')));
        listeners['end']?.forEach((cb) => cb());
      });

      let code = 200;
      const mockRes = {
        writeHead: (c: number) => { code = c; },
        end: () => {},
      } as unknown as ServerResponse;

      await receiver.handleMetrics(req, mockRes);
      expect(code).toBe(400);
    });

    it('handles gauge metric type', async () => {
      const payload = {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: OTEL_METRIC_COST,
                    gauge: {
                      dataPoints: [
                        {
                          attributes: [
                            { key: 'user.account_uuid', value: { stringValue: 'acc-gauge' } },
                            { key: 'model', value: { stringValue: 'claude-haiku-4-5' } },
                          ],
                          asDouble: 0.001,
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      const req = makeRequest(payload);
      let code = 0;
      const mockRes = {
        writeHead: (c: number) => { code = c; },
        end: () => {},
      } as unknown as ServerResponse;

      await receiver.handleMetrics(req, mockRes);
      expect(code).toBe(200);

      const events = getUsageEvents(db, { accountId: 'acc-gauge' });
      expect(events).toHaveLength(1);
    });
  });

  describe('handleLogs', () => {
    it('returns 200 for empty logs payload', async () => {
      const req = makeRequest({ resourceLogs: [] }, '/v1/logs');
      let code = 0;
      const mockRes = {
        writeHead: (c: number) => { code = c; },
        end: () => {},
      } as unknown as ServerResponse;

      await receiver.handleLogs(req, mockRes);
      expect(code).toBe(200);
    });

    it('persists api_request log events to DB', async () => {
      const now = BigInt(Date.now()) * BigInt(1_000_000);
      const payload = {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    timeUnixNano: now.toString(),
                    attributes: [
                      { key: 'event.name', value: { stringValue: OTEL_LOG_API_REQUEST } },
                      { key: 'user.account_uuid', value: { stringValue: 'acc-log-1' } },
                      { key: 'model', value: { stringValue: 'claude-opus-4' } },
                      { key: 'session.id', value: { stringValue: 'sess-log-1' } },
                      { key: 'cost_usd', value: { doubleValue: 0.12 } },
                      { key: 'input_tokens', value: { intValue: 5000 } },
                      { key: 'output_tokens', value: { intValue: 2000 } },
                      { key: 'duration_ms', value: { intValue: 3200 } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const req = makeRequest(payload, '/v1/logs');
      let code = 0;
      const mockRes = {
        writeHead: (c: number) => { code = c; },
        end: () => {},
      } as unknown as ServerResponse;

      await receiver.handleLogs(req, mockRes);
      expect(code).toBe(200);

      const events = getUsageEvents(db, { accountId: 'acc-log-1' });
      expect(events).toHaveLength(1);
      expect(events[0]?.costUsd).toBe(0.12);
      expect(events[0]?.inputTokens).toBe(5000);
      expect(events[0]?.outputTokens).toBe(2000);
      expect(events[0]?.durationMs).toBe(3200);
    });

    it('ignores non-api_request log events', async () => {
      const payload = {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    attributes: [
                      { key: 'event.name', value: { stringValue: 'claude_code.user_prompt' } },
                      { key: 'user.account_uuid', value: { stringValue: 'acc-skip' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const req = makeRequest(payload, '/v1/logs');
      let code = 0;
      const mockRes = {
        writeHead: (c: number) => { code = c; },
        end: () => {},
      } as unknown as ServerResponse;

      await receiver.handleLogs(req, mockRes);
      expect(code).toBe(200);
      expect(getUsageEvents(db, { accountId: 'acc-skip' })).toHaveLength(0);
    });

    it('returns 400 for invalid JSON in handleLogs', async () => {
      const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
      const req = {
        url: '/v1/logs',
        on: (event: string, cb: (arg?: unknown) => void) => {
          listeners[event] = listeners[event] ?? [];
          listeners[event]?.push(cb);
          return req;
        },
      } as unknown as IncomingMessage;

      setImmediate(() => {
        listeners['data']?.forEach((cb) => cb(Buffer.from('not-valid-json')));
        listeners['end']?.forEach((cb) => cb());
      });

      let code = 200;
      const mockRes = {
        writeHead: (c: number) => { code = c; },
        end: () => {},
      } as unknown as ServerResponse;

      await receiver.handleLogs(req, mockRes);
      expect(code).toBe(400);
    });

    it('handles missing timeUnixNano gracefully', async () => {
      const payload = {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    // no timeUnixNano — should default to Date.now()
                    attributes: [
                      { key: 'event.name', value: { stringValue: OTEL_LOG_API_REQUEST } },
                      { key: 'user.account_uuid', value: { stringValue: 'acc-no-ts' } },
                      { key: 'model', value: { stringValue: 'claude-sonnet-4-6' } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };

      const req = makeRequest(payload, '/v1/logs');
      let code = 0;
      const mockRes = {
        writeHead: (c: number) => { code = c; },
        end: () => {},
      } as unknown as ServerResponse;

      await receiver.handleLogs(req, mockRes);
      expect(code).toBe(200);
      const events = getUsageEvents(db, { accountId: 'acc-no-ts' });
      expect(events).toHaveLength(1);
      expect(events[0]?.ts).toBeGreaterThan(0);
    });
  });
});
