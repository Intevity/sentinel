/**
 * Pure search-output compression for tool_result content emitted by the Grep
 * (ripgrep) and Glob tools. Modeled on headroom's SearchCompressor: grep/Glob
 * runs over a large tree routinely return hundreds of `path:line:content` hits
 * or bare path lists that the model rarely needs in full. This rule keeps the
 * shape intact (so the model still sees which files matched and a representative
 * sample of matches) while eliding the long tail.
 *
 * Like every rule here it is a deterministic fixed point: `rule(rule(x)) ===
 * rule(x)`, no clock / randomness / locale / I/O, and the no-op case returns the
 * EXACT same string instance so callers' identity checks hold. See `types.ts`
 * for why that keeps Anthropic's prompt-cache prefixes byte-stable.
 */

import { retrievalHint, type OnElide } from './text-rules.js';

/**
 * Shape A (content mode) line: `path:line:content` or `path:line-content`
 * (the `-` form is a ripgrep context line). Group 1 = path, group 2 = line
 * number, group 3 = `:`|`-` separator, group 4 = content. We deliberately
 * forbid a `:` inside the path group ([^:\n]*) so the FIRST colon always
 * delimits the line number, matching ripgrep's own framing.
 */
const SHAPE_A_RE = /^([^\s:][^:\n]*):(\d{1,7})([:-])(.*)$/;

/** A dot-extension at the end of a token, e.g. `.ts`, `.tsx`, `.py`. */
const DOT_EXT_RE = /\.\w{1,8}$/;

/** Timestamp fragment guard: rejects syslog-ish paths like
 *  `2026-06-06T12:00:01` whose `T12:` would otherwise read as a line number. */
const TIMESTAMP_FRAG_RE = /T\d\d:/;

/** All-digits token (a bare number is never a path). */
const ALL_DIGITS_RE = /^\d+$/;

/**
 * True when `p` looks like a real filesystem path for Shape A/B purposes:
 * contains a separator or ends in a dot-extension, is not all digits, carries
 * no timestamp fragment, and is not absurdly long. Accepts `undefined` so the
 * sole caller's regex group (always present on a match, but typed optional under
 * noUncheckedIndexedAccess) needs no separate coalesce branch. Pure.
 */
function isPathLike(p: string | undefined): boolean {
  if (p === undefined || p.length > 512) return false;
  if (ALL_DIGITS_RE.test(p)) return false;
  if (TIMESTAMP_FRAG_RE.test(p)) return false;
  const hasSep = p.indexOf('/') !== -1 || p.indexOf('\\') !== -1;
  return hasSep || DOT_EXT_RE.test(p);
}

/** Returns the path of a Shape-A line, or null if the line is not Shape A or
 *  its path group fails {@link isPathLike}. Pure. */
function shapeAPath(line: string): string | null {
  const m = SHAPE_A_RE.exec(line);
  if (!m) return null;
  return isPathLike(m[1]) ? (m[1] as string) : null;
}

/**
 * Shape B: the WHOLE line is a single path-like token. No internal whitespace,
 * length <= 512, path-like. (Leading/trailing spaces would mean it is not a
 * bare path token, so we test the raw line, not a trimmed copy.) Pure.
 */
function isShapeB(line: string): boolean {
  if (line.length > 512) return false;
  if (/\s/.test(line)) return false;
  return isPathLike(line);
}

