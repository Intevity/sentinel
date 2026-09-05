/**
 * Proxy-derived usage accounting. Cost and token figures come from Claude
 * Code's OTEL export, which only the terminal CLI produces — so the Claude
 * Desktop app and any third-party client spend quota while contributing nothing
 * to the numbers that explain it. The proxy fills exactly that gap by writing
 * `usage_events` for clients that emit no OTEL.
 *
 * The invariant is one row per request from exactly one writer. A claude-cli
 * user-agent gets a STAGED row (pending_usage_events) rather than an
 * immediate one, because the UA only predicts an OTEL report: the real CLI's
 * OTEL event claims the staged row, and the pending-usage sweeper commits it
 * when no claim arrives (opencode-claude-auth, `claude --print` children).
 * The claim/commit interleavings live in
 * proxy.usage-staging.integration.test.ts; this file pins the immediate-write
 * paths and the CLI's stage-not-write behavior.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, type StartedProxy } from './proxy.test-helpers.js';
import { getUsageEvents, getPendingUsageEvents } from './db.js';
import { BYOK_ACCOUNT_ID } from './proxy.js';

const CLIENT_KEY = 'sk-ant-api03-client-owned-key';
const CLI_UA = 'claude-cli/2.1.197 (external, cli)';
const DESKTOP_UA = 'claude-cli/2.1.197 (external, claude-desktop-3p, agent-sdk/0.3.197)';
const OPENCODE_UA = 'opencode/1.18.16';

/** The fake answers /v1/messages as claude-opus-4-7 with 10 in / 1 out. */
const FAKE_INPUT_TOKENS = 10;
const FAKE_OUTPUT_TOKENS = 1;
/** Opus 4.7 is $5/MTok in, $25/MTok out. */
const EXPECTED_COST = (FAKE_INPUT_TOKENS * 5) / 1e6 + (FAKE_OUTPUT_TOKENS * 25) / 1e6;

async function post(port: number, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'claude-opus-4-7', messages: [] }),
  });
}

describe('proxy usage accounting (real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('does NOT write a row for the Claude Code CLI — OTEL owns that request', async () => {
    ctx = await startProxyWithFake({ tokens: ['pool-token'] });
    ctx.activeToken.value = 'pool-token';

    await post(ctx.proxyPort, { 'user-agent': CLI_UA, 'anthropic-beta': 'oauth-2025-04-20' });
    await new Promise((r) => setTimeout(r, 40));

    // A row here would double the CLI's cost and tokens in every window —
    // the request is STAGED instead, awaiting the OTEL claim (or the sweep).
    expect(getUsageEvents(ctx.db, {})).toEqual([]);
    expect(getPendingUsageEvents(ctx.db)).toHaveLength(1);
  });

  it('writes a row for Claude Desktop, which emits no OTEL', async () => {
    ctx = await startProxyWithFake({
      tokens: ['pool-token'],
      accounts: [{ id: 'acct-pool', email: 'pool@example.com', token: 'pool-token' }],
    });
    ctx.activeToken.value = 'pool-token';

    await post(ctx.proxyPort, { 'user-agent': DESKTOP_UA });
    await new Promise((r) => setTimeout(r, 40));

    const events = getUsageEvents(ctx.db, {});
    expect(events).toHaveLength(1);
    expect(events[0]!.accountId).toBe('acct-pool');
    expect(events[0]!.model).toBe('claude-opus-4-7');
    expect(events[0]!.inputTokens).toBe(FAKE_INPUT_TOKENS);
    expect(events[0]!.outputTokens).toBe(FAKE_OUTPUT_TOKENS);
    expect(events[0]!.costUsd).toBeCloseTo(EXPECTED_COST, 10);
  });

  it('writes a BYOK row against the reserved key, not a pooled account', async () => {
    ctx = await startProxyWithFake({
      tokens: ['pool-token', CLIENT_KEY],
      accounts: [{ id: 'acct-pool', email: 'pool@example.com', token: 'pool-token' }],
    });

    await post(ctx.proxyPort, { 'x-api-key': CLIENT_KEY, 'user-agent': OPENCODE_UA });
    await new Promise((r) => setTimeout(r, 40));

    expect(getUsageEvents(ctx.db, { accountId: 'acct-pool' })).toEqual([]);
    const byok = getUsageEvents(ctx.db, { accountId: BYOK_ACCOUNT_ID });
    expect(byok).toHaveLength(1);
    expect(byok[0]!.outputTokens).toBe(FAKE_OUTPUT_TOKENS);
    expect(byok[0]!.costUsd).toBeCloseTo(EXPECTED_COST, 10);
  });

  it('records tokens with a null cost for a model that is not priced', async () => {
    ctx = await startProxyWithFake({ tokens: ['pool-token'] });
    ctx.activeToken.value = 'pool-token';
    ctx.fake.queueResponse('/v1/messages', {
      body: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model: 'some-future-model',
        content: [],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    });

    await post(ctx.proxyPort, { 'user-agent': DESKTOP_UA });
    await new Promise((r) => setTimeout(r, 40));

    const events = getUsageEvents(ctx.db, {});
    expect(events).toHaveLength(1);
    // Tokens are real, so they are kept; the price is unknown, so cost stays
    // blank rather than being guessed at the fallback rate.
    expect(events[0]!.inputTokens).toBe(7);
    expect(events[0]!.outputTokens).toBe(3);
    expect(events[0]!.costUsd).toBeNull();
  });

  it('counts a streamed response once, from the final cumulative usage', async () => {
    ctx = await startProxyWithFake({ tokens: ['pool-token'] });
    ctx.activeToken.value = 'pool-token';
    // Per Anthropic's SSE contract `message_delta.usage` carries the cumulative
    // final counts, so the row must reflect the delta — not the message_start
    // baseline, and not the two added together.
    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: [
        {
          event: 'message_start',
          data: {
            type: 'message_start',
            message: {
              model: 'claude-sonnet-4-6',
              usage: { input_tokens: 20, output_tokens: 0 },
            },
          },
        },
        {
          event: 'message_delta',
          data: {
            type: 'message_delta',
            usage: { input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 42 },
          },
        },
      ],
    });

    await post(ctx.proxyPort, { 'user-agent': DESKTOP_UA });
    await new Promise((r) => setTimeout(r, 40));

    const events = getUsageEvents(ctx.db, {});
    expect(events).toHaveLength(1);
    expect(events[0]!.inputTokens).toBe(20);
    expect(events[0]!.outputTokens).toBe(42);
    expect(events[0]!.cacheRead).toBe(5);
    // Sonnet: 20 × $3 + 5 × $3 × 0.1 (cache read) + 42 × $15, per MTok.
    expect(events[0]!.costUsd).toBeCloseTo((20 * 3 + 5 * 3 * 0.1 + 42 * 15) / 1e6, 12);
  });
});
