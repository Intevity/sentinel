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
  type EvaluatorHooks,
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

/** Async decision gate. When provided, the interceptor calls this after
 *  a tool_use block finishes assembling and its rule evaluator returns
 *  deny — *before* substituting the synthetic text block. The enforcer
 *  wires this to its pending-block registry, so the caller can either
 *  approve (flush the tool_use frames as-is) or deny/timeout (fall
 *  through to substitution).
 *
 *  While the Promise is pending, any SSE chunks arriving on `push`
 *  are appended to an internal hold buffer and re-processed after the
 *  outcome is known. The 64 KB `MAX_BLOCK_BUFFER_BYTES` cap still
 *  governs per-tool_use buffering; the hold buffer that collects
 *  *other* frames during the await is separate and unbounded — the
 *  user's own timeout settles the block in bounded time. */
export type AwaitDecisionHook = (args: {
  toolName: string;
  toolInput: unknown;
  matchedRule: PermissionRule;
  accountId: string;
}) => Promise<'approve' | 'deny' | 'timeout'>;

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
  /** Optional async gate. Undefined → legacy synchronous behaviour
   *  (substitute on deny immediately). Defined → the interceptor
   *  routes every deny through this callback and acts on the outcome. */
  awaitDecision?: AwaitDecisionHook;
  /** Optional evaluator hooks. When `isBypassed` is provided, a
   *  matched deny rule with an approved (rule, input) bypass flips
   *  to 'allow' before the interceptor ever gates the pending flow —
   *  so previously-approved inputs flush through with zero banner. */
  evaluatorHooks?: EvaluatorHooks;
  /** Sprint 9: working directory of the request that produced this
   *  response stream. Threaded into `evaluateToolCall` so rules with
   *  a non-null `projectScope` only fire when the cwd matches. `null`
   *  (the default) makes scoped rules opt out of the match — matches
   *  the evaluator's contract. */
  cwd?: string | null;
}

/**
 * Build a permission-enforcing SSE interceptor. Attach it to the upstream
 * response: for every chunk, call `push(chunk)`; on `end`, call `flush()`;
 * on error, call `destroy()` and fall through to the client as-is.
 */
