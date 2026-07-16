/**
 * Optimize feature: end-to-end capture of tool_use blocks from a real
 * SSE response over a real TCP connection.
 *
 * Verifies the proxy's tool-call-extractor wire-up actually lands rows
 * in the `tool_calls` table when /v1/messages streams a tool_use, and
 * that turning the kill switch off makes the recorder a no-op.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';
import { _resetSessionSeqsForTest } from './optimize/tool-call-extractor.js';

describe('proxy Optimize tool-call capture (real HTTP, real SSE)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    _resetSessionSeqsForTest();
    if (ctx) await ctx.cleanup();
  });

  it('records a Read tool_use from an SSE response into tool_calls', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-1', email: 'a1@example.com', token: 'integration-token' }],
      settings: { optimizeCaptureEnabled: true },
    });

    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: [
        {
          event: 'message_start',
          data: {
            type: 'message_start',
            message: { model: 'claude-opus-4-7', usage: { input_tokens: 1 } },
          },
        },
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'toolu_real_01',
              name: 'Read',
              input: {},
            },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path":"/etc/hosts"}' },
          },
        },
        {
          event: 'content_block_stop',
          data: { type: 'content_block_stop', index: 0 },
        },
        { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 5 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ],
    });

    await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'read /etc/hosts' }],
      metadata: { user_id: JSON.stringify({ session_id: 'sess-OPT', account_uuid: 'u1' }) },
    });
    await new Promise((r) => setTimeout(r, 80));

    const rows = ctx.db
      .prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY id ASC')
      .all('sess-OPT') as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: 'acct-1',
      session_id: 'sess-OPT',
      tool_use_id: 'toolu_real_01',
      tool_name: 'Read',
      file_path: '/etc/hosts',
      model: 'claude-opus-4-7',
      denied: 0,
    });
    expect((rows[0]?.['input_size_bytes'] as number) ?? 0).toBeGreaterThan(0);
    // request_seq_in_session is monotonic per session; first request = 1.
    expect(rows[0]?.['request_seq_in_session']).toBe(1);
  });

  it('does not record any tool_calls when optimizeCaptureEnabled=false', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-off', email: 'off@example.com', token: 'integration-token' }],
      settings: { optimizeCaptureEnabled: false },
    });

    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: [
        {
          event: 'message_start',
          data: {
            type: 'message_start',
            message: { model: 'claude-opus-4-7', usage: { input_tokens: 1 } },
          },
        },
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_off', name: 'Read', input: {} },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path":"/x"}' },
          },
        },
        {
          event: 'content_block_stop',
          data: { type: 'content_block_stop', index: 0 },
        },
        { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 1 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ],
    });

    await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'x' }],
      metadata: { user_id: JSON.stringify({ session_id: 'sess-DARK', account_uuid: 'u1' }) },
    });
    await new Promise((r) => setTimeout(r, 80));

    const row = ctx.db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get() as { n: number };
    expect(row.n).toBe(0);
  });

  it('backfills response_size_bytes on the next request when tool_result arrives', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-bk', email: 'bk@example.com', token: 'integration-token' }],
      settings: { optimizeCaptureEnabled: true },
    });

    // First request: model emits a tool_use(Read)
    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: [
        {
          event: 'message_start',
          data: {
            type: 'message_start',
            message: { model: 'claude-opus-4-7', usage: { input_tokens: 1 } },
          },
        },
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_bk_01', name: 'Read', input: {} },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path":"/var/log/system.log"}' },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 1 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ],
    });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'inspect logs' }],
      metadata: { user_id: JSON.stringify({ session_id: 'sess-BK', account_uuid: 'u1' }) },
    });
    await new Promise((r) => setTimeout(r, 80));

    const rowsBefore = ctx.db
      .prepare('SELECT * FROM tool_calls WHERE session_id = ?')
      .all('sess-BK') as Array<Record<string, unknown>>;
    expect(rowsBefore).toHaveLength(1);
    expect(rowsBefore[0]?.['response_size_bytes']).toBeNull();

    // Second request: client sends back the tool_result for that toolu_bk_01.
    // This must trigger applyToolResultBackfill before the proxy forwards.
    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: [
        {
          event: 'message_start',
          data: {
            type: 'message_start',
            message: { model: 'claude-opus-4-7', usage: { input_tokens: 100 } },
          },
        },
        { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 5 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ],
    });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'inspect logs' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_bk_01',
              name: 'Read',
              input: { path: '/var/log/system.log' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_bk_01',
              content: 'log contents log contents log contents',
            },
            { type: 'text', text: 'now what should we do?' },
          ],
        },
      ],
      metadata: { user_id: JSON.stringify({ session_id: 'sess-BK', account_uuid: 'u1' }) },
    });
    await new Promise((r) => setTimeout(r, 80));

    const rowsAfter = ctx.db
      .prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY id ASC')
      .all('sess-BK') as Array<Record<string, unknown>>;
    expect(rowsAfter).toHaveLength(1);
    expect(rowsAfter[0]?.['response_size_bytes']).toBe(
      'log contents log contents log contents'.length,
    );
    // file_path was not quoted in the next turn ("now what should we do?"
    // doesn't mention /var/log/system.log) — should be 0.
    expect(rowsAfter[0]?.['was_quoted_in_later_turn']).toBe(0);
  });

  it('invokes onToolCallsFlushed exactly once per response with tool_uses', async () => {
    let flushCount = 0;
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-flush', email: 'f@example.com', token: 'integration-token' }],
      settings: { optimizeCaptureEnabled: true },
      onToolCallsFlushed: () => {
        flushCount += 1;
      },
    });
    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: [
        {
          event: 'message_start',
          data: {
            type: 'message_start',
            message: { model: 'claude-opus-4-7', usage: { input_tokens: 1 } },
          },
        },
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_flush', name: 'Read', input: {} },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path":"/x"}' },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 1 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ],
    });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'go' }],
      metadata: { user_id: JSON.stringify({ session_id: 'sess-FLUSH', account_uuid: 'u1' }) },
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(flushCount).toBe(1);
  });

  it('does not invoke onToolCallsFlushed when the response has no tool_uses', async () => {
    let flushCount = 0;
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-noflush', email: 'nf@example.com', token: 'integration-token' }],
      settings: { optimizeCaptureEnabled: true },
      onToolCallsFlushed: () => {
        flushCount += 1;
      },
    });
    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: [
        {
          event: 'message_start',
          data: {
            type: 'message_start',
            message: { model: 'claude-opus-4-7', usage: { input_tokens: 1 } },
          },
        },
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'just thinking' },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 5 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ],
    });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'thoughts?' }],
      metadata: { user_id: JSON.stringify({ session_id: 'sess-NOFLUSH', account_uuid: 'u1' }) },
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(flushCount).toBe(0);
  });

  it('strips accept-encoding from /v1/messages so upstream cannot compress the SSE stream', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-ae', email: 'ae@example.com', token: 'integration-token' }],
      settings: { optimizeCaptureEnabled: true },
    });

    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: [
        {
          event: 'message_start',
          data: {
            type: 'message_start',
            message: { model: 'claude-opus-4-7', usage: { input_tokens: 1 } },
          },
        },
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_ae_01', name: 'Grep', input: {} },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"pattern":"needle"}' },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 5 } } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ],
    });

    // Real-world shape: claude-cli ≥ 2.1.211 advertises compression on
    // conversation requests; if the header reaches upstream, the SSE body
    // comes back gzip-encoded and every response observer goes blind.
    await postThroughProxy(
      ctx.proxyPort,
      '/v1/messages',
      {
        model: 'claude-opus-4-7',
        messages: [{ role: 'user', content: 'grep for needle' }],
        metadata: { user_id: JSON.stringify({ session_id: 'sess-STRIP', account_uuid: 'u1' }) },
      },
      { headers: { 'accept-encoding': 'gzip, deflate, br, zstd' } },
    );
    await new Promise((r) => setTimeout(r, 80));

    const upstream = ctx.fake
      .requests()
      .filter((r) => r.method === 'POST' && r.url.startsWith('/v1/messages'));
    expect(upstream).toHaveLength(1);
    expect(upstream[0]?.headers['accept-encoding']).toBeUndefined();

    // And with identity encoding negotiated, extraction works end to end.
    const rows = ctx.db
      .prepare('SELECT tool_use_id, tool_name FROM tool_calls WHERE session_id = ?')
      .all('sess-STRIP') as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool_use_id: 'toolu_ae_01', tool_name: 'Grep' });
  });

  it('records tool_use blocks from a non-streaming JSON response', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-ns', email: 'ns@example.com', token: 'integration-token' }],
      settings: { optimizeCaptureEnabled: true },
    });

    // Real-world shape: Claude Code retries a turn stream-less after
    // repeated 429/529/SSE-error responses; the reply is then one
    // complete application/json message carrying the tool_use blocks.
    ctx.fake.queueResponse('/v1/messages', {
      body: JSON.stringify({
        id: 'msg_ns_01',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [
          { type: 'text', text: 'Reading the file.' },
          { type: 'tool_use', id: 'toolu_ns_01', name: 'Read', input: { path: '/etc/hosts' } },
          { type: 'tool_use', id: 'toolu_ns_02', name: 'Bash', input: { command: 'ls -la' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      // stream deliberately omitted — the non-streaming fallback shape.
      messages: [{ role: 'user', content: 'read /etc/hosts' }],
      metadata: { user_id: JSON.stringify({ session_id: 'sess-NS', account_uuid: 'u1' }) },
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 80));

    const rows = ctx.db
      .prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY id ASC')
      .all('sess-NS') as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      account_id: 'acct-ns',
      tool_use_id: 'toolu_ns_01',
      tool_name: 'Read',
      file_path: '/etc/hosts',
      model: 'claude-opus-4-7',
    });
    expect(rows[1]).toMatchObject({
      tool_use_id: 'toolu_ns_02',
      tool_name: 'Bash',
      file_path: 'ls -la',
    });
  });

  it('does not record rows from a non-streaming error body', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-err', email: 'err@example.com', token: 'integration-token' }],
      settings: { optimizeCaptureEnabled: true },
    });

    ctx.fake.queueResponse('/v1/messages', {
      status: 529,
      body: JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      }),
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'anything' }],
      metadata: { user_id: JSON.stringify({ session_id: 'sess-ERR', account_uuid: 'u1' }) },
    });
    expect(res.status).toBe(529);
    await new Promise((r) => setTimeout(r, 80));

    const row = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ?')
      .get('sess-ERR') as { n: number };
    expect(row.n).toBe(0);
  });

  it('routes an encoded response away from the SSE observers and forwards it intact', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-gz', email: 'gz@example.com', token: 'integration-token' }],
      settings: { optimizeCaptureEnabled: true },
    });

    // Upstream misbehaves: gzip body despite identity negotiation. The
    // fake gzips `body` once because extraHeaders declares the encoding.
    const sseScript =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"model":"claude-opus-4-7","usage":{"input_tokens":1}}}\n\n' +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_gz_01","name":"Read","input":{}}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"/tmp/x\\"}"}}\n\n' +
      'event: content_block_stop\n' +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';
    ctx.fake.queueResponse('/v1/messages', {
      body: sseScript,
      extraHeaders: {
        'content-encoding': 'gzip',
        'content-type': 'text/event-stream; charset=utf-8',
      },
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'read /tmp/x' }],
      metadata: { user_id: JSON.stringify({ session_id: 'sess-GZ', account_uuid: 'u1' }) },
    });
    // fetch transparently decodes gzip, so an intact forward means the
    // client sees the original SSE script byte-for-byte.
    expect(await res.text()).toBe(sseScript);
    await new Promise((r) => setTimeout(r, 80));

    // The compressed bytes must not be fed to the extractor as SSE — no
    // rows, no garbage, no crash.
    const row = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE session_id = ?')
      .get('sess-GZ') as { n: number };
    expect(row.n).toBe(0);
  });
});
