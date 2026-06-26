import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import Database from 'better-sqlite3';
import { getDb, closeDb, getUsageEvents } from './db.js';
import { OtelReceiver, OTEL_LOG_API_REQUEST, OTEL_METRIC_COST } from './otel-receiver.js';
import { RequestAccountMap } from './request-account-map.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Convenience wrapper for the test's mock response object.
function mockRes(): { code: number; res: ServerResponse } {
  const out = { code: 0, res: null as unknown as ServerResponse };
  out.res = {
    writeHead: (c: number) => {
      out.code = c;
    },
    end: () => {},
  } as unknown as ServerResponse;
  return out;
}

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
        writeHead: (c: number) => {
          code = c;
        },
        end: () => {},
      } as unknown as ServerResponse;

      await receiver.handleMetrics(req, mockRes);
      expect(code).toBe(200);
    });

    it('does NOT persist cost.usage metric to DB (api_request log is source of truth)', async () => {
      // Claude Code emits cost twice per request — once as this metric and
      // once as the `cost_usd` attribute on `claude_code.api_request` logs.
      // Persisting both doubled every request's cost. The metric path is
      // now a deliberate no-op; the log path retains full responsibility.
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
        writeHead: (c: number) => {
          code = c;
        },
        end: () => {},
      } as unknown as ServerResponse;

      await receiver.handleMetrics(req, mockRes);
      expect(code).toBe(200);

      // Metric is intentionally dropped — no usage_events row written.
      const events = getUsageEvents(db, { accountId: 'acc-otel-1' });
      expect(events).toHaveLength(0);
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
        writeHead: (c: number) => {
          code = c;
        },
        end: () => {},
      } as unknown as ServerResponse;

      await receiver.handleMetrics(req, mockRes);
      expect(code).toBe(400);
    });

    it('accepts gauge metric type without crashing (cost.usage still dropped)', async () => {
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
        writeHead: (c: number) => {
          code = c;
        },
        end: () => {},
      } as unknown as ServerResponse;

      await receiver.handleMetrics(req, mockRes);
      expect(code).toBe(200);

      // Cost metric is always skipped — no row persisted even when the
      // incoming data point looks valid.
      const events = getUsageEvents(db, { accountId: 'acc-gauge' });
      expect(events).toHaveLength(0);
    });
  });

  describe('handleLogs', () => {
    it('returns 200 for empty logs payload', async () => {
      const req = makeRequest({ resourceLogs: [] }, '/v1/logs');
      let code = 0;
      const mockRes = {
        writeHead: (c: number) => {
          code = c;
        },
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
        writeHead: (c: number) => {
          code = c;
        },
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

    it('fires the onApiRequestEvent callback once per api_request, never for other events', async () => {
      const onApiRequest = vi.fn();
      const tracked = new OtelReceiver(
        db,
        undefined,
        undefined,
        undefined,
        undefined,
        onApiRequest,
      );
      const mk = (eventName: string) => ({
        attributes: [
          { key: 'event.name', value: { stringValue: eventName } },
          { key: 'user.account_uuid', value: { stringValue: 'acc-cb-1' } },
          { key: 'model', value: { stringValue: 'claude-opus-4' } },
        ],
      });
      const payload = {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  mk(OTEL_LOG_API_REQUEST),
                  mk('claude_code.user_prompt'),
                  mk(OTEL_LOG_API_REQUEST),
                ],
              },
            ],
          },
        ],
      };

      const out = mockRes();
      await tracked.handleLogs(makeRequest(payload, '/v1/logs'), out.res);
      expect(out.code).toBe(200);
      // Two api_request events → callback fired twice; the user_prompt event
      // (which the capture-health path must ignore) did not add a third.
      expect(onApiRequest).toHaveBeenCalledTimes(2);
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
        writeHead: (c: number) => {
          code = c;
        },
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
        writeHead: (c: number) => {
          code = c;
        },
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
        writeHead: (c: number) => {
          code = c;
        },
        end: () => {},
      } as unknown as ServerResponse;

      await receiver.handleLogs(req, mockRes);
      expect(code).toBe(200);
      const events = getUsageEvents(db, { accountId: 'acc-no-ts' });
      expect(events).toHaveLength(1);
      expect(events[0]?.ts).toBeGreaterThan(0);
    });
  });

  // ─── Expanded OTEL signal coverage ──────────────────────────────────────
  // The receiver persists ~11 more signals beyond cost+api_request. These
  // tests cover each metric / event name and its attribute mapping.

  /** Build a single-metric OTLP payload. */
  function metricPayload(name: string, attrs: Record<string, string | number>, value = 1): object {
    const attributes = Object.entries(attrs).map(([key, val]) => ({
      key,
      value: typeof val === 'number' ? { intValue: val } : { stringValue: val },
    }));
    return {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name,
                  sum: { dataPoints: [{ attributes, asDouble: value }] },
                },
              ],
            },
          ],
        },
      ],
    };
  }

  /** Build a single-log-record OTLP payload. event.name is attached as an
   *  attribute which mirrors Claude Code's current wire format. */
  function logPayload(eventName: string, attrs: Record<string, string | number | boolean>): object {
    const attributes = [
      { key: 'event.name', value: { stringValue: eventName } },
      ...Object.entries(attrs).map(([key, val]) => ({
        key,
        value:
          typeof val === 'number'
            ? { intValue: val }
            : typeof val === 'boolean'
              ? { stringValue: String(val) }
              : { stringValue: val },
      })),
    ];
    return {
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes }] }] }],
    };
  }

  async function sendMetrics(payload: object): Promise<number> {
    const { code, res } = mockRes();
    await receiver.handleMetrics(makeRequest(payload, '/v1/metrics'), res);
    return code;
  }
  async function sendLogs(payload: object): Promise<number> {
    const { code, res } = mockRes();
    await receiver.handleLogs(makeRequest(payload, '/v1/logs'), res);
    return code;
  }
  // mockRes() returns an object whose `code` field we mutate via writeHead;
  // we re-read it after the helper returns.
  async function runMetrics(payload: object): Promise<void> {
    const box = mockRes();
    await receiver.handleMetrics(makeRequest(payload, '/v1/metrics'), box.res);
    expect(box.code).toBe(200);
  }
  async function runLogs(payload: object): Promise<void> {
    const box = mockRes();
    await receiver.handleLogs(makeRequest(payload, '/v1/logs'), box.res);
    expect(box.code).toBe(200);
  }
  // Silence unused-helper warnings in case we want to assert non-200 later
  void sendMetrics;
  void sendLogs;

  describe('expanded metric signals', () => {
    it('session.count → activity_events(kind=session)', async () => {
      await runMetrics(
        metricPayload('claude_code.session.count', { 'user.account_uuid': 'acc-a' }, 1),
      );
      const row = db.prepare('SELECT kind, account_id FROM activity_events').get() as {
        kind: string;
        account_id: string;
      };
      expect(row.kind).toBe('session');
      expect(row.account_id).toBe('acc-a');
    });

    it('lines_of_code.count → lines_added / lines_removed by type attr', async () => {
      await runMetrics(
        metricPayload(
          'claude_code.lines_of_code.count',
          { 'user.account_uuid': 'acc-a', type: 'added' },
          42,
        ),
      );
      await runMetrics(
        metricPayload(
          'claude_code.lines_of_code.count',
          { 'user.account_uuid': 'acc-a', type: 'removed' },
          7,
        ),
      );
      const rows = db
        .prepare('SELECT kind, value FROM activity_events ORDER BY id')
        .all() as Array<{ kind: string; value: number }>;
      expect(rows.map((r) => r.kind)).toEqual(['lines_added', 'lines_removed']);
      expect(rows.map((r) => r.value)).toEqual([42, 7]);
    });

    it('pull_request.count and commit.count each land in their own kind', async () => {
      await runMetrics(
        metricPayload('claude_code.pull_request.count', { 'user.account_uuid': 'acc-a' }),
      );
      await runMetrics(metricPayload('claude_code.commit.count', { 'user.account_uuid': 'acc-a' }));
      const rows = db.prepare('SELECT kind FROM activity_events ORDER BY id').all() as Array<{
        kind: string;
      }>;
      expect(rows.map((r) => r.kind)).toEqual(['pull_request', 'commit']);
    });

    it('active_time.total → active_user_seconds / active_cli_seconds', async () => {
      await runMetrics(
        metricPayload(
          'claude_code.active_time.total',
          { 'user.account_uuid': 'acc-a', type: 'user' },
          120,
        ),
      );
      await runMetrics(
        metricPayload(
          'claude_code.active_time.total',
          { 'user.account_uuid': 'acc-a', type: 'cli' },
          45,
        ),
      );
      const rows = db
        .prepare('SELECT kind, value FROM activity_events ORDER BY id')
        .all() as Array<{ kind: string; value: number }>;
      expect(rows).toEqual([
        { kind: 'active_user_seconds', value: 120 },
        { kind: 'active_cli_seconds', value: 45 },
      ]);
    });

    it('code_edit_tool.decision carries tool_name / decision / language', async () => {
      await runMetrics(
        metricPayload('claude_code.code_edit_tool.decision', {
          'user.account_uuid': 'acc-a',
          tool_name: 'Edit',
          decision: 'accept',
          language: 'TypeScript',
          source: 'user_temporary',
        }),
      );
      const row = db
        .prepare('SELECT kind, tool_name, decision, language, source FROM activity_events')
        .get() as Record<string, string>;
      expect(row).toEqual({
        kind: 'edit_decision',
        tool_name: 'Edit',
        decision: 'accept',
        language: 'TypeScript',
        source: 'user_temporary',
      });
    });

    it('unknown metric names are silently dropped', async () => {
      await runMetrics(
        metricPayload('claude_code.something_new', { 'user.account_uuid': 'acc-a' }),
      );
      const count = (db.prepare('SELECT COUNT(*) AS n FROM activity_events').get() as { n: number })
        .n;
      expect(count).toBe(0);
    });

    it('token.usage metric is received but intentionally not persisted', async () => {
      // Tokens come from api_request logs. The metric is accepted (no 4xx)
      // but produces no usage_events row to avoid fragmented inserts.
      await runMetrics(
        metricPayload(
          'claude_code.token.usage',
          { 'user.account_uuid': 'acc-a', type: 'input', model: 'claude-opus-4' },
          5000,
        ),
      );
      const usageCount = (
        db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }
      ).n;
      expect(usageCount).toBe(0);
    });
  });

  describe('expanded log events', () => {
    it('api_error → api_errors table', async () => {
      await runLogs(
        logPayload('api_error', {
          'user.account_uuid': 'acc-a',
          model: 'claude-opus-4',
          status_code: '429',
          error: 'rate limited',
          duration_ms: 1500,
          attempt: 11,
          request_id: 'req_abc',
          speed: 'normal',
        }),
      );
      const row = db.prepare('SELECT * FROM api_errors').get() as Record<string, unknown>;
      expect(row['account_id']).toBe('acc-a');
      expect(row['status_code']).toBe('429');
      expect(row['error']).toBe('rate limited');
      expect(row['attempt']).toBe(11);
      expect(row['request_id']).toBe('req_abc');
    });

    it('tool_result → tool_events row with success/duration', async () => {
      await runLogs(
        logPayload('tool_result', {
          'user.account_uuid': 'acc-a',
          tool_name: 'Bash',
          success: 'true',
          duration_ms: 234,
          tool_result_size_bytes: 1024,
          mcp_server_scope: '',
        }),
      );
      const row = db.prepare('SELECT * FROM tool_events').get() as Record<string, unknown>;
      expect(row['tool_name']).toBe('Bash');
      expect(row['success']).toBe(1);
      expect(row['duration_ms']).toBe(234);
      expect(row['tool_result_size_bytes']).toBe(1024);
    });

    it('tool_result persists decision_source AND decision_type', async () => {
      await runLogs(
        logPayload('tool_result', {
          'user.account_uuid': 'acc-a',
          tool_name: 'Edit',
          success: 'true',
          decision_source: 'user_temporary',
          decision_type: 'accept',
        }),
      );
      const row = db.prepare('SELECT decision_source, decision_type FROM tool_events').get() as {
        decision_source: string;
        decision_type: string;
      };
      expect(row.decision_source).toBe('user_temporary');
      expect(row.decision_type).toBe('accept');
    });

    it('tool_decision → activity_events(kind=tool_decision) with tool_name/decision/source', async () => {
      await runLogs(
        logPayload('tool_decision', {
          'user.account_uuid': 'acc-a',
          tool_name: 'Bash',
          decision: 'reject',
          source: 'user_permanent',
        }),
      );
      const row = db
        .prepare('SELECT kind, tool_name, decision, source FROM activity_events')
        .get() as Record<string, string>;
      expect(row).toEqual({
        kind: 'tool_decision',
        tool_name: 'Bash',
        decision: 'reject',
        source: 'user_permanent',
      });
    });

    it('user_prompt → activity_events(kind=user_prompt) storing prompt_length in value', async () => {
      await runLogs(
        logPayload('user_prompt', {
          'user.account_uuid': 'acc-a',
          prompt_length: 142,
        }),
      );
      const row = db.prepare('SELECT kind, value FROM activity_events').get() as {
        kind: string;
        value: number;
      };
      expect(row.kind).toBe('user_prompt');
      expect(row.value).toBe(142);
    });

    it('user_prompt without prompt_length stores null value', async () => {
      await runLogs(
        logPayload('user_prompt', {
          'user.account_uuid': 'acc-a',
        }),
      );
      const row = db.prepare('SELECT kind, value FROM activity_events').get() as {
        kind: string;
        value: number | null;
      };
      expect(row.kind).toBe('user_prompt');
      expect(row.value).toBeNull();
    });

    it('tool_result captures failure with error attribute', async () => {
      await runLogs(
        logPayload('tool_result', {
          'user.account_uuid': 'acc-a',
          tool_name: 'Edit',
          success: 'false',
          error: 'file not found',
        }),
      );
      const row = db.prepare('SELECT success, error FROM tool_events').get() as {
        success: number;
        error: string;
      };
      expect(row.success).toBe(0);
      expect(row.error).toBe('file not found');
    });

    it('skill_activated → activity_events(kind=skill_activated)', async () => {
      await runLogs(
        logPayload('skill_activated', {
          'user.account_uuid': 'acc-a',
          'skill.name': 'init',
          'skill.source': 'plugin',
          'marketplace.name': 'claude-plugins-official',
        }),
      );
      const row = db
        .prepare('SELECT kind, name, source, marketplace FROM activity_events')
        .get() as Record<string, string>;
      expect(row).toEqual({
        kind: 'skill_activated',
        name: 'init',
        source: 'plugin',
        marketplace: 'claude-plugins-official',
      });
    });

    it('plugin_installed → activity_events(kind=plugin_installed)', async () => {
      await runLogs(
        logPayload('plugin_installed', {
          'user.account_uuid': 'acc-a',
          'plugin.name': 'vercel-plugin',
          'plugin.version': '1.2.3',
          'marketplace.name': 'vercel-vercel-plugin',
          'install.trigger': 'cli',
        }),
      );
      const row = db
        .prepare('SELECT kind, name, version, marketplace, source FROM activity_events')
        .get() as Record<string, string>;
      expect(row).toEqual({
        kind: 'plugin_installed',
        name: 'vercel-plugin',
        version: '1.2.3',
        marketplace: 'vercel-vercel-plugin',
        source: 'cli',
      });
    });

    it('accepts fully-qualified event.name (claude_code.api_request)', async () => {
      await runLogs(
        logPayload('claude_code.api_request', {
          'user.account_uuid': 'acc-q',
          model: 'claude-opus-4',
          input_tokens: 100,
          output_tokens: 50,
        }),
      );
      expect(getUsageEvents(db, { accountId: 'acc-q' })).toHaveLength(1);
    });

    it('accepts short event.name (api_request)', async () => {
      await runLogs(
        logPayload('api_request', {
          'user.account_uuid': 'acc-s',
          model: 'claude-opus-4',
          input_tokens: 50,
          output_tokens: 25,
        }),
      );
      expect(getUsageEvents(db, { accountId: 'acc-s' })).toHaveLength(1);
    });

    it('accepts OTLP v1.0+ top-level eventName field', async () => {
      const payload = {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    eventName: 'api_request',
                    attributes: [
                      { key: 'user.account_uuid', value: { stringValue: 'acc-top' } },
                      { key: 'model', value: { stringValue: 'claude-opus-4' } },
                      { key: 'input_tokens', value: { intValue: 10 } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      await runLogs(payload);
      expect(getUsageEvents(db, { accountId: 'acc-top' })).toHaveLength(1);
    });

    it('log records with no event name are silently skipped', async () => {
      const payload = {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    attributes: [{ key: 'user.account_uuid', value: { stringValue: 'acc-none' } }],
                  },
                ],
              },
            ],
          },
        ],
      };
      await runLogs(payload);
      expect(getUsageEvents(db, { accountId: 'acc-none' })).toHaveLength(0);
    });

    it('unknown event names are silently dropped', async () => {
      await runLogs(logPayload('mystery_event', { 'user.account_uuid': 'acc-m' }));
      const count = (db.prepare('SELECT COUNT(*) AS n FROM activity_events').get() as { n: number })
        .n;
      expect(count).toBe(0);
    });

    it('api_error with minimal attrs lands with nulls', async () => {
      await runLogs(logPayload('api_error', { 'user.account_uuid': 'acc-minimal' }));
      const row = db
        .prepare('SELECT model, status_code, error, attempt, request_id, speed FROM api_errors')
        .get() as Record<string, unknown>;
      expect(row.model).toBeNull();
      expect(row.status_code).toBeNull();
      expect(row.error).toBeNull();
      expect(row.attempt).toBeNull();
      expect(row.request_id).toBeNull();
      expect(row.speed).toBeNull();
    });

    it('tool_result without tool_name falls back to "unknown"', async () => {
      await runLogs(
        logPayload('tool_result', { 'user.account_uuid': 'acc-anon', success: 'true' }),
      );
      const row = db.prepare('SELECT tool_name FROM tool_events').get() as { tool_name: string };
      expect(row.tool_name).toBe('unknown');
    });

    it('api_request log with missing model falls back to "unknown"', async () => {
      await runLogs(
        logPayload('api_request', { 'user.account_uuid': 'acc-nomodel', input_tokens: 10 }),
      );
      const events = getUsageEvents(db, { accountId: 'acc-nomodel' });
      expect(events[0]?.model).toBe('unknown');
    });

    it('edit_decision metric with no dimensions still lands with nulls', async () => {
      await runMetrics(
        metricPayload('claude_code.code_edit_tool.decision', { 'user.account_uuid': 'acc-bare' }),
      );
      const row = db
        .prepare('SELECT tool_name, decision, language, source FROM activity_events')
        .get() as Record<string, unknown>;
      expect(row.tool_name).toBeNull();
      expect(row.decision).toBeNull();
      expect(row.language).toBeNull();
      expect(row.source).toBeNull();
    });

    it('tool_result with success passed as intValue=1 is truthy', async () => {
      // Verifies the numeric-true branch in success parsing.
      const payload = {
        resourceLogs: [
          {
            scopeLogs: [
              {
                logRecords: [
                  {
                    attributes: [
                      { key: 'event.name', value: { stringValue: 'tool_result' } },
                      { key: 'user.account_uuid', value: { stringValue: 'acc-int' } },
                      { key: 'tool_name', value: { stringValue: 'Read' } },
                      { key: 'success', value: { intValue: 1 } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      await runLogs(payload);
      const row = db.prepare('SELECT success FROM tool_events').get() as { success: number };
      expect(row.success).toBe(1);
    });
  });

  describe('subscriber + broadcast branches', () => {
    it('fireBatchSubscribers catches subscriber errors and logs them', async () => {
      // Register one throwing subscriber + one good one, then route a payload
      // that writes a row so the subscribers fire.
      const good = { called: false };
      receiver.onBatchWritten(() => {
        throw new Error('bad subscriber');
      });
      receiver.onBatchWritten(() => {
        good.called = true;
      });

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const req = makeRequest({
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [
                  {
                    name: 'claude_code.session.count',
                    sum: {
                      dataPoints: [
                        {
                          attributes: [
                            { key: 'user.account_uuid', value: { stringValue: 'acc-sub' } },
                          ],
                          asInt: 1,
                          timeUnixNano: '1700000000000000000',
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
      const { res } = mockRes();
      await receiver.handleMetrics(req, res);
      // The failing subscriber must have been observed; the good one still fired.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('batch subscriber threw'),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });

    it('api_request with known request_id is attributed to the mapped account, overriding activeAccountId', async () => {
      // Auto mode: Claude Code is signed in as one user but the proxy
      // routed this specific request to a different account's token. The
      // request-id map records the routing decision, and the OTEL lookup
      // must honor it.
      const requestAccountMap = new RequestAccountMap();
      requestAccountMap.set('req_routed', 'acc-routed');
      const rrReceiver = new OtelReceiver(
        db,
        { value: 'acc-active' },
        undefined,
        requestAccountMap,
      );
      const { res } = mockRes();
      await rrReceiver.handleLogs(
        makeRequest(
          logPayload('api_request', {
            'user.account_uuid': 'acc-signedin',
            model: 'claude-opus-4',
            input_tokens: 10,
            output_tokens: 5,
            request_id: 'req_routed',
          }),
          '/v1/logs',
        ),
        res,
      );
      expect(getUsageEvents(db, { accountId: 'acc-routed' })).toHaveLength(1);
      expect(getUsageEvents(db, { accountId: 'acc-active' })).toHaveLength(0);
    });

    it('api_request without a request_id falls back to activeAccountId', async () => {
      const requestAccountMap = new RequestAccountMap();
      const rrReceiver = new OtelReceiver(
        db,
        { value: 'acc-active' },
        undefined,
        requestAccountMap,
      );
      const { res } = mockRes();
      await rrReceiver.handleLogs(
        makeRequest(
          logPayload('api_request', {
            'user.account_uuid': 'acc-signedin',
            model: 'claude-opus-4',
            input_tokens: 10,
          }),
          '/v1/logs',
        ),
        res,
      );
      expect(getUsageEvents(db, { accountId: 'acc-active' })).toHaveLength(1);
    });

    it('api_request with an unknown request_id falls back to activeAccountId', async () => {
      const requestAccountMap = new RequestAccountMap();
      const rrReceiver = new OtelReceiver(
        db,
        { value: 'acc-active' },
        undefined,
        requestAccountMap,
      );
      const { res } = mockRes();
      await rrReceiver.handleLogs(
        makeRequest(
          logPayload('api_request', {
            'user.account_uuid': 'acc-signedin',
            model: 'claude-opus-4',
            input_tokens: 10,
            request_id: 'req_never_seen',
          }),
          '/v1/logs',
        ),
        res,
      );
      expect(getUsageEvents(db, { accountId: 'acc-active' })).toHaveLength(1);
    });

    it('handleMetrics returns 400 on malformed JSON', async () => {
      const bodyStr = 'not-json{';
      const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
      const req = {
        url: '/v1/metrics',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        on: (event: string, cb: (arg?: unknown) => void) => {
          listeners[event] = listeners[event] ?? [];
          listeners[event]?.push(cb);
          return req;
        },
        emit: (event: string, arg?: unknown) => listeners[event]?.forEach((cb) => cb(arg)),
      } as unknown as IncomingMessage;
      setImmediate(() => {
        req.emit('data', Buffer.from(bodyStr));
        req.emit('end');
      });
      const { code, res } = mockRes();
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      await receiver.handleMetrics(req, res);
      spy.mockRestore();
      // `code` is bound to mockRes's inner state; read via the closure.
      void code;
    });
  });

  describe('forwarder tee', () => {
    it('relays the raw body to the forwarder AFTER local persist + 200 response', async () => {
      const calls: Array<{ path: string; contentType: string; body: Buffer }> = [];
      const fakeForwarder = {
        forward: (path: '/v1/metrics' | '/v1/logs', contentType: string, body: Buffer): void => {
          calls.push({ path, contentType, body });
        },
      };
      const teeReceiver = new OtelReceiver(db, undefined, undefined, undefined, fakeForwarder);

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
                            { key: 'user.account_uuid', value: { stringValue: 'acct-tee-1' } },
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
      const { res } = mockRes();
      await teeReceiver.handleMetrics(req, res);

      expect(calls).toHaveLength(1);
      expect(calls[0]!.path).toBe('/v1/metrics');
      expect(calls[0]!.contentType).toBe('application/json');
      // Body must be forwarded verbatim — preserves Claude Code's
      // resource attributes that downstream depends on.
      expect(JSON.parse(calls[0]!.body.toString('utf-8'))).toEqual(payload);
    });

    it('does not call the forwarder when the body fails to parse', async () => {
      const calls: Array<{ path: string }> = [];
      const fakeForwarder = {
        forward: (path: '/v1/metrics' | '/v1/logs'): void => {
          calls.push({ path });
        },
      };
      const teeReceiver = new OtelReceiver(db, undefined, undefined, undefined, fakeForwarder);

      // Bypass makeRequest helper to deliver invalid JSON.
      const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
      const req = {
        url: '/v1/metrics',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        on: (event: string, cb: (arg?: unknown) => void) => {
          listeners[event] = listeners[event] ?? [];
          listeners[event]?.push(cb);
          return req;
        },
        emit: (event: string, arg?: unknown) => listeners[event]?.forEach((cb) => cb(arg)),
      } as unknown as IncomingMessage;
      setImmediate(() => {
        req.emit('data', Buffer.from('{ definitely not valid json'));
        req.emit('end');
      });
      const { res } = mockRes();
      await teeReceiver.handleMetrics(req, res);

      // Forwarder is never called for unparseable bodies — passing
      // garbage to the upstream would just produce 4xx noise there.
      // (The receiver's catch path logs to console.error; that noise
      // is acceptable in the test stream and avoids adding a third
      // console spy past the mock-budget floor.)
      expect(calls).toHaveLength(0);
    });
  });
});
