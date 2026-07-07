/**
 * Desktop routing signal: the proxy must fire `onDesktopRequest` once for every
 * real /v1/messages POST from the Claude **Desktop** app (UA marker
 * `claude-desktop-3p`) and never for terminal-CLI traffic or count_tokens. And
 * the dummy gateway credential the desktop app sends must be replaced by the
 * real rotating account token before the request leaves the proxy — desktop
 * inherits pool rotation for free.
 *
 * Runs against the real proxy + fake-Anthropic listener; the callback stub and
 * a real DesktopHealthTracker are the only collaborators.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';
import { createDesktopHealthTracker } from './surface-detector.js';

const DESKTOP_UA = 'claude-cli/2.1.197 (external, claude-desktop-3p, agent-sdk/0.3.197)';
const CLI_UA = 'claude-cli/2.1.201 (external, cli)';
const DUMMY_BEARER = 'sentinel-local-proxy';

describe('proxy desktop routing signal (onDesktopRequest)', () => {
  let ctx: StartedProxy;
  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  const REAL_BODY = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] };

  it('fires once for a desktop UA, flips health, and injects the real token', async () => {
    let desktopHits = 0;
    const tracker = createDesktopHealthTracker();
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-1', email: 'a1@example.com', token: 'integration-token' }],
      onDesktopRequest: () => {
        desktopHits++;
        tracker.record();
      },
    });

    expect(tracker.isHealthy()).toBe(false);
    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', REAL_BODY, {
      headers: { 'user-agent': DESKTOP_UA, authorization: `Bearer ${DUMMY_BEARER}` },
    });
    expect(res.status).toBe(200);
    expect(desktopHits).toBe(1);
    expect(tracker.isHealthy()).toBe(true);

    // The dummy bearer the desktop app sent must NOT reach upstream — the proxy
    // overwrites Authorization with the real rotating account token.
    const upstream = ctx.fake.requests().at(-1);
    expect(upstream?.headers['authorization']).toBe('Bearer integration-token');
    expect(upstream?.headers['authorization']).not.toContain(DUMMY_BEARER);
  });

  it('does NOT fire for terminal-CLI traffic', async () => {
    let desktopHits = 0;
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-1', email: 'a1@example.com', token: 'integration-token' }],
      onDesktopRequest: () => {
        desktopHits++;
      },
    });
    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', REAL_BODY, {
      headers: { 'user-agent': CLI_UA },
    });
    expect(res.status).toBe(200);
    expect(desktopHits).toBe(0);
  });

  it('does NOT fire for a desktop count_tokens call', async () => {
    let desktopHits = 0;
    ctx = await startProxyWithFake({
      accounts: [{ id: 'acct-1', email: 'a1@example.com', token: 'integration-token' }],
      onDesktopRequest: () => {
        desktopHits++;
      },
    });
    await postThroughProxy(ctx.proxyPort, '/v1/messages/count_tokens', REAL_BODY, {
      headers: { 'user-agent': DESKTOP_UA },
    });
    expect(desktopHits).toBe(0);
  });

  it('health tracker expires after its window', () => {
    let clock = 1_000_000;
    const tracker = createDesktopHealthTracker(1000, () => clock);
    tracker.record();
    expect(tracker.isHealthy()).toBe(true);
    clock += 1500; // past the 1s window
    expect(tracker.isHealthy()).toBe(false);
  });
});
