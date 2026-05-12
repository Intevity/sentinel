/**
 * Periodic OTLP/HTTP emitter for Sentinel-derived signals.
 *
 * Sentinel computes things Claude Code's own OTEL stream can't see:
 *   - Cache TTL breakdown (5m vs 1h cache writes — Sentinel parses
 *     responses; CC only emits flat token counts).
 *   - Per-account 5h-window usage attribution in round-robin mode
 *     (CC reports for whichever account it thinks is active).
 *   - Account-switch and rotation events.
 *   - Security scanner findings + counters.
 *   - Proxy request/error counters (best-effort tap from the proxy).
 *
 * Every emitted payload is tagged with `service.name=claude-sentinel`
 * resource attribute so dashboards can split it from the tee'd Claude
 * Code stream (`service.name=claude-code`).
 *
 * Cadence: 30s. Counters are cumulative-since-process-start, matching
 * the AggregationTemporality CC's own counters use.
 *
 * Emission goes through the same `OtelForwarder` as the tee, so the
 * endpoint, header, secret, in-flight cap, and timeouts are unified.
 * The emitter is a no-op when forwarding is disabled or
 * `otelEmitSentinelMetrics` is off, but in-process counters keep
 * accumulating so a later enable picks up where it left off (capped
 * to the current process's history).
 */
import type { Database } from 'better-sqlite3';
import type {
  Settings,
  SecuritySeverity,
  SecurityKind,
  DaemonToAppMessage,
  OAuthAccount,
  PermissionDecision,
} from '@claude-sentinel/shared';
import type { OtelForwarder } from './otel-forwarder.js';
import type { IpcServer } from './ipc.js';

const DEFAULT_TICK_MS = 30_000;
const SENTINEL_SERVICE_NAME = 'claude-sentinel';
/** 5h in ms — matches Anthropic's subscription window. */
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
/** Per-channel ring buffer cap for log events. Drops oldest on overflow. */
const EVENT_RING_CAP = 1024;

/**
 * Human-readable metadata for every metric Sentinel originates. Surfaced in
 * SigNoz hover-docs (`description`) and axis labels (`unit`). Units use UCUM
 * where possible (`tokens`, `USD`) and OTEL's curly-brace form for
 * dimensionless counts (`{events}`, `{requests}`). Exported so the test
 * suite can iterate it and catch newly-added metrics that forgot a
 * registration.
 */
export const METRIC_METADATA: Record<string, { description: string; unit: string }> = {
  'sentinel.cache.tokens_by_ttl': {
    description:
      "Prompt-cache token volume over the rolling 5h subscription window, broken down by TTL bucket (5m vs 1h cache writes) and aggregate cache reads. Computed by Sentinel from response parsing; Claude Code's own stream only reports flat cache counts without TTL.",
    unit: 'tokens',
  },
  'sentinel.account.usage.tokens': {
    description:
      "Per-account token usage in the rolling 5h subscription window, split by kind (input, output, cache_read, cache_create). In round-robin mode this attributes usage to the account actually drained, which Claude Code's own stream cannot see.",
    unit: 'tokens',
  },
  'sentinel.account.usage.cost_usd': {
    description: 'Per-account estimated API cost over the rolling 5h subscription window.',
    unit: 'USD',
  },
  'sentinel.account.switch.count': {
    description:
      'Cumulative count of account switches since Sentinel started, labeled by destination account.',
    unit: '{switches}',
  },
  'sentinel.proxy.requests.count': {
    description:
      'Cumulative count of upstream Anthropic API requests proxied since Sentinel started, labeled by account and HTTP status class (2xx, 4xx, 5xx, other).',
    unit: '{requests}',
  },
  'sentinel.proxy.errors.count': {
    description:
      'Cumulative count of upstream proxy errors since Sentinel started, labeled by account and error kind (connection, timeout, etc.).',
    unit: '{errors}',
  },
  'sentinel.security.event.count': {
    description:
      'Cumulative count of security-scanner detections since Sentinel started, labeled by kind, severity (low, medium, high, critical), and outcome (blocked, allowed).',
    unit: '{events}',
  },
  'sentinel.permission.decision.count': {
    description:
      'Cumulative count of tool-permission decisions since Sentinel started, labeled by decision (allow, deny, ask) and source (local, claude-code).',
    unit: '{decisions}',
  },
};

