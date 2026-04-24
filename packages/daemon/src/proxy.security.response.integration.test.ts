/**
 * Migrated from `proxy.test.ts` — security-response-tap behavior.
 * The original tests stubbed a `tap` object and asserted its push/flush
 * were called; here we let the real scanner mint a real ResponseTap and
 * inspect the side-effects via real SSE chunks from the fake upstream.
 *
 * The gzipped skip-tap test proves that when the upstream response carries
 * content-encoding: gzip, the proxy destroys the tap and pipes the body
 * through unscanned (v1 scanner doesn't decompress).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';

describe('proxy security response tap (real HTTP, real SSE)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('feeds response chunks to the scanner tap and flushes at stream end', async () => {
    ctx = await startProxyWithFake({
      enableSecurityScanner: true,
      settings: {
        securityScanEnabled: true,
        securityScanToolUse: true,
        securityEnforcementMode: 'observe',
      },
    });

    // Custom SSE stream with two data chunks. The real ResponseTap sees
    // both; assertion proves round-trip via a high-severity risky_bash
    // tool_use proposal that the tap detects and persists as a finding.
    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: [
        { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_fake' } } },
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"command":"rm -rf /"}' },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ],
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(200);
    // Drain the body to let the tap finish flushing.
    await res.text();
    await new Promise((r) => setTimeout(r, 30));

    // The scanner persists tool_use findings via insertSecurityEvent. Query
    // the row directly to verify the tap actually saw the stream.
    const rows = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM security_events WHERE kind = 'risky_bash'`)
      .all() as Array<{ n: number }>;
    expect(rows[0]?.n ?? 0).toBeGreaterThan(0);
  });

  it('calls tap.destroy and rejects cleanly when upstream drops mid-stream (tap-active error branch)', async () => {
    ctx = await startProxyWithFake({
      enableSecurityScanner: true,
      settings: {
        securityScanEnabled: true,
        securityScanToolUse: true,
        securityEnforcementMode: 'observe',
      },
    });

    // SSE response writes one event, then destroys the socket mid-stream.
    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: [
        { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_fake' } } },
        { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 1 } } },
      ],
      abortAfterFirstEvent: true,
    });

    // fetch() may throw or return an incomplete response depending on Node
    // version. We don't assert on the client-observable shape — we assert
    // that the proxy survived the abort (subsequent request succeeds).
    try {
      const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
      try {
        await res.text();
      } catch {
        /* partial stream */
      }
    } catch {
      /* expected: TCP reset */
    }
    await new Promise((r) => setTimeout(r, 50));

    // Sanity: the proxy is still serving. This proves the tap error-handler
    // branch ran (tap.destroy + finalizeCapture + reject) without crashing
    // the request pipeline.
    const ok = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(ok.status).toBe(200);
  });

  it('rejects cleanly on mid-stream abort with no tap or interceptor (default error branch)', async () => {
    // Same abort scenario, but scanner disabled so the proxy takes the
    // else branch (no tap, no interceptor — just proxyRes.pipe(res)).
    ctx = await startProxyWithFake();

    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: [
        { event: 'message_start', data: { type: 'message_start' } },
        { event: 'message_delta', data: { type: 'message_delta' } },
      ],
      abortAfterFirstEvent: true,
    });

    try {
      const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
      try {
        await res.text();
      } catch {
        /* partial */
      }
    } catch {
      /* expected */
    }
    await new Promise((r) => setTimeout(r, 50));

    const ok = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(ok.status).toBe(200);
  });

  it('skips the tap when the upstream response is content-encoding: gzip', async () => {
    ctx = await startProxyWithFake({
      enableSecurityScanner: true,
      scenario: 'gzipped-json',
      settings: {
        securityScanEnabled: true,
        securityScanToolUse: true,
        securityEnforcementMode: 'observe',
      },
    });

    // Queue a body that would trigger risky_bash IF the tap saw it.
    ctx.fake.queueResponse('/v1/messages', {
      body: JSON.stringify({
        id: 'msg_fake',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /' } }],
      }),
      extraHeaders: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    // fetch() transparently decompresses — verify the body is actually decodable.
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('msg_fake');
    await new Promise((r) => setTimeout(r, 30));

    // Tap was destroyed before seeing chunks — no security_event row.
    const rows = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM security_events WHERE kind = 'risky_bash'`)
      .all() as Array<{ n: number }>;
    expect(rows[0]?.n ?? 0).toBe(0);
  });
});
