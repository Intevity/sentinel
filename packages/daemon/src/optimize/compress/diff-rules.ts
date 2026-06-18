/**
 * Unified-diff compression for tool_result content (output of `git diff`,
 * `git show`, `diff -u`, patch files, etc.). Modeled on headroom's
 * DiffCompressor but WITHOUT its bug class: that compressor rewrote kept
 * lines (it re-emitted `@@` headers with recomputed counts and could mangle
 * `old mode`/`new mode` bits). Here we NEVER rewrite a single kept line. Every
 * transformation only drops WHOLE lines and inserts standalone marker lines;
 * the bytes of every surviving line (mode lines, index lines, @@ headers, the
 * `\ No newline at end of file` sentinel) are passed through byte-identical.
 *
 * Like every rule in this package the function is PURE, DETERMINISTIC, and
 * IDEMPOTENT: no clock, randomness, locale, or I/O, and `rule(rule(x))` is a
 * no-op. Idempotency is guaranteed two ways: (1) any change inserts a marker
 * line containing the literal phrase "elided by Sentinel", so a second
 * pass short-circuits on the leading guard; (2) even without the guard, the
 * post-trim structure has all counts under the caps, so the cap-based passes
 * would not fire again. When nothing is dropped the EXACT input string
 * instance is returned (callers rely on identity to detect no-ops).
 *
 * A deliberate, documented lossiness: context trimming does NOT rewrite the
 * `@@ -a,b +c,d @@` line counts, so a trimmed hunk's header counts go stale.
 * That is fine here: the model reads the diff for comprehension; nothing in
 * this pipeline re-applies the patch. We accept stale counts in exchange for
 * the absolute guarantee that we never corrupt a kept line (the headroom bug).
 */

import { byteLen, type RuleId } from './types.js';
import { retrievalHint, type OnElide } from './text-rules.js';

const RULE_ID: RuleId = 'diff_trim';

/** Tier-tunable caps. `contextLines` is how many leading/trailing context
 *  lines to keep on each side of a hunk's changes. */
export interface DiffTrimOpts {
  /** Maximum number of files kept verbatim; excess (lightest by churn) elided. */
  maxFiles: number;
  /** Maximum number of hunks kept per file; excess (smallest) elided. */
  maxHunks: number;
  /** Context lines kept on each side of the change inside a hunk. */
  contextLines: number;
}

const HUNK_HEADER_RE = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m;
const DIFF_GIT_RE = /^diff --git /m;

/** A line that begins a new file section inside a unified diff. (The parser
 *  needs no broader header pattern: between a `diff --git` line and the first
 *  `@@` hunk header, EVERY line — index, mode, rename, ---/+++ — belongs to
 *  the file header region by position.) */
const FILE_START_RE = /^diff --git /;

/** Basenames of lockfiles whose hunk bodies are pure noise to a reader. */
const LOCKFILE_RE =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|composer\.lock|poetry\.lock|Gemfile\.lock|go\.sum)$/;

/**
 * Pure shape test: does this text look like a unified diff? True only when it
 * contains BOTH a hunk header (`@@ -a,b +c,d @@`) AND a file header (a
 * `diff --git` line, or a `--- ` line immediately followed by a `+++ ` line).
 *
 * Requiring the hunk header is what defeats false positives from ordinary
 * source code that merely contains lines starting with `+`/`-` (math, regex
 * literals, markdown lists) or the word "diff" in a string.
 */
export function isUnifiedDiff(text: string): boolean {
  if (!HUNK_HEADER_RE.test(text)) return false;
  if (DIFF_GIT_RE.test(text)) return true;
  // `--- ` immediately followed by `+++ ` (the classic diff -u file header).
  const lines = text.split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if ((lines[i] ?? '').startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      return true;
    }
  }
  return false;
}

interface Hunk {
  /** The `@@ ... @@` header line, byte-identical. */
  header: string;
  /** Body lines after the header (' ', '+', '-', '\' or unknown), verbatim. */
  body: string[];
}

interface DiffFile {
  /** Header lines before the first hunk (diff --git, index, mode, ---, +++). */
  header: string[];
  hunks: Hunk[];
}

interface ParsedDiff {
  /** Lines before the first file section (rare; e.g. `git show` commit text). */
  preamble: string[];
  files: DiffFile[];
}

