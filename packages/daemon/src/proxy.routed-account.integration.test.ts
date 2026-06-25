/**
 * Auto-switching surfaces the account currently serving requests to the UI.
 * The proxy emits `routed_account_changed` (via the real ipcServer broadcast
 * path) whenever the tokenProvider-supplied account changes, and stays quiet
 * while it is stable — earliest-reset is sticky, so the header must not get a
 * broadcast per request. In Manual mode the tokenProvider returns null and no
 * broadcast fires at all. Driven over real HTTP through `startProxyWithFake`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';

describe('proxy routed_account_changed broadcast (real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('broadcasts the routed account on change and stays quiet while it is stable', async () => {
    // Auto mode routes through acct-a twice (sticky), then switches to acct-b.
    const sequence = [
      { token: 'tok-a', accountId: 'acct-a' },
      { token: 'tok-a', accountId: 'acct-a' },
      { token: 'tok-b', accountId: 'acct-b' },
    ];
    let i = 0;

    ctx = await startProxyWithFake({
      tokens: ['tok-a', 'tok-b'],
      accounts: [
        { id: 'acct-a', email: 'a@example.com', token: 'tok-a' },
        { id: 'acct-b', email: 'b@example.com', token: 'tok-b' },
      ],
      tokenProvider: () => sequence[Math.min(i++, sequence.length - 1)] ?? null,
    });

    for (let n = 0; n < 3; n++) {
      await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
      await new Promise((r) => setTimeout(r, 20));
    }

    const routed = ctx.ipcServer.broadcasts
      .filter((m) => m.type === 'routed_account_changed')
      .map((m) => (m as { accountId: string }).accountId);
    // Initial acct-a, then acct-b on the switch — the repeated acct-a request
    // in between must NOT re-broadcast.
    expect(routed).toEqual(['acct-a', 'acct-b']);
  });

  it('does not broadcast routed_account_changed in Manual mode (tokenProvider returns null)', async () => {
    // tokenProvider returns null → proxy uses the shared active token (Manual).
    ctx = await startProxyWithFake({ tokenProvider: () => null });

    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await new Promise((r) => setTimeout(r, 20));

    const routed = ctx.ipcServer.broadcasts.filter((m) => m.type === 'routed_account_changed');
    expect(routed).toHaveLength(0);
  });
});
