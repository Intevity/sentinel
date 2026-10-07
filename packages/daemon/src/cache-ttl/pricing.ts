/**
 * The single first-party Claude price table. Every dollar figure the daemon
 * computes (request cost, cache-TTL cost, Optimize savings, Context savings,
 * compression savings) reads its rates from here; nothing else may hold a
 * model price.
 *
 * Each row stores input, output and cache-read $/MTok explicitly. Cache
 * writes are derived from input at the published tier multipliers:
 *   5-minute cache write = input * 1.25
 *   1-hour cache write   = input * 2.0
 *
 * Cache reads are NOT a flat multiple of input: Fable 5.1 / Mythos 5.1 read at
 * 0.025x, Opus 5.5 at 0.05x, Fable 5 / Mythos 5 at 0.1x, and Claude 3 Haiku at
 * 0.12x, so the read rate is a per-model column rather than a multiplier.
 *
 * Model ids arrive in many shapes (proxy response bodies, OTel attributes,
 * opencode, Bedrock and Vertex ids); {@link normalizeModelId} folds them onto
 * the `claude-<family>-<version>` form the table is keyed by.
 */

export interface ModelPrices {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
}

/** `[key, input, output, cacheRead]`, all $/MTok, first-party list prices as
 *  of 2026-09-25.
 *
 *  Keys match on a version boundary, not a bare prefix (see
 *  {@link lookupPrices}), so row order does not matter: `claude-opus-5` does
 *  not swallow `claude-opus-5-5`, and `claude-opus-4` (Opus 4.0's undated
 *  alias) does not swallow `claude-opus-4-5`. A dated id such as
 *  `claude-opus-5-20260101` still resolves to its family row. */
const PRICE_TABLE: ReadonlyArray<readonly [string, number, number, number]> = [
  // Fable / Mythos
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1],
  ['claude-mythos-5', 10, 50, 1],
  ['claude-mythos-preview', 10, 50, 1],
  // Opus
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5],
  ['claude-opus-4-8', 5, 25, 0.5],
  ['claude-opus-4-7', 5, 25, 0.5],
  ['claude-opus-4-6', 5, 25, 0.5],
  ['claude-opus-4-5', 5, 25, 0.5],
  ['claude-opus-4-1', 15, 75, 1.5],
  ['claude-opus-4-0', 15, 75, 1.5],
  ['claude-opus-4', 15, 75, 1.5],
  ['claude-opus-3', 15, 75, 1.5],
  // Sonnet
  ['claude-sonnet-5-5', 2, 10, 0.2],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4-6', 3, 15, 0.3],
  ['claude-sonnet-4-5', 3, 15, 0.3],
  ['claude-sonnet-4-0', 3, 15, 0.3],
  ['claude-sonnet-4', 3, 15, 0.3],
  ['claude-sonnet-3-7', 3, 15, 0.3],
  ['claude-sonnet-3-5', 3, 15, 0.3],
  // Haiku
  ['claude-haiku-4-5', 1, 5, 0.1],
  ['claude-haiku-3-5', 0.8, 4, 0.08],
  ['claude-haiku-3', 0.25, 1.25, 0.03],
];

const PRICES_BY_KEY: ReadonlyMap<string, ModelPrices> = new Map(
  PRICE_TABLE.map(([key, input, output, cacheRead]) => [
    key,
    { inputPerMillion: input, outputPerMillion: output, cacheReadPerMillion: cacheRead },
  ]),
);

/** Rates used where a relative comparison needs *some* number for an
 *  unrecognized model (cache-TTL, Optimize, Context). Sonnet-tier. Never used
 *  for a whole-request cost, which stays null instead. */
const FALLBACK_PRICES: ModelPrices = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  cacheReadPerMillion: 0.3,
};

