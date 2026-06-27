/**
 * Shared number / currency / percent formatting for the UI.
 *
 * Currency and plain integer counts render with US thousands separators
 * (`$15,824.62`, `10,000`) so large values stay readable across the Optimize
 * and Metrics tabs. Compact magnitude helpers for tokens and bytes (`1.29B`,
 * `2.4MB`) deliberately live elsewhere (`lib/optimizeUnits.ts`,
 * `lib/opportunityList.ts`): they trade exactness for a glanceable size and
 * are not duplicated here.
 */

const USD_2DP = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INT = new Intl.NumberFormat('en-US');

export interface UsdOptions {
  minFractionDigits?: number;
  maxFractionDigits?: number;
}

/**
 * US dollar amount with a `$` and thousands separators: `$15,824.62`,
 * `-$12.00`, `$0.00`. Two fraction digits by default; pass options to widen
 * (e.g. sub-cent costs that need 4 places). Negative values keep their sign.
 */
export function formatUsd(n: number, opts?: UsdOptions): string {
  if (!opts) return USD_2DP.format(n);
  const min = opts.minFractionDigits ?? 2;
  // Default the ceiling to at least `min` so a caller widening only the floor
  // (e.g. { minFractionDigits: 4 }) can't produce max < min, which throws.
  const max = opts.maxFractionDigits ?? Math.max(2, min);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: min,
    maximumFractionDigits: max,
  }).format(n);
}

/**
 * Integer with thousands separators: `10,000`. Rounds to the nearest integer
 * first so callers can pass floats (e.g. averaged counts) without trailing
 * decimals leaking through.
 */
export function formatInt(n: number): string {
  return INT.format(Math.round(n));
}

/**
 * Percentage with a `%` suffix and a fixed number of decimals (default 0):
 * `48%`, `92.8%`. Takes the already-scaled value (0–100), not a 0–1 ratio.
 */
export function formatPercent(n: number, digits = 0): string {
  return `${n.toFixed(digits)}%`;
}
