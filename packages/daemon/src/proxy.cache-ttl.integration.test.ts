/**
 * Migrated from `proxy.test.ts` — cache-TTL capture from upstream SSE /
 * JSON responses. The original tests used hand-crafted mock chunk
 * delivery via `dataListeners/endListeners`. Here the fake's
 * `sseEvents` knob emits real SSE frames over a real TCP connection,
 * and the proxy's real SseUsageExtractor sees them chunk-by-chunk.
 *
 * We use a test settings file so `cacheTtlForceOneHour` is OFF (the
 * running user's live setting was leaking into the old unit tests and
 * rewriting 5m markers to 1h before the SSE parser could count them).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';

describe('proxy cache-TTL capture (real HTTP, real SSE)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('inserts a cache_ttl_events row from an SSE message_delta usage payload', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-1', email: 'a1@example.com', token: 'integration-token' }],
      settings: { cacheTtlForceOneHour: false },
    });

    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: [
        {
          event: 'message_start',
          data: {
            type: 'message_start',
            message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1 } },
          },
        },
        {
          event: 'message_delta',
          data: {
            type: 'message_delta',
            usage: {
              input_tokens: 1,
              cache_creation: {
                ephemeral_5m_input_tokens: 1000,
                ephemeral_1h_input_tokens: 2000,
              },
              cache_read_input_tokens: 500,
              output_tokens: 42,
            },
          },
        },
      ],
    });

    await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-sonnet-4-6',
      system: [
        { type: 'text', text: 'instr', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'tail', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { user_id: JSON.stringify({ session_id: 'sess-ABC', account_uuid: 'u1' }) },
    });
    await new Promise((r) => setTimeout(r, 60));

    const rows = ctx.db.prepare('SELECT * FROM cache_ttl_events').all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: 'acct-1',
      session_id: 'sess-ABC',
      model: 'claude-sonnet-4-6',
      req_markers_5m: 1,
      req_markers_1h: 1,
      cache_create_5m: 1000,
      cache_create_1h: 2000,
      cache_read: 500,
      input_tokens: 1,
    });
    // Cost fields: 1000 tokens 5m = 1000/1e6 * 3 * 1.25 = 0.00375
    expect(rows[0]?.['cost_5m_write']).toBeCloseTo(0.00375, 6);
    // 2000 tokens 1h = 2000/1e6 * 3 * 2.0 = 0.012
    expect(rows[0]?.['cost_1h_write']).toBeCloseTo(0.012, 6);
    // 500 tokens read = 500/1e6 * 3 * 0.1 = 0.00015
    expect(rows[0]?.['cost_read']).toBeCloseTo(0.00015, 6);
    expect(ctx.ipcServer.broadcasts.some((c) => c.type === 'metrics_updated')).toBe(true);
  });

  it('skips the insert when no usage arrives in the SSE stream', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-2', email: 'a2@example.com', token: 'integration-token' }],
      settings: { cacheTtlForceOneHour: false },
    });

    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: [{ event: 'ping', data: { type: 'ping' } }],
    });

    await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'm',
      messages: [],
    });
    await new Promise((r) => setTimeout(r, 60));

    const row = ctx.db.prepare('SELECT COUNT(*) AS n FROM cache_ttl_events').get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('falls back to JSON parsing for non-SSE responses', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-3', email: 'a3@example.com', token: 'integration-token' }],
      settings: { cacheTtlForceOneHour: false },
    });

    ctx.fake.queueResponse('/v1/messages', {
      body: {
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 4,
          cache_creation: {
            ephemeral_5m_input_tokens: 10,
            ephemeral_1h_input_tokens: 0,
          },
          cache_read_input_tokens: 7,
          output_tokens: 1,
        },
      },
    });

    await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [],
      metadata: { user_id: JSON.stringify({ session_id: 'sess-JSON' }) },
    });
    await new Promise((r) => setTimeout(r, 60));

    const row = ctx.db.prepare('SELECT * FROM cache_ttl_events').get() as Record<string, unknown>;
    expect(row).toMatchObject({
      account_id: 'acct-3',
      session_id: 'sess-JSON',
      model: 'claude-opus-4-7',
      cache_create_5m: 10,
      cache_create_1h: 0,
      cache_read: 7,
    });
  });

  it('skips count_tokens paths', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-4', email: 'a4@example.com', token: 'integration-token' }],
      settings: { cacheTtlForceOneHour: false },
    });

    // The fake's /v1/count_tokens handler returns a default non-usage body;
    // we don't need a queued override for this path. The proxy skips
    // cache-TTL accounting when the URL contains 'count_tokens'.
    await postThroughProxy(ctx.proxyPort, '/v1/messages/count_tokens', {});
    await new Promise((r) => setTimeout(r, 60));

    const row = ctx.db.prepare('SELECT COUNT(*) AS n FROM cache_ttl_events').get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('skips cache-TTL capture when the non-SSE body exceeds the 256 KB parse cap', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-huge', email: 'huge@example.com', token: 'integration-token' }],
      settings: { cacheTtlForceOneHour: false },
    });

    // 300 KB body — the proxy's non-SSE parser caps at 256 KB and skips
    // the insert when crossed. Covers the early-return branch in
    // feedCacheTtl (proxy.ts ~line 871).
    ctx.fake.queueResponse('/v1/messages', { bodySizeBytes: 300_000 });

    await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [],
    });
    await new Promise((r) => setTimeout(r, 100));

    const row = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM cache_ttl_events WHERE account_id = ?')
      .get('acct-huge') as { n: number };
    expect(row.n).toBe(0);
  });

  it('debounces the metrics_updated broadcast to one per window per account', async () => {
    ctx = await startProxyWithFake({
      accounts: [
        { id: 'acct-debounce', email: 'debounce@example.com', token: 'integration-token' },
      ],
      settings: { cacheTtlForceOneHour: false },
    });

    // Two back-to-back SSE responses with usage markers. The second must
    // NOT trigger a second metrics_updated inside the 1 s debounce window.
    for (let i = 0; i < 2; i++) {
      ctx.fake.queueResponse('/v1/messages', {
        sseEvents: [
          {
            event: 'message_delta',
            data: { type: 'message_delta', usage: { cache_read_input_tokens: 1 } },
          },
        ],
      });
      await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
      await new Promise((r) => setTimeout(r, 40));
    }

    const metricsFires = ctx.ipcServer.broadcasts.filter(
      (c) => c.type === 'metrics_updated',
    ).length;
    expect(metricsFires).toBe(1);

    const rowCount = (
      ctx.db.prepare('SELECT COUNT(*) AS n FROM cache_ttl_events').get() as { n: number }
    ).n;
    expect(rowCount).toBe(2);
  });
});
