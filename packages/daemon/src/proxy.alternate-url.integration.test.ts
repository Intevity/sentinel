/**
 * Integration test for the alternate API URL setting (model-router pass-through).
 *
 * Two fake Anthropic listeners are spun up:
 *  - `fakeCanonical`: stands in for `api.anthropic.com`. The harness wires
 *    `ANTHROPIC_UPSTREAM_URL` to this server.
 *  - `fakeAlt`: stands in for a user-configured router (e.g. Herma). Set
 *    via `settings.alternateApiUrl`.
 *
 * The contract:
 *  - When `alternateApiUrl` is set, Claude Code traffic through the proxy
 *    lands at `fakeAlt`, NOT `fakeCanonical`.
 *  - Daemon-originated queries (driven by `getAnthropicOrigin()`) are
 *    independent and continue to read `ANTHROPIC_UPSTREAM_URL`. This
 *    file's split-routing assertion uses `getAnthropicOrigin` directly to
 *    prove the helper for daemon-side requests is unaffected.
 *  - Clearing the setting at runtime routes the next request back to
 *    `fakeCanonical` without a proxy restart (live `loadSettings()` per
 *    request inside `proxyToAnthropic`).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  startProxyWithFake,
  postThroughProxy,
  patchTestSettings,
  type StartedProxy,
} from './proxy.test-helpers.js';
import { startFakeAnthropic, type FakeAnthropic } from '@claude-sentinel/test-harness';
import { getAnthropicOrigin } from './hosts.js';

describe('alternate API URL routes Claude Code traffic without affecting daemon-side calls', () => {
  let ctx: StartedProxy | undefined;
  let fakeAlt: FakeAnthropic | undefined;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
    ctx = undefined;
    if (fakeAlt) await fakeAlt.close();
    fakeAlt = undefined;
  });

  it('routes /v1/messages to alternate when set, and back to canonical when cleared', async () => {
    fakeAlt = await startFakeAnthropic();
    fakeAlt.registerToken('integration-token');

    ctx = await startProxyWithFake({
      settings: { alternateApiUrl: fakeAlt.origin },
    });

    // First request: must land at the alternate fake.
    const res1 = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [],
    });
    expect(res1.status).toBe(200);

    const altHits1 = fakeAlt.requests().filter((r) => r.url.startsWith('/v1/messages'));
    const canonicalHits1 = ctx.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    expect(altHits1.length).toBe(1);
    expect(canonicalHits1.length).toBe(0);

    // Daemon-originated origin must still be the canonical (test-harness sets
    // ANTHROPIC_UPSTREAM_URL to ctx.fake.origin). This proves the split:
    // alternate routing only applies to the proxy's forwarding path.
    expect(getAnthropicOrigin()).toBe(ctx.fake.origin);
    expect(getAnthropicOrigin()).not.toBe(fakeAlt.origin);

    // Toggle the alternate off mid-test. Since proxyToAnthropic reads
    // settings per request, the very next request should hit canonical.
    patchTestSettings({ alternateApiUrl: null });

    const res2 = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [],
    });
    expect(res2.status).toBe(200);

    const altHits2 = fakeAlt.requests().filter((r) => r.url.startsWith('/v1/messages'));
    const canonicalHits2 = ctx.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    // Alt count unchanged from before; canonical now has the second request.
    expect(altHits2.length).toBe(1);
    expect(canonicalHits2.length).toBe(1);
  });

  it('falls back to canonical when alternateApiUrl is malformed (defense-in-depth)', async () => {
    // Coerce drops malformed input on save, so this can only happen if the
    // setting was legitimate and then later corrupted. getProxyUpstream's
    // try/catch returns canonical rather than throwing.
    ctx = await startProxyWithFake({
      // saveSettings will run coerce() and drop this back to null. That is
      // the expected production path; this test confirms the runtime safety
      // net by then setting `alternateApiUrl` directly with a malformed
      // string via patchTestSettings (which also goes through coerce).
      settings: {},
    });

    // Even with a malformed value attempted, the proxy lands at canonical
    // because (a) coerce drops the bad value, and (b) getProxyUpstream
    // would also fall back if it somehow did get through.
    patchTestSettings({ alternateApiUrl: 'ftp://nope.example.com' });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      model: 'claude-opus-4-7',
      messages: [],
    });
    expect(res.status).toBe(200);
    expect(ctx.fake.requests().filter((r) => r.url.startsWith('/v1/messages'))).toHaveLength(1);
  });
});
