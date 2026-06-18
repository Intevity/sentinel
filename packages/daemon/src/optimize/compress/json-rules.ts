/**
 * Pure JSON-compression rules for tool_result content that parses as a JSON
 * object or array. Deterministic and idempotent like the text rules.
 */

import type { OnElide } from './text-rules.js';
import { retrievalHint } from './text-rules.js';

/** Minimum array length before tabular folding is worth it. */
const TABULAR_MIN_ROWS = 5;

/** Substrings that mark an array item as an error/failure worth keeping. */
const SAMPLE_ERROR_RE =
  /(error|fail|failed|failure|exception|denied|refused|fatal|panic|timed?\s?out|timeout)/i;

/** Minimum numeric samples for a field before its outliers are trustworthy. */
const OUTLIER_MIN_SAMPLES = 4;

export interface ParsedJson {
  ok: boolean;
  value?: unknown;
}

/**
 * Attempt to parse `text` as a JSON object or array. Fast-rejects anything
 * not starting with `{` or `[` (the only shapes the JSON rules act on) so we
 * never pay a full parse on a large prose/log payload.
 */
export function tryParseJson(text: string): ParsedJson {
  const t = text.trimStart();
  if (t.length === 0) return { ok: false };
  const c = t[0];
  if (c !== '{' && c !== '[') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Remove insignificant whitespace from a JSON document, preserving everything
 * inside string literals exactly. Unlike a parse/re-stringify round trip this
 * is byte-lossless for numbers (`1.0` stays `1.0`), large integers (no
 * precision loss), key order, and unicode escapes — it only drops whitespace
 * that JSON treats as insignificant.
 *
 * Returns the input unchanged when it is not valid JSON. Idempotent: minified
 * JSON has no insignificant whitespace, so a second pass drops nothing.
 */
export function minifyJsonWhitespace(text: string): string {
  // Validate first; the scanner below assumes well-formed JSON (balanced
  // quotes/escapes), which JSON.parse guarantees.
  try {
    JSON.parse(text);
  } catch {
    return text;
  }
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
    out += ch;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Fold a JSON array of homogeneous objects (same key set, same order) into a
 * compact `{ _sentinelTable: { columns, rows } }` shape, hoisting the repeated
 * keys out of every element. Lossless (all values preserved) but it changes
 * the structure the model sees, so tier policy lives in tiers.ts.
 *
 * Depth-1 dotted-column flattening (TabularCompactor parity): when a top-level
 * key holds a plain object in EVERY row with an identical sub-key signature,
 * its sub-keys are hoisted into dotted columns (`addr.city`, `addr.zip`) sitting
 * at the parent's position in first-seen (row-0) order. This is still fully
 * lossless: the dotted columns plus their per-row values reconstruct the nested
 * object exactly. A collision guard skips the expansion for any key whose dotted
 * name would clash with another top-level key or another dotted name being
 * created, so the column set is always unambiguous (the reconstruction map keys
 * on column name, and a clash would silently overwrite a column). Sub-values are
 * used as-is even when objects/arrays: flattening is depth 1 only.
 *
 * `parsed` is the already-parsed value (avoids a re-parse). Returns the input
 * `jsonText` unchanged when the array isn't a foldable homogeneous table.
 * Idempotent: the folded result is an object, not an array, so it never
 * re-matches the array trigger.
 */
export function tabularDedup(jsonText: string, parsed: unknown): string {
  if (!Array.isArray(parsed) || parsed.length < TABULAR_MIN_ROWS) return jsonText;
  const first = parsed[0];
  if (!isPlainObject(first)) return jsonText;
  const keys = Object.keys(first);
  if (keys.length === 0) return jsonText;
  const keySig = keys.join('\u0000');
  for (const el of parsed) {
    if (!isPlainObject(el)) return jsonText;
    const elKeys = Object.keys(el);
    if (elKeys.length !== keys.length || elKeys.join('\u0000') !== keySig) return jsonText;
  }
  const objs = parsed as Array<Record<string, unknown>>;

  // Decide, per top-level key (first-seen order), whether to expand it into
  // dotted sub-columns. A key expands iff every row's value at the key is a
  // plain object sharing one identical sub-key signature with at least one
  // sub-key, and none of the resulting dotted names collide with an existing
  // top-level key or another dotted name created here.
  const topLevel = new Set(keys);
  const plannedDotted = new Set<string>();
  const subKeysByKey = new Map<string, string[]>();
  for (const k of keys) {
    const firstVal = objs[0]?.[k];
    if (!isPlainObject(firstVal)) continue;
    const subKeys = Object.keys(firstVal);
    if (subKeys.length === 0) continue;
    // Same NUL separator as the top-level keySig: a space-containing sub-key
    // must not alias another sub-key set's signature.
    const subSig = subKeys.join('\u0000');
    let uniform = true;
    for (const el of objs) {
      const v = el[k];
      if (!isPlainObject(v) || Object.keys(v).join('\u0000') !== subSig) {
        uniform = false;
        break;
      }
    }
    if (!uniform) continue;
    // Collision guard: any dotted name colliding with a top-level key or an
    // already-planned dotted name disqualifies the whole key.
    let collides = false;
    for (const sub of subKeys) {
      const dotted = k + '.' + sub;
      if (topLevel.has(dotted) || plannedDotted.has(dotted)) {
        collides = true;
        break;
      }
    }
    if (collides) continue;
    for (const sub of subKeys) plannedDotted.add(k + '.' + sub);
    subKeysByKey.set(k, subKeys);
  }

  const columns: string[] = [];
  for (const k of keys) {
    const subKeys = subKeysByKey.get(k);
    if (subKeys) for (const sub of subKeys) columns.push(k + '.' + sub);
    else columns.push(k);
  }
  const rows = objs.map((el) => {
    const cells: unknown[] = [];
    for (const k of keys) {
      const subKeys = subKeysByKey.get(k);
      if (subKeys) {
        const nested = el[k] as Record<string, unknown>;
        for (const sub of subKeys) cells.push(nested[sub]);
      } else {
        cells.push(el[k]);
      }
    }
    return cells;
  });
  return JSON.stringify({ _sentinelTable: { columns, rows } });
}

/** True when an array item looks like an error/failure: a string that matches
 *  the error pattern, or an object with an error-ish key or string value. Pure +
 *  content-only. (An `error`/`failed` boolean flag is already caught by its key
 *  matching the pattern, so no separate boolean check is needed.) */
function looksLikeError(item: unknown): boolean {
  if (typeof item === 'string') return SAMPLE_ERROR_RE.test(item);
  if (!isPlainObject(item)) return false;
  for (const [k, v] of Object.entries(item)) {
    if (SAMPLE_ERROR_RE.test(k)) return true;
    if (typeof v === 'string' && SAMPLE_ERROR_RE.test(v)) return true;
  }
  return false;
}

/** Indices of items that are statistical outliers on any numeric field (a
 *  numeric array item is treated as a single anonymous field). Deterministic:
 *  population mean/std over the array, keep items more than `sigma` std away.
 *  Skips fields with fewer than {@link OUTLIER_MIN_SAMPLES} values or zero
 *  variance, so uniform data flags nothing. */
function collectNumericOutliers(items: unknown[], sigma: number): Set<number> {
  const out = new Set<number>();
  const byField = new Map<string, Array<[number, number]>>();
  const add = (field: string, idx: number, val: number): void => {
    const list = byField.get(field) ?? [];
    list.push([idx, val]);
    byField.set(field, list);
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (typeof it === 'number' && Number.isFinite(it)) {
      add('', i, it);
    } else if (isPlainObject(it)) {
      for (const [k, v] of Object.entries(it)) {
        if (typeof v === 'number' && Number.isFinite(v)) add(k, i, v);
      }
    }
  }
  for (const vals of byField.values()) {
    if (vals.length < OUTLIER_MIN_SAMPLES) continue;
    const mean = vals.reduce((a, [, v]) => a + v, 0) / vals.length;
    const variance = vals.reduce((a, [, v]) => a + (v - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance);
    if (std === 0) continue;
    for (const [idx, v] of vals) {
      if (Math.abs(v - mean) > sigma * std) out.add(idx);
    }
  }
  return out;
}

/** Round to 4 decimals deterministically. We deliberately avoid `toFixed`
 *  (it returns a locale-adjacent string) and `Intl`; a fixed binary round keeps
 *  mean/median/stdev byte-stable across replayed turns for cache prefixes. */
function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}

/** Per-field aggregate over a population of finite numbers. count/min/max are
 *  exact; mean/median/stdev are 4-decimal rounded. stdev is the POPULATION
 *  standard deviation (divide by n), matching {@link collectNumericOutliers}. */
interface FieldStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  stdev: number;
}

/**
 * Aggregate the dropped items into per-field numeric stats, mirroring the field
 * collection of {@link collectNumericOutliers} exactly: a scalar finite number
 * contributes to field `''`; a plain object's finite-number fields contribute
 * by key name; first-appearance (Map iteration) order is preserved.
 *
 * Returns `undefined` when no dropped item carried a finite number, so a
 * non-numeric population yields no `stats` key at all (byte-identical output to
 * before this enrichment for existing non-numeric traffic). Deterministic via
 * fixed 4-decimal rounding and population stdev.
 */
function collectDroppedStats(dropped: unknown[]): Record<string, FieldStats> | undefined {
  const byField = new Map<string, number[]>();
  const add = (field: string, val: number): void => {
    const list = byField.get(field) ?? [];
    list.push(val);
    byField.set(field, list);
  };
  for (const it of dropped) {
    if (typeof it === 'number' && Number.isFinite(it)) {
      add('', it);
    } else if (isPlainObject(it)) {
      for (const [k, v] of Object.entries(it)) {
        if (typeof v === 'number' && Number.isFinite(v)) add(k, v);
      }
    }
  }
  if (byField.size === 0) return undefined;
  const stats: Record<string, FieldStats> = {};
  for (const [field, vals] of byField) {
    const count = vals.length;
    let min = vals[0] ?? 0;
    let max = vals[0] ?? 0;
    let sum = 0;
    for (const v of vals) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }
    const mean = sum / count;
    const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / count;
    const stdev = Math.sqrt(variance);
    const sorted = [...vals].sort((a, b) => a - b);
    const mid = Math.floor(count / 2);
    const median =
      count % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
    stats[field] = {
      count,
      min,
      max,
      mean: round4(mean),
      median: round4(median),
      stdev: round4(stdev),
    };
  }
  return stats;
}

