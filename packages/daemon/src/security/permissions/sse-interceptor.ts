/**
 * SSE stream interceptor that enforces permission rules by rewriting
 * `tool_use` content blocks in a `/v1/messages` streaming response.
 *
 * Unlike {@link ResponseTap}, which is a pure observer, this interceptor
 * *participates* in the forwarding path: it buffers any event belonging to a
 * tool_use content block until `content_block_stop` arrives, evaluates the
 * assembled tool_use against the rule set, and then either flushes the
 * buffered bytes to the client verbatim (allow) or substitutes a synthetic
 * text block carrying a block-reason message (deny).
 *
 * All other events — `message_start`, `message_delta`, `message_stop`,
 * text content blocks, ping — pass through without delay. Per-block
 * buffering is capped at 64 KB; larger tool inputs fall back to
 * pass-through with a warning so a malicious upstream can't stall the
 * client by streaming an unbounded partial_json.
 *
 * Used by the proxy when `toolPermissionsEnabled` is true. Gzipped
 * responses are not supported at this layer — the proxy strips
 * `accept-encoding` from the upstream request before installing the
 * interceptor.
 */

import type { ServerResponse } from 'http';
import type { PermissionRule } from '@claude-sentinel/shared';
import {
  compileRules,
  evaluateToolCall,
  type CompiledRuleSet,
  type EvaluatorSettingsView,
} from './evaluator.js';

/** Per-block buffer cap. Tool inputs larger than this fall back to
 *  pass-through so the interceptor never stalls the client indefinitely. */
export const MAX_BLOCK_BUFFER_BYTES = 64 * 1024;

/** A synthetic text block's substitution text, parameterized by the
 *  matched rule and optional note. Kept as a pure function for testing. */
export function buildBlockText(rule: PermissionRule): string {
  const parts = [`[Blocked by Claude Sentinel: ${rule.raw}`];
  if (rule.note) parts.push(` — ${rule.note}`);
  parts.push(']');
  return parts.join('');
}

/** Format a single SSE frame. The Anthropic streaming API uses the standard
 *  `event: <type>\ndata: <json>\n\n` shape. */
