/**
 * Usage extraction for non-streaming `/v1/messages` responses too large to
 * buffer whole.
 *
 * The proxy keeps the first 256 KB of a non-SSE body for its JSON parse. A
 * long non-streaming answer (large `max_tokens`, big tool inputs) overflows
 * that, the parse fails, and the request used to leave no usage row at all,
 * which for clients with no OTEL of their own (Claude Desktop 3p, BYOK API
 * keys) meant the spend was invisible. A Messages API response serializes
 * `model` before `content` and `usage` after it, so the two fields survive in
 * a bounded head and a bounded rolling tail of the body.
 */

import { extractUsageFromJson, type UsageExtractResult } from './cache-ttl/parser.js';

/** Bytes of the body's end kept for the tail parse. A usage object is a few
 *  hundred bytes; the headroom covers keys serialized after it. */
export const USAGE_TAIL_BYTES = 64 * 1024;

/** How much of the head to search for the top-level `model`. It precedes
 *  `content`, so it sits in the first few hundred bytes. */
const MODEL_HEAD_BYTES = 16 * 1024;

/** Keep the last {@link USAGE_TAIL_BYTES} of a stream across chunks. */
export function appendToTail(tail: Buffer, chunk: Buffer): Buffer {
  const next = tail.length === 0 ? chunk : Buffer.concat([tail, chunk]);
  return next.length > USAGE_TAIL_BYTES ? next.subarray(next.length - USAGE_TAIL_BYTES) : next;
}

/** Index of the `}` closing the object that opens at `start`, honoring JSON
 *  strings and escapes; -1 when the object does not close inside `text`. */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipWhitespace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i]!)) i += 1;
  return i;
}

/**
 * Recover usage from the head and tail of a non-streaming message whose full
 * body was not kept. Takes the LAST `"usage": {...}` in the tail: the
 * top-level usage is the message's final large key, and a `"usage"` inside a
 * content string is escaped (`\"usage\"`) so it never matches. Returns null
 * when the tail holds no parseable usage object.
 */
export function extractUsageFromJsonTail(head: Buffer, tail: Buffer): UsageExtractResult | null {
  const modelMatch = /"model"\s*:\s*"([^"\\]+)"/.exec(
    head.subarray(0, MODEL_HEAD_BYTES).toString('utf-8'),
  );
  const model = modelMatch ? modelMatch[1]! : null;
  const text = tail.toString('utf-8');
  const KEY = '"usage"';
  // `lastIndexOf(KEY, -1)` would re-find index 0, so step past 0 explicitly.
  for (let at = text.lastIndexOf(KEY); at >= 0; at = at > 0 ? text.lastIndexOf(KEY, at - 1) : -1) {
    let i = skipWhitespace(text, at + KEY.length);
    if (text[i] !== ':') continue;
    i = skipWhitespace(text, i + 1);
    if (text[i] !== '{') continue;
    const end = closingBrace(text, i);
    if (end < 0) continue;
    const result = extractUsageFromJson(
      Buffer.from(`{"model":${JSON.stringify(model)},"usage":${text.slice(i, end + 1)}}`),
    );
    if (result) return result;
  }
  return null;
}
