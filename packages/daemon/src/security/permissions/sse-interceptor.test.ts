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
    joined() { return chunks.join(''); },
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
  out += formatSseFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } });
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
      rules: compileRules([rule({ decision: 'deny', tool: 'Bash', pattern: 'rm -rf *', raw: 'Bash(rm -rf *)' })]),
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
    const denyRule = rule({ decision: 'deny', tool: 'Bash', pattern: 'rm -rf *', raw: 'Bash(rm -rf *)' });
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
    const stream = buildToolUseStream({ name: 'WebFetch', inputParts: ['{"url":"https://example.com"}'] });
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
