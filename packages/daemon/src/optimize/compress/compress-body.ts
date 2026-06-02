/**
 * Top-level entry: compress the tool_result content in an Anthropic
 * /v1/messages request body.
 *
 * Hard guarantees (see types.ts):
 *  - Deterministic + idempotent (cache-prefix stability).
 *  - Only ever reassigns the `.text` of tool_result content (string form) or
 *    of `{type:'text'}` elements (array form). Never adds/removes/reorders
 *    content blocks, never touches `system`/`tools`/top-level keys, and never
 *    reads/moves/rewrites any `cache_control` marker.
 *  - Returns the ORIGINAL Buffer reference on any skip (parse error, oversized,
 *    nothing to do, no net gain), so the caller's `result.body !== body`
 *    check cleanly detects "unchanged" and leaves Content-Length alone.
 */

import type {
  CaptureRecord,
  CompressOpts,
  CompressResult,
  CompressionStats,
  PerRuleStat,
  PerToolStat,
  RuleId,
  SkipReason,
} from './types.js';
import { byteLen, estimateTokensFromBytes, hashOriginal } from './types.js';
import { compressToolResultText } from './tiers.js';
import type { OnElide } from './text-rules.js';

function emptyStats(skipReason: SkipReason): CompressionStats {
  return {
    bytesIn: 0,
    bytesOut: 0,
    estTokensIn: 0,
    estTokensOut: 0,
    changed: false,
    skipReason,
    perTool: {},
    perRule: {},
  };
}

function mergeRule(
  into: Partial<Record<RuleId, PerRuleStat>>,
  from: Partial<Record<RuleId, PerRuleStat>>,
): void {
  for (const key of Object.keys(from) as RuleId[]) {
    const src = from[key];
    if (!src) continue;
    const cur = into[key] ?? { bytesSaved: 0, hits: 0 };
    cur.bytesSaved += src.bytesSaved;
    cur.hits += src.hits;
    into[key] = cur;
  }
}

function accPerTool(
  perTool: Record<string, PerToolStat>,
  tool: string,
  bytesIn: number,
  bytesOut: number,
): void {
  const cur = perTool[tool] ?? { bytesIn: 0, bytesOut: 0, blocks: 0 };
  cur.bytesIn += bytesIn;
  cur.bytesOut += bytesOut;
  cur.blocks += 1;
  perTool[tool] = cur;
}

/** Build a tool_use_id -> tool_name map from assistant-message tool_use
 *  blocks so tool_result savings can be attributed to the right tool. */
function buildToolNameMap(messages: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const content = (msg as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'tool_use') continue;
      const id = b['id'];
      const name = b['name'];
      if (typeof id === 'string' && typeof name === 'string' && name.length > 0) {
        map.set(id, name);
      }
    }
  }
  return map;
}

function resolveToolName(map: Map<string, string>, toolUseId: unknown): string {
  if (typeof toolUseId === 'string') {
    const name = map.get(toolUseId);
    if (name) return name;
  }
  return 'unknown';
}

interface BlockResult {
  changed: boolean;
  bytesIn: number;
  bytesOut: number;
  perRule: Partial<Record<RuleId, PerRuleStat>>;
}

/** Compress one tool_result block in place. Handles string content and
 *  array-of-content (compressing only `{type:'text'}` elements, leaving
 *  images and other elements and the array length untouched). */
function compressToolResultBlock(
  block: Record<string, unknown>,
  level: CompressOpts['level'],
  onElide?: OnElide,
): BlockResult {
  const perRule: Partial<Record<RuleId, PerRuleStat>> = {};
  let bytesIn = 0;
  let bytesOut = 0;
  let changed = false;

  const content = block['content'];
  if (typeof content === 'string') {
    bytesIn = byteLen(content);
    const r = compressToolResultText(content, level, onElide);
    bytesOut = byteLen(r.text);
    if (r.text !== content) {
      block['content'] = r.text;
      changed = true;
    }
    mergeRule(perRule, r.perRule);
  } else if (Array.isArray(content)) {
    for (const el of content) {
      if (!el || typeof el !== 'object') continue;
      const e = el as Record<string, unknown>;
      if (e['type'] !== 'text' || typeof e['text'] !== 'string') continue;
      const t = e['text'];
      bytesIn += byteLen(t);
      const r = compressToolResultText(t, level, onElide);
      bytesOut += byteLen(r.text);
      if (r.text !== t) {
        e['text'] = r.text;
        changed = true;
      }
      mergeRule(perRule, r.perRule);
    }
  }
  // Any other content shape is left untouched and contributes no bytes.

  return { changed, bytesIn, bytesOut, perRule };
}

export function compressMessagesBody(body: Buffer, opts: CompressOpts): CompressResult {
  if (body.length > opts.maxBodyBytes) {
    return { body, stats: emptyStats('oversized'), captures: [] };
  }

  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { body, stats: emptyStats('parse_error'), captures: [] };
    }
    root = parsed as Record<string, unknown>;
  } catch {
    return { body, stats: emptyStats('parse_error'), captures: [] };
  }

  const messages = root['messages'];
  if (!Array.isArray(messages)) {
    return { body, stats: emptyStats('no_tool_results'), captures: [] };
  }

  // Reversible mode: collect elided originals keyed by content-hash id. Dedup
  // by id so identical elisions across blocks/turns store once. `onElide` is a
  // pure write-to-map side effect that returns the deterministic id — it never
  // reads mutable state, so determinism/idempotency hold.
  const captureMap = new Map<string, CaptureRecord>();
  const onElide: OnElide | undefined = opts.reversible
    ? (ruleId, original) => {
        const id = hashOriginal(original);
        if (!captureMap.has(id)) captureMap.set(id, { id, ruleId, original });
        return id;
      }
    : undefined;

  const toolNames = buildToolNameMap(messages);
  const perTool: Record<string, PerToolStat> = {};
  const perRule: Partial<Record<RuleId, PerRuleStat>> = {};
  let bytesIn = 0;
  let bytesOut = 0;
  let toolResultCount = 0;
  let anyChanged = false;

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const content = (msg as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'tool_result') continue;
      toolResultCount++;
      const toolName = resolveToolName(toolNames, b['tool_use_id']);
      const r = compressToolResultBlock(b, opts.level, onElide);
      bytesIn += r.bytesIn;
      bytesOut += r.bytesOut;
      accPerTool(perTool, toolName, r.bytesIn, r.bytesOut);
      mergeRule(perRule, r.perRule);
      if (r.changed) anyChanged = true;
    }
  }

  const base = {
    bytesIn,
    bytesOut,
    estTokensIn: estimateTokensFromBytes(bytesIn),
    estTokensOut: estimateTokensFromBytes(bytesOut),
    perTool,
    perRule,
  };

  if (toolResultCount === 0) {
    return { body, stats: emptyStats('no_tool_results'), captures: [] };
  }
  if (!anyChanged) {
    return {
      body,
      stats: { ...base, changed: false, skipReason: 'already_compressed' },
      captures: [],
    };
  }

  const newBody = Buffer.from(JSON.stringify(root), 'utf-8');
  // Net-expansion guard: if the re-stringified body is not actually smaller,
  // forward the original verbatim. Keeps cache stable and prevents pathological
  // growth (e.g. when a marker outweighs the bytes it saved). Captures are
  // dropped — the markers referencing them never reach the wire.
  if (newBody.length >= body.length) {
    return { body, stats: { ...base, changed: false, skipReason: 'no_gain' }, captures: [] };
  }
  return {
    body: newBody,
    stats: { ...base, changed: true, skipReason: null },
    captures: [...captureMap.values()],
  };
}
