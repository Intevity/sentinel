/**
 * End-to-end integration tests for the tool-permission pipeline.
 *
 * Existing security integration tests cover the secret/risk scanner
 * boundary; these tests cover the OTHER security feature — the
 * user-authored `permission_rules` engine that intercepts tool calls
 * (Bash, Read, WebFetch, etc.) before the agent can act on them.
 *
 * The test stack is real top-to-bottom:
 *   - real proxy (createProxyServer)
 *   - real PermissionsEnforcer
 *   - real SQLite for the rule set
 *   - fake-Anthropic upstream for the SSE/tool_use responses
 *
 * Each test asserts on the BYTES the test client receives so the
 * end-to-end frame rewriting (synthesized text blocks for denied
 * tool_use, original frames for allowed tool_use, index integrity in
 * multi-block responses, request-side `tools[]` stripping) is
 * verified at the wire level — not just at the registry-state level
 * the unit tests already cover.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';
import { upsertPermissionRule } from './db.js';

afterEach(async () => {
  if (activeCtx) await activeCtx.cleanup();
  activeCtx = undefined;
});

let activeCtx: StartedProxy | undefined;

function trackContext(ctx: StartedProxy): StartedProxy {
  activeCtx = ctx;
  return ctx;
}

/** Build a /v1/messages SSE response that emits one tool_use block.
 *  The interceptor will see a `content_block_start` (tool_use), one
 *  `content_block_delta` (input JSON), and a `content_block_stop`. */
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

// `securityBlockHoldEnabled: false` puts us on the synchronous
// immediate-block path. The async hold path is correctness-tested
// in sse-interceptor.test.ts at the unit level; integrating it
// against a real upstream involves a fundamental race between the
// upstream stream closing and the user's IPC resolve, which is not
// deterministically testable without harness changes.
const SYNC_BLOCK: {
  toolPermissionsEnabled: true;
  toolPermissionDefaultAction: 'allow' | 'deny';
  securityBlockHoldEnabled: false;
} = {
  toolPermissionsEnabled: true,
  toolPermissionDefaultAction: 'allow',
  securityBlockHoldEnabled: false,
};

describe('proxy permissions e2e: response-side tool_use interception', () => {
  it('denied tool_use → client receives a synthetic [Blocked by Claude Sentinel] text block', async () => {
    const ctx = trackContext(
      await startProxyWithFake({
        enablePermissionsEnforcer: true,
        settings: { ...SYNC_BLOCK },
      }),
    );
    upsertPermissionRule(ctx.db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      source: 'local',
    });
    ctx.enforcer!.invalidate();

    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: toolUseSseEvents(0, 'Bash', { command: 'rm -rf /' }),
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(200);
    const body = await res.text();

    // The synthesized text block carries the rule's raw text in the
    // body so the agent sees a structured "you were blocked" message
    // instead of the original tool_use it asked for.
    expect(body).toContain('[Blocked by Claude Sentinel: Bash(rm -rf *)]');
    // The original tool_use frames must NOT have leaked through.
    expect(body).not.toContain('"type":"tool_use"');
    expect(body).not.toContain('input_json_delta');
  });

  it('allowed tool_use → client receives the original tool_use frames byte-for-byte', async () => {
    const ctx = trackContext(
      await startProxyWithFake({
        enablePermissionsEnforcer: true,
        settings: { ...SYNC_BLOCK },
      }),
    );
    // No deny rule — default-allow lets every tool_use through.
    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: toolUseSseEvents(0, 'Read', { file_path: '/Users/alice/notes.md' }),
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(200);
    const body = await res.text();

    // Original frames passed through verbatim.
    expect(body).toContain('"type":"tool_use"');
    expect(body).toContain('"name":"Read"');
    expect(body).toContain('input_json_delta');
    // No substitution happened.
    expect(body).not.toContain('Blocked by Claude Sentinel');
  });

  it('multi-block response: denied middle tool_use is substituted; surrounding text blocks pass through unchanged', async () => {
    const ctx = trackContext(
      await startProxyWithFake({
        enablePermissionsEnforcer: true,
        settings: { ...SYNC_BLOCK },
      }),
    );
    upsertPermissionRule(ctx.db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      source: 'local',
    });
    ctx.enforcer!.invalidate();

    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: [
        { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_fake' } } },
        // index 0 — text block, must pass through untouched
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'hello-from-text-block-0' },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        // index 1 — tool_use, must be substituted
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 1,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify({ command: 'rm -rf /' }),
            },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
        // index 2 — text block, must pass through untouched
        {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 2,
            content_block: { type: 'text', text: '' },
          },
        },
        {
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'text_delta', text: 'hello-from-text-block-2' },
          },
        },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
        { event: 'message_stop', data: { type: 'message_stop' } },
      ],
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(200);
    const body = await res.text();

    // Original text content for blocks 0 and 2 made it through.
    expect(body).toContain('hello-from-text-block-0');
    expect(body).toContain('hello-from-text-block-2');
    // Block 1's tool_use was substituted with a [Blocked …] text block,
    // and the substitution preserved the index so client-side message
    // assembly remains valid.
    expect(body).toContain('Blocked by Claude Sentinel');
    expect(body).toContain('"index":1');
    // The original block-1 tool_use payload did NOT leak through.
    expect(body).not.toContain('rm -rf /');
  });

  it('tool_use with byte-split chunking (1 byte per write) yields the same denied substitution', async () => {
    const ctx = trackContext(
      await startProxyWithFake({
        enablePermissionsEnforcer: true,
        settings: { ...SYNC_BLOCK },
      }),
    );
    upsertPermissionRule(ctx.db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      source: 'local',
    });
    ctx.enforcer!.invalidate();

    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: toolUseSseEvents(0, 'Bash', { command: 'rm -rf /' }),
      sseChunking: 'byte-split',
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Blocked by Claude Sentinel');
    expect(body).not.toContain('rm -rf /');
  });
});

