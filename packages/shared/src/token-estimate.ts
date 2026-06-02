/**
 * Single source of truth for byte -> token estimation across the whole app.
 *
 * Anthropic's tokenizer averages ~3.5 bytes per input token across a mix of
 * prose (~3.6) and code (~3). This used to be split between two rulers: the
 * compression path used `ceil(bytes / 4)` while the subagent savings model
 * used `bytes / 3.5`. Because the Optimize header now SUMS both sources into
 * one total, that drift made the combined number internally inconsistent.
 * They are unified here at 3.5.
 *
 * Uses `Math.round` (not ceil/floor) so the before/after estimates are
 * symmetric: `estTokensSaved = estimateTokensFromBytes(in) -
 * estimateTokensFromBytes(out)` stays unbiased.
 */

/** Average bytes per input token (prose + code blended). */
export const BYTES_PER_TOKEN = 3.5;

/** Deterministic token estimate from a UTF-8 byte count. */
export function estimateTokensFromBytes(bytes: number): number {
  return Math.round(bytes / BYTES_PER_TOKEN);
}
