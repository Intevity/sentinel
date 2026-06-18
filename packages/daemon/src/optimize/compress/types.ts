/**
 * Shared types for the in-flight tool_result compressor.
 *
 * The compressor is a set of PURE, DETERMINISTIC, IDEMPOTENT functions. It
 * never touches the clock, randomness, or I/O. Determinism is what keeps
 * Anthropic prompt-cache prefixes byte-stable: Claude Code replays the full
 * (original) conversation history every turn, so compressing the same
 * tool_result must always yield identical bytes, and re-compressing already
 * compressed output must be a no-op.
 */

import { createHash } from 'node:crypto';
import type { CompressionLevel } from '@sentinel/shared';

export type { CompressionLevel };

/** Identifier for each compression rule. Surfaced in the by-rule analytics
 *  breakdown, so the values double as stable analytics keys. */
export type RuleId =
  | 'ansi_strip'
  | 'collapse_blank_lines'
  | 'collapse_duplicate_lines'
  | 'json_minify'
  | 'json_tabular'
  | 'json_sample'
  | 'stack_trace_collapse'
  | 'log_truncate'
  | 'log_error_extract'
  | 'log_near_dup_fold'
  | 'search_extract'
  | 'diff_trim'
  | 'html_extract'
  | 'intra_body_fold';

/** Why a request was processed but its body left unchanged. `null` skip
 *  reason on {@link CompressionStats} means the body was compressed. */
export type SkipReason =
  | 'parse_error' // body wasn't a JSON object, or had no `messages` array
  | 'oversized' // body exceeded the configured size cap
  | 'no_tool_results' // no tool_result blocks to compress
  | 'already_compressed' // every candidate compressed to identical bytes
  | 'no_gain'; // compressed body was not smaller, so we reverted

export interface PerToolStat {
  /** tool_result text bytes seen for this tool, before compression. */
  bytesIn: number;
  /** tool_result text bytes after compression. */
  bytesOut: number;
  /** Number of tool_result blocks attributed to this tool. */
  blocks: number;
}

export interface PerRuleStat {
  /** Total bytes removed by this rule across all blocks (can be negative if
   *  a rule added bytes, e.g. an elision marker; the body-level no-gain guard
   *  prevents net expansion from reaching the wire). */
  bytesSaved: number;
  /** Number of blocks where this rule changed the text. */
  hits: number;
}

export interface CompressionStats {
  /** Sum of tool_result text bytes seen, before compression. Measured over
   *  the text we actually process (strings and `{type:'text'}` blocks), not
   *  the whole request body. */
  bytesIn: number;
  /** Sum of tool_result text bytes after compression. */
  bytesOut: number;
  /** Estimated input tokens before compression (shared ruler:
   *  `estimateTokensFromBytes(bytesIn)`, ~3.5 bytes/token). The Anthropic API
   *  never reports the counterfactual uncompressed token count, so this is an
   *  estimate; the UI must label it as such. */
  estTokensIn: number;
  /** Estimated input tokens after compression. */
  estTokensOut: number;
  /** True only when the request body bytes actually changed. */
  changed: boolean;
  /** Set when `changed` is false. `null` when the body was compressed. */
  skipReason: SkipReason | null;
  /** Per-tool byte breakdown, keyed by tool name (`'unknown'` when the
   *  tool_use_id can't be resolved to a name). */
  perTool: Record<string, PerToolStat>;
  /** Per-rule byte breakdown. Only rules that fired appear. */
  perRule: Partial<Record<RuleId, PerRuleStat>>;
}

export interface CompressOpts {
  level: CompressionLevel;
  /** Bodies larger than this are skipped (`skipReason: 'oversized'`). */
  maxBodyBytes: number;
  /** Reversible compression (CCR). When true, lossy rules keep the elided
   *  original (returned in {@link CompressResult.captures}) and embed a
   *  content-hash id in the marker so the model can retrieve the full text.
   *  Off by default; conservative tier never elides, so this is a no-op there. */
  reversible?: boolean;
}

/** A captured original, keyed by a deterministic content hash. The proxy
 *  persists these so the `retrieve` MCP tool can return the full text the
 *  marker referenced. */
export interface CaptureRecord {
  /** `sha256(original).slice(0, 16)` — deterministic, so the same elided text
   *  always yields the same id (cache-prefix stability). */
  id: string;
  /** Which rule elided this content. */
  ruleId: RuleId;
  /** The exact text that was removed from the tool_result. */
  original: string;
}

export interface CompressResult {
  /** The compressed body, or the original Buffer reference when unchanged. */
  body: Buffer;
  stats: CompressionStats;
  /** Originals elided under reversible mode, keyed by content-hash id. Empty
   *  when `reversible` is off, nothing was elided, or the body was skipped. */
  captures: CaptureRecord[];
}

/** Deterministic content-hash id for a captured original. Pure (no clock, no
 *  randomness), so the reversible markers stay byte-stable across replayed
 *  turns — preserving the cache-prefix invariant. */
export function hashOriginal(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** UTF-8 byte length of a string. */
export function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Byte -> token estimate. Re-exported from the shared single-source-of-truth
 *  ruler (3.5 bytes/token) so compression, the subagent analyzer, and the
 *  context-bloat estimators all agree. Kept exported here so the many local
 *  `./types.js` imports don't have to change. */
export { estimateTokensFromBytes } from '@sentinel/shared';
