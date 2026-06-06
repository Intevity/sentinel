/**
 * Shared cost/tokens rendering helpers for the Optimize tab. The
 * Settings field `optimizeUnits` ('tokens' | 'cost') drives every
 * surface that shows a savings number — header totals, the chart bars,
 * the per-subagent badge, and the opportunity list — so we keep the
 * rule in one place.
 *
 * Token rendering matches the dashboard's existing typography:
 *   - sub-1k → "12 tk" (still useful for the small-Reads case)
 *   - kilo → "1.2K tk"
 *   - mega → "3.40M tk"
 *
 * Negative tokens read with the same "regression" framing as negative
 * dollars — see savingsColorClass in opportunityList.ts.
 */

export type SavingsUnits = 'tokens' | 'cost';

const TOKEN_NOISE_FLOOR = 1; // < 1 input token of difference is noise

/** Format an input-token savings number. Mirrors `formatUsd`'s sign
 *  semantics (clamps near-zero to "0 tk" without a leading "-"). */
export function formatTokens(n: number): string {
  if (Math.abs(n) < TOKEN_NOISE_FLOOR) return '0 tk';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs < 1000) return `${sign}${Math.round(abs)} tk`;
  if (abs < 1_000_000) return `${sign}${(abs / 1000).toFixed(1)}K tk`;
  return `${sign}${(abs / 1_000_000).toFixed(2)}M tk`;
}

/** "Ax" label for the effective context-window multiplier of a reduction:
 *  content that would have cost `denomTokens` fits in `denomTokens -
 *  savedTokens`, so the same window holds denom/(denom - saved) times as
 *  much (67% saved ≈ 3.03x). At most 2 decimals, trailing zeros trimmed
 *  ("3x", "2.5x", "3.03x"). Returns null when there is no compressible
 *  content (denom 0) or the reduction is total (remainder 0), where a
 *  multiplier is undefined. */
export function windowMultiplierLabel(savedTokens: number, denomTokens: number): string | null {
  if (denomTokens <= 0) return null;
  const remaining = denomTokens - savedTokens;
  if (remaining <= 0) return null;
  const rounded = Math.round((denomTokens / remaining) * 100) / 100;
  return `${rounded}x`;
}

/** Color class for a token savings number. Same emerald/red/neutral
 *  rule as the cost view. */
export function tokensColorClass(n: number): string {
  if (n >= TOKEN_NOISE_FLOOR) return 'text-emerald-700 dark:text-emerald-300';
  if (n <= -TOKEN_NOISE_FLOOR) return 'text-red-600 dark:text-red-400';
  return 'text-foreground/70';
}
