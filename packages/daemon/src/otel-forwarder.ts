/**
 * External OTEL forwarder.
 *
 * Tees every OTLP/HTTP request body Sentinel receives at `/v1/metrics`
 * and `/v1/logs` to a user-configured external observability backend
 * (e.g. SigNoz Cloud), AND ships Sentinel's own derived metrics
 * (synthesized by `OtelEmitter`) through the same endpoint so dashboards
 * see one stream tagged by `service.name=claude-code` (raw Claude Code
 * data) or `service.name=claude-sentinel` (Sentinel-computed signals).
 *
 * Cross-cutting guarantees:
 *  - Fire-and-forget: `forward()` never blocks the receiver's response
 *    to Claude Code. A hung upstream only consumes one in-flight slot.
 *  - In-flight cap (default 4) with drop-on-overflow + counter bump,
 *    so a sustained outage can't grow heap.
 *  - Per-request 10s timeout via `AbortController`.
 *  - Endpoint + header name read from settings on every call (free,
 *    in-memory). Secret read from the OS keychain once and cached;
 *    `onSecretChanged()` invalidates the cache so a re-keychain'd value
 *    is picked up without restart.
 *  - All HTTP I/O via the global `fetch` (Node 18+ undici), matching the
 *    `alerting/webhook.ts` pattern. Tests pass `fetchImpl` to inject a
 *    fake — but the canonical test approach in this repo is `http.createServer`
 *    so the real fetch path runs end to end.
 */
import type {
  Settings,
  OtelForwarderStatus,
  OtelExporterTestResult,
} from '@claude-sentinel/shared';
import { hasOtelExporterSecret, readOtelExporterSecret } from './otel-forwarder-secret.js';

export type OtelForwardPath = '/v1/metrics' | '/v1/logs';

export interface OtelForwarderDeps {
  /** Live accessor to the current Settings object. The forwarder reads
   *  the endpoint, header name, and toggles on every call so changes
   *  take effect on the next request without restart. */
  getSettings: () => Settings;
  /** Test seam: lets a fixture replace `globalThis.fetch` without
   *  monkey-patching the global. Defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam for the success-timestamp counter. Defaults to `Date.now`. */
  now?: () => number;
  /** Per-request hard timeout. Default 10_000 ms. */
  timeoutMs?: number;
  /** Cap on simultaneous outbound forwards. Default 4. Anything beyond
   *  this is dropped with `dropped` incremented — protects against
   *  unbounded memory growth if the upstream stalls. */
  maxInFlight?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_IN_FLIGHT = 4;

export class OtelForwarder {
  private sent = 0;
  private dropped = 0;
  private failed = 0;
  private inFlight = 0;
  private lastForwardOkAt: number | null = null;
  private lastForwardErr: string | null = null;
  /** Cached secret. `undefined` = never read; `null` = read and absent;
   *  `string` = read and present. Avoids spawning the macOS `security`
   *  CLI per request. Cleared by `onSecretChanged()`. */
  private cachedSecret: string | null | undefined = undefined;
  private statusListeners: ((status: OtelForwarderStatus) => void)[] = [];

  constructor(private readonly deps: OtelForwarderDeps) {}

  /** Subscribe to forwarder status changes. The listener fires on every
   *  secret invalidation, dispatch outcome (success or failure), and
   *  drop. The daemon wires this to the `otel_forwarder_status`
   *  broadcast so the Settings UI updates live without polling. */
  onStatusChange(listener: (status: OtelForwarderStatus) => void): () => void {
    this.statusListeners.push(listener);
    return () => {
      const i = this.statusListeners.indexOf(listener);
      if (i >= 0) this.statusListeners.splice(i, 1);
    };
  }

