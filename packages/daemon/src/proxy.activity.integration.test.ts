/**
 * Proxy activity tracking (`getProxyActivity`) — the idle gate the Tauri
 * updater consults before silently installing an update. A restart kills
 * the proxy, so the updater must see "busy" while a Claude Code request is
 * in flight and "recently active" right after one completes.
 *
 * Runs against the real proxy + fake Anthropic listener. The fake's
 * `delayMs` knob holds the upstream response open so the in-flight window
 * is wide enough to observe deterministically.
 *
 * NOTE: the counters are module-level (one proxy per daemon), so these
 * tests assert relative-to-now values rather than assuming a virgin state.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getProxyActivity } from './proxy.js';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';

const MESSAGES_BODY = {
  model: 'claude-opus-4-7',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'hi' }],
};

/** Poll until `predicate` is true or `timeoutMs` elapses. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

describe('proxy activity tracking (idle gate for silent updates)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('counts an in-flight /v1/messages request and settles back to zero', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-1', email: 'a1@example.com', token: 'integration-token' }],
    });
    const before = Date.now();

    // Hold the upstream response open so the in-flight state is observable.
    ctx.fake.queueResponse('/v1/messages', { delayMs: 400 });
    const responseP = postThroughProxy(ctx.proxyPort, '/v1/messages', MESSAGES_BODY);

    const sawInFlight = await waitUntil(() => getProxyActivity().inFlightRequests === 1);
    expect(sawInFlight).toBe(true);
    const during = getProxyActivity();
    expect(during.inFlightRequests).toBe(1);
    expect(during.lastRequestTs).not.toBeNull();
    expect(during.lastRequestTs!).toBeGreaterThanOrEqual(before);

    const res = await responseP;
    expect(res.status).toBe(200);
    // `close` fires after the response finishes; allow the event loop a tick.
    const settled = await waitUntil(() => getProxyActivity().inFlightRequests === 0);
    expect(settled).toBe(true);
    expect(getProxyActivity().lastRequestTs!).toBeGreaterThanOrEqual(before);
  });

  it('counts non-messages Anthropic paths (GET /v1/models)', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-1', email: 'a1@example.com', token: 'integration-token' }],
    });
    const before = Date.now();
    await fetch(`http://127.0.0.1:${ctx.proxyPort}/v1/models`, {
      headers: { Authorization: 'Bearer client-supplied' },
    });
    const settled = await waitUntil(() => getProxyActivity().inFlightRequests === 0);
    expect(settled).toBe(true);
    expect(getProxyActivity().lastRequestTs!).toBeGreaterThanOrEqual(before);
  });

  it('excludes Sentinel rate-limit probes via their user-agent marker', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-1', email: 'a1@example.com', token: 'integration-token' }],
    });
    const baseline = getProxyActivity().lastRequestTs;

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', MESSAGES_BODY, {
      headers: { 'user-agent': 'claude-cli/sentinel-probe' },
    });
    expect(res.status).toBe(200);

    // The probe completed against the upstream but left no activity trace:
    // background probing must not make an idle machine look busy.
    const after = getProxyActivity();
    expect(after.lastRequestTs).toBe(baseline);
    expect(after.inFlightRequests).toBe(0);
  });

  it('ignores /health checks', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-1', email: 'a1@example.com', token: 'integration-token' }],
    });
    const baseline = getProxyActivity().lastRequestTs;
    const res = await fetch(`http://127.0.0.1:${ctx.proxyPort}/health`);
    expect(res.status).toBe(200);
    expect(getProxyActivity().lastRequestTs).toBe(baseline);
    expect(getProxyActivity().inFlightRequests).toBe(0);
  });
});