export function createPermissionsSseInterceptor(
  opts: CreateInterceptorOptions,
): PermissionsSseInterceptor {
  const compiled: CompiledRuleSet = Array.isArray(opts.rules)
    ? compileRules(opts.rules)
    : opts.rules;
  const sink = opts.sink;
  const blocks = new Map<number, BlockState>();

  let rawBuffer = '';
  let killed = false;
  /** True once any tool_use block has been substituted with synthetic text.
   *  When true, we rewrite `stop_reason: "tool_use"` in message_delta to
   *  `"end_turn"` so the client's streaming parser doesn't go hunting for
   *  a tool_use block that no longer exists. */
  let substitutedAny = false;

  /** Hold mode is on while an async `awaitDecision` call is in flight.
   *  All SSE chunks received during that window accumulate in
   *  `holdBuffer` so they don't race past the block we're still
   *  deciding about. When the decision settles we prepend the hold
   *  buffer back onto `rawBuffer` and re-drain as if nothing happened. */
  let holdBuffer = '';
  let holdActive = false;

  const push = (chunk: Buffer | string): void => {
    if (killed) return;
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    if (holdActive) {
      holdBuffer += str;
      return;
    }
    rawBuffer += str;
    drainFrames();
  };

  const drainFrames = (): void => {
    // SSE events are separated by a blank line (\n\n). Consume one event at a
    // time; hold any trailing partial event for the next chunk. If an
    // async decision starts mid-drain (content_block_stop → pending),
    // `processFrame` flips `holdActive` and we bail out so subsequent
    // frames can accumulate in `holdBuffer` until the decision settles.
    while (!holdActive) {
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
        blocks.set(index, {
          mode: 'passthrough',
          bufferedRaw: [],
          bufferedBytes: 0,
          toolName: '',
          partialJson: '',
          overflowed: false,
        });
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
      if (
        delta &&
        delta['type'] === 'input_json_delta' &&
        typeof delta['partial_json'] === 'string'
      ) {
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
      // Fire-and-forget: `decideAndFlush` may await the user's
      // decision, during which time `push()` diverts chunks into
      // `holdBuffer`. We don't `await` here because routeEvent is
      // called synchronously from the drainFrames loop — the loop
      // exits via the hold-mode check below before the next iteration.
      void decideAndFlush(index, state);
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

  const decideAndFlush = async (index: number, state: BlockState): Promise<void> => {
    let toolInput: unknown = {};
    if (state.partialJson.length > 0) {
      try {
        toolInput = JSON.parse(state.partialJson);
      } catch {
        toolInput = {};
      }
    }
    const decision = evaluateToolCall(
      state.toolName,
      toolInput,
      compiled,
      opts.settings,
      opts.evaluatorHooks,
      opts.cwd ?? null,
    );
    if (decision.decision === 'allow' || !decision.matchedRule) {
      // Flush verbatim.
      for (const f of state.bufferedRaw) sink.write(f);
      state.mode = 'passthrough';
      state.bufferedRaw = [];
      return;
    }

    const matchedRule = decision.matchedRule;

    // Sync path — no awaitDecision hook wired, fall back to the
    // historical "block immediately" behaviour. Keeps the fast path
    // fast and preserves compatibility with existing tests that don't
    // opt in to the hold flow.
    if (!opts.awaitDecision) {
      const text = buildBlockText(matchedRule);
      sink.write(synthesizeTextBlock(index, text));
      state.mode = 'substituted';
      state.bufferedRaw = [];
      substitutedAny = true;
      opts.onBlocked?.({
        toolName: state.toolName,
        toolInput,
        matchedRule,
        accountId: opts.accountId,
      });
      return;
    }

    // Async path — open hold, await the user's decision. During the
    // await, `push()` diverts incoming SSE chunks into `holdBuffer`
    // so frame ordering stays correct.
    holdActive = true;
    let outcome: 'approve' | 'deny' | 'timeout';
    try {
      outcome = await opts.awaitDecision({
        toolName: state.toolName,
        toolInput,
        matchedRule,
        accountId: opts.accountId,
      });
    } catch {
      // If the hook itself throws, treat as deny — better to over-
      // block than to accidentally leak a tool_use the evaluator said
      // no to. The enforcer's pending registry doesn't throw, but the
      // signature permits it.
      outcome = 'deny';
    }

    if (killed) {
      // Interceptor was torn down during the await (upstream error,
      // client hang-up). Discard both buffers; nothing to do.
      holdBuffer = '';
      holdActive = false;
      return;
    }

    if (outcome === 'approve') {
      // User approved this one tool_use — flush the buffered frames
      // verbatim so Claude Code sees the original tool_use content
      // block and can dispatch it. No allowlist side effect: the
      // permission rule stays intact and a subsequent identical call
      // would re-prompt (matches the "one-shot approve" contract
      // documented in pending.ts).
      for (const f of state.bufferedRaw) sink.write(f);
      state.mode = 'passthrough';
      state.bufferedRaw = [];
    } else {
      // Deny or timeout — substitute as the sync path would, and
      // emit the onBlocked side effect so the Security panel still
      // records the block consistently with pre-refactor behaviour.
      const text = buildBlockText(matchedRule);
      sink.write(synthesizeTextBlock(index, text));
      state.mode = 'substituted';
      state.bufferedRaw = [];
      substitutedAny = true;
      // No onBlocked call here — the pending registry's onFinalized
      // hook in the enforcer already persisted the block outcome
      // when the pending resolved. Calling onBlocked again would
      // double-insert the event.
    }

    // Release the hold: swap holdBuffer back into rawBuffer and
    // resume normal frame processing. Any frames that arrived during
    // the await get their normal drainFrames treatment now.
    rawBuffer = holdBuffer + rawBuffer;
    holdBuffer = '';
    holdActive = false;
    drainFrames();
  };

  const flush = (): void => {
    if (killed) return;
    // If a hold is still active when the upstream signals 'end',
    // there's no way to retroactively emit the right outcome — the
    // user can't approve an already-closed stream. Flush the
    // buffered tool_use frames verbatim (fail-open on abort), then
    // drain whatever accumulated in holdBuffer so the client sees a
    // complete stream. `destroy` is the right call if the caller
    // wants a hard discard instead.
    if (holdActive) {
      for (const state of blocks.values()) {
        if (state.mode === 'buffering' && state.bufferedRaw.length > 0) {
          for (const f of state.bufferedRaw) sink.write(f);
          // Clear after the fail-open flush so the second loop below
          // (which catches genuinely-orphaned partial frames) doesn't
          // re-emit these. Without this, ask rules that hold past
          // upstream-end produced a duplicated tool_use in the client
          // body — exposed by the proxy.security.permissions.e2e tests.
          state.bufferedRaw = [];
          state.mode = 'passthrough';
        }
      }
      if (holdBuffer.length > 0) {
        sink.write(holdBuffer);
        holdBuffer = '';
      }
      holdActive = false;
    }
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
    holdBuffer = '';
    holdActive = false;
    blocks.clear();
  };

  return { push, flush, destroy };
}
