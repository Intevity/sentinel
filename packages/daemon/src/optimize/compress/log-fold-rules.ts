/**
 * Near-duplicate log-line folding (rule id `log_near_dup_fold`).
 *
 * Modeled on headroom's LogCompressor dedup: normalize the volatile fields of a
 * log line into a stable TEMPLATE (timestamps -> <TS>, ids -> <UUID>, addresses
 * -> <ADDR>, paths -> <PATH>, numbers -> <N>), then fold maximal runs of
 * ADJACENT lines that share a template down to the first line plus a count
 * marker. This complements {@link collapseDuplicateLines} (byte-identical
 * adjacent only, which runs BEFORE this rule): two lines that differ only by a
 * timestamp or a request id are byte-distinct, so the cheaper rule leaves them
 * alone, but they share a template and fold here.
 *
 * Every function in this module is PURE, DETERMINISTIC, IDEMPOTENT, and
 * byte-stable: no clock/random/locale/I/O, no cross-call state. See `types.ts`
 * for why that matters (Anthropic prompt-cache prefix stability across replayed
 * turns). When nothing folds, {@link foldNearDuplicateLines} returns the EXACT
 * same string instance so callers' identity checks short-circuit.
 */

import type { RuleId } from './types.js';
import { type OnElide, retrievalHint, LOG_INTERESTING_RE } from './text-rules.js';

const RULE_ID: RuleId = 'log_near_dup_fold';

/** Tier-tunable knobs. `minRun` is the minimum number of adjacent same-template
 *  lines required before a run is folded. Below it, lines pass through verbatim
 *  so a stray pair of similar lines never churns into a marker the net-gain
 *  guard would just revert. */
export interface NearDupOpts {
  minRun: number;
}

// --- normalizeTemplate patterns ----------------------------------------------
// All are global so `.replace` hits every occurrence on a line. Because each is
// used only with `String.prototype.replace` (which resets lastIndex per call),
// the global flag carries no cross-call state.

// 1. ISO-8601 timestamps: 2024-01-02T03:04:05.678Z, 2024-01-02 03:04:05+01:00.
const TS_ISO_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
// 2. Bare wall-clock times: 03:04:05, 3:04:05.678.
const TS_CLOCK_RE = /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g;
// 3. UUIDs (canonical 8-4-4-4-12 hex).
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
// 4a. 0x-prefixed hex addresses, then 4b. bare long lowercase-hex blobs.
const HEX_0X_RE = /\b0x[0-9a-fA-F]+\b/g;
const HEX_BARE_RE = /\b[0-9a-f]{8,}\b/g;
// 5. Absolute filesystem paths: POSIX (/usr/...) or Windows drive (C:\...).
//    Only the captured path token is replaced; the leading boundary char (which
//    may be whitespace, a quote, '(', or '=') is preserved via the $1 backref.
const PATH_RE = /(?:^|[\s"'(=])((?:\/|[A-Za-z]:\\)[^\s"')]+)/g;
// 6. Remaining numbers (ints and decimals).
const NUM_RE = /\d+(?:\.\d+)?/g;

/**
 * Reduce a single log line to a stable template by masking its volatile fields.
 *
 * ORDER MATTERS and is fixed: more-specific patterns run before more-general
 * ones so the general pattern cannot eat a substring the specific one owns.
 *   1. ISO timestamps  (before bare clock + numbers; a full ISO stamp contains
 *      both a clock-shaped substring and many digit runs).
 *   2. bare clock      (before numbers, which would otherwise shred 03:04:05).
 *   3. UUIDs           (before hex; a UUID's segments are hex, and before
 *      numbers, whose digit runs live inside it).
 *   4. hex addresses   (0x form first, then bare long hex; before numbers).
 *   5. absolute paths  (before numbers; paths often embed version digits).
 *   6. numbers         (last; the broadest mask, run only on what survived).
 *
 * Pure string function: same input always yields the same output, no state.
 * Exported so tests can assert templates directly and so adjacent-run grouping
 * in {@link foldNearDuplicateLines} keys on it.
 */
export function normalizeTemplate(line: string): string {
  return line
    .replace(TS_ISO_RE, '<TS>')
    .replace(TS_CLOCK_RE, '<TS>')
    .replace(UUID_RE, '<UUID>')
    .replace(HEX_0X_RE, '<ADDR>')
    .replace(HEX_BARE_RE, '<ADDR>')
    .replace(
      PATH_RE,
      (match, path: string) => match.slice(0, match.length - path.length) + '<PATH>',
    )
    .replace(NUM_RE, '<N>');
}

/** A line is eligible to be folded iff it has non-whitespace content, is NOT an
 *  interesting line (error/warning/failure/etc; see {@link LOG_INTERESTING_RE}),
 *  and does not already carry an elision marker. Keeping interesting lines out
 *  of folds guarantees an ERROR line is never absorbed into an INFO template and
 *  that the later log_error_extract pass still sees every error verbatim. */
function isFoldable(line: string): boolean {
  if (line.trim().length === 0) return false;
  if (line.includes('elided by Sentinel')) return false;
  if (LOG_INTERESTING_RE.test(line)) return false;
  return true;
}

/**
 * Fold maximal runs of ADJACENT near-duplicate log lines.
 *
 * Two lines are near-duplicates when {@link normalizeTemplate} maps them to the
 * same template (so they differ only in volatile fields like timestamps or
 * ids). Each maximal run of length >= `opts.minRun` of adjacent foldable lines
 * with one shared template collapses to: the FIRST line verbatim, followed by a
 * single marker line `... [<N-1> similar lines elided by Sentinel<hint>] ...`.
 * The exact lines 2..N (joined with '\n') are handed to {@link OnElide} so the
 * fold is fully reversible. Shorter runs, interesting lines, and blanks pass
 * through verbatim.
 *
 * Deterministic (pure function of the text + opts). Idempotent for two reasons:
 * the leading marker guard returns already-folded text unchanged, AND even
 * absent the guard the result cannot re-fold: the inserted marker line is not
 * foldable (it carries the phrase 'elided by Sentinel') so it breaks
 * adjacency, and the lone surviving representative line cannot by itself form a
 * run of length >= minRun. Returns the EXACT input instance when nothing folds.
 */
export function foldNearDuplicateLines(text: string, opts: NearDupOpts, onElide?: OnElide): string {
  // Idempotency + non-interference: never re-process text that already carries
  // an elision marker (ours, or one from an earlier rule in the same pass).
  if (text.includes('elided by Sentinel')) return text;

  const lines = text.split('\n');
  const out: string[] = [];
  let changed = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!isFoldable(line)) {
      out.push(line);
      i++;
      continue;
    }
    // Extend a run of adjacent foldable lines that share this line's template.
    const template = normalizeTemplate(line);
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j] ?? '';
      if (!isFoldable(next) || normalizeTemplate(next) !== template) break;
      j++;
    }
    const runLen = j - i;
    if (runLen >= opts.minRun) {
      out.push(line); // first line verbatim
      const elided = lines.slice(i + 1, j).join('\n');
      const hint = retrievalHint(onElide, RULE_ID, elided);
      out.push(`... [${runLen - 1} similar lines elided by Sentinel${hint}] ...`);
      changed = true;
    } else {
      for (let k = i; k < j; k++) out.push(lines[k] ?? '');
    }
    i = j;
  }
  return changed ? out.join('\n') : text;
}
