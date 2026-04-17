import type { IncomingMessage, ServerResponse } from 'http';
import type { Database } from 'better-sqlite3';
import { insertUsageEvent } from './db.js';
import type { ActiveAccountId } from './proxy.js';

/**
 * Known Claude Code OTEL metric/log names.
 */
export const OTEL_METRIC_COST = 'claude_code.cost.usage';
export const OTEL_METRIC_TOKENS = 'claude_code.token.usage';
export const OTEL_METRIC_SESSION = 'claude_code.session.count';
export const OTEL_LOG_API_REQUEST = 'claude_code.api_request';

interface OtelAttributes {
  [key: string]: string | number | boolean | null | undefined;
}

interface OtelNumberDataPoint {
  attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: number; doubleValue?: number } }>;
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
            this.handleMetricDataPoint(metric.name, attrs, dp.asDouble ?? dp.asInt ?? 0);
          }
        }
      }
    }
  }

  private handleMetricDataPoint(name: string, attrs: OtelAttributes, value: number): void {
    if (name === OTEL_METRIC_COST) {
      /* v8 ignore next 3 */
      const otelAccountId = (attrs['user.account_uuid'] as string | undefined) ?? 'unknown';
      // Use the active sentinel key (org-specific) when available so that usage is
      // attributed per-org rather than per-Anthropic-user-UUID. Falls back to the
      // account UUID from OTEL attributes when no sentinel key is active.
      const accountId = this.activeAccountId?.value || otelAccountId;
      const model = (attrs['model'] as string | undefined) ?? 'unknown';
      const sessionId = (attrs['session.id'] as string | undefined) ?? null;

      insertUsageEvent(this.db, {
        ts: Date.now(),
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
    }
  }

  private processLogs(payload: OtelLogsBody): void {
    /* v8 ignore next 3 */
    for (const rl of payload.resourceLogs ?? []) {
      for (const sl of rl.scopeLogs ?? []) {
        for (const lr of sl.logRecords ?? []) {
          const attrs = parseAttributes(lr.attributes);
          const eventName = attrs['event.name'] as string | undefined;
          if (eventName === OTEL_LOG_API_REQUEST) {
            this.handleApiRequestLog(lr, attrs);
          }
        }
      }
    }
  }

  private handleApiRequestLog(lr: OtelLogRecord, attrs: OtelAttributes): void {
    const tsNano = lr.timeUnixNano ? BigInt(lr.timeUnixNano) : BigInt(Date.now()) * BigInt(1_000_000);
    const ts = Number(tsNano / BigInt(1_000_000));

    /* v8 ignore next 5 */
    const otelAccountId = (attrs['user.account_uuid'] as string | undefined) ?? 'unknown';
    // Use the active sentinel key for per-org attribution (see handleMetricDataPoint).
    const accountId = this.activeAccountId?.value || otelAccountId;
    const model = (attrs['model'] as string | undefined) ?? 'unknown';
    const sessionId = (attrs['session.id'] as string | undefined) ?? null;
    const costUsd = (attrs['cost_usd'] as number | undefined) ?? null;
    const inputTokens = (attrs['input_tokens'] as number | undefined) ?? null;
    const outputTokens = (attrs['output_tokens'] as number | undefined) ?? null;
    const cacheRead = (attrs['cache_read_tokens'] as number | undefined) ?? null;
    const cacheCreate = (attrs['cache_creation_tokens'] as number | undefined) ?? null;
    const durationMs = (attrs['duration_ms'] as number | undefined) ?? null;

    insertUsageEvent(this.db, {
      ts,
      accountId,
      sessionId,
      model,
      costUsd,
      inputTokens,
      outputTokens,
      cacheRead,
      cacheCreate,
      durationMs,
    });
  }
}
