/**
 * Base input $/MTok rate for a given Claude model.
 *
 * Only the base input rate is stored here; the cache-ttl writer applies the
 * published multipliers at write-time:
 *   5-minute cache write = base * 1.25
 *   1-hour cache write   = base * 2.0
 *   cache read           = base * 0.1
 *
 * Matching is prefix-based so family variants (claude-sonnet-4-6,
 * claude-sonnet-4-5, claude-sonnet-4-6-20250514, ...) all resolve to the same
 * row without a per-release update.
 */

const FALLBACK_BASE_PER_MILLION = 3;

const PRICE_TABLE: ReadonlyArray<readonly [string, number]> = [
  ['claude-opus-4', 15],
  ['claude-opus-3', 15],
  ['claude-sonnet-4', 3],
  ['claude-sonnet-3', 3],
  ['claude-haiku-4', 1],
  ['claude-haiku-3', 0.8],
];

export function getBaseInputPricePerMillion(model: string): number {
  const m = model.toLowerCase();
  for (const [prefix, price] of PRICE_TABLE) {
    if (m.startsWith(prefix)) return price;
  }
  return FALLBACK_BASE_PER_MILLION;
}

export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;
export const CACHE_READ_MULTIPLIER = 0.1;

export interface CacheCosts {
  cost5mWrite: number;
  cost1hWrite: number;
  costRead: number;
}

export function computeCacheCosts(
  model: string,
  tokens5m: number,
  tokens1h: number,
  tokensRead: number,
): CacheCosts {
  const base = getBaseInputPricePerMillion(model);
  return {
    cost5mWrite: (tokens5m / 1_000_000) * base * CACHE_WRITE_5M_MULTIPLIER,
    cost1hWrite: (tokens1h / 1_000_000) * base * CACHE_WRITE_1H_MULTIPLIER,
    costRead: (tokensRead / 1_000_000) * base * CACHE_READ_MULTIPLIER,
  };
}