/** First N non-empty lines, used both by the classifier and the sampler. Pure. */
function nonEmptyLines(lines: string[], cap: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    out.push(line);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Pure shape test: does this text look like grep/ripgrep/Glob output? Samples
 * the first 200 non-empty lines and requires at least 10 sampled. True when
 * either (Shape A fraction >= 0.8 with >= 2 distinct paths) OR (Shape B
 * fraction >= 0.95). The distinct-path floor on Shape A keeps `key: value`
 * config and `Error: at foo.ts:1:2` prose (one or zero real paths) from
 * tripping the classifier.
 */
export function isSearchOutput(text: string): boolean {
  const sample = nonEmptyLines(text.split('\n'), 200);
  if (sample.length < 10) return false;

  let shapeA = 0;
  let shapeB = 0;
  const distinctPaths = new Set<string>();
  for (const line of sample) {
    const p = shapeAPath(line);
    if (p !== null) {
      shapeA++;
      distinctPaths.add(p);
    }
    if (isShapeB(line)) shapeB++;
  }
  const n = sample.length;
  if (shapeA / n >= 0.8 && distinctPaths.size >= 2) return true;
  if (shapeB / n >= 0.95) return true;
  return false;
}

export interface SearchExtractOpts {
  /** Only act when the non-empty line count exceeds this. */
  triggerLines: number;
  /** Max distinct files kept in content mode; the rest are folded by run. */
  maxFiles: number;
  /** Max matches kept per surviving file; the middle is elided. */
  maxPerFile: number;
  /** Bare-path mode: paths kept from the head. */
  headPaths: number;
  /** Bare-path mode: paths kept from the tail. */
  tailPaths: number;
}

// Structural idempotency invariant (mirrors truncateLog): a once-compressed
// Shape-B result has exactly headPaths + 1 marker + tailPaths lines, which must
// not re-trigger. Both shipped tiers satisfy headPaths + tailPaths + 1 <=
// triggerLines (moderate 40+10+1=51 <= 60; aggressive 20+5+1=26 <= 30).

/** A path group in content mode: the path and its original lines, in order. */
interface Group {
  path: string;
  lines: string[];
}

/**
 * Compress grep/ripgrep/Glob output. Two modes:
 *
 * MODE A (content `path:line:content`): group hits by path (first-seen order),
 * apply a FILE cap (keep the heaviest `maxFiles`, fold each contiguous dropped
 * run into one marker), then a PER-FILE cap (keep first ceil(n/2) + last
 * floor(n/2) matches of each survivor, fold the middle).
 *
 * MODE B (bare paths from Glob or `--files-with-matches`): head/tail truncate
 * to `headPaths` + `tailPaths`, fold the middle into one marker.
 *
 * Lossy elisions are reversible: each marker embeds a retrieval id and the
 * exact dropped bytes are handed to `onElide`.
 *
 * Idempotent: the leading marker guard short-circuits a second pass; and
 * structurally, marker lines match neither shape (after `<path>:` comes ` ...`,
 * not digits; markers contain spaces so they are not bare paths) and post-cap
 * counts fall under the triggers. Returns the EXACT input instance when the
 * text is short, not classifiable, or nothing is dropped.
 */
export function extractSearchMatches(
  text: string,
  opts: SearchExtractOpts,
  onElide?: OnElide,
): string {
  // Idempotency + non-interference: never re-process text already carrying a
  // marker (ours or another rule's; all use this exact phrase).
  if (text.includes('elided by Sentinel')) return text;

  const lines = text.split('\n');
  const sample = nonEmptyLines(lines, 200);
  // Count non-empty lines for the trigger (cheap, no second classify pass).
  let nonEmptyCount = 0;
  for (const line of lines) if (line.trim().length !== 0) nonEmptyCount++;
  if (nonEmptyCount <= opts.triggerLines) return text;

  // Re-classify on the sample (same fractions as isSearchOutput, but we need
  // to know WHICH mode to drive the right cap path).
  if (sample.length < 10) return text;
  let shapeA = 0;
  let shapeB = 0;
  for (const line of sample) {
    if (shapeAPath(line) !== null) shapeA++;
    if (isShapeB(line)) shapeB++;
  }
  const sn = sample.length;
  const isA = shapeA / sn >= 0.8;
  const isB = !isA && shapeB / sn >= 0.95;
  if (!isA && !isB) return text;

  return isA ? modeA(text, lines, opts, onElide) : modeB(text, lines, opts, onElide);
}

/** Content mode: group, file-cap, per-file-cap. */
function modeA(
  text: string,
  lines: string[],
  opts: SearchExtractOpts,
  onElide: OnElide | undefined,
): string {
  // 1. Group lines by path in first-seen order. Blank lines and `--` rg group
  //    separators are dropped. Non-matching lines ride with the most recent
  //    path group (e.g. multiline match continuations), or a preamble block if
  //    no path has been seen yet.
  const preamble: string[] = [];
  const groups: Group[] = [];
  const byPath = new Map<string, Group>();
  let current: Group | null = null;
  for (const line of lines) {
    if (line.length === 0 || line.trim() === '--') continue;
    const path = shapeAPath(line);
    if (path !== null) {
      let g = byPath.get(path);
      if (!g) {
        g = { path, lines: [] };
        byPath.set(path, g);
        groups.push(g);
      }
      g.lines.push(line);
      current = g;
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }

  // 2. FILE CAP, computed on the ORIGINAL groups. Keep the heaviest `maxFiles`
  //    by line count (ties: first-seen). We walk the original group order and
  //    fold each contiguous dropped RUN into one marker.
  const keepGroup = new Set<Group>();
  if (groups.length > opts.maxFiles) {
    const ranked = groups
      .map((g, idx) => ({ g, idx, weight: g.lines.length }))
      .sort((a, b) => (b.weight !== a.weight ? b.weight - a.weight : a.idx - b.idx))
      .slice(0, opts.maxFiles);
    for (const r of ranked) keepGroup.add(r.g);
  } else {
    for (const g of groups) keepGroup.add(g);
  }

  // 3. Emit. Preamble rides through untouched at the top.
  const out: string[] = [];
  for (const line of preamble) out.push(line);

  let i = 0;
  while (i < groups.length) {
    const g = groups[i];
    if (g && keepGroup.has(g)) {
      emitGroup(out, g, opts, onElide);
      i++;
      continue;
    }
    // Contiguous run of dropped files -> one marker.
    let j = i;
    let matchCount = 0;
    const elidedLines: string[] = [];
    while (j < groups.length) {
      const dg = groups[j];
      if (!dg || keepGroup.has(dg)) break;
      matchCount += dg.lines.length;
      for (const l of dg.lines) elidedLines.push(l);
      j++;
    }
    const fileCount = j - i;
    const elided = elidedLines.join('\n');
    const hint = retrievalHint(onElide, 'search_extract', elided);
    out.push(
      `... [${fileCount} more files with ${matchCount} matches elided by Sentinel${hint}] ...`,
    );
    i = j;
  }

  // Gate on byte-difference: dropping blank / `--` separator lines counts as a
  // change even when no cap fired, and when truly nothing changed we MUST return
  // the exact input instance (callers' identity check, no-gain guard upstream).
  const result = out.join('\n');
  return result !== text ? result : text;
}

/** Emit one surviving group, applying the per-file cap to its match lines. */
function emitGroup(
  out: string[],
  g: Group,
  opts: SearchExtractOpts,
  onElide: OnElide | undefined,
): void {
  if (g.lines.length <= opts.maxPerFile) {
    out.push(...g.lines);
    return;
  }
  // Keep first ceil(maxPerFile/2) and last floor(maxPerFile/2). Slices keep this
  // type-safe under noUncheckedIndexedAccess without per-element coalesces.
  const headN = Math.ceil(opts.maxPerFile / 2);
  const tailN = Math.floor(opts.maxPerFile / 2);
  out.push(...g.lines.slice(0, headN));
  const middle = g.lines.slice(headN, g.lines.length - tailN);
  const elided = middle.join('\n');
  const hint = retrievalHint(onElide, 'search_extract', elided);
  out.push(`${g.path}: ... [${middle.length} more matches elided by Sentinel${hint}] ...`);
  out.push(...g.lines.slice(g.lines.length - tailN));
}

/** Bare-path mode: keep first `headPaths` and last `tailPaths` non-empty lines,
 *  fold the middle. Empty lines are not counted toward head/tail but are not
 *  separately preserved either (Glob output has none); the non-empty subsequence
 *  is what we keep. */
function modeB(
  text: string,
  lines: string[],
  opts: SearchExtractOpts,
  onElide: OnElide | undefined,
): string {
  // The caller (extractSearchMatches) has already verified non-empty count >
  // triggerLines, so we do not re-check it here; we only recompute the non-empty
  // subsequence to slice head/tail from.
  const ne: string[] = [];
  for (const line of lines) if (line.trim().length !== 0) ne.push(line);

  const head = ne.slice(0, opts.headPaths);
  const tail = ne.slice(ne.length - opts.tailPaths);
  const middle = ne.slice(opts.headPaths, ne.length - opts.tailPaths);
  if (middle.length === 0) return text;
  const elided = middle.join('\n');
  const hint = retrievalHint(onElide, 'search_extract', elided);
  const marker = `... [${middle.length} more paths elided by Sentinel${hint}] ...`;
  return [...head, marker, ...tail].join('\n');
}
