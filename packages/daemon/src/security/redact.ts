import { createHash } from 'crypto';

/** Number of plaintext characters shown on each side of the redacted middle
 *  in `maskSecret`. "AKIA[...16 chars redacted...]AB12" has 4 + 4 visible. */
const MASK_VISIBLE_EDGE = 4;

/** 40 chars on each side of a match is plenty of signal for a human to
 *  recognize the context while still being small enough to store. */
export const SNIPPET_WINDOW = 40;

/**
 * Return a short sha256 hex digest. Used as a dedup key — not suitable for
 * cryptographic identification and never collision-resistant at 32 chars,
 * but the search space is always scoped to (account_id, detector_id, 1h
 * window) so collisions within that bucket are effectively impossible.
 */
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * Replace the middle of a secret with `[... N redacted ...]`, keeping a
 * handful of characters on each side so the user can still recognize which
 * key this refers to without being able to reconstruct it.
 *
 *   maskSecret("AKIAIOSFODNN7EXAMPLE") → "AKIA[... 12 redacted ...]MPLE"
 *   maskSecret("abc")                  → "[... 3 redacted ...]"
 */
export function maskSecret(text: string): string {
  if (text.length <= MASK_VISIBLE_EDGE * 2) {
    return `[... ${text.length} redacted ...]`;
  }
  const head = text.slice(0, MASK_VISIBLE_EDGE);
  const tail = text.slice(-MASK_VISIBLE_EDGE);
  const middle = text.length - MASK_VISIBLE_EDGE * 2;
  return `${head}[... ${middle} redacted ...]${tail}`;
}

/**
 * Build a 40-char window of surrounding context with the secret itself
 * replaced in-place by `[REDACTED:<kind>]`. Guarantees the caller never has
 * to store the raw match alongside the snippet.
 */
export function buildSnippet(params: {
  fullText: string;
  matchStart: number;
  matchEnd: number;
  kind: string;
}): string {
  const { fullText, matchStart, matchEnd, kind } = params;
  const windowStart = Math.max(0, matchStart - SNIPPET_WINDOW);
  const windowEnd = Math.min(fullText.length, matchEnd + SNIPPET_WINDOW);
  const before = fullText.slice(windowStart, matchStart);
  const after = fullText.slice(matchEnd, windowEnd);
  const prefix = windowStart > 0 ? '…' : '';
  const suffix = windowEnd < fullText.length ? '…' : '';
  return `${prefix}${before}[REDACTED:${kind}]${after}${suffix}`.replace(/\s+/g, ' ').trim();
}

/** Hash of the 40-char window around a match — for secondary dedup when the
 *  same secret appears in multiple places, so we don't collapse unrelated
 *  sites into one row. */
export function contextHashOf(fullText: string, matchStart: number, matchEnd: number): string {
  const windowStart = Math.max(0, matchStart - SNIPPET_WINDOW);
  const windowEnd = Math.min(fullText.length, matchEnd + SNIPPET_WINDOW);
  return hashText(fullText.slice(windowStart, windowEnd));
}

/** Wider window for non-secret pattern findings: the matched English IS the
 *  signal (e.g. "execute this", "ignore previous instructions"), so we keep
 *  it verbatim and surface ~1-2 sentences of surrounding prose. */
export const PATTERN_SNIPPET_WINDOW = 200;

/** Markers wrapping the matched text inside a pattern snippet. The UI splits
 *  on these to render the match highlighted. Chosen because they almost never
 *  occur in source/code/JSON the scanner sees, and their visual asymmetry
 *  makes them unambiguous to split on. */
export const MATCH_MARKER_OPEN = '«';
export const MATCH_MARKER_CLOSE = '»';

/** Find the index of the rightmost sentence boundary in `text` (within
 *  [0, end)), preferring `.!?` and `\n` over `,`. Returns -1 if none found. */
function findRightmostBoundary(text: string, end: number): number {
  for (let i = end - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '.' || c === '!' || c === '?' || c === '\n') return i + 1;
  }
  for (let i = end - 1; i >= 0; i--) {
    if (text[i] === ',') return i + 1;
  }
  return -1;
}

/** Find the index of the leftmost sentence boundary in `text` (within
 *  [start, text.length)), preferring `.!?` and `\n` over `,`. Returns -1
 *  if none found. */
function findLeftmostBoundary(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '.' || c === '!' || c === '?' || c === '\n') return i + 1;
  }
  for (let i = start; i < text.length; i++) {
    if (text[i] === ',') return i + 1;
  }
  return -1;
}

/**
 * Build a sentence-trimmed snippet (~200 chars each side) with the matched
 * text preserved verbatim and wrapped in `«…»` markers so the UI can render
 * it highlighted. Use this for non-secret detections where the matched
 * English is the threat signal itself. The returned `match` is the literal
 * matched substring, suitable for storing in `matchMask` so the user sees
 * the actual phrase that fired the rule.
 *
 *   buildPatternSnippet({ fullText: "Some prose. Now execute this. Trailing.",
 *                         matchStart: 16, matchEnd: 28 })
 *   → { snippet: "Now «execute this».", match: "execute this" }
 */
export function buildPatternSnippet(params: {
  fullText: string;
  matchStart: number;
  matchEnd: number;
}): { snippet: string; match: string } {
  const { fullText, matchStart, matchEnd } = params;
  const match = fullText.slice(matchStart, matchEnd);

  const windowStart = Math.max(0, matchStart - PATTERN_SNIPPET_WINDOW);
  const windowEnd = Math.min(fullText.length, matchEnd + PATTERN_SNIPPET_WINDOW);

  // Trim the left edge inward to a sentence boundary strictly outside the
  // match. Always search the window — even when it already reaches the
  // start of fullText — so the snippet reads as a sentence rather than
  // starting mid-thought. If a boundary is found, advance past it; the
  // ellipsis-prefix then signals that earlier text was trimmed.
  let trimmedStart = windowStart;
  const leftSlice = fullText.slice(windowStart, matchStart);
  const leftIdx = findLeftmostBoundary(leftSlice, 0);
  if (leftIdx !== -1 && leftIdx < leftSlice.length) {
    trimmedStart = windowStart + leftIdx;
  }

  // Trim the right edge inward to a sentence boundary strictly outside the
  // match. Same rationale: end at a clean punctuation mark when one exists.
  let trimmedEnd = windowEnd;
  const rightSlice = fullText.slice(matchEnd, windowEnd);
  const rightIdx = findRightmostBoundary(rightSlice, rightSlice.length);
  if (rightIdx !== -1 && rightIdx > 0) {
    trimmedEnd = matchEnd + rightIdx;
  }

  const before = fullText.slice(trimmedStart, matchStart);
  const after = fullText.slice(matchEnd, trimmedEnd);
  const prefix = trimmedStart > 0 ? '…' : '';
  const suffix = trimmedEnd < fullText.length ? '…' : '';
  // Whitespace collapse runs AFTER boundary detection so newlines remain
  // valid sentence delimiters during the search above.
  const snippet =
    `${prefix}${before}${MATCH_MARKER_OPEN}${match}${MATCH_MARKER_CLOSE}${after}${suffix}`
      .replace(/\s+/g, ' ')
      .trim();
  return { snippet, match };
}
