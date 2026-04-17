import type { IncomingMessage, ServerResponse } from 'http';
import type { Database } from 'better-sqlite3';
import {
  insertUsageEvent,
  insertToolEvent,
  insertApiError,
  insertActivityEvent,
} from './db.js';
import type { ActiveAccountId } from './proxy.js';

/**
 * Known Claude Code OTEL metric names. Full list:
 *   https://code.claude.com/docs/en/monitoring-usage
 */
const METRIC_COST = 'claude_code.cost.usage';
const METRIC_TOKENS = 'claude_code.token.usage';
const METRIC_SESSION = 'claude_code.session.count';
const METRIC_LINES = 'claude_code.lines_of_code.count';
const METRIC_PR = 'claude_code.pull_request.count';
const METRIC_COMMIT = 'claude_code.commit.count';
const METRIC_EDIT_DECISION = 'claude_code.code_edit_tool.decision';
const METRIC_ACTIVE_TIME = 'claude_code.active_time.total';

/**
 * Known Claude Code OTEL log-event names. The `event.name` attribute on the
 * log record may carry either the fully-qualified name (`claude_code.api_request`)
 * or the short form (`api_request`) depending on the SDK version — normalize
 * before matching (see normalizeEventName below).
 */
const EVENT_API_REQUEST = 'api_request';
const EVENT_API_ERROR = 'api_error';
const EVENT_TOOL_RESULT = 'tool_result';
const EVENT_SKILL_ACTIVATED = 'skill_activated';
const EVENT_PLUGIN_INSTALLED = 'plugin_installed';

// Back-compat re-export: tests import this by name.
export const OTEL_METRIC_COST = METRIC_COST;
export const OTEL_METRIC_TOKENS = METRIC_TOKENS;
export const OTEL_METRIC_SESSION = METRIC_SESSION;
export const OTEL_LOG_API_REQUEST = EVENT_API_REQUEST;

interface OtelAttributes {
  [key: string]: string | number | boolean | null | undefined;
}

interface OtelNumberDataPoint {
  attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: number; doubleValue?: number } }>;
  timeUnixNano?: string;
  asDouble?: number;
  asInt?: number;
}

interface OtelMetric {
  name: string;
  sum?: { dataPoints: OtelNumberDataPoint[] };
  gauge?: { dataPoints: OtelNumberDataPoint[] };
}

interface OtelScopeMetric {
  metrics: OtelMetric[];
}

interface OtelResourceMetric {
  scopeMetrics: OtelScopeMetric[];
}

interface OtelMetricsBody {
  resourceMetrics?: OtelResourceMetric[];
}

interface OtelLogRecord {
  timeUnixNano?: string;
  /** OTLP v1.0+ top-level event name. Some SDKs also mirror this in
   *  the `event.name` attribute — handleLogs checks both. */
  eventName?: string;
  body?: { stringValue?: string };
  attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: number; doubleValue?: number } }>;
}

interface OtelScopeLog {
  logRecords: OtelLogRecord[];
}

interface OtelResourceLog {
  scopeLogs: OtelScopeLog[];
}

interface OtelLogsBody {
  resourceLogs?: OtelResourceLog[];
}

/** Strip the `claude_code.` prefix if present so short-form and long-form
 *  names both match a single switch. */
function normalizeEventName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  return name.startsWith('claude_code.') ? name.slice('claude_code.'.length) : name;
}

/**
 * Parse a flat attribute list from OTLP JSON format into a plain object.
 */
function parseAttributes(
  attrs?: Array<{ key: string; value: { stringValue?: string; intValue?: number; doubleValue?: number } }>,
): OtelAttributes {
  /* v8 ignore next 1 */
  if (!attrs) return {};
  const result: OtelAttributes = {};
  for (const attr of attrs) {
    const v = attr.value;
    if (v.stringValue !== undefined) {
      result[attr.key] = v.stringValue;
    } else if (v.intValue !== undefined) {
      result[attr.key] = v.intValue;
    } else if (v.doubleValue !== undefined) {
      result[attr.key] = v.doubleValue;
    }
  }
  return result;
}

/**
 * Collect and buffer raw request body.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * OTLP HTTP receiver — handles /v1/metrics and /v1/logs from Claude Code.
 *
 * Persists a curated subset of what Claude Code emits:
 *
 *   Metrics → usage_events + activity_events
 *     • claude_code.cost.usage        → usage_events.cost_usd
 *     • claude_code.token.usage       → fallback into usage_events.*_tokens
 *     • claude_code.session.count     → activity_events(kind='session')
 *     • claude_code.lines_of_code.count → activity_events(kind='lines_added'|'lines_removed')
 *     • claude_code.pull_request.count  → activity_events(kind='pull_request')
 *     • claude_code.commit.count        → activity_events(kind='commit')
 *     • claude_code.active_time.total   → activity_events(kind='active_user_seconds'|'active_cli_seconds')
 *     • claude_code.code_edit_tool.decision → activity_events(kind='edit_decision')
 *
 *   Logs → usage_events / tool_events / api_errors / activity_events
 *     • api_request        → usage_events (full token breakdown)
 *     • api_error          → api_errors
 *     • tool_result        → tool_events
 *     • skill_activated    → activity_events(kind='skill_activated')
 *     • plugin_installed   → activity_events(kind='plugin_installed')
 *
 * Any other metric/event name is silently dropped (with a debug log) so
 * future Claude Code signals surface as "known unknowns".
 */