/** Parse a unified diff into preamble + files + hunks. Every line is kept
 *  verbatim in exactly one slot; the parser never rewrites a line. Unknown
 *  lines inside a hunk attach to the current hunk body. */
function parseDiff(text: string): ParsedDiff {
  const lines = text.split('\n');
  const preamble: string[] = [];
  const files: DiffFile[] = [];
  let curFile: DiffFile | null = null;
  let curHunk: Hunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (FILE_START_RE.test(line)) {
      curHunk = null;
      curFile = { header: [line], hunks: [] };
      files.push(curFile);
      continue;
    }
    // A `--- ` line immediately followed by `+++ ` is a file header, in ANY
    // state. In multi-file `diff -u` output (no `diff --git` delimiter) this is
    // the ONLY file boundary, and it can land while we are still inside the
    // previous file's hunk. The `+++ ` lookahead is what disambiguates it from
    // an ordinary removed line that merely starts with `--- ` (that would be
    // followed by another body line, not a `+++ ` header). git's own parser
    // uses the same adjacency rule.
    const next = lines[i + 1];
    if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
      // Inside a diff --git file the `--- `/`+++ ` pair belongs to the existing
      // header region (curFile present, no hunk yet); only start a NEW file when
      // we are not already collecting that file's header.
      if (!curFile || curHunk) {
        curHunk = null;
        curFile = { header: [line, next], hunks: [] };
        files.push(curFile);
        i++;
        continue;
      }
      // diff --git case: append both header lines to the current file header.
      curFile.header.push(line, next);
      i++;
      continue;
    }
    if (line.startsWith('@@ ')) {
      // A hunk header. If we have no file yet (a stream that opens with a bare
      // @@, e.g. a diff whose body contains nested diff headers), synthesize an
      // empty-header file to attach it to.
      if (!curFile) {
        curFile = { header: [], hunks: [] };
        files.push(curFile);
      }
      curHunk = { header: line, body: [] };
      curFile.hunks.push(curHunk);
      continue;
    }
    if (curHunk) {
      curHunk.body.push(line);
      continue;
    }
    if (curFile) {
      // Still in the file's header region (index/mode or unknown).
      curFile.header.push(line);
      continue;
    }
    preamble.push(line);
  }
  return { preamble, files };
}

/** Churn = number of changed (+/-) lines across a file's hunks. */
function fileChurn(f: DiffFile): number {
  let n = 0;
  for (const h of f.hunks) {
    for (const b of h.body) {
      if (b.startsWith('+') || b.startsWith('-')) n++;
    }
  }
  return n;
}

/** Body-line count for a single hunk (all lines after the @@ header). This is
 *  the hunk-cap weight: a hunk's "size" for ranking which middle hunks to keep.
 *  Distinct from {@link fileChurn}, which weights files by +/- churn only. */
function hunkBodyLines(h: Hunk): number {
  return h.body.length;
}

