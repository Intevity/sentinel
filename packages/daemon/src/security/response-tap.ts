/**
 * Streaming parser for Anthropic server-sent events. Accumulates tool_use
 * content blocks without buffering the entire response.
 *
 * The parser is a pure state machine — it exposes `push(chunk)` (never
 * blocks, drops on size overflow) and `flush()` (returns the assembled
 * tool_use blocks for detectors to inspect). It NEVER participates in
 * Node's stream backpressure, so even a pathologically slow consumer
 * cannot delay the bytes the proxy is forwarding to Claude Code.
 */

export interface AssembledToolUse {
  /** `content_block_start` for tool_use gives us { id, name, input: {} }. We
   *  then accumulate `input_json_delta.partial_json` strings and JSON.parse
   *  the concatenation at the end. */
  index: number;
  id: string;
  name: string;
  input: unknown;
}

/** Default cap on how many bytes a single response can feed the tap. Larger
 *  responses degrade the tap to observe-nothing and emit a synthetic
 *  `scan_truncated` finding via the scanner. */
export const DEFAULT_TAP_BUDGET_BYTES = 2 * 1024 * 1024;

export class ResponseTap {
  private budget: number;
  private killed = false;
  private truncated = false;
  private lineBuffer = '';
  /** Accumulator keyed by content_block index. */
  private blocks = new Map<number, { id: string; name: string; partial: string }>();
  private completed: AssembledToolUse[] = [];

  constructor(budget: number = DEFAULT_TAP_BUDGET_BYTES) {
    this.budget = budget;
  }

  /** Ingest a chunk of response bytes. Safe to call after `destroy()` —
   *  it becomes a no-op. Never blocks. */
  push(chunk: Buffer | string): void {
    if (this.killed) return;
    const str = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    if (str.length > this.budget) {
      this.truncated = true;
      this.budget = 0;
      return;
    }
    this.budget -= str.length;
    this.lineBuffer += str;
    this.drainLines();
  }

  /** Called when the upstream stream has ended. Finalizes any
   *  not-yet-parsed input_json_delta payloads. Returns the tool_use
   *  blocks that were fully assembled. */
  flush(): { blocks: AssembledToolUse[]; truncated: boolean } {
    if (this.killed) return { blocks: [], truncated: this.truncated };
    this.drainLines();
    for (const [index, acc] of this.blocks.entries()) {
      let input: unknown = {};
      if (acc.partial.length > 0) {
        try {
          input = JSON.parse(acc.partial);
        } catch {
          input = { _parseError: true, _raw: acc.partial.slice(0, 200) };
        }
      }
      this.completed.push({ index, id: acc.id, name: acc.name, input });
    }
    this.blocks.clear();
    return { blocks: [...this.completed], truncated: this.truncated };
  }

  /** Drop all buffered state. Used on upstream errors so the caller doesn't
   *  accidentally flush a partially-assembled block to detectors. */
  destroy(): void {
    this.killed = true;
    this.lineBuffer = '';
    this.blocks.clear();
    this.completed = [];
  }

  private drainLines(): void {
    // SSE events are separated by a blank line; each event has one or more
    // `field: value\n` lines. We care about the `data:` lines only.
    let newlineIdx: number;
    while ((newlineIdx = this.lineBuffer.indexOf('\n')) !== -1) {
      const line = this.lineBuffer.slice(0, newlineIdx);
      this.lineBuffer = this.lineBuffer.slice(newlineIdx + 1);
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trimStart();
      if (payload === '[DONE]') continue;
      try {
        const evt = JSON.parse(payload) as Record<string, unknown>;
        this.applyEvent(evt);
      } catch {
        /* malformed event — ignore and keep streaming */
      }
    }
  }

  private applyEvent(evt: Record<string, unknown>): void {
    const type = evt['type'];
    if (type === 'content_block_start') {
      const index = typeof evt['index'] === 'number' ? evt['index'] : -1;
      const block = evt['content_block'] as Record<string, unknown> | undefined;
      if (index < 0 || !block || block['type'] !== 'tool_use') return;
      const id = typeof block['id'] === 'string' ? block['id'] : '';
      const name = typeof block['name'] === 'string' ? block['name'] : '';
      this.blocks.set(index, { id, name, partial: '' });
    } else if (type === 'content_block_delta') {
      const index = typeof evt['index'] === 'number' ? evt['index'] : -1;
      const delta = evt['delta'] as Record<string, unknown> | undefined;
      if (!delta || delta['type'] !== 'input_json_delta') return;
      const acc = this.blocks.get(index);
      if (!acc) return;
      const pj = delta['partial_json'];
      if (typeof pj === 'string') acc.partial += pj;
    } else if (type === 'content_block_stop') {
      const index = typeof evt['index'] === 'number' ? evt['index'] : -1;
      const acc = this.blocks.get(index);
      if (!acc) return;
      let input: unknown = {};
      if (acc.partial.length > 0) {
        try {
          input = JSON.parse(acc.partial);
        } catch {
          input = { _parseError: true, _raw: acc.partial.slice(0, 200) };
        }
      }
      this.completed.push({ index, id: acc.id, name: acc.name, input });
      this.blocks.delete(index);
    }
  }
}