export class OtelReceiver {
  constructor(
    private readonly db: Database,
    /** When set, new events are attributed to the currently active sentinel key
     *  rather than the raw `user.account_uuid` from OTEL attributes. This allows
     *  per-org usage tracking when the same Anthropic user belongs to multiple orgs. */
    private readonly activeAccountId?: ActiveAccountId,
  ) {}

  /**
   * Handle POST /v1/metrics
   */
  async handleMetrics(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString('utf-8')) as OtelMetricsBody;
      this.processMetrics(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    } catch (err) {
      console.error('[OTEL] Metrics parse error:', err);
      res.writeHead(400);
      res.end();
    }
  }

  /**
   * Handle POST /v1/logs
   */
  async handleLogs(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body.toString('utf-8')) as OtelLogsBody;
      this.processLogs(payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    } catch (err) {
      console.error('[OTEL] Logs parse error:', err);
      res.writeHead(400);
      res.end();
    }
  }

  private processMetrics(payload: OtelMetricsBody): void {
    /* v8 ignore next 1 */
    for (const rm of payload.resourceMetrics ?? []) {
      /* v8 ignore next 1 */
      for (const sm of rm.scopeMetrics ?? []) {
        /* v8 ignore next 1 */
        for (const metric of sm.metrics ?? []) {
          /* v8 ignore next 1 */
          const dataPoints = metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
          for (const dp of dataPoints) {
            const attrs = parseAttributes(dp.attributes);
            /* v8 ignore next 1 */
            const value = dp.asDouble ?? dp.asInt ?? 0;
            const ts = dp.timeUnixNano ? Number(BigInt(dp.timeUnixNano) / BigInt(1_000_000)) : Date.now();
            this.handleMetricDataPoint(metric.name, attrs, value, ts);
          }
        }
      }
    }
  }

  private handleMetricDataPoint(name: string, attrs: OtelAttributes, value: number, ts: number): void {
    const accountId = this.resolveAccountId(attrs);
    const sessionId = (attrs['session.id'] as string | undefined) ?? null;
    const model = (attrs['model'] as string | undefined) ?? 'unknown';

    switch (name) {
      case METRIC_COST: {
        insertUsageEvent(this.db, {
          ts,
          accountId,
          sessionId,
          model,
          costUsd: value,
          inputTokens: null,
          outputTokens: null,
          cacheRead: null,
          cacheCreate: null,
          durationMs: null,
        });
        return;
      }

      case METRIC_TOKENS: {
        // Fallback path — usage tokens are primarily captured from the
        // api_request log event (which bundles all four token types with cost
        // in one row). This metric arrives as *separate* data points per
        // `type` attribute, so we can't reconstruct a single usage_events row
        // atomically. Skip persistence here to avoid fragmented / partial rows
        // in usage_events when logs are flowing normally. If a user ever
        // configures metrics-only, we'd revisit this with per-type aggregation
        // keyed by session+timestamp.
        return;
      }

      case METRIC_SESSION: {
        insertActivityEvent(this.db, { ts, accountId, sessionId, kind: 'session', value });
        return;
      }

      case METRIC_LINES: {
        const type = (attrs['type'] as string | undefined) ?? 'added';
        const kind = type === 'removed' ? 'lines_removed' : 'lines_added';
        insertActivityEvent(this.db, { ts, accountId, sessionId, kind, value });
        return;
      }

      case METRIC_PR: {
        insertActivityEvent(this.db, { ts, accountId, sessionId, kind: 'pull_request', value });
        return;
      }

      case METRIC_COMMIT: {
        insertActivityEvent(this.db, { ts, accountId, sessionId, kind: 'commit', value });
        return;
      }

      case METRIC_ACTIVE_TIME: {
        const type = (attrs['type'] as string | undefined) ?? 'user';
        const kind = type === 'cli' ? 'active_cli_seconds' : 'active_user_seconds';
        insertActivityEvent(this.db, { ts, accountId, sessionId, kind, value });
        return;
      }

      case METRIC_EDIT_DECISION: {
        insertActivityEvent(this.db, {
          ts,
          accountId,
          sessionId,
          kind: 'edit_decision',
          value,
          toolName: (attrs['tool_name'] as string | undefined) ?? null,
          decision: (attrs['decision'] as string | undefined) ?? null,
          source: (attrs['source'] as string | undefined) ?? null,
          language: (attrs['language'] as string | undefined) ?? null,
        });
        return;
      }

      default:
        // Unknown metric — log once at debug level so future additions show up
        // in daemon.log without silently accumulating.
        console.log(`[OTEL] Unhandled metric: ${name}`);
    }
  }

  private processLogs(payload: OtelLogsBody): void {
    /* v8 ignore next 3 */
    for (const rl of payload.resourceLogs ?? []) {
      for (const sl of rl.scopeLogs ?? []) {
        for (const lr of sl.logRecords ?? []) {
          const attrs = parseAttributes(lr.attributes);
          // OTLP v1.0+ puts the event name at the top of the LogRecord,
          // but many SDKs still emit it as an attribute. Check both so we
          // match whichever wire format Claude Code happens to use.
          const rawName = lr.eventName ?? (attrs['event.name'] as string | undefined);
          const eventName = normalizeEventName(rawName);
          this.handleLogRecord(eventName, lr, attrs);
        }
      }
    }
  }

  private handleLogRecord(
    eventName: string | undefined,
    lr: OtelLogRecord,
    attrs: OtelAttributes,
  ): void {
    if (!eventName) return;
    const ts = logRecordTs(lr);
    const accountId = this.resolveAccountId(attrs);
    const sessionId = (attrs['session.id'] as string | undefined) ?? null;

    switch (eventName) {
      case EVENT_API_REQUEST: {
        insertUsageEvent(this.db, {
          ts,
          accountId,
          sessionId,
          model: (attrs['model'] as string | undefined) ?? 'unknown',
          costUsd: (attrs['cost_usd'] as number | undefined) ?? null,
          inputTokens: (attrs['input_tokens'] as number | undefined) ?? null,
          outputTokens: (attrs['output_tokens'] as number | undefined) ?? null,
          cacheRead: (attrs['cache_read_tokens'] as number | undefined) ?? null,
          cacheCreate: (attrs['cache_creation_tokens'] as number | undefined) ?? null,
          durationMs: (attrs['duration_ms'] as number | undefined) ?? null,
        });
        return;
      }

      case EVENT_API_ERROR: {
        insertApiError(this.db, {
          ts,
          accountId,
          sessionId,
          model: (attrs['model'] as string | undefined) ?? null,
          // status_code is documented as a string (e.g. "429", "undefined").
          // Preserve as-is since it may not be numeric.
          statusCode: asString(attrs['status_code']),
          error: asString(attrs['error']),
          durationMs: (attrs['duration_ms'] as number | undefined) ?? null,
          attempt: (attrs['attempt'] as number | undefined) ?? null,
          requestId: asString(attrs['request_id']),
          speed: asString(attrs['speed']),
        });
        return;
      }

      case EVENT_TOOL_RESULT: {
        const successAttr = attrs['success'];
        const success = successAttr === true || successAttr === 'true' || successAttr === 1;
        insertToolEvent(this.db, {
          ts,
          accountId,
          sessionId,
          toolName: (attrs['tool_name'] as string | undefined) ?? 'unknown',
          success,
          durationMs: (attrs['duration_ms'] as number | undefined) ?? null,
          error: asString(attrs['error']),
          decisionSource: asString(attrs['decision_source']),
          mcpServerScope: asString(attrs['mcp_server_scope']),
          toolResultSizeBytes: (attrs['tool_result_size_bytes'] as number | undefined) ?? null,
        });
        return;
      }

      case EVENT_SKILL_ACTIVATED: {
        insertActivityEvent(this.db, {
          ts,
          accountId,
          sessionId,
          kind: 'skill_activated',
          value: 1,
          name: asString(attrs['skill.name']),
          source: asString(attrs['skill.source']),
          marketplace: asString(attrs['marketplace.name']),
          // Note: plugin.name is stored in `source` so we don't need another
          // column; skill.source is the install origin (e.g. 'plugin').
        });
        return;
      }

      case EVENT_PLUGIN_INSTALLED: {
        insertActivityEvent(this.db, {
          ts,
          accountId,
          sessionId,
          kind: 'plugin_installed',
          value: 1,
          name: asString(attrs['plugin.name']),
          version: asString(attrs['plugin.version']),
          marketplace: asString(attrs['marketplace.name']),
          source: asString(attrs['install.trigger']),
        });
        return;
      }

      default:
        console.log(`[OTEL] Unhandled event: ${eventName}`);
    }
  }

  /** Prefer the active sentinel key so per-org attribution works when one
   *  Anthropic user belongs to multiple orgs. Falls back to the account UUID
   *  from OTEL attributes when no key is active. */
  private resolveAccountId(attrs: OtelAttributes): string {
    /* v8 ignore next 2 */
    const otelAccountId = (attrs['user.account_uuid'] as string | undefined) ?? 'unknown';
    return this.activeAccountId?.value || otelAccountId;
  }
}

function logRecordTs(lr: OtelLogRecord): number {
  return lr.timeUnixNano
    ? Number(BigInt(lr.timeUnixNano) / BigInt(1_000_000))
    : Date.now();
}

function asString(v: OtelAttributes[string]): string | null {
  if (v === undefined || v === null) return null;
  return String(v);
}
