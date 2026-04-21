import { describe, it, expect, vi } from 'vitest';
import type { PermissionRule } from '@claude-sentinel/shared';
import {
  createPermissionsSseInterceptor,
  buildBlockText,
  formatSseFrame,
  synthesizeTextBlock,
  MAX_BLOCK_BUFFER_BYTES,
  type InterceptorSink,
} from './sse-interceptor.js';
import { compileRules, type EvaluatorSettingsView } from './evaluator.js';

function collectingSink(): InterceptorSink & { chunks: string[]; joined: () => string } {
  const chunks: string[] = [];
  return {
    write(c: string | Buffer): void {
      chunks.push(typeof c === 'string' ? c : c.toString('utf-8'));
    },
    chunks,
    joined() {
      return chunks.join('');
    },
  };
}

function rule(overrides: Partial<PermissionRule>): PermissionRule {
  return {
    id: overrides.id ?? `r-${Math.random().toString(36).slice(2)}`,
    decision: overrides.decision ?? 'deny',
    tool: overrides.tool ?? 'Bash',
    pattern: overrides.pattern ?? null,
    raw: overrides.raw ?? overrides.tool ?? 'Bash',
    note: overrides.note ?? null,
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 100,
    createdAt: overrides.createdAt ?? 0,
    source: overrides.source ?? 'local',
  };
}

function settings(overrides: Partial<EvaluatorSettingsView> = {}): EvaluatorSettingsView {
  return {
    toolPermissionsEnabled: true,
    toolPermissionDefaultAction: 'allow',
    toolPermissionSkipInAutoMode: true,
    toolPermissionAutoModeActive: false,
    ...overrides,
  };
}

/** Build a complete SSE stream with one tool_use block. Input is split into
 *  n `input_json_delta` frames so we can stress the parser's chunking. */
function buildToolUseStream(opts: {
  index?: number;
  name: string;
  id?: string;
  inputParts: string[];
}): string {
  const idx = opts.index ?? 0;
  let out = '';
  out += formatSseFrame('message_start', { type: 'message_start', message: { id: 'msg_1' } });
  out += formatSseFrame('content_block_start', {
    type: 'content_block_start',
    index: idx,
    content_block: { type: 'tool_use', id: opts.id ?? 'toolu_1', name: opts.name, input: {} },
  });
  for (const part of opts.inputParts) {
    out += formatSseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: idx,
      delta: { type: 'input_json_delta', partial_json: part },
    });
  }
  out += formatSseFrame('content_block_stop', { type: 'content_block_stop', index: idx });
  out += formatSseFrame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
  });
  out += formatSseFrame('message_stop', { type: 'message_stop' });
  return out;
}

describe('buildBlockText', () => {
  it('includes rule raw', () => {
    const r = rule({ raw: 'Bash(rm -rf *)' });
    expect(buildBlockText(r)).toBe('[Blocked by Claude Sentinel: Bash(rm -rf *)]');
  });
  it('appends note when present', () => {
    const r = rule({ raw: 'WebFetch', note: 'no network in CI' });
    expect(buildBlockText(r)).toBe('[Blocked by Claude Sentinel: WebFetch — no network in CI]');
  });
});

describe('formatSseFrame / synthesizeTextBlock', () => {
  it('emits event + data + blank line', () => {
    const f = formatSseFrame('ping', { type: 'ping' });
    expect(f).toBe('event: ping\ndata: {"type":"ping"}\n\n');
  });
  it('synthesizeTextBlock yields three frames', () => {
    const out = synthesizeTextBlock(2, 'blocked');
    expect(out).toContain('content_block_start');
    expect(out).toContain('content_block_delta');
    expect(out).toContain('content_block_stop');
    expect(out).toContain('"index":2');
    expect(out).toContain('"text":"blocked"');
  });
});

