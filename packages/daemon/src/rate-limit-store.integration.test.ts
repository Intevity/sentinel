/**
 * Integration test: RateLimitStore fed by REAL proxy → fake Anthropic
 * header traffic. Every scenario in `packages/test-harness/src/scenarios.ts`
 * that alters rate-limit headers is driven through the production
 * `createProxyServer` pipeline once and the resulting store state is
 * asserted against the wire shape.
 *
 * This is the wire-shape drift test bed for the parser at
 * `rate-limit-store.ts:49-105`. The unit tests in `rate-limit-store.test.ts`
 * already exercise every branch of the parser and merge semantics with
 * hand-authored header objects; this file confirms the same bytes that
 * Anthropic would send (via the fake) round-trip through the proxy's
 * header-forwarding + `rateLimitStore.update(accountId, headers)` glue
 * at `proxy.ts:1023-1042` into the store's in-memory map.
 *
 * If Anthropic renames a header (e.g. `unified-5h` → `claude-5h`), the
 * fake's contract test fails first; once it's updated to the new name,
 * this test catches any daemon-side regex in `rate-limit-store.ts:54-58`
 * that wasn't updated to match.
 *
 * No mocks. No `vi.fn()` / `vi.mock` / `vi.spyOn`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';

/** Let the proxy's async response pipeline finish writing to the store
 *  before the test reads it. Longer than strictly needed to be safe
 *  under CI load. */
async function letHeadersSettle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
}

describe('RateLimitStore integration (scenario headers → proxy → store)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('healthy-account: unified-5h at ~10% util, unified-7d present, no overage window', async () => {
    ctx = await startProxyWithFake({ scenario: 'healthy-account' });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await letHeadersSettle();

    const windows = ctx.rateLimitStore.getAll(ctx.activeAccountId.value);
    const fiveH = windows.find((w) => w.name === 'unified-5h');
    const sevenD = windows.find((w) => w.name === 'unified-7d');
    const overage = windows.find((w) => w.name === 'unified-overage');

    expect(fiveH?.utilization).toBeCloseTo(0.1, 2);
    expect(fiveH?.status).toBe('allowed');
    expect(sevenD?.utilization).toBeCloseTo(0.15, 2);
    expect(overage).toBeUndefined();
    expect(windows.some((w) => w.status === 'blocked')).toBe(false);
  });

  it('5h-warning: unified-5h parsed as allowed_warning at 92% util', async () => {
    ctx = await startProxyWithFake({ scenario: '5h-warning' });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await letHeadersSettle();

    const fiveH = ctx.rateLimitStore
      .getAll(ctx.activeAccountId.value)
      .find((w) => w.name === 'unified-5h');
    expect(fiveH?.status).toBe('allowed_warning');
    expect(fiveH?.utilization).toBeCloseTo(0.92, 2);
  });

  it('overage-in-use: unified-overage is present with inUse=true and status=allowed', async () => {
    ctx = await startProxyWithFake({ scenario: 'overage-in-use' });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await letHeadersSettle();

    const windows = ctx.rateLimitStore.getAll(ctx.activeAccountId.value);
    const fiveH = windows.find((w) => w.name === 'unified-5h');
    const overage = windows.find((w) => w.name === 'unified-overage');

    expect(fiveH?.status).toBe('blocked');
    expect(fiveH?.utilization).toBeCloseTo(1.0, 2);
    expect(overage?.status).toBe('allowed');
    expect(overage?.inUse).toBe(true);
  });

  it('overage-entered-fresh: unified-overage inUse=false coerces through string "false" on the wire', async () => {
    // The "in-use" header is a string; the parser at rate-limit-store.ts:68-69
    // coerces "false" → false (explicit "false" string, not just absence).
    ctx = await startProxyWithFake({ scenario: 'overage-entered-fresh' });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await letHeadersSettle();

    const overage = ctx.rateLimitStore
      .getAll(ctx.activeAccountId.value)
      .find((w) => w.name === 'unified-overage');
    expect(overage?.status).toBe('allowed');
    expect(overage?.inUse).toBe(false);
    expect(overage?.utilization).toBeCloseTo(0.0, 2);
  });

  it('overage-disabled: unified-overage parsed with status=disabled and no inUse (coerced to false)', async () => {
    // The disabled scenario emits only overage-status; the parser's coercion
    // at rate-limit-store.ts:76-79 backfills inUse=false when other overage
    // headers arrive without `in-use` so stale `true` doesn't leak across.
    ctx = await startProxyWithFake({ scenario: 'overage-disabled' });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await letHeadersSettle();

    const overage = ctx.rateLimitStore
      .getAll(ctx.activeAccountId.value)
      .find((w) => w.name === 'unified-overage');
    expect(overage?.status).toBe('disabled');
    expect(overage?.inUse).toBe(false);
  });

  it('fable-saturation: window name with underscore (unified-7d_oi) round-trips intact', async () => {
    // The regex at rate-limit-store.ts:54-58 captures the window name
    // greedily, which is the only way `unified-7d_oi` parses without
    // splitting on the underscore. This test proves the wire shape holds.
    ctx = await startProxyWithFake({ scenario: 'fable-saturation' });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await letHeadersSettle();

    const windows = ctx.rateLimitStore.getAll(ctx.activeAccountId.value);
    const fable = windows.find((w) => w.name === 'unified-7d_oi');
    expect(fable, 'unified-7d_oi window must round-trip').toBeDefined();
    expect(fable?.utilization).toBeCloseTo(0.95, 2);
    expect(fable?.status).toBe('allowed_warning');
  });

  it('fable-saturated-blocked: unified-7d_oi at util=1.0 parsed with status=blocked', async () => {
    ctx = await startProxyWithFake({ scenario: 'fable-saturated-blocked' });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await letHeadersSettle();

    const fable = ctx.rateLimitStore
      .getAll(ctx.activeAccountId.value)
      .find((w) => w.name === 'unified-7d_oi');
    expect(fable?.status).toBe('blocked');
    expect(fable?.utilization).toBeCloseTo(1.0, 2);
  });

  it('rate-limited-5h: 429 upstream still populates the store from the headers on the error response', async () => {
    // Even on a 429, Anthropic emits rate-limit headers; the proxy still
    // funnels them to the store (proxy.ts:1023 — this happens before the
    // retry decision). Regression guard: a past bug skipped this update
    // on non-2xx responses and caused the rotator to retry the same
    // account it just failed on.
    ctx = await startProxyWithFake({ scenario: 'rate-limited-5h' });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await letHeadersSettle();

    const fiveH = ctx.rateLimitStore
      .getAll(ctx.activeAccountId.value)
      .find((w) => w.name === 'unified-5h');
    expect(fiveH?.status).toBe('blocked');
    expect(fiveH?.utilization).toBeCloseTo(1.0, 2);
  });
});
