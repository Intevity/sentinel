/**
 * Sprint 9 — Outbound webhook for security events.
 *
 * Subscribes to the daemon's broadcast pipeline and POSTs every
 * `security_event_detected` whose severity reaches the user-configured
 * floor to a user-supplied URL. Plug-compatible with Slack incoming
 * webhooks, PagerDuty Events API v2, generic HTTP receivers, etc.
 *
 * Cross-cutting guarantees:
 *  - HMAC-SHA256 over the raw JSON body when the user sets a secret.
 *  - Token-bucket rate limit (10/min) so a noisy detector can't burn
 *    a webhook quota.
 *  - 3-attempt retry with 1s/4s/16s backoff on network errors and 5xx;
 *    4xx fails immediately (configuration problem).
 *  - Bounded queue (100 entries) so a sustained outage doesn't grow
 *    the daemon's heap.
 *  - All HTTP I/O runs in real `fetch` calls — no mocks needed in
 *    tests, just spin up a real `http.createServer` per the
 *    cross-cutting "tests must use real boundaries" rule in CLAUDE.md.
 */

import { createHmac } from 'crypto';
import type { Settings, SecuritySeverity, SecurityKind } from '@sentinel/shared';
import type { IpcServer } from '../ipc.js';

const SEVERITY_RANK: Record<SecuritySeverity, number> = { low: 0, medium: 1, high: 2 };

const RATE_LIMIT_CAPACITY = 10;
const RATE_LIMIT_REFILL_MS = 6_000;
const QUEUE_MAX = 100;
const RETRY_DELAYS_MS = [1_000, 4_000, 16_000] as const;
const REQUEST_TIMEOUT_MS = 5_000;

/** Minimal slice of the upstream `security_event_detected` broadcast
 *  the webhook needs. Mirrors the IPC message shape so wiring is
 *  trivial: pass the broadcast straight in. */
export interface WebhookEvent {
  ts: number;
  severity: SecuritySeverity;
  kind: SecurityKind;
  title: string;
  reason?: string;
  blocked: boolean;
  accountId: string;
}

export interface WebhookEmitterDeps {
  getSettings: () => Settings;
  /** Optional injection point for tests: lets a fixture replace
   *  `globalThis.fetch` without monkey-patching the global. Production
   *  passes nothing and the real `fetch` is used. */
  fetchImpl?: typeof fetch;
  /** Optional clock injection for tests so retry/backoff timing can
   *  be fast-forwarded. Defaults to `Date.now`. */
  now?: () => number;
  /** Test-only override for retry backoff. Length determines max
   *  attempts (initial + retries.length). Defaults to [1s, 4s, 16s]. */
  retryDelaysMs?: readonly number[];
}

export interface WebhookEmitter {
  /** Synchronously enqueue an event for delivery. The dispatch happens
   *  on a microtask so `emit` never blocks the broadcast. Drops with a
   *  log line when the queue is full or the rate-limit token bucket
   *  has no tokens left. */
  emit(event: WebhookEvent): void;
  /** Stop accepting new events; pending in-flight requests still
   *  complete (their fetches own their own timers). */
  close(): void;
  /** Test-only: inspect the current queue depth. */
  _queueDepth(): number;
}

