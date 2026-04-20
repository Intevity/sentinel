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
  return `${prefix}${before}[REDACTED:${kind}]${after}${suffix}`
    .replace(/\s+/g, ' ')
    .trim();
}

/** Hash of the 40-char window around a match — for secondary dedup when the
 *  same secret appears in multiple places, so we don't collapse unrelated
 *  sites into one row. */
export function contextHashOf(fullText: string, matchStart: number, matchEnd: number): string {
  const windowStart = Math.max(0, matchStart - SNIPPET_WINDOW);
  const windowEnd = Math.min(fullText.length, matchEnd + SNIPPET_WINDOW);
  return hashText(fullText.slice(windowStart, windowEnd));
}