export interface OtelEmitterDeps {
  forwarder: Pick<OtelForwarder, 'forward'>;
  getSettings: () => Settings;
  db: Database;
  /** Resolved at construct time; included as a resource attribute so a
   *  multi-machine SigNoz instance can disambiguate hosts. */
  serviceVersion: string;
  hostUuid: string;
  /** Live accessor for `service.instance.id`. Reads from settings on every
   *  tick so a regenerated value (e.g. after a settings reset) is picked
   *  up without a daemon restart. */
  getServiceInstanceId: () => string;
  /** Live accessor for the active Anthropic OAuth account. Used to derive
   *  the `user.name` and `user.email` resource attributes. Returns null
   *  when no account is active (fresh install before login), in which
   *  case those attributes are omitted entirely. */
  getActiveAccount: () => OAuthAccount | null;
  /** Override the 30s cadence in tests. */
  tickMs?: number;
  /** Test seam for the timestamps in emitted payloads. */
  now?: () => number;
}

interface ProxyRequestRecord {
  accountId: string;
  statusClass: '2xx' | '4xx' | '5xx' | 'other';
  errorKind: string | null;
}

interface SwitchRecord {
  ts: number;
  to: string;
}

interface SecurityRecord {
  ts: number;
  accountId: string;
  severity: SecuritySeverity;
  kind: SecurityKind;
  blocked: boolean;
  title: string;
  eventId: number | null;
}

interface PermissionRecord {
  ts: number;
  accountId: string;
  toolName: string;
  decision: PermissionDecision | 'ask';
  source: 'local' | 'claude-code';
}

export class OtelEmitter {
  // ─── Cumulative counters ───────────────────────────────────────────
  private switchCount: Record<string, number> = {}; // keyed by `to`
  private proxyRequestCount: Record<string, number> = {};
  private proxyErrorCount: Record<string, number> = {};
  private securityCount: Record<string, number> = {};
  private permissionCount: Record<string, number> = {};