/**
 * Fold a model id onto the `claude-<family>-<version>[-<suffix>]` shape the
 * table is keyed by:
 *   - case and surrounding whitespace are ignored
 *   - a bracketed context tag (`claude-opus-4-7[1m]`, as Claude Code reports
 *     it over OTel) is dropped
 *   - a provider path (`anthropic/claude-sonnet-4-5`), a Bedrock prefix
 *     (`anthropic.`, `us.anthropic.`, an inference-profile ARN) and a Bedrock
 *     revision suffix (`-v1:0`) are dropped
 *   - a Vertex `@<date>` suffix becomes a `-<date>` suffix
 *   - a dotted version (`claude-opus-4.5`) becomes dashed
 *   - a Claude 3-era id (`claude-3-5-sonnet-20241022`) is rewritten family
 *     first (`claude-sonnet-3-5-20241022`)
 */
export function normalizeModelId(model: string): string {
  let m = model.trim().toLowerCase();
  m = m.replace(/\[[^\]]*\]$/, '');
  m = m.slice(m.lastIndexOf('/') + 1);
  const bedrock = m.indexOf('anthropic.claude-');
  if (bedrock >= 0) m = m.slice(bedrock + 'anthropic.'.length);
  m = m.replace(/-v\d+(:\d+)?$/, '').replace(/:\d+$/, '');
  m = m.replace('@', '-');
  m = m.replace(/(\d)\.(\d)/g, '$1-$2');
  m = m.replace(/^claude-(\d+(?:-\d)?)-(opus|sonnet|haiku)(?=-|$)/, 'claude-$2-$1');
  return m;
}

/** A segment after a table key that is a further minor version (`-5` in
 *  `claude-opus-5-5`) rather than a date, `latest` or other tag. */
const MINOR_VERSION_SEGMENT = /^-\d{1,2}(?:-|$)/;

function lookupPrices(model: string): ModelPrices | null {
  const m = normalizeModelId(model);
  for (const [key, prices] of PRICES_BY_KEY) {
    if (m === key) return prices;
    if (m.startsWith(`${key}-`) && !MINOR_VERSION_SEGMENT.test(m.slice(key.length))) {
      return prices;
    }
  }
  return null;
}

/**
 * Input, output and cache-read rates for a model, or `null` when the model is
 * not in the table.
 *
 * Deliberately does NOT fall back the way {@link getBaseInputPricePerMillion}
 * does. Cache-TTL uses the fallback to keep a relative comparison meaningful,
 * but a whole-request cost is an absolute figure the user reads as money — a
 * guessed rate for an unrecognized model is worse than an honest blank, so
 * callers record the tokens and leave cost null.
 */
export function getModelPrices(model: string | null): ModelPrices | null {
  if (!model) return null;
  return lookupPrices(model);
}

/** Base input $/MTok, falling back to Sonnet-tier for an unknown model. */
export function getBaseInputPricePerMillion(model: string): number {
  return (lookupPrices(model) ?? FALLBACK_PRICES).inputPerMillion;
}

/** Cache-read $/MTok, falling back to Sonnet-tier for an unknown model. */
export function getCacheReadPricePerMillion(model: string): number {
  return (lookupPrices(model) ?? FALLBACK_PRICES).cacheReadPerMillion;
}

/**
 * Total $ for one request: uncached input, cache writes at their tier
 * multipliers, cache reads at the model's own read rate, and output. Returns
 * null for an unpriced model — see {@link getModelPrices}.
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
    (tokens.cacheRead * prices.cacheReadPerMillion) / 1_000_000 +
    (tokens.outputTokens * prices.outputPerMillion) / 1_000_000
  );
}

export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

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
  const prices = lookupPrices(model) ?? FALLBACK_PRICES;
  const base = prices.inputPerMillion;
  return {
    cost5mWrite: (tokens5m / 1_000_000) * base * CACHE_WRITE_5M_MULTIPLIER,
    cost1hWrite: (tokens1h / 1_000_000) * base * CACHE_WRITE_1H_MULTIPLIER,
    costRead: (tokensRead / 1_000_000) * prices.cacheReadPerMillion,
  };
}
