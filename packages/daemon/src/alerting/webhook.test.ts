import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createHmac } from 'crypto';
import type { Settings } from '@sentinel/shared';
import { createWebhookEmitter, type WebhookEvent } from './webhook.js';

interface FakeReceiverState {
  url: string;
  server: Server;
  requests: Array<{ headers: Record<string, string>; body: string }>;
  /** Per-request status override queue. Drains FIFO; falls back to 200. */
  statusQueue: number[];
  close: () => Promise<void>;
}

async function startReceiver(): Promise<FakeReceiverState> {
  const state: FakeReceiverState = {
    url: '',
    server: createServer(),
    requests: [],
    statusQueue: [],
    close: async () => {
      await new Promise<void>((res) => state.server.close(() => res()));
    },
  };
  state.server.on('request', (req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      state.requests.push({
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0]! : (v ?? '')]),
        ),
        body,
      });
      const status = state.statusQueue.shift() ?? 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: status < 400 }));
    });
  });
  await new Promise<void>((res) => state.server.listen(0, '127.0.0.1', res));
  const addr = state.server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${addr.port}/sink`;
  return state;
}

function event(over: Partial<WebhookEvent> = {}): WebhookEvent {
  return {
    ts: 1_700_000_000,
    severity: 'high',
    kind: 'secret',
    title: 'GitHub PAT',
    blocked: true,
    accountId: 'acct-1',
    ...over,
  };
}

function settings(over: Partial<Settings> = {}): Settings {
  return {
    securityWebhookUrl: null,
    securityWebhookSecret: null,
    securityWebhookSeverityFloor: 'high',
    optimizeCaptureEnabled: true,
    optimizeAutoRecommend: true,
    optimizeShowMicroOpportunities: false,
    optimizeUnits: 'tokens',
    optimizeChartView: 'realized',
    ...over,
  } as Settings;
}

describe('createWebhookEmitter', () => {
  let receiver: FakeReceiverState;

  beforeEach(async () => {
    receiver = await startReceiver();
  });
  afterEach(async () => {
    await receiver.close();
  });

  it('POSTs a JSON body with the expected fields when severity meets the floor', async () => {
    const emitter = createWebhookEmitter({
      getSettings: () => settings({ securityWebhookUrl: receiver.url }),
    });
    emitter.emit(
      event({ ts: 12345, severity: 'high', kind: 'secret', title: 'AWS key', accountId: 'a-1' }),
    );
    await vi.waitFor(() => expect(receiver.requests.length).toBe(1), { timeout: 2000 });
    expect(receiver.requests[0]!.headers['content-type']).toBe('application/json');
    const body = JSON.parse(receiver.requests[0]!.body);
    expect(body).toMatchObject({
      ts: 12345,
      severity: 'high',
      kind: 'secret',
      title: 'AWS key',
      blocked: true,
      accountId: 'a-1',
    });
    emitter.close();
  });

  it('skips events strictly below the configured severity floor', async () => {
    const emitter = createWebhookEmitter({
      getSettings: () =>
        settings({ securityWebhookUrl: receiver.url, securityWebhookSeverityFloor: 'high' }),
    });
    emitter.emit(event({ severity: 'medium' }));
    emitter.emit(event({ severity: 'low' }));
    // Wait a tick to give the queue a chance to fire if it was going to.
    await new Promise((r) => setTimeout(r, 50));
    expect(receiver.requests).toHaveLength(0);
    emitter.close();
  });

  it('signs the body with HMAC-SHA256 when a secret is set', async () => {
    const secret = 'shh-this-is-a-test-secret';
    const emitter = createWebhookEmitter({
      getSettings: () =>
        settings({ securityWebhookUrl: receiver.url, securityWebhookSecret: secret }),
    });
    emitter.emit(event());
    await vi.waitFor(() => expect(receiver.requests.length).toBe(1), { timeout: 2000 });
    const got = receiver.requests[0]!;
    const expected = `sha256=${createHmac('sha256', secret).update(got.body).digest('hex')}`;
    expect(got.headers['x-sentinel-signature']).toBe(expected);
    emitter.close();
  });

  it('omits the signature header when no secret is configured', async () => {
    const emitter = createWebhookEmitter({
      getSettings: () => settings({ securityWebhookUrl: receiver.url }),
    });
    emitter.emit(event());
    await vi.waitFor(() => expect(receiver.requests.length).toBe(1), { timeout: 2000 });
    expect(receiver.requests[0]!.headers['x-sentinel-signature']).toBeUndefined();
    emitter.close();
  });

  it('drops events on a 4xx response without retrying', async () => {
    receiver.statusQueue.push(400);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const emitter = createWebhookEmitter({
      getSettings: () => settings({ securityWebhookUrl: receiver.url }),
    });
    emitter.emit(event());
    await vi.waitFor(() => expect(receiver.requests.length).toBe(1), { timeout: 2000 });
    // Give a short window for any retry to (incorrectly) fire.
    await new Promise((r) => setTimeout(r, 100));
    expect(receiver.requests).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/returned 400 — not retrying/));
    warnSpy.mockRestore();
    emitter.close();
  });

  it('does not POST when the webhook URL is null', async () => {
    const emitter = createWebhookEmitter({
      getSettings: () => settings({ securityWebhookUrl: null }),
    });
    emitter.emit(event());
    await new Promise((r) => setTimeout(r, 50));
    expect(receiver.requests).toHaveLength(0);
    emitter.close();
  });

  it('drops events when the queue is full (back-pressure)', async () => {
    // Force the receiver to never respond in time so the queue backs up.
    // We saturate the rate-limit bucket to keep the queue from draining.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const virtualNow = 1_000_000;
    const emitter = createWebhookEmitter({
      getSettings: () => settings({ securityWebhookUrl: receiver.url }),
      now: () => virtualNow,
    });
    // Burn all 10 tokens by emitting 10 events; further ones hit
    // the rate-limit drop branch since the bucket is empty and
    // `now` is frozen so no refill happens.
    for (let i = 0; i < 10; i += 1) emitter.emit(event());
    emitter.emit(event());
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/rate-limited/));
    warnSpy.mockRestore();
    emitter.close();
  });

  it('retries on 5xx then succeeds when a later attempt returns 200', async () => {
    receiver.statusQueue.push(500, 503, 200);
    const emitter = createWebhookEmitter({
      getSettings: () => settings({ securityWebhookUrl: receiver.url }),
      // Tight delays so the test runs in <100ms instead of >20s.
      retryDelaysMs: [5, 5, 5],
    });
    emitter.emit(event());
    await vi.waitFor(() => expect(receiver.requests.length).toBe(3), { timeout: 2000 });
    emitter.close();
  });

  it('logs and gives up after the retry budget is exhausted', async () => {
    receiver.statusQueue.push(500, 500, 500, 500);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const emitter = createWebhookEmitter({
      getSettings: () => settings({ securityWebhookUrl: receiver.url }),
      retryDelaysMs: [5, 5, 5],
    });
    emitter.emit(event());
    await vi.waitFor(() => expect(receiver.requests.length).toBe(4), { timeout: 2000 });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/delivery failed after retries.*status=500/),
    );
    warnSpy.mockRestore();
    emitter.close();
  });

  it('logs the network=... reason when every attempt errors out without a response', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const networkErr = new TypeError('fetch failed');
    const emitter = createWebhookEmitter({
      getSettings: () => settings({ securityWebhookUrl: receiver.url }),
      retryDelaysMs: [1, 1, 1],
      fetchImpl: () => Promise.reject(networkErr),
    });
    emitter.emit(event());
    // Wait until the warn line has fired (after all 4 attempts).
    await vi.waitFor(
      () => {
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringMatching(/delivery failed after retries.*network=fetch failed/),
        );
      },
      { timeout: 2000 },
    );
    warnSpy.mockRestore();
    emitter.close();
  });

  it('drops queued items when emit() is called after close()', async () => {
    const emitter = createWebhookEmitter({
      getSettings: () => settings({ securityWebhookUrl: receiver.url }),
    });
    emitter.close();
    emitter.emit(event());
    await new Promise((r) => setTimeout(r, 30));
    expect(receiver.requests).toHaveLength(0);
    expect(emitter._queueDepth()).toBe(0);
  });

  it('drops events when the queue is full', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Fetch impl that never resolves so the drain loop holds in-flight
    // forever; subsequent emits stack up in the queue.
    const resolverHolder: { resolve: ((v: Response) => void) | null } = { resolve: null };
    const fakeFetch: typeof fetch = () =>
      new Promise<Response>((r) => {
        resolverHolder.resolve = r;
      });
    const emitter = createWebhookEmitter({
      getSettings: () => settings({ securityWebhookUrl: receiver.url }),
      fetchImpl: fakeFetch,
    });
    // First emit consumes a token and starts draining (and blocks on fetch).
    emitter.emit(event());
    // Now spam events to fill the queue past the cap. The token bucket
    // starts at 10, so we have 9 more "free" emits before rate-limiting
    // would kick in. We reach the queue-full branch by emitting >100
    // batched calls — but need to keep tokens available, so refresh
    // the bucket by feeding a clock that always returns "future".
    const baseNow = Date.now();
    let virtualClock = baseNow;
    const emitter2 = createWebhookEmitter({
      getSettings: () => settings({ securityWebhookUrl: receiver.url }),
      fetchImpl: fakeFetch,
      now: () => virtualClock,
    });
    // First emit starts the in-flight fetch and consumes one token.
    emitter2.emit(event());
    // Bump the clock so the bucket refills; loop until queue is full.
    for (let i = 0; i < 200; i += 1) {
      virtualClock += 6_000;
      emitter2.emit(event());
    }
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/queue full/));
    // Resolve the dangling fetch so the test runner can exit.
    resolverHolder.resolve?.(new Response('{}', { status: 200 }));
    warnSpy.mockRestore();
    emitter.close();
    emitter2.close();
  });
});
