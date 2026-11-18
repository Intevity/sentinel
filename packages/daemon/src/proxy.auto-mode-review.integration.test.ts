/**
 * Auto mode's server-side classifier review through the proxy, over real HTTP
 * against the fake upstream.
 *
 * Claude Code in auto mode asks the API to review each tool call: the request
 * carries a top-level `safeguards` field paired with a `dangerous-tool-use-*`
 * value in `anthropic-beta`, and the response answers in
 * `message_delta.delta.safeguard_results`, keyed by the response's tool_use
 * ids. Behind a gateway, a response that completes without those results ends
 * the review for the session, and from Claude Code's 2026-11-30 releases on
 * the session then asks the user to approve every action.
 *
 * What the proxy owes such a request: `anthropic-beta` upstream as sent, the
 * `safeguards` field byte-exact, the response streamed back byte-for-byte
 * (permission interceptor included), and a record on `/health` of whether the
 * review results came back.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import type { FakeSseEvent } from '@sentinel/test-harness';
import {
  startProxyWithFake,
  getThroughProxy,
  type StartedProxy,
  type StartProxyOpts,
} from './proxy.test-helpers.js';
import { CompressionStatsStore } from './optimize/compress/compression-stats-db.js';
import { upsertPermissionRule } from './db.js';
import { resetAutoModeReviewStats, type AutoModeReviewStats } from './auto-mode-review.js';
import { log } from './logger.js';

const ESC = '\x1b';
const CLI_UA = 'claude-cli/2.1.327 (external, cli)';
const REVIEW_BETA = 'dangerous-tool-use-2026-09-03';
/** The betas Claude Code sends in an auto mode session, as it sends them. */
const CC_BETA = `claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,${REVIEW_BETA}`;
const EXTENDED_TTL_BETA = 'extended-cache-ttl-2025-04-11';

const SAFEGUARDS = [
  {
    type: 'dangerous_tool_use',
    classifier_context: {
      v: 1,
      permission_mode: 'auto',
      platform: 'macos',
      live_cwd: '/Users/dev/café — 日本',
      rules: ['Bash(git push:*)', 'quote "inside" a rule'],
    },
  },
];

/** The earlier assistant turn's tool_use, which the request must carry intact. */
const PRIOR_TOOL_USE = {
  type: 'tool_use',
  id: 'toolu_prior',
  name: 'Bash',
  input: { command: 'echo "café — done"' },
};

/** A /v1/messages body shaped like Claude Code's in auto mode: a prior tool
 *  call with a compressible result, cache breakpoints, tools, and, when
 *  `reviewed`, the `safeguards` field. */
function claudeCodeBody(reviewed: boolean): Record<string, unknown> {
  const noisy = `${ESC}[32mbuild ok${ESC}[0m\n${'log line\n'.repeat(60)}`;
  return {
    model: 'claude-opus-5-5',
    max_tokens: 64,
    stream: true,
    system: [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=2.1.327.a1b; cc_entrypoint=cli;',
      },
      { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } },
    ],
    tools: [
      { name: 'Bash', description: 'Run a command', input_schema: { type: 'object' } },
      { name: 'WebFetch', description: 'Fetch a URL', input_schema: { type: 'object' } },
    ],
    messages: [
      { role: 'user', content: 'build it' },
      { role: 'assistant', content: [PRIOR_TOOL_USE] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_prior',
            content: noisy,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
    metadata: { user_id: JSON.stringify({ session_id: 'sess-review', account_uuid: 'u1' }) },
    ...(reviewed ? { safeguards: SAFEGUARDS } : {}),
  };
}

/** A streamed response proposing one tool call, with or without the
 *  review's verdict on it. */
