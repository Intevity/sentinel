/**
 * Migrated from `proxy.test.ts` — overage state-machine transitions and
 * their IPC broadcasts. Uses the scenario-driven overage headers from
 * `@claude-sentinel/test-harness` (scenarios.ts) instead of hand-authored
 * mock response headers. The state machine is the real one; the broadcast
 * capture is the real path through IpcServer.broadcast.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';
import { OverageStateMachine } from './overage.js';

describe('proxy overage transitions (real HTTP, scenario-driven headers)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('fires overage_entered and broadcasts via IPC when the upstream reports overage-in-use', async () => {
    ctx = await startProxyWithFake({
      scenario: 'overage-in-use',
      overageMachine: new OverageStateMachine(),
    });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await new Promise((r) => setTimeout(r, 30));

    expect(ctx.ipcServer.broadcasts.some((m) => m.type === 'overage_entered')).toBe(true);
  });

  it('fires overage_disabled and broadcasts when the upstream reports overage-status=disabled', async () => {
    ctx = await startProxyWithFake({
      scenario: 'overage-disabled',
      overageMachine: new OverageStateMachine(),
    });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await new Promise((r) => setTimeout(r, 30));

    expect(ctx.ipcServer.broadcasts.some((m) => m.type === 'overage_disabled')).toBe(true);
  });

  it('fires overage_exited when a prior in-use account observes allowed 5h with overage not in use', async () => {
    // Prime the state machine into in-use so the next observation produces
    // the exited transition. The OverageStateMachine keys off the account
    // the proxy derives from request headers (x-account-uuid or auth);
    // with the default test request shape, no x-account-uuid is sent and
    // auth parsing returns null, so proxy.ts line 670 falls back to
    // 'default'. Prime that key.
    const machine = new OverageStateMachine();
    machine.handleHeaders('default', {
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-in-use': 'true',
    });

    ctx = await startProxyWithFake({
      scenario: 'overage-exited',
      overageMachine: machine,
    });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await new Promise((r) => setTimeout(r, 30));

    expect(ctx.ipcServer.broadcasts.some((m) => m.type === 'overage_exited')).toBe(true);
  });

  it('fires overage_entered with resetsAt=null when no overage-reset header arrives', async () => {
    ctx = await startProxyWithFake({
      scenario: 'overage-null-reset',
      overageMachine: new OverageStateMachine(),
    });
    await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await new Promise((r) => setTimeout(r, 30));

    const entered = ctx.ipcServer.broadcasts.find(
      (m): m is { type: 'overage_entered'; accountId: string; resetsAt: number | null } =>
        m.type === 'overage_entered',
    );
    expect(entered).toBeDefined();
    expect(entered?.resetsAt).toBeNull();
  });
});
