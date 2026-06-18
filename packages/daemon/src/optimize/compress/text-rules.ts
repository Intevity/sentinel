/**
 * Pure text-compression rules for tool_result content that is NOT JSON
 * (command output, logs, stack traces). Every function is a deterministic
 * fixed point: `rule(rule(x)) === rule(x)`. See `types.ts` for why that
 * matters for prompt-cache stability.
 */

import type { RuleId } from './types.js';

/** Reversible-compression hook. Called by lossy rules with the text they are
 *  about to elide; returns a content-hash id to embed in the marker so the
 *  model can fetch the original via the retrieve tool. Pure + deterministic
 *  (a content hash), so markers stay byte-stable across replayed turns. */
export type OnElide = (ruleId: RuleId, elided: string) => string;

/** Build the trailing retrieval hint for an elision marker. Empty string when
 *  reversible mode is off, so the non-CCR marker is byte-identical to before.
 *  Exported so the JSON rules can embed the same hint in their markers. */
export function retrievalHint(
  onElide: OnElide | undefined,
  ruleId: RuleId,
  elided: string,
): string {
  if (!onElide) return '';
  return `; retrieve the full output with the sentinel retrieve tool, id="${onElide(ruleId, elided)}"`;
}

// CSI sequences: ESC [ ... final-byte. Covers colors and cursor moves.
// no-control-regex: matching ANSI escapes inherently requires the ESC (\x1b)
// control byte — that is the whole point of this rule.
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;?:]*[ -/]*[@-~]/g;
// OSC sequences: ESC ] ... terminated by BEL or ST (ESC \). Covers window
// titles and hyperlinks.
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Strip ANSI escape sequences (colors, cursor moves, OSC titles/hyperlinks).
 * Lossless for the textual content the model reads. Idempotent: after the
 * first pass no matched escape remains, so a second pass removes nothing.
 */
export function stripAnsi(text: string): string {
  // Fast path: no ESC byte means nothing to do, and guarantees the no-op
  // case returns the exact same string instance.
  if (text.indexOf('\x1b') === -1) return text;
  return text.replace(ANSI_OSC, '').replace(ANSI_CSI, '');
}

/**
 * Collapse runs of two or more whitespace-only lines down to a single empty
 * line, and normalize whitespace-only lines to empty. Lossless for any
 * reasonable consumer (blank lines carry no information). Idempotent: the
 * result has no two consecutive blank lines.
 */
export function collapseBlankLines(text: string): string {
  if (text.length === 0) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let prevBlank = false;
  for (const line of lines) {
    const blank = line.trim().length === 0;
    if (blank && prevBlank) continue;
    out.push(blank ? '' : line);
    prevBlank = blank;
  }
  return out.join('\n');
}

/**
 * Collapse runs of two or more identical adjacent lines down to a single
 * line. Targets repeated progress/spinner output and duplicated log lines.
 * Idempotent: the result has no two adjacent identical lines.
 */