describe('proxy permissions e2e: outbound tool[] stripping', () => {
  it('whole-tool deny rule strips the matching tool from the request body before it reaches upstream', async () => {
    const ctx = trackContext(
      await startProxyWithFake({
        enablePermissionsEnforcer: true,
        settings: {
          toolPermissionsEnabled: true,
          toolPermissionDefaultAction: 'allow',
          // Disable hold so the strip happens synchronously and we can
          // observe the rewritten request body without orchestrating
          // an approve/deny IPC.
          securityBlockHoldEnabled: false,
        },
      }),
    );
    upsertPermissionRule(ctx.db, {
      decision: 'deny',
      tool: 'WebFetch',
      pattern: null,
      raw: 'WebFetch',
      source: 'local',
    });
    ctx.enforcer!.invalidate();

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'Bash', description: 'run shell' },
        { name: 'WebFetch', description: 'fetch a URL' },
        { name: 'Read', description: 'read a file' },
      ],
    });
    expect(res.status).toBe(200);

    // Inspect the body the fake-Anthropic actually saw.
    const upstreamReq = ctx.fake.requests().find((r) => r.url.startsWith('/v1/messages'));
    expect(upstreamReq).toBeDefined();
    const sentBody = JSON.parse(upstreamReq!.body) as { tools?: Array<{ name: string }> };
    const toolNames = (sentBody.tools ?? []).map((t) => t.name);
    expect(toolNames).toEqual(['Bash', 'Read']);
    // WebFetch was stripped — the agent literally cannot call it on this turn.
    expect(toolNames).not.toContain('WebFetch');
  });
});

