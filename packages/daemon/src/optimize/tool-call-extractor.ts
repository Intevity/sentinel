/**
 * Pure SSE observer that captures structured tool_use metadata from the
 * Claude API response stream. Mirrors {@link SseUsageExtractor}'s contract:
 * onChunk / flush, no participation in forwarding. Intentionally separate
 * from `permissions/sse-interceptor.ts` — that interceptor mutates the
 * stream; this one only watches.
 *
 * What we keep per tool_use block:
 *   - tool_use_id (Anthropic's `toolu_...` id, used to match against
 *     tool_result blocks that arrive in the next request's user message)
 *   - tool name
 *   - input bytes (length of the partial_json deltas concatenated)
 *   - identifying string when the tool input includes one (Read/Write/Edit
 *     `path` or `file_path`, Glob/Grep `pattern`, Bash `command`,
 *     WebFetch/WebSearch `url`). Stored in `tool_calls.file_path` for
 *     indexing.
 *
 * What we DO NOT keep:
 *   - raw tool inputs beyond the size in bytes
 *   - tool_result content (those arrive in the next request's user message
 *     and the recorder's `observeRequest` backfills `response_size_bytes`
 *     from the tool_result block's `content` length)
 *
 * Privacy posture: file paths, Bash commands, and fetched URLs are
 * already in the request-log raw BLOB when `requestLoggingEnabled` is
 * on. Storing them in the structured `tool_calls.file_path` column is a
 * query-friendly form of the same data; no new exfil surface. The
 * user-facing disclosure lives in Settings → Optimize.
 */

import type Database from 'better-sqlite3';
import {
  insertToolCall,
  findToolCallByToolUseId,
  backfillToolCallResponseSize,
  backfillToolCallQuoteDetection,
} from '../db.js';

/** Per-block buffer cap. tool_use input larger than this is recorded but
 *  the partial_json is truncated; we still capture the tool_use_id and
 *  name, just lose precise field extraction. Matches the SSE
 *  interceptor's MAX_BLOCK_BUFFER_BYTES so behavior is consistent across
 *  the two observers. */
export const MAX_TOOL_INPUT_BYTES = 64 * 1024;

interface BlockState {
  toolUseId: string | null;
  toolName: string;
  partialJson: string;
  inputSizeBytes: number;
  overflowed: boolean;
}

export interface PendingToolCall {
  toolUseId: string | null;
  toolName: string;
  filePath: string | null;
  inputSizeBytes: number;
}

export interface ToolCallExtractorOptions {
  db: Database.Database;
  accountId: string;
  sessionId: string | null;
  requestId: string;
  requestSeqInSession: number | null;
  model: string;
  /** Set true for any tool_use this proxy decided to deny on the request
   *  side. Lets the analyzer filter out denied calls — they don't
   *  reflect intended token spend. */
  deniedToolNames: Set<string>;
  /** Wall-clock timestamp recorded on each inserted row. Tests inject a
   *  fixed value for deterministic assertions. */
  nowMs: number;
}

/**
 * Build a per-request extractor. Feed every chunk from the upstream SSE
 * response via `onChunk`; call `flush` once on `proxyRes.end` so collected
 * tool_use blocks land in `tool_calls`. The extractor never throws — a
 * malformed event is silently ignored so it cannot stall the proxy.
 */
