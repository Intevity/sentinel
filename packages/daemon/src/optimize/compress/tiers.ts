/**
 * Tier composition: maps a CompressionLevel to an ordered set of rules and
 * thresholds, and applies them to a single tool_result text payload while
 * tracking per-rule byte savings.
 *
 * Tier contents (each tier is a superset of the previous):
 *   conservative — ansi_strip, collapse_blank_lines, json_minify. Lossless-ish.
 *   moderate     — + collapse_duplicate_lines, stack_trace_collapse, log_truncate
 *                  (gentle thresholds). Safe lossy.
 *   aggressive   — + json_tabular and lower truncation thresholds. Max lossy.
 *
 * The tabular fold is aggressive-only because it restructures the data the
 * model sees; the truncations only differ by threshold across moderate and
 * aggressive.
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
    intraBodyFold: false,
  },
  moderate: {
    collapseDuplicates: true,
    stackKeep: 8,
    errorExtract: { triggerLines: 200, headLines: 3, tailLines: 5, contextLines: 2, minRun: 6 },
    truncate: { triggerLines: 300, headLines: 120, tailLines: 120 },
    tabular: false,
    sample: null,
    intraBodyFold: true,
  },
  aggressive: {
    collapseDuplicates: true,
    stackKeep: 4,
    errorExtract: { triggerLines: 80, headLines: 2, tailLines: 3, contextLines: 1, minRun: 4 },
    truncate: { triggerLines: 120, headLines: 40, tailLines: 40 },
    tabular: true,
    sample: { minRows: 30, headN: 3, tailN: 3, sigma: 2 },
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
  cur = apply('ansi_strip', cur, stripAnsi(cur));
  cur = apply('collapse_blank_lines', cur, collapseBlankLines(cur));
  if (th.collapseDuplicates) {
    cur = apply('collapse_duplicate_lines', cur, collapseDuplicateLines(cur));
  }
  if (th.stackKeep !== null) {
    cur = apply('stack_trace_collapse', cur, collapseStackTraces(cur, th.stackKeep, onElide));
  }
  if (th.errorExtract !== null) {
    cur = apply('log_error_extract', cur, extractLogErrors(cur, th.errorExtract, onElide));
  }
  if (th.truncate !== null) {
    cur = apply('log_truncate', cur, truncateLog(cur, th.truncate, onElide));
  }
  return { text: cur, perRule };
}