export function createWebhookEmitter(deps: WebhookEmitterDeps): WebhookEmitter {
  const fetchFn: typeof fetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const retryDelays: readonly number[] = deps.retryDelaysMs ?? RETRY_DELAYS_MS;

  // Token bucket. Filled to capacity at boot; refills 1 token every
  // RATE_LIMIT_REFILL_MS. Drops over the refill cap saturate to capacity.
  let tokens = RATE_LIMIT_CAPACITY;
  let lastRefillAt = now();
  const refill = (): void => {
    const elapsed = now() - lastRefillAt;
    if (elapsed <= 0) return;
    const replenish = Math.floor(elapsed / RATE_LIMIT_REFILL_MS);
    if (replenish > 0) {
      tokens = Math.min(RATE_LIMIT_CAPACITY, tokens + replenish);
      lastRefillAt += replenish * RATE_LIMIT_REFILL_MS;
    }
  };

  const queue: WebhookEvent[] = [];
  let draining = false;
  let closed = false;

  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      // Token consumption happens at emit() time so the test's
      // "rate-limit drops the 11th event" assertion is deterministic.
      // The drain loop just delivers; tokens were already debited.
      while (queue.length > 0 && !closed) {
        const event = queue.shift()!;
        await deliver(event);
      }
    } finally {
      draining = false;
    }
  };

  const deliver = async (event: WebhookEvent): Promise<void> => {
    const settings = deps.getSettings();
    const url = settings.securityWebhookUrl;
    if (!url) return; // setting flipped off mid-queue
    const body = JSON.stringify({
      ts: event.ts,
      severity: event.severity,
      kind: event.kind,
      title: event.title,
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
      blocked: event.blocked,
      accountId: event.accountId,
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.securityWebhookSecret) {
      const sig = createHmac('sha256', settings.securityWebhookSecret).update(body).digest('hex');
      headers['X-Sentinel-Signature'] = `sha256=${sig}`;
    }
    for (let attempt = 0; attempt < retryDelays.length + 1; attempt += 1) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
      let res: Response | null = null;
      let networkErr: Error | null = null;
      try {
        res = await fetchFn(url, { method: 'POST', headers, body, signal: ac.signal });
      } catch (err) {
        networkErr = err instanceof Error ? err : new Error(String(err));
      } finally {
        clearTimeout(timer);
      }
      if (res && res.ok) return;
      // 4xx is a configuration error: stop retrying, log once.
      if (res && res.status >= 400 && res.status < 500) {
        console.warn(`[Webhook] ${url} returned ${res.status} — not retrying`);
        return;
      }
      // 5xx or network error → retry with backoff if attempts remain.
      const last = attempt === retryDelays.length;
      if (last) {
        const reason = res ? `status=${res.status}` : `network=${networkErr?.message ?? 'unknown'}`;
        console.warn(`[Webhook] ${url} delivery failed after retries (${reason})`);
        return;
      }
      const backoff = retryDelays[attempt]!;
      await new Promise((r) => setTimeout(r, backoff));
    }
  };

  const emit = (event: WebhookEvent): void => {
    if (closed) return;
    const settings = deps.getSettings();
    if (!settings.securityWebhookUrl) return;
    const floor = settings.securityWebhookSeverityFloor;
    if (SEVERITY_RANK[event.severity] < SEVERITY_RANK[floor]) return;
    if (queue.length >= QUEUE_MAX) {
      console.warn(`[Webhook] queue full (${QUEUE_MAX}); dropping event ${event.kind}`);
      return;
    }
    refill();
    if (tokens <= 0) {
      console.warn(`[Webhook] rate-limited; dropping event ${event.kind} (webhook_rate_limited)`);
      return;
    }
    tokens -= 1;
    queue.push(event);
    void drain();
  };

  const close = (): void => {
    closed = true;
    queue.length = 0;
  };

  return { emit, close, _queueDepth: () => queue.length };
}

/** Wire a webhook emitter to the daemon's broadcast pipeline. Pulls
 *  out the `security_event_detected` shape and forwards to `emit`.
 *  Returns the constructed emitter so callers can hold it for
 *  shutdown. */
export function attachWebhookToIpc(ipcServer: IpcServer, deps: WebhookEmitterDeps): WebhookEmitter {
  const emitter = createWebhookEmitter(deps);
  ipcServer.onBroadcast((msg) => {
    if (msg.type !== 'security_event_detected') return;
    emitter.emit({
      ts: Date.now(),
      severity: msg.severity,
      kind: msg.kind,
      title: msg.title,
      blocked: msg.blocked,
      accountId: msg.accountId,
    });
  });
  return emitter;
}