export function formatSseFrame(eventType: string, payload: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** Synthetic events emitted when a tool_use block is denied. Exposed for
 *  testing; wraps `formatSseFrame` with Anthropic's `content_block_*`
 *  payload shapes. */
export function synthesizeTextBlock(index: number, text: string): string {
  return (
    formatSseFrame('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    }) +
    formatSseFrame('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: { type: 'text_delta', text },
    }) +
    formatSseFrame('content_block_stop', {
      type: 'content_block_stop',
      index,
    })
  );
}

export interface InterceptorSink {
  write(chunk: string | Buffer): void;
}

/** Minimal adapter so the interceptor can target either a Node ServerResponse
 *  (production) or a test-side string collector. */
export function sinkFromResponse(res: ServerResponse): InterceptorSink {
  return {
    write(chunk: string | Buffer): void {
      res.write(chunk);
    },
  };
}

/** Hook invoked each time the interceptor blocks a tool_use. The proxy wires
 *  this to the security-event persistAndBroadcast pipeline. */
export type OnBlockedHook = (args: {
  toolName: string;
  toolInput: unknown;
  matchedRule: PermissionRule;
  accountId: string;
}) => void;

interface BlockState {
  /** 'passthrough' for non-tool_use content blocks. */
  mode: 'passthrough' | 'buffering' | 'substituted';
  /** Raw SSE frames accumulated while `mode === 'buffering'`. Preserved
   *  byte-for-byte so allow-decisions replay upstream's exact output. */
  bufferedRaw: string[];
  bufferedBytes: number;
  toolName: string;
  partialJson: string;
  overflowed: boolean;
}

export interface PermissionsSseInterceptor {
  push(chunk: Buffer | string): void;
  flush(): void;
  destroy(): void;
}

export interface CreateInterceptorOptions {
  sink: InterceptorSink;
  rules: PermissionRule[] | CompiledRuleSet;
  settings: EvaluatorSettingsView;
  accountId: string;
  onBlocked?: OnBlockedHook;
}

/**
 * Build a permission-enforcing SSE interceptor. Attach it to the upstream
 * response: for every chunk, call `push(chunk)`; on `end`, call `flush()`;
 * on error, call `destroy()` and fall through to the client as-is.
 */
export function createPermissionsSseInterceptor(
  opts: CreateInterceptorOptions,
): PermissionsSseInterceptor {
  const compiled: CompiledRuleSet = Array.isArray(opts.rules) ? compileRules(opts.rules) : opts.rules;
  const sink = opts.sink;
  const blocks = new Map<number, BlockState>();

  let rawBuffer = '';
  let killed = false;
  /** True once any tool_use block has been substituted with synthetic text.
   *  When true, we rewrite `stop_reason: "tool_use"` in message_delta to
   *  `"end_turn"` so the client's streaming parser doesn't go hunting for
   *  a tool_use block that no longer exists. */
  let substitutedAny = false;

  const push = (chunk: Buffer | string): void => {
    if (killed) return;
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    rawBuffer += str;
    drainFrames();
  };

  const drainFrames = (): void => {
    // SSE events are separated by a blank line (\n\n). Consume one event at a
    // time; hold any trailing partial event for the next chunk.
    while (true) {
      const sepIdx = rawBuffer.indexOf('\n\n');
      if (sepIdx === -1) break;
      const frame = rawBuffer.slice(0, sepIdx + 2);
      rawBuffer = rawBuffer.slice(sepIdx + 2);
      processFrame(frame);
    }
  };

  const processFrame = (frame: string): void => {
    // Parse the frame's `data:` payload. Non-data lines (event:, id:) are kept
    // as part of the raw frame string when replayed.
    const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) {
      // No data: line — likely a comment or empty keepalive. Pass through.
      sink.write(frame);
      return;
    }
    const payload = dataLine.slice(5).trimStart();
    if (payload === '[DONE]') {
      sink.write(frame);
      return;
    }
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      // Malformed event — pass through untouched.
      sink.write(frame);
      return;
    }
    routeEvent(frame, evt);
  };

  const routeEvent = (frame: string, evt: Record<string, unknown>): void => {
    const type = evt['type'];
    const index = typeof evt['index'] === 'number' ? evt['index'] : -1;

    if (type === 'content_block_start') {
      const block = evt['content_block'] as Record<string, unknown> | undefined;
      if (!block || block['type'] !== 'tool_use' || index < 0) {
        blocks.set(index, { mode: 'passthrough', bufferedRaw: [], bufferedBytes: 0, toolName: '', partialJson: '', overflowed: false });
        sink.write(frame);
        return;
      }
      const toolName = typeof block['name'] === 'string' ? block['name'] : '';
      blocks.set(index, {
        mode: 'buffering',
        bufferedRaw: [frame],
        bufferedBytes: frame.length,
        toolName,
        partialJson: '',
        overflowed: false,
      });
      return;
    }

    if (type === 'content_block_delta' && index >= 0) {
      const state = blocks.get(index);
      if (!state || state.mode !== 'buffering') {
        sink.write(frame);
        return;
      }
      if (state.overflowed) {
        sink.write(frame);
        return;
      }
      state.bufferedRaw.push(frame);
      state.bufferedBytes += frame.length;
      const delta = evt['delta'] as Record<string, unknown> | undefined;
      if (delta && delta['type'] === 'input_json_delta' && typeof delta['partial_json'] === 'string') {
        state.partialJson += delta['partial_json'];
      }
      if (state.bufferedBytes > MAX_BLOCK_BUFFER_BYTES) {
        // Overflow — give up buffering, flush what we have and let the rest
        // pass through unmolested. The rule evaluator can't see the tool
        // call so we default to "allow" here. This is load-bearing: a
        // malicious upstream cannot stall the client by emitting an
        // unbounded partial_json.
        state.overflowed = true;
        for (const f of state.bufferedRaw) sink.write(f);
        state.bufferedRaw = [];
        state.bufferedBytes = 0;
      }
      return;
    }

    if (type === 'content_block_stop' && index >= 0) {
      const state = blocks.get(index);
      if (!state) {
        sink.write(frame);
        return;
      }
      if (state.mode !== 'buffering' || state.overflowed) {
        sink.write(frame);
        return;
      }
      state.bufferedRaw.push(frame);
      decideAndFlush(index, state);
      return;
    }

    // message_delta carries `stop_reason`. If we substituted a tool_use
    // block, the original `stop_reason: "tool_use"` is now a lie — the
    // client will hunt for a tool_use in the content and error out.
    // Rewrite to "end_turn" so the turn terminates cleanly.
    if (type === 'message_delta' && substitutedAny) {
      const delta = evt['delta'] as Record<string, unknown> | undefined;
      if (delta && delta['stop_reason'] === 'tool_use') {
        const rewritten = {
          ...evt,
          delta: { ...delta, stop_reason: 'end_turn' },
        };
        sink.write(formatSseFrame('message_delta', rewritten));
        return;
      }
    }

    // Default pass-through for message_*, ping, and any other unknown event.
    sink.write(frame);
  };

  const decideAndFlush = (index: number, state: BlockState): void => {
    let toolInput: unknown = {};
    if (state.partialJson.length > 0) {
      try {
        toolInput = JSON.parse(state.partialJson);
      } catch {
        toolInput = {};
      }
    }
    const decision = evaluateToolCall(state.toolName, toolInput, compiled, opts.settings);
    if (decision.decision === 'allow' || !decision.matchedRule) {
      // Flush verbatim.
      for (const f of state.bufferedRaw) sink.write(f);
      state.mode = 'passthrough';
      state.bufferedRaw = [];
      return;
    }
    // Deny: drop buffered frames, emit synthetic text block.
    const text = buildBlockText(decision.matchedRule);
    sink.write(synthesizeTextBlock(index, text));
    state.mode = 'substituted';
    state.bufferedRaw = [];
    substitutedAny = true;
    opts.onBlocked?.({
      toolName: state.toolName,
      toolInput,
      matchedRule: decision.matchedRule,
      accountId: opts.accountId,
    });
  };

  const flush = (): void => {
    if (killed) return;
    // Emit any still-buffered partial frame that never terminated. Rare in
    // practice — the upstream either sends a proper content_block_stop or
    // an error. If we have tool_use frames in flight, flush them verbatim
    // so we don't swallow the response.
    for (const state of blocks.values()) {
      if (state.mode === 'buffering' && state.bufferedRaw.length > 0) {
        for (const f of state.bufferedRaw) sink.write(f);
      }
    }
    if (rawBuffer.length > 0) {
      sink.write(rawBuffer);
      rawBuffer = '';
    }
    blocks.clear();
  };

  const destroy = (): void => {
    killed = true;
    rawBuffer = '';
    blocks.clear();
  };

  return { push, flush, destroy };
}