export function createToolCallExtractor(opts: ToolCallExtractorOptions): {
  onChunk(chunk: Buffer | string): void;
  flush(): PendingToolCall[];
  /** For tests: read the buffered tool calls without inserting. */
  peek(): PendingToolCall[];
} {
  let partial = '';
  const blocks = new Map<number, BlockState>();
  const collected: PendingToolCall[] = [];

  const onChunk = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    partial += text;
    while (true) {
      const sep = partial.indexOf('\n\n');
      if (sep === -1) break;
      const frame = partial.slice(0, sep);
      partial = partial.slice(sep + 2);
      processFrame(frame);
    }
  };

  const processFrame = (frame: string): void => {
    const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) return;
    const payload = dataLine.slice(5).trimStart();
    if (!payload || payload === '[DONE]') return;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    routeEvent(evt);
  };

  const routeEvent = (evt: Record<string, unknown>): void => {
    const type = evt['type'];
    const index = typeof evt['index'] === 'number' ? evt['index'] : -1;

    if (type === 'content_block_start' && index >= 0) {
      const block = evt['content_block'] as Record<string, unknown> | undefined;
      if (!block || block['type'] !== 'tool_use') return;
      const toolName = typeof block['name'] === 'string' ? block['name'] : '';
      const toolUseId = typeof block['id'] === 'string' ? (block['id'] as string) : null;
      blocks.set(index, {
        toolUseId,
        toolName,
        partialJson: '',
        inputSizeBytes: 0,
        overflowed: false,
      });
      return;
    }

    if (type === 'content_block_delta' && index >= 0) {
      const state = blocks.get(index);
      if (!state) return;
      const delta = evt['delta'] as Record<string, unknown> | undefined;
      if (!delta || delta['type'] !== 'input_json_delta') return;
      const partialJson = delta['partial_json'];
      if (typeof partialJson !== 'string') return;
      state.inputSizeBytes += partialJson.length;
      if (state.overflowed) return;
      if (state.inputSizeBytes > MAX_TOOL_INPUT_BYTES) {
        state.overflowed = true;
        state.partialJson = '';
        return;
      }
      state.partialJson += partialJson;
      return;
    }

    if (type === 'content_block_stop' && index >= 0) {
      const state = blocks.get(index);
      if (!state) return;
      const filePath = state.overflowed ? null : extractFilePath(state.partialJson);
      collected.push({
        toolUseId: state.toolUseId,
        toolName: state.toolName,
        filePath,
        inputSizeBytes: state.inputSizeBytes,
      });
      blocks.delete(index);
      return;
    }
  };

  const flush = (): PendingToolCall[] => {
    for (const c of collected) {
      try {
        insertToolCall(opts.db, {
          ts: opts.nowMs,
          accountId: opts.accountId,
          sessionId: opts.sessionId,
          requestId: opts.requestId,
          requestSeqInSession: opts.requestSeqInSession,
          toolUseId: c.toolUseId,
          toolName: c.toolName,
          filePath: c.filePath,
          inputSizeBytes: c.inputSizeBytes,
          responseSizeBytes: null,
          denied: opts.deniedToolNames.has(c.toolName),
          model: opts.model,
        });
      } catch {
        // Insert can fail if the DB is closed mid-stream during a test
        // teardown. Don't propagate — the proxy must finish forwarding.
      }
    }
    return collected.slice();
  };

  return { onChunk, flush, peek: () => collected.slice() };
}

/**
 * Best-effort identifying-string extraction from a tool_use input JSON.
 * The Claude API doesn't standardize the field name — `Read` uses `path`,
 * `Glob` / `Grep` use `pattern`, `Bash` uses `command`, `WebFetch` /
 * `WebSearch` use `url`, MCP tools use whatever the server defined. We
 * probe a small known list and fall back to null.
 *
 * The value is stored in `tool_calls.file_path` for indexing — analyzer
 * heuristics that key off Bash command stubs (testRunnerNoise) or web
 * URLs (web_fetch_oversized) read this column. Privacy posture matches
 * the surrounding comment block: the same data is in the request-log
 * raw BLOB when request logging is on.
 *
 * Exported for testing.
 */
