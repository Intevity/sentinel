/**
 * Tier composition: maps a CompressionLevel to an ordered set of rules and
 * thresholds, and applies them to a single tool_result text payload while
 * tracking per-rule byte savings.
 *
 * Tier contents (each tier is a superset of the previous):
 *   conservative — ansi_strip, collapse_blank_lines, json_minify. Lossless-ish.
 *   moderate     — + collapse_duplicate_lines, stack_trace_collapse,
 *                  log_error_extract, log_truncate (gentle thresholds), the
 *                  lossless json_tabular fold, gentle json_sample, and the
 *                  content-type rules: diff_trim, search_extract,
 *                  log_near_dup_fold, html_extract. Safe lossy (reversible).
 *   aggressive   — the same rule set with the lowest thresholds and tightest
 *                  caps. Max lossy.
 *
 * Non-JSON payloads are routed by content type before the generic log chain:
 * a unified diff or grep/Glob output gets its dedicated trimmer and SKIPS the
 * log rules (diff body lines starting with `at `/`error` must not be misread
 * as log noise); HTML is extracted to text and then falls through to the
 * generic chain (the extraction yields prose). JSON payloads are untouched by
 * the text path, exactly as before.
 *
 * Rule-set changes between versions recompute the compressed bytes for the
 * SAME original tool_result, so the first request after an upgrade rebuilds
 * the Anthropic cache prefix once for in-flight conversations. That one-time
 * cost is accepted (precedent: the commit that introduced sampling); within a
 * version every rule is deterministic, so replayed turns stay byte-stable.
 */

import type { CompressionLevel, RuleId, PerRuleStat } from './types.js';
import { byteLen } from './types.js';
import {
  stripAnsi,
  collapseBlankLines,
  collapseDuplicateLines,
  collapseStackTraces,
  extractLogErrors,
  truncateLog,
  type TruncateOpts,
  type ErrorExtractOpts,
  type OnElide,
} from './text-rules.js';
import {
  tryParseJson,
  minifyJsonWhitespace,
  tabularDedup,
  sampleJsonArray,
  type SampleOpts,
} from './json-rules.js';
import { isUnifiedDiff, trimUnifiedDiff, type DiffTrimOpts } from './diff-rules.js';
import { isSearchOutput, extractSearchMatches, type SearchExtractOpts } from './search-rules.js';
import { foldNearDuplicateLines, type NearDupOpts } from './log-fold-rules.js';
import { isHtml, extractHtmlText } from './html-rules.js';

interface Thresholds {
  collapseDuplicates: boolean;
  /** Frames kept at each end of a long stack run; `null` disables. */
  stackKeep: number | null;
  /** Format-aware log error extraction; `null` disables. Runs before truncate
   *  so truncate only sees the already-trimmed log. */
  errorExtract: ErrorExtractOpts | null;
  /** Log truncation thresholds; `null` disables. Invariant enforced by the
   *  truncate rule: headLines + tailLines + 1 <= triggerLines. */
  truncate: TruncateOpts | null;
  /** Whether to tabular-fold homogeneous JSON arrays. */
  tabular: boolean;
  /** Large-array sampling (lossy, reversible); `null` disables. Takes priority
   *  over the lossless tabular fold when both could apply. */
  sample: SampleOpts | null;
  /** Unified-diff trimming (lossy, reversible); `null` disables. Routed: a
   *  detected diff skips the generic log chain. */
  diff: DiffTrimOpts | null;
  /** grep/Glob output capping (lossy, reversible); `null` disables. Routed:
   *  detected search output skips the generic log chain. */
  search: SearchExtractOpts | null;
  /** Near-duplicate log-line folding (lossy, reversible); `null` disables.
   *  Runs in the generic chain, before stack/error/truncate. */
  nearDup: NearDupOpts | null;
  /** HTML-to-text extraction (lossy, reversible). The extracted prose falls
   *  through to the generic chain. */
  html: boolean;
  /** Whether to fold tool_result blocks that are byte-identical to an earlier
   *  block in the same request body. Body-level, applied by compress-body.ts. */
  intraBodyFold: boolean;
}

const THRESHOLDS: Record<CompressionLevel, Thresholds> = {
  conservative: {
    collapseDuplicates: false,
    stackKeep: null,
    errorExtract: null,
    truncate: null,
    tabular: false,
    sample: null,
    diff: null,
    search: null,
    nearDup: null,
    html: false,
    intraBodyFold: false,
  },
  moderate: {
    collapseDuplicates: true,
    stackKeep: 8,
    errorExtract: { triggerLines: 200, headLines: 3, tailLines: 5, contextLines: 2, minRun: 6 },
    truncate: { triggerLines: 300, headLines: 120, tailLines: 120 },
    // Lossless structural fold: safe at moderate (sampling still pre-empts it
    // on very large arrays, where the gentle thresholds below take over).
    tabular: true,
    // Gentle sampling: only genuinely large arrays (120+) are sampled, keeping
    // 8 boundary items per end, and only extreme (3-sigma) outliers flag.
    sample: { minRows: 120, headN: 8, tailN: 8, sigma: 3 },
    diff: { maxFiles: 20, maxHunks: 10, contextLines: 3 },
    search: { triggerLines: 60, maxFiles: 30, maxPerFile: 20, headPaths: 40, tailPaths: 10 },
    nearDup: { minRun: 5 },
    html: true,
    intraBodyFold: true,
  },
  aggressive: {
    collapseDuplicates: true,
    stackKeep: 4,
    errorExtract: { triggerLines: 80, headLines: 2, tailLines: 3, contextLines: 1, minRun: 4 },
    truncate: { triggerLines: 120, headLines: 40, tailLines: 40 },
    tabular: true,
    sample: { minRows: 30, headN: 3, tailN: 3, sigma: 2 },
    diff: { maxFiles: 8, maxHunks: 4, contextLines: 1 },
    search: { triggerLines: 30, maxFiles: 12, maxPerFile: 6, headPaths: 20, tailPaths: 5 },
    nearDup: { minRun: 3 },
    html: true,
    intraBodyFold: true,
  },
};