export function collapseDuplicateLines(text: string): string {
  if (text.length === 0) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (out.length > 0 && out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out.join('\n');
}

// Lines that look like a stack frame in common runtimes.
const FRAME_RE = /^\s*(?:at\s|File ".*", line \d+|#\d+\s|from\s)/;

/**
 * Collapse long runs of consecutive stack-frame lines, keeping the first and
 * last `keep` frames and replacing the middle with a deterministic marker.
 * Idempotent: after collapse each remaining run is at most `2*keep` frames
 * (split by the non-frame marker line), which never re-triggers the
 * `> 2*keep + 1` threshold.
 */
export function collapseStackTraces(text: string, keep: number, onElide?: OnElide): string {
  if (keep < 1) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  let changed = false;
  while (i < lines.length) {
    let j = i;
    while (j < lines.length && FRAME_RE.test(lines[j] ?? '')) j++;
    const runLen = j - i;
    if (runLen > keep * 2 + 1) {
      out.push(...lines.slice(i, i + keep));
      const elided = lines.slice(i + keep, j - keep).join('\n');
      const hint = retrievalHint(onElide, 'stack_trace_collapse', elided);
      out.push(`    ... [${runLen - keep * 2} stack frames elided by Sentinel${hint}] ...`);
      out.push(...lines.slice(j - keep, j));
      changed = true;
    } else {
      out.push(...lines.slice(i, j));
    }
    if (j < lines.length) {
      // Push the single non-frame line that ended the run (slice keeps it
      // type-safe under noUncheckedIndexedAccess), then advance past it.
      out.push(...lines.slice(j, j + 1));
      i = j + 1;
    } else {
      i = j;
    }
  }
  return changed ? out.join('\n') : text;
}

/** Output of a recognized build/test runner. We only extract from logs that
 *  match one of these so arbitrary prose/config/markdown is never mangled.
 *  Anchored, multiline patterns: pytest/jest session lines, cargo compile +
 *  `error[E####]`, npm errors, make recipes, and stack-frame `at ... (f:1:2)`. */
const LOG_FRAMEWORK_RE =
  /(?:={3,}\s*test session starts|^PASS\b|^FAIL\b|^Tests:\s|^Test Suites:\s|^\s*Compiling\s|error\[E\d{2,4}\]|^npm ERR!|^make(?:\[\d+\])?:\s|^\s*at\s.+\(.+:\d+:\d+\)|^test result:)/m;

/** A line worth keeping verbatim: an error, failure, warning, or test summary.
 *  Case-insensitive; intentionally broad on the keep side because dropping a
 *  real error is far worse than keeping a benign line. */
export const LOG_INTERESTING_RE =
  /(?:\berror(?:s)?\b|\bfail(?:ed|ure|ing)?\b|\bexception\b|traceback|\bpanic\b|\bfatal\b|\bassert(?:ion)?\b|error\[E\d|npm ERR!|warning:|\bdenied\b|\brefused\b|\btimed? ?out\b|\bnot found\b|test result:|[✗✕×●])/i;

export interface ErrorExtractOpts {
  /** Only act when the line count exceeds this. */
  triggerLines: number;
  /** Lines always kept from the start (the run header). */
  headLines: number;
  /** Lines always kept from the end (the summary). */
  tailLines: number;
  /** Lines of context kept on each side of an interesting line. */
  contextLines: number;
  /** Minimum contiguous non-kept run length to elide; shorter runs are kept
   *  verbatim so the output stays readable and small gaps don't churn into
   *  markers that the net-gain guard would just revert. */
  minRun: number;
}

/**
 * Format-aware log compression: in output from a recognized build/test runner,
 * keep the error/warning/summary lines (with a little surrounding context) and
 * the head/tail, eliding the long contiguous runs of passing/progress noise in
 * between. Each elided run becomes a reversible marker carrying a retrieval id.
 *
 * Unlike head/tail {@link truncateLog}, this keeps position-independent errors
 * that would otherwise fall in the truncated middle. It runs BEFORE truncate so
 * truncate only sees the already-trimmed log.
 *
 * Deterministic (pure function of the text). Idempotent via the same marker
 * guard the whole engine relies on: once any rule has written an "elided by
 * Sentinel" marker, a second pass returns the text unchanged. Returns
 * the input unchanged when no framework is detected, the log is short, or no
 * run is long enough to elide.
 */
export function extractLogErrors(text: string, opts: ErrorExtractOpts, onElide?: OnElide): string {
  // Idempotency + non-interference: never re-process text that already carries
  // an elision marker (ours, or a stack-collapse marker from an earlier rule
  // in the same pass — both use this exact phrase).
  if (text.includes('elided by Sentinel')) return text;
  const lines = text.split('\n');
  if (lines.length <= opts.triggerLines) return text;
  if (!LOG_FRAMEWORK_RE.test(text)) return text;

  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (i < opts.headLines || i >= lines.length - opts.tailLines) {
      keep[i] = true;
      continue;
    }
    if (LOG_INTERESTING_RE.test(lines[i] ?? '')) {
      const lo = Math.max(0, i - opts.contextLines);
      const hi = Math.min(lines.length - 1, i + opts.contextLines);
      for (let k = lo; k <= hi; k++) keep[k] = true;
    }
  }

  const out: string[] = [];
  let i = 0;
  let changed = false;
  while (i < lines.length) {
    if (keep[i]) {
      out.push(lines[i] ?? '');
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !keep[j]) j++;
    const runLen = j - i;
    if (runLen >= opts.minRun) {
      const elided = lines.slice(i, j).join('\n');
      const hint = retrievalHint(onElide, 'log_error_extract', elided);
      out.push(`... [${runLen} lines elided by Sentinel${hint}] ...`);
      changed = true;
    } else {
      for (let k = i; k < j; k++) out.push(lines[k] ?? '');
    }
    i = j;
  }
  return changed ? out.join('\n') : text;
}

export interface TruncateOpts {
  /** Only truncate when the line count exceeds this. */
  triggerLines: number;
  /** Lines kept from the start. */
  headLines: number;
  /** Lines kept from the end. */
  tailLines: number;
}

/**
 * Head/tail truncation of very long output. Keeps the first `headLines` and
 * last `tailLines` lines with a deterministic elision marker between them.
 * Idempotent by construction: callers MUST choose thresholds where
 * `headLines + tailLines + 1 <= triggerLines`, so a once-truncated result
 * (which has exactly that many lines) never re-triggers.
 */
export function truncateLog(text: string, opts: TruncateOpts, onElide?: OnElide): string {
  const lines = text.split('\n');
  if (lines.length <= opts.triggerLines) return text;
  const head = lines.slice(0, opts.headLines);
  const tail = lines.slice(lines.length - opts.tailLines);
  const elidedLines = lines.slice(opts.headLines, lines.length - opts.tailLines);
  const hint = retrievalHint(onElide, 'log_truncate', elidedLines.join('\n'));
  const marker = `... [${elidedLines.length} lines elided by Sentinel${hint}] ...`;
  return [...head, marker, ...tail].join('\n');
}
