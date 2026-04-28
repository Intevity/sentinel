/**
 * End-to-end tests for the synthetic network-egress default-deny.
 *
 * Confirms the Sprint 1 acceptance criterion at the wire level:
 *   "High preset, when applied, denies a `WebFetch` to 169.254.169.254
 *   end-to-end through the proxy."
 *
 * The synthetic deny lives in the evaluator (between user allow tier
 * and default-action fallback), so it fires even when no user rule
 * matches. The proxy's SSE interceptor substitutes the matching
 * tool_use with a `[Blocked by Claude Sentinel: <rule.raw>]` text
 * frame; the agent never sees the original tool_use.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';
import { upsertPermissionRule } from './db.js';
import { SYNTHETIC_NETWORK_EGRESS_DENY_ID } from './security/permissions/evaluator.js';

afterEach(async () => {
  if (activeCtx) await activeCtx.cleanup();
  activeCtx = undefined;
});

let activeCtx: StartedProxy | undefined;

function trackContext(ctx: StartedProxy): StartedProxy {
  activeCtx = ctx;
  return ctx;
}

function toolUseSseEvents(
  index: number,
  toolName: string,
  toolInput: Record<string, unknown>,
): Array<{ event?: string; data: unknown }> {
  return [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_fake' } } },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: `toolu_${index}`, name: toolName, input: {} },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) },
      },
    },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
}

const SYNC_BLOCK = {
  toolPermissionsEnabled: true as const,
  toolPermissionDefaultAction: 'allow' as const,
  securityBlockHoldEnabled: false as const,
};

describe('proxy network-egress: synthetic default-deny end-to-end', () => {
  it('WebFetch to 169.254.169.254 → blocked with no user rule seeded', async () => {
    const ctx = trackContext(
      await startProxyWithFake({
        enablePermissionsEnforcer: true,
        settings: { ...SYNC_BLOCK },
      }),
    );
    // No upsertPermissionRule — the synthetic matcher is the only
    // thing in play.
    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: toolUseSseEvents(0, 'WebFetch', {
        url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      }),
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(200);
    const body = await res.text();

    // Synthesized text block carries the synthetic rule's raw form.
    expect(body).toContain(
      `[Blocked by Claude Sentinel: ${SYNTHETIC_NETWORK_EGRESS_DENY_ID}(169.254.169.254)`,
    );
    // Original tool_use frames must NOT have leaked.
    expect(body).not.toContain('"type":"tool_use"');
    expect(body).not.toContain('input_json_delta');
  });

  it('WebFetch to 169.254.169.254 → also blocked by an explicit High preset deny rule', async () => {
    const ctx = trackContext(
      await startProxyWithFake({
        enablePermissionsEnforcer: true,
        settings: { ...SYNC_BLOCK },
      }),
    );
    // Mirror the High preset's explicit network-egress deny so the
    // user-visible rule path is exercised independently of the
    // synthetic matcher.
    upsertPermissionRule(ctx.db, {
      decision: 'deny',
      tool: 'WebFetch',
      pattern: 'domain:169.254.169.254',
      raw: 'WebFetch(domain:169.254.169.254)',
      source: 'local',
    });
    ctx.enforcer!.invalidate();

    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: toolUseSseEvents(0, 'WebFetch', { url: 'http://169.254.169.254/' }),
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(200);
    const body = await res.text();

    // The explicit user rule's raw is in the substituted block — and
    // the synthetic id is NOT, since the deny tier matched first.
    expect(body).toContain('[Blocked by Claude Sentinel: WebFetch(domain:169.254.169.254)');
    expect(body).not.toContain(SYNTHETIC_NETWORK_EGRESS_DENY_ID);
    expect(body).not.toContain('"type":"tool_use"');
  });

  it('RFC-1918 only blocked when denyPrivateNetworkByDefault is on', async () => {
    // Setting on → 10.0.0.0/8 is denied by the synthetic matcher.
    const onCtx = trackContext(
      await startProxyWithFake({
        enablePermissionsEnforcer: true,
        settings: { ...SYNC_BLOCK, denyPrivateNetworkByDefault: true },
      }),
    );
    onCtx.fake.queueResponse('/v1/messages', {
      sseEvents: toolUseSseEvents(0, 'WebFetch', { url: 'http://10.1.2.3/admin' }),
    });
    const onRes = await postThroughProxy(onCtx.proxyPort, '/v1/messages', { messages: [] });
    const onBody = await onRes.text();
    expect(onBody).toContain(
      `[Blocked by Claude Sentinel: ${SYNTHETIC_NETWORK_EGRESS_DENY_ID}(10.1.2.3)`,
    );
    await onCtx.cleanup();
    activeCtx = undefined;

    // Setting off → 10.0.0.0/8 passes through (default-allow).
    const offCtx = trackContext(
      await startProxyWithFake({
        enablePermissionsEnforcer: true,
        settings: { ...SYNC_BLOCK, denyPrivateNetworkByDefault: false },
      }),
    );
    offCtx.fake.queueResponse('/v1/messages', {
      sseEvents: toolUseSseEvents(0, 'WebFetch', { url: 'http://10.1.2.3/admin' }),
    });
    const offRes = await postThroughProxy(offCtx.proxyPort, '/v1/messages', { messages: [] });
    const offBody = await offRes.text();
    expect(offBody).not.toContain('Blocked by Claude Sentinel');
    expect(offBody).toContain('"type":"tool_use"');
  });
});