describe('interceptor — allow decision', () => {
  it('passes tool_use through byte-for-byte', () => {
    const sink = collectingSink();
    const stream = buildToolUseStream({
      name: 'Bash',
      inputParts: ['{"comm', 'and": "npm', ' test"}'],
    });
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([rule({ decision: 'allow', tool: 'Bash', pattern: null, raw: 'Bash' })]),
      settings: settings(),
      accountId: 'acc-1',
    });
    it.push(stream);
    it.flush();
    expect(sink.joined()).toBe(stream);
  });

  it('passes tool_use through under default-allow (no matching rule)', () => {
    const sink = collectingSink();
    const stream = buildToolUseStream({ name: 'Read', inputParts: ['{"file_path":"/a"}'] });
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([]),
      settings: settings({ toolPermissionDefaultAction: 'allow' }),
      accountId: 'acc-1',
    });
    it.push(stream);
    it.flush();
    expect(sink.joined()).toBe(stream);
  });

  it('passes through when feature is disabled', () => {
    const sink = collectingSink();
    const stream = buildToolUseStream({ name: 'Bash', inputParts: ['{"command":"rm -rf /"}'] });
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([
        rule({ decision: 'deny', tool: 'Bash', pattern: 'rm -rf *', raw: 'Bash(rm -rf *)' }),
      ]),
      settings: settings({ toolPermissionsEnabled: false }),
      accountId: 'acc-1',
    });
    it.push(stream);
    it.flush();
    expect(sink.joined()).toBe(stream);
  });
});

describe('interceptor — deny decision', () => {
  it('substitutes synthetic text block for a denied tool_use', () => {
    const sink = collectingSink();
    const onBlocked = vi.fn();
    const denyRule = rule({
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
    });
    const stream = buildToolUseStream({ name: 'Bash', inputParts: ['{"command":"rm -rf /tmp"}'] });
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([denyRule]),
      settings: settings(),
      accountId: 'acc-1',
      onBlocked,
    });
    it.push(stream);
    it.flush();
    const out = sink.joined();
    expect(out).not.toContain('"type":"tool_use"');
    expect(out).toContain('[Blocked by Claude Sentinel: Bash(rm -rf *)]');
    expect(out).toContain('message_start');
    expect(out).toContain('message_stop');
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(onBlocked.mock.calls[0]?.[0]).toMatchObject({
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /tmp' },
      matchedRule: denyRule,
      accountId: 'acc-1',
    });
  });

  it('denies whole-tool denied WebFetch (even though request-level strip usually handles that)', () => {
    const sink = collectingSink();
    const denyRule = rule({ decision: 'deny', tool: 'WebFetch', pattern: null, raw: 'WebFetch' });
    const stream = buildToolUseStream({
      name: 'WebFetch',
      inputParts: ['{"url":"https://example.com"}'],
    });
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([denyRule]),
      settings: settings(),
      accountId: 'acc-1',
    });
    it.push(stream);
    it.flush();
    expect(sink.joined()).toContain('[Blocked by Claude Sentinel: WebFetch]');
  });

  it('handles tiny chunks spread across tool_use events', () => {
    const sink = collectingSink();
    const denyRule = rule({ decision: 'deny', tool: 'Bash', pattern: 'rm *', raw: 'Bash(rm *)' });
    const stream = buildToolUseStream({
      name: 'Bash',
      inputParts: ['{"comm', 'and"', ':"rm file"}'],
    });
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([denyRule]),
      settings: settings(),
      accountId: 'acc-1',
    });
    // Feed one byte at a time.
    for (const ch of stream) it.push(ch);
    it.flush();
    expect(sink.joined()).toContain('[Blocked by Claude Sentinel: Bash(rm *)]');
  });
});

describe('interceptor — text blocks pass through', () => {
  it('does not buffer text content blocks', () => {
    const sink = collectingSink();
    const textStream =
      formatSseFrame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }) +
      formatSseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello world' },
      }) +
      formatSseFrame('content_block_stop', { type: 'content_block_stop', index: 0 });
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([rule({ decision: 'deny' })]),
      settings: settings(),
      accountId: 'acc-1',
    });
    it.push(textStream);
    it.flush();
    expect(sink.joined()).toBe(textStream);
  });
});

describe('interceptor — overflow safety', () => {
  it('falls back to passthrough when a tool_use input exceeds the buffer cap', () => {
    const sink = collectingSink();
    const big = 'x'.repeat(MAX_BLOCK_BUFFER_BYTES + 1000);
    const stream = buildToolUseStream({
      name: 'Bash',
      inputParts: [`{"command":"${big}"}`],
    });
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([rule({ decision: 'deny', tool: 'Bash', pattern: '*', raw: 'Bash(*)' })]),
      settings: settings(),
      accountId: 'acc-1',
    });
    it.push(stream);
    it.flush();
    // Overflow → pass-through. The denied rule does NOT get to rewrite the block.
    expect(sink.joined()).toContain('"type":"tool_use"');
    expect(sink.joined()).not.toContain('[Blocked by Claude Sentinel');
  });
});