function toolCallStream(opts: {
  tool: string;
  input: Record<string, unknown>;
  withResults: boolean;
}): FakeSseEvent[] {
  const id = 'toolu_review_1';
  const delta: Record<string, unknown> = { stop_reason: 'tool_use', stop_sequence: null };
  if (opts.withResults) {
    delta['safeguard_results'] = [
      {
        type: 'dangerous_tool_use',
        status: {
          type: 'available',
          tool_uses: { [id]: { type: 'evaluated', outcome: 'not_flagged' } },
        },
      },
    ];
  }
  const inputJson = JSON.stringify(opts.input);
  const half = Math.floor(inputJson.length / 2);
  return [
    {
      event: 'message_start',
      data: { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5-5' } },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id, name: opts.tool, input: {} },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: inputJson.slice(0, half) },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: inputJson.slice(half) },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    {
      event: 'message_delta',
      data: { type: 'message_delta', delta, usage: { output_tokens: 12 } },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

/** The bytes the fake writes for an event list. */
function encode(events: FakeSseEvent[]): Buffer {
  return Buffer.from(
    events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join(''),
    'utf-8',
  );
}

async function postClaudeCode(
  port: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': CLI_UA,
      authorization: 'Bearer sk-ant-oat01-claude-code-own-login',
      'anthropic-beta': CC_BETA,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function reviewStats(port: number): Promise<AutoModeReviewStats> {
  const res = await getThroughProxy(port, '/health');
  const health = (await res.json()) as { autoModeReview: AutoModeReviewStats };
  return health.autoModeReview;
}

/** The ledger records on the upstream response's `close`, a tick after the
 *  client has its last byte. */
async function waitForStats(
  port: number,
  done: (s: AutoModeReviewStats) => boolean,
): Promise<AutoModeReviewStats> {
  for (let i = 0; i < 100; i += 1) {
    const s = await reviewStats(port);
    if (done(s)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  return reviewStats(port);
}

const zero = { answered: 0, missing: 0, incomplete: 0, error: 0 };

describe('proxy and auto mode server review (real HTTP)', () => {
  let ctx: StartedProxy | null = null;
  let store: CompressionStatsStore | null = null;
  let storePath: string | null = null;

  beforeEach(() => {
    resetAutoModeReviewStats();
    log.clear();
  });

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
    if (store) store.close();
    if (storePath) {
      for (const s of ['', '-wal', '-shm']) if (existsSync(storePath + s)) rmSync(storePath + s);
    }
    ctx = null;
    store = null;
    storePath = null;
  });

  async function start(opts: StartProxyOpts): Promise<StartedProxy> {
    ctx = await startProxyWithFake({
      tokens: ['sk-ant-oat01-pooled'],
      accounts: [{ id: 'acct-sub', email: 'sub@example.com', token: 'sk-ant-oat01-pooled' }],
      ...opts,
    });
    return ctx;
  }

  function upstreamMessages(): Array<{ headers: Record<string, unknown>; body: string }> {
    return ctx!.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
  }

  it('sends anthropic-beta and safeguards upstream unchanged while compression and the 1h TTL still apply', async () => {
    storePath = join(tmpdir(), `sentinel-review-${randomUUID()}.db`);
    store = new CompressionStatsStore({ dbPath: storePath });
    await start({
      settings: {
        cacheTtlForceOneHour: true,
        compressionEnabled: true,
        compressionLevel: 'aggressive',
      },
      compressionStore: store,
    });
    const events = toolCallStream({ tool: 'Bash', input: { command: 'ls' }, withResults: true });
    ctx!.fake.queueResponse('/v1/messages', { sseEvents: events });

    const sent = claudeCodeBody(true);
    const res = await postClaudeCode(ctx!.proxyPort, sent);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(encode(events))).toBe(true);

    const [upstream] = upstreamMessages();
    // The beta goes up exactly as Claude Code sent it: no 1h-TTL beta appended.
    expect(upstream!.headers['anthropic-beta']).toBe(CC_BETA);
    // The safeguards subtree is byte-identical to what the client sent.
    expect(upstream!.body).toContain(`"safeguards":${JSON.stringify(SAFEGUARDS)}`);
    // The prior tool_use block, id and input included, is untouched.
    expect(upstream!.body).toContain(JSON.stringify(PRIOR_TOOL_USE));
    // The body rewrites still ran: the tool result was compressed and the
    // cache breakpoints were moved to 1h.
    const parsed = JSON.parse(upstream!.body) as {
      messages: Array<{ content: Array<Record<string, unknown>> | string }>;
      system: Array<{ cache_control?: { ttl?: string } }>;
    };
    const result = (parsed.messages[2]!.content as Array<Record<string, unknown>>)[0]!;
    expect(String(result['content'])).not.toContain(ESC);
    expect(parsed.system[1]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });

    const stats = await waitForStats(ctx!.proxyPort, (s) => s.rewritten.answered === 1);
    expect(stats).toEqual({ untouched: zero, rewritten: { ...zero, answered: 1 } });
  });

  it('still appends the 1h TTL beta to a request that does not ask for review', async () => {
    await start({ settings: { cacheTtlForceOneHour: true } });
    const res = await postClaudeCode(ctx!.proxyPort, claudeCodeBody(false));
    await res.text();
    expect(res.status).toBe(200);
    const [upstream] = upstreamMessages();
    expect(upstream!.headers['anthropic-beta']).toBe(`${CC_BETA}, ${EXTENDED_TTL_BETA}`);
    // Not a reviewed request: nothing recorded.
    expect(await reviewStats(ctx!.proxyPort)).toEqual({ untouched: zero, rewritten: zero });
  });

  it('streams a reviewed response back byte-for-byte through the permission interceptor', async () => {
    // Enforcement stays on in auto mode, as a user can choose. A rule that
    // doesn't match keeps the interceptor installed without blocking.
    await start({
      enablePermissionsEnforcer: true,
      settings: { toolPermissionsEnabled: true, toolPermissionSkipInAutoMode: false },
    });
    upsertPermissionRule(ctx!.db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      source: 'local',
    });
    ctx!.enforcer!.invalidate();
    const events = toolCallStream({
      tool: 'Bash',
      input: { command: 'echo "café — 日本 🚀"' },
      withResults: true,
    });
    // One byte per write: every multi-byte character crosses a chunk boundary.
    ctx!.fake.queueResponse('/v1/messages', { sseEvents: events, sseChunking: 'byte-split' });

    const res = await postClaudeCode(ctx!.proxyPort, claudeCodeBody(true));
    const received = Buffer.from(await res.arrayBuffer());
    expect(res.status).toBe(200);
    expect(received.equals(encode(events))).toBe(true);
    expect(received.toString('utf-8')).not.toContain('�');

    const stats = await waitForStats(ctx!.proxyPort, (s) => s.untouched.answered === 1);
    expect(stats).toEqual({ untouched: { ...zero, answered: 1 }, rewritten: zero });
  });

  it('treats a reviewed request as auto mode, so "skip in auto mode" steps the enforcer aside without afk-mode', async () => {
    await start({
      enablePermissionsEnforcer: true,
      settings: { toolPermissionsEnabled: true, toolPermissionSkipInAutoMode: true },
    });
    // A whole-tool deny would strip WebFetch from tools[] and substitute its
    // tool_use, had the request not been recognised as auto mode.
    upsertPermissionRule(ctx!.db, {
      decision: 'deny',
      tool: 'WebFetch',
      pattern: null,
      raw: 'WebFetch',
      source: 'local',
    });
    ctx!.enforcer!.invalidate();
    expect(CC_BETA).not.toMatch(/afk-mode|advisor-tool/);
    const events = toolCallStream({
      tool: 'WebFetch',
      input: { url: 'https://example.com' },
      withResults: true,
    });
    ctx!.fake.queueResponse('/v1/messages', { sseEvents: events });

    const sent = JSON.stringify(claudeCodeBody(true));
    const res = await postClaudeCode(ctx!.proxyPort, JSON.parse(sent) as Record<string, unknown>);
    const received = Buffer.from(await res.arrayBuffer());
    expect(received.equals(encode(events))).toBe(true);
    // The request went up byte-for-byte: no tools[] strip.
    expect(upstreamMessages()[0]!.body).toBe(sent);
    expect(ctx!.enforcer!.listPending()).toEqual([]);
    expect(ctx!.enforcer!.getAutoModeStatus()).toMatchObject({ active: true, source: 'headers' });
  });

  it('records and logs a reviewed request whose response completes without review results', async () => {
    await start({});
    const events = toolCallStream({ tool: 'Bash', input: { command: 'ls' }, withResults: false });
    ctx!.fake.queueResponse('/v1/messages', { sseEvents: events });
    ctx!.fake.queueResponse('/v1/messages', { sseEvents: events });

    for (let i = 0; i < 2; i += 1) {
      const res = await postClaudeCode(ctx!.proxyPort, claudeCodeBody(true));
      expect(Buffer.from(await res.arrayBuffer()).equals(encode(events))).toBe(true);
    }

    const stats = await waitForStats(ctx!.proxyPort, (s) => s.untouched.missing === 2);
    expect(stats).toEqual({ untouched: { ...zero, missing: 2 }, rewritten: zero });
    const lines = log
      .getHistory()
      .filter((e) => e.message.includes('[AutoModeReview]'))
      .map((e) => e.message);
    // Logged once for the session's credential, not per request.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('(credential: login, body: untouched)');
    expect(lines[0]).not.toContain('sk-ant-oat01-pooled');
  });

  it('records an incomplete review when the stream ends before message_stop', async () => {
    await start({});
    // Cut off before message_delta: no verdict, and no message_stop either, so
    // Claude Code denies the call without a verdict but keeps asking for review.
    const events = toolCallStream({ tool: 'Bash', input: { command: 'ls' }, withResults: true });
    ctx!.fake.queueResponse('/v1/messages', { sseEvents: events.slice(0, 5) });
    const res = await postClaudeCode(ctx!.proxyPort, claudeCodeBody(true));
    expect(Buffer.from(await res.arrayBuffer()).equals(encode(events.slice(0, 5)))).toBe(true);
    const stats = await waitForStats(ctx!.proxyPort, (s) => s.untouched.incomplete === 1);
    expect(stats).toEqual({ untouched: { ...zero, incomplete: 1 }, rewritten: zero });
  });

  it('records an upstream error, and leaves an encoded body it cannot read unrecorded', async () => {
    await start({});
    ctx!.fake.queueResponse('/v1/messages', {
      status: 529,
      body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    });
    const failed = await postClaudeCode(ctx!.proxyPort, claudeCodeBody(true));
    expect(failed.status).toBe(529);
    await failed.text();
    await waitForStats(ctx!.proxyPort, (s) => s.untouched.error === 1);

    ctx!.fake.queueResponse('/v1/messages', {
      extraHeaders: { 'content-encoding': 'gzip' },
      body: { type: 'message', content: [] },
    });
    const encoded = await postClaudeCode(ctx!.proxyPort, claudeCodeBody(true));
    expect(encoded.status).toBe(200);
    await encoded.arrayBuffer();
    await new Promise((r) => setTimeout(r, 50));
    expect(await reviewStats(ctx!.proxyPort)).toEqual({
      untouched: { ...zero, error: 1 },
      rewritten: zero,
    });
  });

  it('names a pooled API key when its review goes missing, keeping the review pair intact', async () => {
    const userKey = `sk-ant-usr01-${'u'.repeat(95)}`;
    await start({
      tokens: [userKey],
      accounts: [{ id: 'acct-key', email: 'Personal key', token: userKey }],
    });
    ctx!.fake.queueResponse('/v1/messages', {
      sseEvents: toolCallStream({ tool: 'Bash', input: { command: 'ls' }, withResults: false }),
    });
    const res = await postClaudeCode(ctx!.proxyPort, claudeCodeBody(true));
    await res.arrayBuffer();
    expect(res.status).toBe(200);

    const [upstream] = upstreamMessages();
    // The key's credential swap drops the flags describing Claude Code's own
    // login; the review's beta value and its body field still travel together.
    expect(upstream!.headers['anthropic-beta']).toBe(
      `interleaved-thinking-2025-05-14,${REVIEW_BETA}`,
    );
    expect(upstream!.body).toContain(`"safeguards":${JSON.stringify(SAFEGUARDS)}`);

    // The API key path reshapes the system prompt, so the body counts as rewritten.
    const stats = await waitForStats(ctx!.proxyPort, (s) => s.rewritten.missing === 1);
    expect(stats.rewritten.missing).toBe(1);
    const line = log.getHistory().find((e) => e.message.includes('[AutoModeReview]'));
    expect(line?.message).toContain('(credential: pooled-api-key, body: rewritten)');
    expect(line?.message).not.toContain(userKey);
  });

  it("names the client's own API key when its review goes missing", async () => {
    const clientKey = `sk-ant-api03-${'c'.repeat(95)}`;
    await start({ tokens: [clientKey] });
    ctx!.fake.queueResponse('/v1/messages', {
      sseEvents: toolCallStream({ tool: 'Bash', input: { command: 'ls' }, withResults: false }),
    });
    // A third-party client bringing its own key: no Claude Code identity.
    const res = await fetch(`http://127.0.0.1:${ctx!.proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': clientKey,
        'anthropic-beta': REVIEW_BETA,
      },
      body: JSON.stringify(claudeCodeBody(true)),
    });
    await res.arrayBuffer();
    expect(res.status).toBe(200);
    await waitForStats(ctx!.proxyPort, (s) => s.untouched.missing === 1);
    const line = log.getHistory().find((e) => e.message.includes('[AutoModeReview]'));
    expect(line?.message).toContain('(credential: client-api-key, body: untouched)');
  });
});
