/**
 * Capture-health signal: the proxy must fire `onRealMessagesRequest` once for
 * every real Claude Code message request, and NEVER for Sentinel's own
 * background usage probes or count_tokens calls. This is the input that lets
 * the daemon tell "API traffic is reaching the proxy" from "API traffic is
 * bypassing the proxy" (overridden ANTHROPIC_BASE_URL) — the divergence that
 * leaves the Optimize tab empty while the Metrics tab still populates.
 *
 * Runs against the real proxy + fake-Anthropic listener; the callback stub is
 * the only mock (a permitted subscriber stub).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';

describe('proxy capture-health signal (onRealMessagesRequest)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  const REAL_BODY = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hi' }],
  };

  it('fires exactly once for a real /v1/messages POST', async () => {
    const onReal = vi.fn();
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-1', email: 'a1@example.com', token: 'integration-token' }],
      onRealMessagesRequest: onReal,
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', REAL_BODY);
    expect(res.status).toBe(200);
    expect(onReal).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire for a background usage probe (sentinel-probe user-agent)', async () => {
    const onReal = vi.fn();
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-1', email: 'a1@example.com', token: 'integration-token' }],
      onRealMessagesRequest: onReal,
    });

    await postThroughProxy(ctx.proxyPort, '/v1/messages', REAL_BODY, {
      headers: { 'user-agent': 'claude-cli/sentinel-probe' },
    });
    expect(onReal).not.toHaveBeenCalled();
  });

  it('does NOT fire for a count_tokens call', async () => {
    const onReal = vi.fn();
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-1', email: 'a1@example.com', token: 'integration-token' }],
      onRealMessagesRequest: onReal,
    });

    await postThroughProxy(ctx.proxyPort, '/v1/messages/count_tokens', REAL_BODY);
    expect(onReal).not.toHaveBeenCalled();
  });
});
