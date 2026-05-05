/**
 * Real-listener tests for OtelForwarder. The mock-budget gate forbids
 * mocking internal modules or overriding global fetch, so every test
 * below spins up an `http.createServer` to act as the user's external
 * observability backend (e.g. SigNoz). The forwarder hits it via real
 * `fetch`. This is the same pattern `alerting/webhook.ts` uses.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { OtelForwarder } from './otel-forwarder.js';
import {
  deleteOtelExporterSecret,
  hasOtelExporterSecret,
  writeOtelExporterSecret,
} from './otel-forwarder-secret.js';
import { DEFAULT_SETTINGS } from './settings.js';
import type { Settings } from '@claude-sentinel/shared';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

interface FakeUpstream {
  server: Server;
  url: string;
  received: CapturedRequest[];
}

async function startFake(
  handler: (req: IncomingMessage, body: Buffer) => Promise<{ status: number; body?: string }>,
): Promise<FakeUpstream> {
  const received: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      received.push({
        url: req.url ?? '',
        method: req.method ?? '',
        headers: req.headers,
        body,
      });
      handler(req, body)
        .then((reply) => {
          res.writeHead(reply.status);
          res.end(reply.body ?? '');
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('listen failed');
  return { server, url: `http://127.0.0.1:${addr.port}`, received };
}

function stopFake(fake: FakeUpstream): Promise<void> {
  return new Promise((resolve) => fake.server.close(() => resolve()));
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

/** Wait until a predicate flips true, or until `timeoutMs` elapses.
 *  Avoids fixed `setTimeout` waits that race the network. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

describe('OtelForwarder', () => {
  let kchainDir: string;

  beforeEach(() => {
    kchainDir = mkdtempSync(join(tmpdir(), 'otel-forwarder-test-'));
    const kchain = join(kchainDir, 'keychain.json');
    writeFileSync(kchain, '{}');
    process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE = kchain;
  });

  afterEach(() => {
    delete process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE;
    rmSync(kchainDir, { force: true, recursive: true });
  });

  it('happy path: forwards body and injects auth header', async () => {
    writeOtelExporterSecret('shh-key-value');
    const fake = await startFake(async () => ({ status: 200, body: '{}' }));
    try {
      const fw = new OtelForwarder({
        getSettings: () =>
          makeSettings({
            otelForwardingEnabled: true,
            otelForwardMetrics: true,
            otelForwardLogs: true,
            otelExporterEndpoint: fake.url,
            otelExporterHeaderName: 'signoz-ingestion-key',
          }),
      });
      const body = Buffer.from(
        JSON.stringify({ resourceMetrics: [{ tag: 'unique-payload-marker' }] }),
      );
      fw.forward('/v1/metrics', 'application/json', body);

      await waitFor(() => fw.getStatus().sent === 1);

      expect(fake.received).toHaveLength(1);
      const captured = fake.received[0]!;
      expect(captured.method).toBe('POST');
      expect(captured.url).toBe('/v1/metrics');
      expect(captured.headers['signoz-ingestion-key']).toBe('shh-key-value');
      expect(captured.headers['content-type']).toBe('application/json');
      // Body must be forwarded verbatim — preserves Claude Code's
      // resource attributes that downstream depends on.
      expect(captured.body.toString('utf-8')).toBe(body.toString('utf-8'));
      expect(fw.getStatus().sent).toBe(1);
      expect(fw.getStatus().lastForwardErr).toBeNull();
    } finally {
      await stopFake(fake);
    }
  });

  it('disabled by default: no outbound HTTP fires', async () => {
    writeOtelExporterSecret('s');
    const fake = await startFake(async () => ({ status: 200 }));
    try {
      const fw = new OtelForwarder({
        getSettings: () => makeSettings({ otelExporterEndpoint: fake.url }),
      });
      fw.forward('/v1/metrics', 'application/json', Buffer.from('{}'));
      // Wait long enough that any in-flight network call would land.
      await new Promise((r) => setTimeout(r, 50));
      expect(fake.received).toHaveLength(0);
      expect(fw.getStatus().sent).toBe(0);
    } finally {
      await stopFake(fake);
    }
  });

  it('no-op when secret is missing: status reports not-ready', async () => {
    const fake = await startFake(async () => ({ status: 200 }));
    try {
      const fw = new OtelForwarder({
        getSettings: () =>
          makeSettings({
            otelForwardingEnabled: true,
            otelForwardMetrics: true,
            otelExporterEndpoint: fake.url,
          }),
      });
      fw.forward('/v1/metrics', 'application/json', Buffer.from('{}'));
      await new Promise((r) => setTimeout(r, 50));
      expect(fake.received).toHaveLength(0);
      const status = fw.getStatus();
      expect(status.secretConfigured).toBe(false);
      expect(status.ready).toBe(false);
    } finally {
      await stopFake(fake);
    }
  });

  it('secret roundtrip: write → status configured; clear → not configured', () => {
    const fw = new OtelForwarder({ getSettings: () => DEFAULT_SETTINGS });
    expect(fw.getStatus().secretConfigured).toBe(false);
    writeOtelExporterSecret('abc-123');
    expect(hasOtelExporterSecret()).toBe(true);
    fw.onSecretChanged();
    expect(fw.getStatus().secretConfigured).toBe(true);
    deleteOtelExporterSecret();
    fw.onSecretChanged();
    expect(fw.getStatus().secretConfigured).toBe(false);
  });

  it('upstream 4xx: failed counter increments and lastForwardErr is populated', async () => {
    writeOtelExporterSecret('s');
    const fake = await startFake(async () => ({ status: 401, body: 'invalid key' }));
    try {
      const fw = new OtelForwarder({
        getSettings: () =>
          makeSettings({
            otelForwardingEnabled: true,
            otelForwardMetrics: true,
            otelExporterEndpoint: fake.url,
            otelExporterHeaderName: 'k',
          }),
      });
      fw.forward('/v1/metrics', 'application/json', Buffer.from('{}'));
      await waitFor(() => fw.getStatus().failed === 1);
      const status = fw.getStatus();
      expect(status.failed).toBe(1);
      expect(status.sent).toBe(0);
      expect(status.lastForwardErr).toContain('401');
    } finally {
      await stopFake(fake);
    }
  });

  it('split toggles: forward metrics off and forward logs on relays only logs', async () => {
    writeOtelExporterSecret('s');
    const fake = await startFake(async () => ({ status: 200 }));
    try {
      const fw = new OtelForwarder({
        getSettings: () =>
          makeSettings({
            otelForwardingEnabled: true,
            otelForwardMetrics: false,
            otelForwardLogs: true,
            otelExporterEndpoint: fake.url,
            otelExporterHeaderName: 'k',
          }),
      });
      fw.forward('/v1/metrics', 'application/json', Buffer.from('{}'));
      fw.forward('/v1/logs', 'application/json', Buffer.from('{}'));
      await waitFor(() => fw.getStatus().sent === 1);
      expect(fake.received).toHaveLength(1);
      expect(fake.received[0]!.url).toBe('/v1/logs');
    } finally {
      await stopFake(fake);
    }
  });

  it('backpressure: hung upstream drops past in-flight cap with counter bump', async () => {
    writeOtelExporterSecret('s');
    // Each request hangs forever; we'll close the server to release them.
    let pendingCount = 0;
    const fake = await startFake(
      () =>
        new Promise(() => {
          pendingCount += 1;
        }),
    );
    try {
      const fw = new OtelForwarder({
        getSettings: () =>
          makeSettings({
            otelForwardingEnabled: true,
            otelForwardMetrics: true,
            otelExporterEndpoint: fake.url,
            otelExporterHeaderName: 'k',
          }),
        maxInFlight: 2,
        timeoutMs: 60_000,
      });
      // 4 concurrent forwards: 2 should be in-flight, 2 dropped.
      fw.forward('/v1/metrics', 'application/json', Buffer.from('{}'));
      fw.forward('/v1/metrics', 'application/json', Buffer.from('{}'));
      fw.forward('/v1/metrics', 'application/json', Buffer.from('{}'));
      fw.forward('/v1/metrics', 'application/json', Buffer.from('{}'));
      // Backpressure decision is synchronous, so the dropped count is
      // exact at this point.
      expect(fw.getStatus().dropped).toBe(2);
      expect(fw.getStatus().inFlight).toBe(2);
      void pendingCount;
    } finally {
      // Forcefully close so the hung fetches reject and unblock test cleanup.
      fake.server.closeAllConnections?.();
      await stopFake(fake);
    }
  });

  it('testConnection reports not-configured paths cleanly', async () => {
    const fw = new OtelForwarder({ getSettings: () => DEFAULT_SETTINGS });
    const noEndpoint = await fw.testConnection();
    expect(noEndpoint.ok).toBe(false);
    expect(noEndpoint.message).toBe('no endpoint configured');
    const fake = await startFake(async () => ({ status: 200 }));
    try {
      const fw2 = new OtelForwarder({
        getSettings: () =>
          makeSettings({
            otelExporterEndpoint: fake.url,
            otelExporterHeaderName: 'k',
          }),
      });
      const noSecret = await fw2.testConnection();
      expect(noSecret.ok).toBe(false);
      expect(noSecret.message).toBe('no secret stored');
      writeOtelExporterSecret('test-key');
      const okResult = await fw2.testConnection();
      expect(okResult.ok).toBe(true);
      expect(okResult.status).toBe(200);
      // Probe must hit /v1/metrics and carry the auth header.
      expect(fake.received).toHaveLength(1);
      expect(fake.received[0]!.url).toBe('/v1/metrics');
      expect(fake.received[0]!.headers.k).toBe('test-key');
    } finally {
      await stopFake(fake);
    }
  });

  it('onStatusChange returns an unsubscriber that detaches the listener', () => {
    const fw = new OtelForwarder({ getSettings: () => DEFAULT_SETTINGS });
    const calls: number[] = [];
    const unsub = fw.onStatusChange(() => calls.push(1));
    fw.onSecretChanged();
    expect(calls.length).toBe(1);
    unsub();
    fw.onSecretChanged();
    expect(calls.length).toBe(1); // didn't fire again
  });

  it('a throwing status listener does not break the dispatch path', async () => {
    writeOtelExporterSecret('s');
    const fake = await startFake(async () => ({ status: 200 }));
    try {
      const fw = new OtelForwarder({
        getSettings: () =>
          makeSettings({
            otelForwardingEnabled: true,
            otelForwardMetrics: true,
            otelExporterEndpoint: fake.url,
            otelExporterHeaderName: 'k',
          }),
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      fw.onStatusChange(() => {
        throw new Error('listener boom');
      });
      const goodCalls: number[] = [];
      fw.onStatusChange((s) => goodCalls.push(s.sent));
      fw.forward('/v1/metrics', 'application/json', Buffer.from('{}'));
      await waitFor(() => fw.getStatus().sent === 1);
      // The good listener still ran despite the bad one throwing.
      expect(goodCalls.length).toBeGreaterThan(0);
      errorSpy.mockRestore();
    } finally {
      await stopFake(fake);
    }
  });

  it('status listener fires on dispatch outcome and on secret change', async () => {
    writeOtelExporterSecret('s');
    const fake = await startFake(async () => ({ status: 200 }));
    try {
      const fw = new OtelForwarder({
        getSettings: () =>
          makeSettings({
            otelForwardingEnabled: true,
            otelForwardMetrics: true,
            otelExporterEndpoint: fake.url,
            otelExporterHeaderName: 'k',
          }),
      });
      const updates: number[] = [];
      fw.onStatusChange((status) => updates.push(status.sent));
      fw.forward('/v1/metrics', 'application/json', Buffer.from('{}'));
      await waitFor(() => updates.length > 0);
      expect(updates[updates.length - 1]).toBe(1);
      // Secret-change notification — sent count unchanged but listener runs.
      const before = updates.length;
      fw.onSecretChanged();
      expect(updates.length).toBe(before + 1);
    } finally {
      await stopFake(fake);
    }
  });
});
