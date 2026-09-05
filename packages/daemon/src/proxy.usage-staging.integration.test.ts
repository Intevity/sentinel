/**
 * Staged-usage OTEL dedupe, end to end over real HTTP.
 *
 * A claude-cli user-agent is a *prediction* that the client reports its own
 * usage over OTEL. The real Claude Code CLI does; opencode plugins presenting
 * the same UA (opencode-claude-auth) and short-lived `claude --print`
 * children do not. Instead of predicting, the proxy stages the observed
 * usage keyed on Anthropic's request-id: an OTEL api_request carrying the
 * same id claims the row, and an unclaimed row commits after the grace
 * window. The invariant under test: exactly ONE usage_events row per request,
 * from exactly one writer, in every interleaving.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, type StartedProxy } from './proxy.test-helpers.js';
import { getUsageEvents, getPendingUsageEvents, commitStalePendingUsage } from './db.js';
import { OTEL_LOG_API_REQUEST } from './otel-receiver.js';
import { PENDING_USAGE_GRACE_MS } from './pending-usage-sweeper.js';

const CLI_UA = 'claude-cli/2.1.197 (external, cli)';
const OPENCODE_AUTH_UA = 'claude-cli/2.1.197 (external, sdk-cli)';
const DESKTOP_UA = 'claude-cli/2.1.197 (external, claude-desktop-3p, agent-sdk/0.3.197)';

/** The fake answers /v1/messages as claude-opus-4-7 with 10 in / 1 out. */
const FAKE_INPUT_TOKENS = 10;
const FAKE_OUTPUT_TOKENS = 1;
/** Opus 4.7 is $5/MTok in, $25/MTok out. */
const EXPECTED_COST = (FAKE_INPUT_TOKENS * 5) / 1e6 + (FAKE_OUTPUT_TOKENS * 25) / 1e6;

const POOL_ACCOUNT = { id: 'acct-pool', email: 'pool@example.com', token: 'pool-token' };

async function post(port: number, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'claude-opus-4-7', messages: [] }),
  });
}

/** POST an OTLP api_request log event to the proxy's OTEL route — the same
 *  path the real CLI exporter uses. */
async function postOtelApiRequest(
  port: number,
  attrs: { requestId?: string; costUsd: number },
): Promise<Response> {
  const attributes = [
    { key: 'event.name', value: { stringValue: OTEL_LOG_API_REQUEST } },
    { key: 'model', value: { stringValue: 'claude-opus-4-7' } },
    { key: 'cost_usd', value: { doubleValue: attrs.costUsd } },
    { key: 'input_tokens', value: { intValue: FAKE_INPUT_TOKENS } },
    { key: 'output_tokens', value: { intValue: FAKE_OUTPUT_TOKENS } },
  ];
  if (attrs.requestId !== undefined) {
    attributes.push({ key: 'request_id', value: { stringValue: attrs.requestId } });
  }
  return fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: (BigInt(Date.now()) * BigInt(1_000_000)).toString(),
                  attributes,
                },
              ],
            },
          ],
        },
      ],
    }),
  });
}

function rawRequestIds(ctx: StartedProxy): Array<string | null> {
  return (
    ctx.db.prepare('SELECT request_id FROM usage_events').all() as Array<{
      request_id: string | null;
    }>
  ).map((r) => r.request_id);
}

