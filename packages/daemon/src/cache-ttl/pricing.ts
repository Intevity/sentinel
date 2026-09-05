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

/** `[prefix, input $/MTok, output $/MTok]`. Output rates are listed explicitly
 *  rather than derived from a multiplier: the current Claude family happens to
 *  price output at 5× input, but that is a coincidence of the price list, not a
 *  rule, and a future model breaking it would silently mis-bill every row.
 *
 *  **Order is load-bearing.** Matching is first-hit prefix, so specific entries
 *  must precede general ones. `claude-opus-4-6` and later are $5/$25, while
 *  `claude-opus-4-0`/`4-1` remain $15/$75 — a bare `claude-opus-4` row placed
 *  first silently priced every 4.6+ request at 3× its real rate.
 *
 *  Sonnet 5 carries a promotional $2/$10 rate through 2026-08-31. The standard
 *  $3/$15 is used here deliberately: a date-conditional rate in a pure pricing
 *  function is a cliff that breaks silently when it passes, and over-reporting
 *  during a promo is the safer error. */
const PRICE_TABLE: ReadonlyArray<readonly [string, number, number]> = [
  ['claude-fable-5', 10, 50],
  ['claude-mythos-5', 10, 50],
  ['claude-opus-5', 5, 25],
  ['claude-opus-4-8', 5, 25],
  ['claude-opus-4-7', 5, 25],
  ['claude-opus-4-6', 5, 25],
  ['claude-opus-4', 15, 75],
  ['claude-opus-3', 15, 75],
  ['claude-sonnet-5', 3, 15],
  ['claude-sonnet-4', 3, 15],
  ['claude-sonnet-3', 3, 15],
  ['claude-haiku-4', 1, 5],
  ['claude-haiku-3', 0.8, 4],
];

export function getBaseInputPricePerMillion(model: string): number {
  const m = model.toLowerCase();
  for (const [prefix, price] of PRICE_TABLE) {
    if (m.startsWith(prefix)) return price;
  }
  return FALLBACK_BASE_PER_MILLION;
}

export interface ModelPrices {
  inputPerMillion: number;
  outputPerMillion: number;
}

/**
 * Input and output rates for a model, or `null` when the model is not in the
 * table.
 *
 * Deliberately does NOT fall back the way {@link getBaseInputPricePerMillion}
 * does. Cache-TTL uses the fallback to keep a relative comparison meaningful,
 * but a whole-request cost is an absolute figure the user reads as money — a
 * guessed rate for an unrecognized model is worse than an honest blank, so
 * callers record the tokens and leave cost null.
 */
export function getModelPrices(model: string | null): ModelPrices | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const [prefix, input, output] of PRICE_TABLE) {
    if (m.startsWith(prefix)) return { inputPerMillion: input, outputPerMillion: output };
  }
  return null;
}

/**
 * Total $ for one request: uncached input, cache writes at their tier
 * multipliers, cache reads at 0.1×, and output. Returns null for an unpriced
 * model — see {@link getModelPrices}.
 */
export function computeRequestCost(
  model: string | null,
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheCreate5m: number;
    cacheCreate1h: number;
    cacheRead: number;
  },
): number | null {
  const prices = getModelPrices(model);
  if (!prices) return null;
  const inM = prices.inputPerMillion / 1_000_000;
  return (
    tokens.inputTokens * inM +
    tokens.cacheCreate5m * inM * CACHE_WRITE_5M_MULTIPLIER +
    tokens.cacheCreate1h * inM * CACHE_WRITE_1H_MULTIPLIER +
    tokens.cacheRead * inM * CACHE_READ_MULTIPLIER +
    (tokens.outputTokens * prices.outputPerMillion) / 1_000_000
  );
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