export interface SampleOpts {
  /** Array length at/above which sampling applies. */
  minRows: number;
  /** Items kept from the start. */
  headN: number;
  /** Items kept from the end. */
  tailN: number;
  /** Std-dev distance beyond which a numeric value marks its item an outlier. */
  sigma: number;
}

/**
 * Sample a large JSON array down to its high-value items: the first `headN` and
 * last `tailN`, every error/failure-like item, and statistical outliers on any
 * numeric field. The dropped items are elided behind a reversible marker (one
 * capture holding the dropped sub-array), so the original is recoverable via the
 * retrieve tool. This is the lossy, content-only core of Headroom's SmartCrusher
 * (no query-relevance signal, which would be mutable and break cache stability).
 *
 * Output shape `{ _sentinelSample: { kept, droppedCount, note, stats } }` is an
 * object, not an array, so a second pass never re-matches the array trigger
 * (idempotent). Deterministic: selection is a pure function of the items.
 *
 * `stats` is a per-field aggregate over the DROPPED items only, giving the model
 * aggregate insight into the elided population it can no longer see inline
 * (count/min/max/mean/median/population-stdev per numeric field, scalar numbers
 * under the `''` field). It is deterministic via fixed 4-decimal rounding and
 * population stdev, and is OMITTED entirely when no dropped item carried a
 * finite number, so non-numeric arrays produce byte-identical output to before.
 *
 * Returns `jsonText` unchanged when the array is below `minRows` or when every
 * item qualifies to keep (nothing to drop).
 */