/** Whether identical-tool_result folding runs at this level. Body-level, so it
 *  lives in compress-body.ts, but the per-tier policy stays centralized here. */
export function intraBodyFoldEnabled(level: CompressionLevel): boolean {
  return THRESHOLDS[level].intraBodyFold;
}

export interface CompressTextResult {
  text: string;
  perRule: Partial<Record<RuleId, PerRuleStat>>;
}

/**
 * Compress one tool_result text payload at the given level. JSON payloads
 * (object/array) take the JSON path (tabular + minify); everything else takes
 * the text path (ansi/blank/duplicate/stack/truncate). Records per-rule byte
 * savings for the analytics breakdown.
 *
 * Deterministic and idempotent: re-running on the output yields the output.
 */
export function compressToolResultText(
  text: string,
  level: CompressionLevel,
  onElide?: OnElide,
): CompressTextResult {
  const th = THRESHOLDS[level];
  const perRule: Partial<Record<RuleId, PerRuleStat>> = {};

  const apply = (id: RuleId, before: string, after: string): string => {
    if (after !== before) {
      const saved = byteLen(before) - byteLen(after);
      const cur = perRule[id] ?? { bytesSaved: 0, hits: 0 };
      cur.bytesSaved += saved;
      cur.hits += 1;
      perRule[id] = cur;
    }
    return after;
  };

  const parsed = tryParseJson(text);
  if (parsed.ok) {
    let cur = text;
    if (Array.isArray(parsed.value)) {
      // Sampling (lossy, reversible) takes priority; the lossless tabular fold
      // only runs when sampling didn't fire, so they never both rewrite the
      // same array (tabular would otherwise re-expand the dropped items).
      const sampled = th.sample ? sampleJsonArray(cur, parsed.value, th.sample, onElide) : cur;
      if (sampled !== cur) {
        cur = apply('json_sample', cur, sampled);
      } else if (th.tabular) {
        cur = apply('json_tabular', cur, tabularDedup(cur, parsed.value));
      }
    }
    cur = apply('json_minify', cur, minifyJsonWhitespace(cur));
    return { text: cur, perRule };
  }

  let cur = text;
  // ANSI stripping first: it is content-neutral and cleans the text for the
  // content-type detectors below (a color-coded diff still detects as a diff).
  cur = apply('ansi_strip', cur, stripAnsi(cur));

  // Content-type routing. Detection order is deliberate: diff before search
  // (the diff test is stricter, and hunk headers contain `path:line` lookalikes
  // a search detector could claim); search before HTML (shape test is stricter
  // than tag density). A routed diff or match list SKIPS the generic log chain
  // (its `+`/`-`/`at ` lines must not be misread as log noise) and keeps only
  // the shape-agnostic truncate as a final safety net. HTML extraction yields
  // prose, so it falls through to the generic chain like any other text.
  let routed = false;
  if (th.diff !== null && isUnifiedDiff(cur)) {
    cur = apply('diff_trim', cur, trimUnifiedDiff(cur, th.diff, onElide));
    routed = true;
  } else if (th.search !== null && isSearchOutput(cur)) {
    cur = apply('search_extract', cur, extractSearchMatches(cur, th.search, onElide));
    routed = true;
  } else if (th.html && isHtml(cur)) {
    cur = apply('html_extract', cur, extractHtmlText(cur, onElide));
  }

  cur = apply('collapse_blank_lines', cur, collapseBlankLines(cur));
  if (!routed) {
    if (th.collapseDuplicates) {
      cur = apply('collapse_duplicate_lines', cur, collapseDuplicateLines(cur));
    }
    if (th.nearDup !== null) {
      cur = apply('log_near_dup_fold', cur, foldNearDuplicateLines(cur, th.nearDup, onElide));
    }
    if (th.stackKeep !== null) {
      cur = apply('stack_trace_collapse', cur, collapseStackTraces(cur, th.stackKeep, onElide));
    }
    if (th.errorExtract !== null) {
      cur = apply('log_error_extract', cur, extractLogErrors(cur, th.errorExtract, onElide));
    }
  }
  if (th.truncate !== null) {
    cur = apply('log_truncate', cur, truncateLog(cur, th.truncate, onElide));
  }
  return { text: cur, perRule };
}