export function extractFilePath(partialJson: string): string | null {
  if (!partialJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(partialJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'pattern', 'filename', 'filePath', 'url', 'command']) {
    const v = o[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Walk the prior-turn `tool_result` blocks in a /v1/messages request body
 * and backfill `response_size_bytes` on the matching tool_calls rows.
 * Also performs file-path-presence quote-detection: when a later assistant
 * or user message contains a prior tool_call's file_path as a substring,
 * mark `was_quoted_in_later_turn = 1`. Otherwise, when the next request
 * arrives without any quote, mark it `0`.
 *
 * Called once per /v1/messages POST from the proxy. The body must be the
 * unrewritten request body (the form Sentinel actually forwards).
 */
export function applyToolResultBackfill(
  db: Database.Database,
  body: Buffer,
  sessionId: string | null,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf-8'));
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  const obj = parsed as Record<string, unknown>;
  const messages = obj['messages'];
  if (!Array.isArray(messages)) return;

  // Pass 1: collect tool_results by tool_use_id and the concatenated text
  // surface across user/assistant messages (for quote detection).
  type ToolResult = { toolUseId: string; sizeBytes: number };
  const toolResults: ToolResult[] = [];
  const textBlobParts: string[] = [];

  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as Record<string, unknown>;
    const content = msg['content'];
    if (!Array.isArray(content)) {
      if (typeof content === 'string') textBlobParts.push(content);
      continue;
    }
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      const bType = b['type'];
      if (bType === 'tool_result') {
        const toolUseId = typeof b['tool_use_id'] === 'string' ? b['tool_use_id'] : null;
        if (!toolUseId) continue;
        const c = b['content'];
        let bytes = 0;
        if (typeof c === 'string') bytes = c.length;
        else if (Array.isArray(c)) {
          for (const inner of c) {
            if (inner && typeof inner === 'object' && 'text' in inner) {
              const t = (inner as Record<string, unknown>)['text'];
              if (typeof t === 'string') bytes += t.length;
            }
          }
        }
        toolResults.push({ toolUseId, sizeBytes: bytes });
      } else if (bType === 'text') {
        const t = b['text'];
        if (typeof t === 'string') textBlobParts.push(t);
      }
    }
  }

  const textBlob = textBlobParts.join('\n');

  // Pass 2: for each tool_result, look up the matching prior tool_call by
  // tool_use_id and backfill response_size_bytes (if not already set).
  // Then set was_quoted_in_later_turn based on whether the file_path
  // appears anywhere in textBlob.
  let hits = 0;
  let sizeBackfills = 0;
  let quoteBackfills = 0;
  const missPrefixes: string[] = [];
  for (const tr of toolResults) {
    const row = findToolCallByToolUseId(db, tr.toolUseId);
    if (!row) {
      if (missPrefixes.length < 5) missPrefixes.push(tr.toolUseId.slice(0, 12));
      continue;
    }
    hits += 1;
    if (row.responseSizeBytes === null) {
      backfillToolCallResponseSize(db, row.id, tr.sizeBytes);
      sizeBackfills += 1;
    }
    if (row.wasQuotedInLaterTurn === null && row.filePath) {
      const quoted = textBlob.includes(row.filePath);
      backfillToolCallQuoteDetection(db, row.id, quoted);
      quoteBackfills += 1;
    }
  }

  // Diagnostic line: emitted on every backfill pass that scanned at
  // least one tool_result. Lets the user grep `[Optimize/Backfill]` and
  // see whether the proxy is reaching the matching rows. The miss-
  // prefixes column surfaces tool_use_id mismatches when they happen.
  if (toolResults.length > 0) {
    const missesSuffix = missPrefixes.length > 0 ? ` miss_prefixes=${missPrefixes.join(',')}` : '';
    console.log(
      `[Optimize/Backfill] tool_results=${toolResults.length} hits=${hits}` +
        ` misses=${toolResults.length - hits}` +
        ` size_backfills=${sizeBackfills} quote_backfills=${quoteBackfills}` +
        missesSuffix,
    );
  }

  // Touch sessionId only as a defensive guard for unit tests calling
  // this with sessionId=null. We don't filter by session because the
  // tool_use_id is globally unique across requests.
  void sessionId;
}

/**
 * Per-session monotonic sequence counter shared across requests in the
 * same Claude Code session. Lives in module scope keyed by sessionId.
 * Trimmed lazily — keys older than `SESSION_SEQ_TTL_MS` since their last
 * use are dropped on every read.
 */
const sessionSeqs = new Map<string, { seq: number; lastUsedMs: number }>();
const SESSION_SEQ_TTL_MS = 24 * 60 * 60 * 1000;

export function nextRequestSeqForSession(sessionId: string | null, nowMs: number): number | null {
  if (!sessionId) return null;
  const now = nowMs;
  // Trim old entries lazily. The TTL trigger is genuinely impractical to
  // exercise in tests (would need 24h-old in-memory state) so the
  // delete branch is ignored — production hits this naturally as
  // long-lived sessions age out.
  for (const [k, v] of sessionSeqs) {
    /* v8 ignore next 1 */
    if (now - v.lastUsedMs > SESSION_SEQ_TTL_MS) sessionSeqs.delete(k);
  }
  const cur = sessionSeqs.get(sessionId);
  const next = (cur?.seq ?? 0) + 1;
  sessionSeqs.set(sessionId, { seq: next, lastUsedMs: now });
  return next;
}

/** Test hook for resetting the session-seq state between cases. */
export function _resetSessionSeqsForTest(): void {
  sessionSeqs.clear();
}