/** True when a file's path (either side) is a lockfile. */
function isLockfile(f: DiffFile): boolean {
  for (const h of f.header) {
    if (h.startsWith('diff --git ')) {
      // `diff --git a/path b/path` — test both operands.
      const rest = h.slice('diff --git '.length);
      const parts = rest.split(' ');
      for (const p of parts) {
        const stripped = p.replace(/^[ab]\//, '');
        if (LOCKFILE_RE.test(stripped)) return true;
      }
    } else if (h.startsWith('--- ') || h.startsWith('+++ ')) {
      const p = h
        .slice(4)
        .replace(/^[ab]\//, '')
        .replace(/\t.*$/, '');
      if (LOCKFILE_RE.test(p)) return true;
    }
  }
  return false;
}

/** True when every +/- line in the hunk is whitespace-only after the prefix,
 *  and there is at least one such line. */
function isWhitespaceOnlyHunk(h: Hunk): boolean {
  let saw = false;
  for (const b of h.body) {
    if (b.startsWith('+') || b.startsWith('-')) {
      saw = true;
      if (b.slice(1).trim().length !== 0) return false;
    }
  }
  return saw;
}

/** Render one file's lines (header + hunks). */
function renderFile(f: DiffFile): string[] {
  const out: string[] = [...f.header];
  for (const h of f.hunks) {
    out.push(h.header);
    out.push(...h.body);
  }
  return out;
}

/** Render a hunk's lines (header + body). */
function renderHunk(h: Hunk): string[] {
  return [h.header, ...h.body];
}

/**
 * Trim a unified diff. Drops whole lines only, inserting standalone marker
 * lines; never rewrites a kept line (the headroom-bug guard). Transformations
 * run in a fixed order: lockfile hunks, whitespace-only hunks, file cap, hunk
 * cap, context trim. Returns the exact input instance when nothing is dropped.
 */
export function trimUnifiedDiff(text: string, opts: DiffTrimOpts, onElide?: OnElide): string {
  // Leading guard: already-compressed text carries the marker phrase.
  if (text.includes('elided by Sentinel')) return text;
  if (!isUnifiedDiff(text)) return text;

  const parsed = parseDiff(text);
  let changed = false;

  // (a) Lockfile files: keep headers, collapse all hunks to one marker.
  // (b) Whitespace-only hunks: collapse each to one marker.
  for (const f of parsed.files) {
    if (f.hunks.length === 0) continue;
    if (isLockfile(f)) {
      const droppedLines: string[] = [];
      for (const h of f.hunks) droppedLines.push(...renderHunk(h));
      const elided = droppedLines.join('\n');
      const hint = retrievalHint(onElide, RULE_ID, elided);
      const marker = `... [${f.hunks.length} hunks elided by Sentinel${hint}] ...`;
      f.hunks = [{ header: marker, body: [] }];
      // Mark this synthetic "hunk" so later passes skip it: a marker header
      // does not start with '@@', so the hunk cap/context passes ignore it.
      changed = true;
      continue;
    }
    const keptHunks: Hunk[] = [];
    for (const h of f.hunks) {
      if (isWhitespaceOnlyHunk(h)) {
        const elided = renderHunk(h).join('\n');
        const hint = retrievalHint(onElide, RULE_ID, elided);
        const marker = `... [1 whitespace-only hunks elided by Sentinel${hint}] ...`;
        keptHunks.push({ header: marker, body: [] });
        changed = true;
      } else {
        keptHunks.push(h);
      }
    }
    f.hunks = keptHunks;
  }

  // (c) File cap: keep the heaviest maxFiles by churn, ties by earlier
  //     position; preserve original order; collapse contiguous dropped runs.
  if (parsed.files.length > opts.maxFiles) {
    const ranked = parsed.files
      .map((f, idx) => ({ f, idx, churn: fileChurn(f) }))
      .sort((x, y) => y.churn - x.churn || x.idx - y.idx);
    const keepIdx = new Set<number>();
    for (let k = 0; k < opts.maxFiles; k++) {
      const r = ranked[k];
      if (r) keepIdx.add(r.idx);
    }
    const newFiles: DiffFile[] = [];
    let i = 0;
    while (i < parsed.files.length) {
      if (keepIdx.has(i)) {
        const f = parsed.files[i];
        if (f) newFiles.push(f);
        i++;
        continue;
      }
      // Contiguous run of dropped files -> one marker pseudo-file.
      let j = i;
      const droppedLines: string[] = [];
      let hunkCount = 0;
      while (j < parsed.files.length && !keepIdx.has(j)) {
        const f = parsed.files[j];
        if (f) {
          droppedLines.push(...renderFile(f));
          hunkCount += f.hunks.length;
        }
        j++;
      }
      const elided = droppedLines.join('\n');
      const hint = retrievalHint(onElide, RULE_ID, elided);
      const marker = `... [${j - i} files (${hunkCount} hunks) elided by Sentinel${hint}] ...`;
      newFiles.push({ header: [marker], hunks: [] });
      changed = true;
      i = j;
    }
    parsed.files = newFiles;
  }

  // (d) Hunk cap per kept file: always keep first + last, fill remaining
  //     maxHunks-2 slots by body-line-count descending (ties: earlier position).
  for (const f of parsed.files) {
    if (f.hunks.length <= opts.maxHunks) continue;
    const n = f.hunks.length;
    const keep = new Array<boolean>(n).fill(false);
    keep[0] = true;
    keep[n - 1] = true;
    const slots = opts.maxHunks - 2;
    if (slots > 0) {
      const middle: { idx: number; size: number }[] = [];
      for (let idx = 1; idx < n - 1; idx++) {
        const h = f.hunks[idx];
        if (h) middle.push({ idx, size: hunkBodyLines(h) });
      }
      middle.sort((a, b) => b.size - a.size || a.idx - b.idx);
      for (let k = 0; k < slots && k < middle.length; k++) {
        const m = middle[k];
        if (m) keep[m.idx] = true;
      }
    }
    const newHunks: Hunk[] = [];
    let i = 0;
    while (i < n) {
      if (keep[i]) {
        const h = f.hunks[i];
        if (h) newHunks.push(h);
        i++;
        continue;
      }
      let j = i;
      const droppedLines: string[] = [];
      while (j < n && !keep[j]) {
        const h = f.hunks[j];
        if (h) droppedLines.push(...renderHunk(h));
        j++;
      }
      const elided = droppedLines.join('\n');
      const hint = retrievalHint(onElide, RULE_ID, elided);
      const marker = `... [${j - i} hunks elided by Sentinel${hint}] ...`;
      newHunks.push({ header: marker, body: [] });
      changed = true;
      i = j;
    }
    f.hunks = newHunks;
  }

  // (e) Context trim per kept hunk: drop the leading run of ' ' context before
  //     the first change and the trailing run after the last change, keeping
  //     opts.contextLines adjacent ones, but only when the run is long enough
  //     that the ~165-byte marker pays off (>= 4 dropped lines).
  for (const f of parsed.files) {
    for (const h of f.hunks) {
      // Skip synthetic marker "hunks": their header is not a real @@ header.
      if (!h.header.startsWith('@@ ')) continue;
      const trimmed = trimHunkContext(h, opts.contextLines, onElide);
      if (trimmed !== h.body) {
        h.body = trimmed;
        changed = true;
      }
    }
  }

  if (!changed) return text;

  const out: string[] = [...parsed.preamble];
  for (const f of parsed.files) out.push(...renderFile(f));
  return out.join('\n');
}

/** Trim leading/trailing context inside one hunk body. Returns the SAME body
 *  array instance when nothing is dropped (so the caller can identity-check).
 *  Only ' '-prefixed context lines at the extreme ends are candidates; interior
 *  context between changes is never touched. */
function trimHunkContext(h: Hunk, contextLines: number, onElide?: OnElide): string[] {
  const body = h.body;
  // Find first and last changed (+/-) line.
  let first = -1;
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    const b = body[i] ?? '';
    if (b.startsWith('+') || b.startsWith('-')) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return body; // no changes; leave alone.

  // Leading context run: indices [0, first) that are all ' ' context lines.
  let leadEnd = 0;
  while (leadEnd < first && (body[leadEnd] ?? '').startsWith(' ')) leadEnd++;
  // Trailing context run: indices (last, end) that are all ' ' context lines.
  let trailStart = body.length;
  {
    let k = body.length - 1;
    while (k > last && (body[k] ?? '').startsWith(' ')) k--;
    trailStart = k + 1;
  }

  const out: string[] = [];
  let changed = false;

  // Leading: keep the contextLines closest to the change.
  const leadLen = leadEnd; // run is [0, leadEnd)
  const leadDrop = leadLen - contextLines;
  if (leadLen > contextLines && leadDrop >= 4) {
    const elided = body.slice(0, leadDrop).join('\n');
    const hint = retrievalHint(onElide, RULE_ID, elided);
    out.push(`... [${leadDrop} context lines elided by Sentinel${hint}] ...`);
    out.push(...body.slice(leadDrop, leadEnd));
    changed = true;
  } else {
    out.push(...body.slice(0, leadEnd));
  }

  // Interior (between leading context and trailing context) verbatim.
  out.push(...body.slice(leadEnd, trailStart));

  // Trailing: keep contextLines closest to the change.
  const trailLen = body.length - trailStart;
  const trailDrop = trailLen - contextLines;
  if (trailLen > contextLines && trailDrop >= 4) {
    out.push(...body.slice(trailStart, trailStart + contextLines));
    const elided = body.slice(trailStart + contextLines).join('\n');
    const hint = retrievalHint(onElide, RULE_ID, elided);
    out.push(`... [${trailDrop} context lines elided by Sentinel${hint}] ...`);
    changed = true;
  } else {
    out.push(...body.slice(trailStart));
  }

  return changed ? out : body;
}

/** Exported only so the benchmark suite can size markers; not part of the
 *  compression contract. Kept here to avoid duplicating the constant. */
export const APPROX_MARKER_BYTES = byteLen('... [99 context lines elided by Sentinel] ...');