describe('interceptor — resilience', () => {
  it('passes unknown event types through', () => {
    const sink = collectingSink();
    const stream = formatSseFrame('custom_event', { type: 'custom_event', foo: 1 });
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([]),
      settings: settings(),
      accountId: 'acc-1',
    });
    it.push(stream);
    it.flush();
    expect(sink.joined()).toBe(stream);
  });

  it('passes malformed JSON frames through', () => {
    const sink = collectingSink();
    const stream = 'event: ping\ndata: {not json}\n\n';
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([]),
      settings: settings(),
      accountId: 'acc-1',
    });
    it.push(stream);
    it.flush();
    expect(sink.joined()).toBe(stream);
  });

  it('passes through data-less frames (comments/keepalives)', () => {
    const sink = collectingSink();
    const stream = ': keepalive\n\n';
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([]),
      settings: settings(),
      accountId: 'acc-1',
    });
    it.push(stream);
    it.flush();
    expect(sink.joined()).toBe(stream);
  });

  it('passes [DONE] sentinel through', () => {
    const sink = collectingSink();
    const stream = 'data: [DONE]\n\n';
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([]),
      settings: settings(),
      accountId: 'acc-1',
    });
    it.push(stream);
    it.flush();
    expect(sink.joined()).toBe(stream);
  });

  it('destroy() clears state and drops further writes', () => {
    const sink = collectingSink();
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([]),
      settings: settings(),
      accountId: 'acc-1',
    });
    it.push('data: {"type":"ping"}\n\n');
    it.destroy();
    it.push('data: {"type":"ping"}\n\n');
    it.flush();
    // Only the first ping should have been written.
    expect(sink.chunks.length).toBe(1);
  });
});

describe('interceptor — stop_reason rewrite', () => {
  it('rewrites stop_reason: tool_use to end_turn when a tool_use was substituted', () => {
    const sink = collectingSink();
    const denyRule = rule({ decision: 'deny', tool: 'Bash', pattern: 'rm *', raw: 'Bash(rm *)' });
    const stream =
      formatSseFrame('message_start', { type: 'message_start', message: { id: 'm' } }) +
      formatSseFrame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't0', name: 'Bash', input: {} },
      }) +
      formatSseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":"rm file"}' },
      }) +
      formatSseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      formatSseFrame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 10 },
      }) +
      formatSseFrame('message_stop', { type: 'message_stop' });
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([denyRule]),
      settings: settings(),
      accountId: 'acc-1',
    });
    it.push(stream);
    it.flush();
    const out = sink.joined();
    expect(out).toContain('"stop_reason":"end_turn"');
    expect(out).not.toContain('"stop_reason":"tool_use"');
    // Usage payload should still be present so the client updates its
    // token counters correctly.
    expect(out).toContain('"output_tokens":10');
  });

  it('leaves stop_reason alone when no tool_use was substituted', () => {
    const sink = collectingSink();
    // No rules; the tool_use passes through unchanged.
    const stream =
      formatSseFrame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't0', name: 'Bash', input: {} },
      }) +
      formatSseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":"npm test"}' },
      }) +
      formatSseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      formatSseFrame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
      });
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([]),
      settings: settings(),
      accountId: 'acc-1',
    });
    it.push(stream);
    it.flush();
    const out = sink.joined();
    expect(out).toContain('"stop_reason":"tool_use"');
    expect(out).not.toContain('"stop_reason":"end_turn"');
  });

  it('leaves non-tool_use stop_reason alone even after a substitution', () => {
    const sink = collectingSink();
    const denyRule = rule({ decision: 'deny', tool: 'Bash', pattern: 'rm *', raw: 'Bash(rm *)' });
    const stream =
      formatSseFrame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't0', name: 'Bash', input: {} },
      }) +
      formatSseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":"rm x"}' },
      }) +
      formatSseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      formatSseFrame('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens', stop_sequence: null },
      });
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([denyRule]),
      settings: settings(),
      accountId: 'acc-1',
    });
    it.push(stream);
    it.flush();
    // max_tokens should survive; we only rewrite the tool_use stop_reason.
    expect(sink.joined()).toContain('"stop_reason":"max_tokens"');
  });
});