  /** Receiver and emitter call this. Fire-and-forget: never awaited.
   *  Drops silently when forwarding is disabled, the relevant
   *  metrics/logs toggle is off, the endpoint is unset, or no secret
   *  is configured — so callers don't need to gate themselves. */
  forward(path: OtelForwardPath, contentType: string, body: Buffer): void {
    const s = this.deps.getSettings();
    if (!s.otelForwardingEnabled) return;
    if (path === '/v1/metrics' && !s.otelForwardMetrics) return;
    if (path === '/v1/logs' && !s.otelForwardLogs) return;
    if (!s.otelExporterEndpoint) return;
    const secret = this.getSecretCached();
    if (!secret) return;

    const cap = this.deps.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    if (this.inFlight >= cap) {
      this.dropped += 1;
      this.notifyStatus();
      return;
    }
    this.inFlight += 1;
    void this.dispatch(
      s.otelExporterEndpoint,
      s.otelExporterHeaderName,
      secret,
      path,
      contentType,
      body,
    ).finally(() => {
      this.inFlight -= 1;
    });
  }

  /** Invalidate the cached secret so the next forward picks up a fresh
   *  value from the keychain. Wired to the `set_otel_exporter_secret`
   *  and `clear_otel_exporter_secret` IPC handlers. */
  onSecretChanged(): void {
    this.cachedSecret = undefined;
    this.notifyStatus();
  }

  getStatus(): OtelForwarderStatus {
    const s = this.deps.getSettings();
    const secretConfigured = hasOtelExporterSecret();
    return {
      secretConfigured,
      ready: s.otelForwardingEnabled && s.otelExporterEndpoint !== null && secretConfigured,
      sent: this.sent,
      dropped: this.dropped,
      failed: this.failed,
      lastForwardOkAt: this.lastForwardOkAt,
      lastForwardErr: this.lastForwardErr,
      inFlight: this.inFlight,
    };
  }

  /** User-initiated probe: synthesize a tiny empty OTLP/HTTP metrics
   *  payload and POST it to the configured endpoint with the configured
   *  auth header. Returns the upstream status code and a brief message
   *  for the Settings UI to render. Doesn't update success/failure
   *  counters — it's a one-shot. */
  async testConnection(): Promise<OtelExporterTestResult> {
    const s = this.deps.getSettings();
    if (!s.otelExporterEndpoint) {
      return { ok: false, status: null, message: 'no endpoint configured' };
    }
    const secret = readOtelExporterSecret();
    if (!secret) {
      return { ok: false, status: null, message: 'no secret stored' };
    }
    const body = Buffer.from(JSON.stringify({ resourceMetrics: [] }), 'utf-8');
    return this.dispatchOnce(
      s.otelExporterEndpoint,
      s.otelExporterHeaderName,
      secret,
      '/v1/metrics',
      'application/json',
      body,
    );
  }

  private getSecretCached(): string | null {
    if (this.cachedSecret === undefined) {
      this.cachedSecret = readOtelExporterSecret();
    }
    return this.cachedSecret;
  }

  private async dispatch(
    endpointBase: string,
    headerName: string,
    secret: string,
    path: OtelForwardPath,
    contentType: string,
    body: Buffer,
  ): Promise<void> {
    const result = await this.dispatchOnce(
      endpointBase,
      headerName,
      secret,
      path,
      contentType,
      body,
    );
    const now = (this.deps.now ?? Date.now)();
    if (result.ok) {
      this.sent += 1;
      this.lastForwardOkAt = now;
      this.lastForwardErr = null;
    } else {
      this.failed += 1;
      this.lastForwardErr = result.message;
    }
    this.notifyStatus();
  }

  private async dispatchOnce(
    endpointBase: string,
    headerName: string,
    secret: string,
    path: OtelForwardPath,
    contentType: string,
    body: Buffer,
  ): Promise<OtelExporterTestResult> {
    const fetchFn = this.deps.fetchImpl ?? fetch;
    const url = endpointBase + path;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      // Buffer extends Uint8Array, which is a valid fetch body. Cast to
      // unknown first to dodge platform-typing differences (DOM vs Node).
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': contentType || 'application/json',
          [headerName]: secret,
        },
        body: body as unknown as Uint8Array,
        signal: ac.signal,
      });
      if (res.ok) return { ok: true, status: res.status, message: 'ok' };
      return { ok: false, status: res.status, message: `HTTP ${res.status}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, status: null, message: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  private notifyStatus(): void {
    if (this.statusListeners.length === 0) return;
    const status = this.getStatus();
    for (const cb of this.statusListeners) {
      try {
        cb(status);
      } catch (err) {
        console.error('[OtelForwarder] status listener threw:', err);
      }
    }
  }
}