describe('proxy permissions e2e: rule mutation reflects between requests', () => {
  it('a deny rule added between two requests blocks the second one (cache invalidation works)', async () => {
    const ctx = trackContext(
      await startProxyWithFake({
        enablePermissionsEnforcer: true,
        settings: { ...SYNC_BLOCK },
      }),
    );

    // Request 1 — no deny rules. tool_use must pass through.
    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: toolUseSseEvents(0, 'Bash', { command: 'rm -rf /' }),
    });
    const res1 = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    const body1 = await res1.text();
    expect(body1).toContain('"type":"tool_use"');
    expect(body1).not.toContain('Blocked by Claude Sentinel');

    // Add the deny rule and invalidate the enforcer's compiled cache.
    upsertPermissionRule(ctx.db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      source: 'local',
    });
    ctx.enforcer!.invalidate();

    // Request 2 — same SSE payload, but this time the deny applies.
    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: toolUseSseEvents(0, 'Bash', { command: 'rm -rf /' }),
    });
    const res2 = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    const body2 = await res2.text();
    expect(body2).toContain('Blocked by Claude Sentinel');
    expect(body2).not.toContain('rm -rf /');
  });
});

describe('proxy permissions e2e: ask rule still surfaces a pending block to the registry', () => {
  // The full async flow (user-resolves before fail-open) is fundamentally
  // racy in a real-HTTP harness because the upstream stream may close
  // before the test can poll-and-resolve. Unit-tested in
  // sse-interceptor.test.ts:"flush during an active hold" + the
  // approve/deny outcomes. This e2e test verifies only that ask
  // produces a registry entry that the IPC layer can list — the
  // visible side-effect is sufficient to know the wiring is correct
  // without depending on timing.
  it('ask rule on a tool_use call registers a pending block with the right rule + tool', async () => {
    const ctx = trackContext(
      await startProxyWithFake({
        enablePermissionsEnforcer: true,
        settings: {
          toolPermissionsEnabled: true,
          toolPermissionDefaultAction: 'allow',
          securityBlockHoldEnabled: true,
          securityApproveHoldSec: 60,
        },
      }),
    );
    upsertPermissionRule(ctx.db, {
      decision: 'ask',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      source: 'local',
    });
    ctx.enforcer!.invalidate();

    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: toolUseSseEvents(0, 'Bash', { command: 'rm -rf /tmp/build' }),
    });

    // Fire the request and let it run to completion (fail-open path is
    // expected here — we're not asserting on the response body, only
    // on whether the registry observed the tool_use).
    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    await res.text();

    // The registry's onFinalized hook records a security event on
    // settle (timeout/approve/deny). For an unresolved ask that
    // fail-opened, the entry stays live until settle fires. Either
    // way, a row in security_events with kind='tool_permission_blocked'
    // and source='permissions_tool_use' is the durable signal that
    // the ask wiring fired.
    //
    // The pending entry itself is in-memory; assert via listPending
    // that it was registered. The fail-open scenario leaves the
    // entry in place since the timer hasn't tripped yet.
    const pendings = ctx.enforcer!.listPending();
    expect(pendings.some((p) => p.toolName === 'Bash' && p.matchMask === 'Bash(rm -rf *)')).toBe(
      true,
    );

    // Resolve so the cleanup tear-down doesn't dangle.
    for (const p of pendings) ctx.enforcer!.resolvePending(p.pendingId, 'deny');
  });
});

describe('proxy permissions e2e: auto-mode bypass', () => {
  it("anthropic-beta: afk-mode header bypasses every deny rule (Claude Code's auto-mode opt-out)", async () => {
    const ctx = trackContext(
      await startProxyWithFake({
        enablePermissionsEnforcer: true,
        settings: {
          ...SYNC_BLOCK,
          toolPermissionSkipInAutoMode: true,
        },
      }),
    );
    upsertPermissionRule(ctx.db, {
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
      source: 'local',
    });
    ctx.enforcer!.invalidate();

    ctx.fake.queueResponse('/v1/messages', {
      sseEvents: toolUseSseEvents(0, 'Bash', { command: 'rm -rf /' }),
    });

    const res = await postThroughProxy(
      ctx.proxyPort,
      '/v1/messages',
      { messages: [] },
      { headers: { 'anthropic-beta': 'afk-mode-2026-01-15' } },
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    // Auto-mode skip → no enforcement → the original tool_use passes
    // through. The user opted into Claude Code's auto-mode classifier
    // and Sentinel deliberately stays out of the way.
    expect(body).toContain('"type":"tool_use"');
    expect(body).not.toContain('Blocked by Claude Sentinel');
  });
});