describe('interceptor — multiple blocks', () => {
  it('blocks the denied tool_use but passes a subsequent allowed one', () => {
    const sink = collectingSink();
    const denyRule = rule({ decision: 'deny', tool: 'Bash', pattern: 'rm *', raw: 'Bash(rm *)' });
    const stream =
      formatSseFrame('message_start', { type: 'message_start', message: { id: 'm' } }) +
      // Block 0 — denied Bash
      formatSseFrame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't0', name: 'Bash', input: {} },
      }) +
      formatSseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":"rm file"}' },
      }) +
      formatSseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      // Block 1 — allowed Read
      formatSseFrame('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      }) +
      formatSseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a"}' },
      }) +
      formatSseFrame('content_block_stop', { type: 'content_block_stop', index: 1 }) +
      formatSseFrame('message_stop', { type: 'message_stop' });
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([denyRule]),
      settings: settings(),
      accountId: 'acc-1',
    });
    it.push(stream);
    it.flush();
    const out = sink.joined();
    expect(out).toContain('[Blocked by Claude Sentinel: Bash(rm *)]');
    // Read tool_use should be passed verbatim
    expect(out).toContain('"name":"Read"');
    expect(out).toContain('\\"file_path\\":\\"/a\\"');
  });
});

describe('interceptor — async hold flow', () => {
  const denyRule = rule({ decision: 'deny', tool: 'Bash', pattern: 'rm *', raw: 'Bash(rm *)' });

  it('approve: flushes the buffered tool_use frames verbatim to the client', async () => {
    const sink = collectingSink();
    let resolveDecision: ((o: 'approve' | 'deny' | 'timeout') => void) | null = null;
    const onBlocked = vi.fn();
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([denyRule]),
      settings: settings(),
      accountId: 'acc-h',
      awaitDecision: () =>
        new Promise<'approve' | 'deny' | 'timeout'>((resolve) => {
          resolveDecision = resolve;
        }),
      onBlocked,
    });
    const stream = buildToolUseStream({ name: 'Bash', inputParts: ['{"command":"rm -rf /tmp"}'] });
    it.push(stream);

    // Pending decision has been triggered; let the microtask settle.
    await Promise.resolve();
    expect(resolveDecision).not.toBeNull();

    // Frames that arrive during the hold must accumulate in holdBuffer.
    it.push(formatSseFrame('ping', { type: 'ping' }));

    resolveDecision!('approve');
    // Let the async decideAndFlush finish.
    await new Promise((r) => setTimeout(r, 0));
    it.flush();

    const out = sink.joined();
    // Approved → original tool_use body flushed verbatim.
    expect(out).toContain('"name":"Bash"');
    expect(out).toContain('rm -rf /tmp');
    // And the ping emitted during the hold came through.
    expect(out).toContain('"type":"ping"');
    // No synthetic block text was inserted.
    expect(out).not.toContain('[Blocked by Claude Sentinel');
    // onBlocked is NOT invoked on the async-approve path (the pending
    // registry's onFinalized already persists the event — no double-fire).
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it('deny: substitutes the synthetic block text even on the async path', async () => {
    const sink = collectingSink();
    let resolveDecision: ((o: 'approve' | 'deny' | 'timeout') => void) | null = null;
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([denyRule]),
      settings: settings(),
      accountId: 'acc-h',
      awaitDecision: () =>
        new Promise<'approve' | 'deny' | 'timeout'>((resolve) => {
          resolveDecision = resolve;
        }),
    });
    const stream = buildToolUseStream({ name: 'Bash', inputParts: ['{"command":"rm -rf /tmp"}'] });
    it.push(stream);
    await Promise.resolve();
    resolveDecision!('deny');
    await new Promise((r) => setTimeout(r, 0));
    it.flush();

    const out = sink.joined();
    expect(out).toContain('[Blocked by Claude Sentinel: Bash(rm *)]');
    // Original tool_use frames must NOT appear.
    expect(out).not.toContain('rm -rf /tmp');
  });

  it('timeout: treated identically to deny on the async path', async () => {
    const sink = collectingSink();
    let resolveDecision: ((o: 'approve' | 'deny' | 'timeout') => void) | null = null;
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([denyRule]),
      settings: settings(),
      accountId: 'acc-h',
      awaitDecision: () =>
        new Promise<'approve' | 'deny' | 'timeout'>((resolve) => {
          resolveDecision = resolve;
        }),
    });
    it.push(buildToolUseStream({ name: 'Bash', inputParts: ['{"command":"rm -rf /"}'] }));
    await Promise.resolve();
    resolveDecision!('timeout');
    await new Promise((r) => setTimeout(r, 0));
    it.flush();

    expect(sink.joined()).toContain('[Blocked by Claude Sentinel: Bash(rm *)]');
  });

  it('awaitDecision throws → treated as deny (fail-closed)', async () => {
    const sink = collectingSink();
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([denyRule]),
      settings: settings(),
      accountId: 'acc-h',
      awaitDecision: () => {
        throw new Error('hook blew up');
      },
    });
    it.push(buildToolUseStream({ name: 'Bash', inputParts: ['{"command":"rm -rf /"}'] }));
    await new Promise((r) => setTimeout(r, 0));
    it.flush();

    expect(sink.joined()).toContain('[Blocked by Claude Sentinel: Bash(rm *)]');
  });

  it('destroy during a pending hold discards every buffer cleanly', async () => {
    const sink = collectingSink();
    let resolveDecision: ((o: 'approve' | 'deny' | 'timeout') => void) | null = null;
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([denyRule]),
      settings: settings(),
      accountId: 'acc-h',
      awaitDecision: () =>
        new Promise<'approve' | 'deny' | 'timeout'>((resolve) => {
          resolveDecision = resolve;
        }),
    });
    it.push(buildToolUseStream({ name: 'Bash', inputParts: ['{"command":"rm -rf /"}'] }));
    await Promise.resolve();

    // Tear down mid-hold.
    it.destroy();
    resolveDecision!('approve');
    await new Promise((r) => setTimeout(r, 0));

    // Post-destroy push is a no-op.
    it.push('event: later\ndata: {}\n\n');
    // Post-destroy flush also a no-op.
    it.flush();

    // Some frames may have been emitted before decideAndFlush awaited, but
    // nothing after the destroy should land. Most importantly, no synthetic
    // block, no "later" frame.
    expect(sink.joined()).not.toContain('[Blocked by Claude Sentinel');
    expect(sink.joined()).not.toContain('event: later');
  });

  it('push accepts a Buffer chunk and decodes it as utf-8', () => {
    const sink = collectingSink();
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([]),
      settings: settings({ toolPermissionDefaultAction: 'allow' }),
      accountId: 'acc-1',
    });
    it.push(Buffer.from('event: ping\ndata: {"type":"ping"}\n\n', 'utf-8'));
    it.flush();
    expect(sink.joined()).toContain('"type":"ping"');
  });

  it('content_block_start with a non-string name field falls back to empty toolName', () => {
    const sink = collectingSink();
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([rule({ decision: 'deny', tool: '*', pattern: null, raw: '*' })]),
      settings: settings(),
      accountId: 'acc-1',
    });
    // Manually build a tool_use stream where `name` is a number, exercising
    // the `typeof block["name"] === "string" ? ... : ""` branch.
    const stream =
      formatSseFrame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't1', name: 123, input: {} },
      }) +
      formatSseFrame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"x":1}' },
      }) +
      formatSseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      formatSseFrame('message_stop', { type: 'message_stop' });
    it.push(stream);
    it.flush();
    // Wildcard deny still matches the empty tool name; synthesized block emitted.
    expect(sink.joined()).toContain('[Blocked by Claude Sentinel');
  });

  it('flush during an active hold emits buffered tool_use frames verbatim (fail-open)', async () => {
    const sink = collectingSink();
    const pending: Array<() => void> = [];
    const it = createPermissionsSseInterceptor({
      sink,
      rules: compileRules([denyRule]),
      settings: settings(),
      accountId: 'acc-h',
      // Never resolves — simulates the decision hanging past end-of-stream.
      awaitDecision: () =>
        new Promise<'approve' | 'deny' | 'timeout'>(() => {
          pending.push(() => undefined);
        }),
    });
    it.push(buildToolUseStream({ name: 'Bash', inputParts: ['{"command":"rm -rf /"}'] }));
    await Promise.resolve();
    // An in-flight SSE frame (arrives during hold) must be captured in
    // holdBuffer and then emitted by the end-of-stream flush.
    it.push(formatSseFrame('ping', { type: 'ping' }));
    // End of stream with hold still active — fail open.
    it.flush();

    const out = sink.joined();
    // Buffered tool_use frames come through verbatim.
    expect(out).toContain('"name":"Bash"');
    expect(out).toContain('rm -rf /');
    expect(out).toContain('"type":"ping"');
  });
});