export function sampleJsonArray(
  jsonText: string,
  parsed: unknown,
  opts: SampleOpts,
  onElide?: OnElide,
): string {
  if (!Array.isArray(parsed) || parsed.length < opts.minRows) return jsonText;
  const n = parsed.length;
  const keep = new Set<number>();
  for (let i = 0; i < opts.headN && i < n; i++) keep.add(i);
  for (let i = Math.max(0, n - opts.tailN); i < n; i++) keep.add(i);
  for (let i = 0; i < n; i++) if (looksLikeError(parsed[i])) keep.add(i);
  for (const i of collectNumericOutliers(parsed, opts.sigma)) keep.add(i);
  if (keep.size >= n) return jsonText;

  const keptItems: unknown[] = [];
  const droppedItems: unknown[] = [];
  for (let i = 0; i < n; i++) {
    if (keep.has(i)) keptItems.push(parsed[i]);
    else droppedItems.push(parsed[i]);
  }
  const droppedCount = droppedItems.length;
  // Capture the EXACT original array text (not just the dropped subset) so the
  // retrieve tool reconstructs it byte-for-byte — perfect reversibility, and
  // the local capture never rides the wire anyway.
  const hint = retrievalHint(onElide, 'json_sample', jsonText);
  const note = `${droppedCount} of ${n} items elided by Sentinel${hint}`;
  const stats = collectDroppedStats(droppedItems);
  // stats LAST in key order; omitted entirely when no numeric fields exist.
  const sample =
    stats === undefined
      ? { kept: keptItems, droppedCount, note }
      : { kept: keptItems, droppedCount, note, stats };
  return JSON.stringify({ _sentinelSample: sample });
}