describe('proxy staged-usage OTEL dedupe (real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('real CLI: stages the row, then the OTEL claim owns accounting', async () => {
    ctx = await startProxyWithFake({ tokens: ['pool-token'], accounts: [POOL_ACCOUNT] });
    ctx.activeToken.value = 'pool-token';
    ctx.fake.queueResponse('/v1/messages', { extraHeaders: { 'request-id': 'req_cli_1' } });

    await post(ctx.proxyPort, { 'user-agent': CLI_UA, 'anthropic-beta': 'oauth-2025-04-20' });
    await new Promise((r) => setTimeout(r, 40));

    // Staged, not written: OTEL may still report this request.
    expect(getUsageEvents(ctx.db, {})).toEqual([]);
    const pending = getPendingUsageEvents(ctx.db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.requestId).toBe('req_cli_1');
    expect(pending[0]!.accountId).toBe('acct-pool');
    expect(pending[0]!.inputTokens).toBe(FAKE_INPUT_TOKENS);
    expect(pending[0]!.costUsd).toBeCloseTo(EXPECTED_COST, 10);

    // The CLI's OTEL export arrives: it claims the staged row and owns
    // accounting, with the CLI's own cost figure.
    await postOtelApiRequest(ctx.proxyPort, { requestId: 'req_cli_1', costUsd: 0.123 });

    const events = getUsageEvents(ctx.db, {});
    expect(events).toHaveLength(1);
    expect(events[0]!.costUsd).toBe(0.123);
    expect(getPendingUsageEvents(ctx.db)).toEqual([]);

    // A later sweep finds nothing to add — still exactly one row.
    commitStalePendingUsage(ctx.db, {
      graceMs: PENDING_USAGE_GRACE_MS,
      now: Date.now() + PENDING_USAGE_GRACE_MS + 1000,
    });
    expect(getUsageEvents(ctx.db, {})).toHaveLength(1);
  });

  it('opencode-claude-auth: no OTEL ever arrives, the sweep commits the row', async () => {
    ctx = await startProxyWithFake({ tokens: ['pool-token'], accounts: [POOL_ACCOUNT] });
    ctx.activeToken.value = 'pool-token';

    await post(ctx.proxyPort, {
      'user-agent': OPENCODE_AUTH_UA,
      authorization: 'Bearer plugin-supplied-oauth-token',
      'anthropic-beta': 'oauth-2025-04-20',
    });
    await new Promise((r) => setTimeout(r, 40));

    // Inside the grace window: nothing visible yet.
    expect(getUsageEvents(ctx.db, {})).toEqual([]);
    expect(getPendingUsageEvents(ctx.db)).toHaveLength(1);

    // Grace passes with no OTEL claim: the proxy owns the row.
    const landed = commitStalePendingUsage(ctx.db, {
      graceMs: PENDING_USAGE_GRACE_MS,
      now: Date.now() + PENDING_USAGE_GRACE_MS + 1000,
    });
    expect(landed).toBe(1);

    const events = getUsageEvents(ctx.db, {});
    expect(events).toHaveLength(1);
    expect(events[0]!.accountId).toBe('acct-pool');
    expect(events[0]!.model).toBe('claude-opus-4-7');
    expect(events[0]!.inputTokens).toBe(FAKE_INPUT_TOKENS);
    expect(events[0]!.outputTokens).toBe(FAKE_OUTPUT_TOKENS);
    expect(events[0]!.costUsd).toBeCloseTo(EXPECTED_COST, 10);
    expect(rawRequestIds(ctx)[0]).toBeTruthy();

    // Idempotent: a second sweep adds nothing.
    expect(
      commitStalePendingUsage(ctx.db, {
        graceMs: PENDING_USAGE_GRACE_MS,
        now: Date.now() + PENDING_USAGE_GRACE_MS + 2000,
      }),
    ).toBe(0);
    expect(getUsageEvents(ctx.db, {})).toHaveLength(1);
  });

  it('race: OTEL arriving after the sweep committed neither double-counts nor broadcasts', async () => {
    ctx = await startProxyWithFake({ tokens: ['pool-token'], accounts: [POOL_ACCOUNT] });
    ctx.activeToken.value = 'pool-token';
    ctx.fake.queueResponse('/v1/messages', { extraHeaders: { 'request-id': 'req_race_1' } });

    await post(ctx.proxyPort, { 'user-agent': CLI_UA });
    await new Promise((r) => setTimeout(r, 40));

    commitStalePendingUsage(ctx.db, {
      graceMs: PENDING_USAGE_GRACE_MS,
      now: Date.now() + PENDING_USAGE_GRACE_MS + 1000,
    });
    expect(getUsageEvents(ctx.db, {})).toHaveLength(1);

    // The late OTEL event drops on the request_id unique index: the
    // committed row's figures stand, and the no-op batch must not fire a
    // metrics broadcast.
    const broadcastsBefore = ctx.ipcServer.broadcasts.length;
    await postOtelApiRequest(ctx.proxyPort, { requestId: 'req_race_1', costUsd: 9.99 });

    const events = getUsageEvents(ctx.db, {});
    expect(events).toHaveLength(1);
    expect(events[0]!.costUsd).toBeCloseTo(EXPECTED_COST, 10);
    expect(getPendingUsageEvents(ctx.db)).toEqual([]);
    expect(ctx.ipcServer.broadcasts).toHaveLength(broadcastsBefore);
  });

  it('claude-cli response without a request-id defers to OTEL (no row, no staging)', async () => {
    ctx = await startProxyWithFake({ tokens: ['pool-token'], accounts: [POOL_ACCOUNT] });
    ctx.activeToken.value = 'pool-token';
    // An empty request-id header value reads as absent to the proxy.
    ctx.fake.queueResponse('/v1/messages', { extraHeaders: { 'request-id': '' } });

    await post(ctx.proxyPort, { 'user-agent': CLI_UA });
    await new Promise((r) => setTimeout(r, 40));

    expect(getUsageEvents(ctx.db, {})).toEqual([]);
    expect(getPendingUsageEvents(ctx.db)).toEqual([]);
    // Even a far-future sweep has nothing to commit.
    commitStalePendingUsage(ctx.db, { graceMs: 0, now: Date.now() + 10 * 60_000 });
    expect(getUsageEvents(ctx.db, {})).toEqual([]);
  });

  it('Claude Desktop keeps the immediate write, now stamped with the request-id', async () => {
    ctx = await startProxyWithFake({ tokens: ['pool-token'], accounts: [POOL_ACCOUNT] });
    ctx.activeToken.value = 'pool-token';
    ctx.fake.queueResponse('/v1/messages', { extraHeaders: { 'request-id': 'req_desktop_1' } });

    await post(ctx.proxyPort, { 'user-agent': DESKTOP_UA });
    await new Promise((r) => setTimeout(r, 40));

    const events = getUsageEvents(ctx.db, {});
    expect(events).toHaveLength(1);
    expect(events[0]!.costUsd).toBeCloseTo(EXPECTED_COST, 10);
    expect(getPendingUsageEvents(ctx.db)).toEqual([]);
    expect(rawRequestIds(ctx)).toEqual(['req_desktop_1']);
  });
});