  // ─── Event ring buffers (emitted as OTEL logs, not metrics) ────────
  private switchEvents: SwitchRecord[] = [];
  private securityEvents: SecurityRecord[] = [];
  private permissionEvents: PermissionRecord[] = [];

  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: OtelEmitterDeps) {}

  /** Begin the 30s tick. No-op if already running. */
  start(): void {
    if (this.timer !== null) return;
    const tickMs = this.deps.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => this.tick(), tickMs);
    // Don't keep the event loop alive solely for this timer.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Subscribe to the daemon broadcast pipeline so we can tap account
   *  switches and security events without each producer needing to know
   *  about the emitter. The proxy and permissions enforcer call the
   *  bump* methods directly because they don't broadcast every decision. */
  attachToIpc(ipcServer: IpcServer): void {
    const handler = (msg: DaemonToAppMessage): void => this.onBroadcast(msg);
    ipcServer.onBroadcast(handler);
    // IpcServer.onBroadcast doesn't return an unsubscriber; we rely on
    // the daemon process exiting to clean up. Stop() doesn't try to
    // detach from IPC — broadcasts will simply be ignored once stopped
    // because counters / ring buffers will continue accumulating but
    // the timer is gone (no harm; bounded memory via the ring cap).
  }

  /** Bumped by the proxy on every completed upstream request. Cheap so
   *  it can sit on the proxy hot path. */
  bumpProxyRequest(rec: ProxyRequestRecord): void {
    const key = `${rec.accountId}|${rec.statusClass}`;
    this.proxyRequestCount[key] = (this.proxyRequestCount[key] ?? 0) + 1;
    if (rec.errorKind !== null) {
      const errKey = `${rec.accountId}|${rec.errorKind}`;
      this.proxyErrorCount[errKey] = (this.proxyErrorCount[errKey] ?? 0) + 1;
    }
  }

  /** Bumped by the permissions enforcer on every rule-driven decision. */
  bumpPermissionDecision(rec: PermissionRecord): void {
    const key = `${rec.decision}|${rec.source}`;
    this.permissionCount[key] = (this.permissionCount[key] ?? 0) + 1;
    if (this.permissionEvents.length >= EVENT_RING_CAP) {
      this.permissionEvents.shift();
    }
    this.permissionEvents.push(rec);
  }

  /** Hand a tick. Public so tests can drive cadence deterministically. */
  tick(): void {
    const s = this.deps.getSettings();
    if (!s.otelForwardingEnabled || !s.otelEmitSentinelMetrics) return;
    if (!s.otelExporterEndpoint) return;

    const now = (this.deps.now ?? Date.now)();
    const metricsBody = this.buildMetricsBody(now);
    if (metricsBody !== null) {
      this.deps.forwarder.forward(
        '/v1/metrics',
        'application/json',
        Buffer.from(JSON.stringify(metricsBody), 'utf-8'),
      );
    }
    const logsBody = this.buildLogsBody(now);
    if (logsBody !== null) {
      this.deps.forwarder.forward(
        '/v1/logs',
        'application/json',
        Buffer.from(JSON.stringify(logsBody), 'utf-8'),
      );
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────

  private onBroadcast(msg: DaemonToAppMessage): void {
    if (msg.type === 'account_switched') {
      const to = msg.to.accountUuid;
      this.switchCount[to] = (this.switchCount[to] ?? 0) + 1;
      if (this.switchEvents.length >= EVENT_RING_CAP) {
        this.switchEvents.shift();
      }
      this.switchEvents.push({ ts: Date.now(), to });
    } else if (msg.type === 'security_event_detected') {
      const key = `${msg.kind}|${msg.severity}|${msg.blocked ? 'blocked' : 'allowed'}`;
      this.securityCount[key] = (this.securityCount[key] ?? 0) + 1;
      if (this.securityEvents.length >= EVENT_RING_CAP) {
        this.securityEvents.shift();
      }
      this.securityEvents.push({
        ts: Date.now(),
        accountId: msg.accountId,
        severity: msg.severity,
        kind: msg.kind,
        blocked: msg.blocked,
        title: msg.title,
        eventId: msg.eventId ?? null,
      });
    }
  }

  private buildMetricsBody(now: number): Record<string, unknown> | null {
    const dataPoints: Record<string, OtlpNumberDataPoint[]> = {};

    // Cache TTL breakdown (gauge, by ttl bucket, summed last 5h across all accounts).
    const since = now - FIVE_HOURS_MS;
    try {
      const row = this.deps.db
        .prepare(
          `SELECT
             COALESCE(SUM(cache_create_5m), 0) AS create5m,
             COALESCE(SUM(cache_create_1h), 0) AS create1h,
             COALESCE(SUM(cache_read), 0)      AS readTokens
           FROM cache_ttl_events
           WHERE ts >= ?`,
        )
        .get(since) as { create5m: number; create1h: number; readTokens: number };
      addGauge(dataPoints, 'sentinel.cache.tokens_by_ttl', now, [
        { value: row.create5m, attrs: { ttl: '5m', operation: 'create' } },
        { value: row.create1h, attrs: { ttl: '1h', operation: 'create' } },
        { value: row.readTokens, attrs: { ttl: 'aggregate', operation: 'read' } },
      ]);
    } catch (err) {
      console.warn('[OtelEmitter] cache_ttl_events query failed:', err);
    }

    // Per-account usage in the last 5h (gauges per account, kind).
    try {
      const rows = this.deps.db
        .prepare(
          `SELECT
             account_id   AS accountId,
             COALESCE(SUM(input_tokens), 0)  AS inputTokens,
             COALESCE(SUM(output_tokens), 0) AS outputTokens,
             COALESCE(SUM(cache_read), 0)    AS cacheRead,
             COALESCE(SUM(cache_create), 0)  AS cacheCreate,
             COALESCE(SUM(cost_usd), 0.0)    AS costUsd
           FROM usage_events
           WHERE ts >= ?
           GROUP BY account_id`,
        )
        .all(since) as Array<{
        accountId: string;
        inputTokens: number;
        outputTokens: number;
        cacheRead: number;
        cacheCreate: number;
        costUsd: number;
      }>;
      const tokenPoints: OtlpNumberDataPoint[] = [];
      const costPoints: OtlpNumberDataPoint[] = [];
      for (const r of rows) {
        tokenPoints.push(
          { value: r.inputTokens, attrs: { account_id: r.accountId, kind: 'input' } },
          { value: r.outputTokens, attrs: { account_id: r.accountId, kind: 'output' } },
          { value: r.cacheRead, attrs: { account_id: r.accountId, kind: 'cache_read' } },
          { value: r.cacheCreate, attrs: { account_id: r.accountId, kind: 'cache_create' } },
        );
        costPoints.push({ value: r.costUsd, attrs: { account_id: r.accountId } });
      }
      if (tokenPoints.length > 0) {
        addGauge(dataPoints, 'sentinel.account.usage.tokens', now, tokenPoints);
        addGauge(dataPoints, 'sentinel.account.usage.cost_usd', now, costPoints);
      }
    } catch (err) {
      console.warn('[OtelEmitter] usage_events query failed:', err);
    }

    // Cumulative counters.
    addCounter(
      dataPoints,
      'sentinel.account.switch.count',
      now,
      Object.entries(this.switchCount).map(([to, value]) => ({
        value,
        attrs: { to_account: to },
      })),
    );
    addCounter(
      dataPoints,
      'sentinel.proxy.requests.count',
      now,
      Object.entries(this.proxyRequestCount).map(([k, value]) => {
        const [accountId, statusClass] = k.split('|', 2) as [string, string];
        return { value, attrs: { account_id: accountId, status_class: statusClass } };
      }),
    );
    addCounter(
      dataPoints,
      'sentinel.proxy.errors.count',
      now,
      Object.entries(this.proxyErrorCount).map(([k, value]) => {
        const [accountId, errorKind] = k.split('|', 2) as [string, string];
        return { value, attrs: { account_id: accountId, error_kind: errorKind } };
      }),
    );
    addCounter(
      dataPoints,
      'sentinel.security.event.count',
      now,
      Object.entries(this.securityCount).map(([k, value]) => {
        const [kind, severity, outcome] = k.split('|', 3) as [string, string, string];
        return { value, attrs: { kind, severity, outcome } };
      }),
    );
    addCounter(
      dataPoints,
      'sentinel.permission.decision.count',
      now,
      Object.entries(this.permissionCount).map(([k, value]) => {
        const [decision, source] = k.split('|', 2) as [string, string];
        return { value, attrs: { decision, source } };
      }),
    );

    // Build the payload. Skip the request entirely when no metric has
    // any data points — saves an outbound POST of an empty body.
    const metrics = renderMetrics(dataPoints);
    if (metrics.length === 0) return null;
    return {
      resourceMetrics: [
        {
          resource: { attributes: this.resourceAttrs() },
          scopeMetrics: [
            {
              scope: { name: 'claude-sentinel', version: this.deps.serviceVersion },
              metrics,
            },
          ],
        },
      ],
    };
  }

  private buildLogsBody(_now: number): Record<string, unknown> | null {
    const records: OtlpLogRecord[] = [];

    for (const ev of this.switchEvents) {
      records.push({
        eventName: 'sentinel.account.switch',
        timeUnixNano: msToNano(ev.ts),
        attributes: [{ key: 'to_account', value: { stringValue: ev.to } }],
      });
    }
    for (const ev of this.securityEvents) {
      records.push({
        eventName: 'sentinel.security.event',
        timeUnixNano: msToNano(ev.ts),
        attributes: [
          { key: 'account_id', value: { stringValue: ev.accountId } },
          { key: 'severity', value: { stringValue: ev.severity } },
          { key: 'kind', value: { stringValue: ev.kind } },
          { key: 'blocked', value: { boolValue: ev.blocked } },
          { key: 'title', value: { stringValue: ev.title } },
          ...(ev.eventId !== null ? [{ key: 'event_id', value: { intValue: ev.eventId } }] : []),
        ],
      });
    }
    for (const ev of this.permissionEvents) {
      records.push({
        eventName: 'sentinel.permission.decision',
        timeUnixNano: msToNano(ev.ts),
        attributes: [
          { key: 'account_id', value: { stringValue: ev.accountId } },
          { key: 'tool_name', value: { stringValue: ev.toolName } },
          { key: 'decision', value: { stringValue: ev.decision } },
          { key: 'source', value: { stringValue: ev.source } },
        ],
      });
    }

    if (records.length === 0) return null;

    // Drain the buffers — these are events, not gauges, so they should
    // only ship once. Counters above are cumulative and continue to
    // reflect the same totals.
    this.switchEvents = [];
    this.securityEvents = [];
    this.permissionEvents = [];

    return {
      resourceLogs: [
        {
          resource: { attributes: this.resourceAttrs() },
          scopeLogs: [
            {
              scope: { name: 'claude-sentinel', version: this.deps.serviceVersion },
              logRecords: records,
            },
          ],
        },
      ],
    };
  }

  private resourceAttrs(): Array<{ key: string; value: { stringValue: string } }> {
    const attrs: Array<{ key: string; value: { stringValue: string } }> = [
      { key: 'service.name', value: { stringValue: SENTINEL_SERVICE_NAME } },
      { key: 'service.version', value: { stringValue: this.deps.serviceVersion } },
      { key: 'service.instance.id', value: { stringValue: this.deps.getServiceInstanceId() } },
      { key: 'claude.sentinel.host_uuid', value: { stringValue: this.deps.hostUuid } },
    ];
    // OTEL convention `user.name` / `user.email` derived from the active
    // Anthropic OAuth account. Only emit when populated — empty strings
    // would clutter SigNoz dashboards and break per-user filtering.
    const account = this.deps.getActiveAccount();
    if (account) {
      if (account.displayName && account.displayName.length > 0) {
        attrs.push({ key: 'user.name', value: { stringValue: account.displayName } });
      }
      if (account.emailAddress && account.emailAddress.length > 0) {
        attrs.push({ key: 'user.email', value: { stringValue: account.emailAddress } });
      }
    }
    return attrs;
  }
}

// ─── OTLP/HTTP JSON shape helpers ────────────────────────────────────

interface OtlpAttributeValue {
  stringValue?: string;
  intValue?: number;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpLogRecord {
  eventName: string;
  timeUnixNano: string;
  attributes: Array<{ key: string; value: OtlpAttributeValue }>;
}

interface OtlpNumberDataPoint {
  value: number;
  attrs: Record<string, string>;
}

function addGauge(
  out: Record<string, OtlpNumberDataPoint[]>,
  name: string,
  _nowMs: number,
  points: OtlpNumberDataPoint[],
): void {
  if (points.length === 0) return;
  out[name] = points;
}

function addCounter(
  out: Record<string, OtlpNumberDataPoint[]>,
  name: string,
  _nowMs: number,
  points: OtlpNumberDataPoint[],
): void {
  if (points.length === 0) return;
  // Sentinel marker so renderMetrics knows to emit this as an OTLP sum
  // (cumulative + monotonic) rather than a gauge.
  out[`${name}::sum`] = points;
}

function renderMetrics(grouped: Record<string, OtlpNumberDataPoint[]>): unknown[] {
  const nowNano = msToNano(Date.now());
  const metrics: unknown[] = [];
  for (const [key, points] of Object.entries(grouped)) {
    const isSum = key.endsWith('::sum');
    const name = isSum ? key.slice(0, -'::sum'.length) : key;
    const renderedPoints = points.map((p) => ({
      attributes: Object.entries(p.attrs).map(([k, v]) => ({
        key: k,
        value: { stringValue: v },
      })),
      timeUnixNano: nowNano,
      ...(Number.isInteger(p.value) ? { asInt: p.value } : { asDouble: p.value }),
    }));
    const meta = METRIC_METADATA[name];
    const base = meta ? { name, description: meta.description, unit: meta.unit } : { name };
    if (isSum) {
      metrics.push({
        ...base,
        sum: {
          dataPoints: renderedPoints,
          aggregationTemporality: 2, // CUMULATIVE
          isMonotonic: true,
        },
      });
    } else {
      metrics.push({
        ...base,
        gauge: { dataPoints: renderedPoints },
      });
    }
  }
  return metrics;
}

function msToNano(ms: number): string {
  return (BigInt(Math.floor(ms)) * 1_000_000n).toString();
}
