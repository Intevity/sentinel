import { describe, expect, it } from 'vitest';
import {
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  computeCacheCosts,
  computeRequestCost,
  getBaseInputPricePerMillion,
  getCacheReadPricePerMillion,
  getModelPrices,
  normalizeModelId,
} from './pricing.js';

/** [model id, input, output, cache read], first-party $/MTok as of 2026-09-25. */
const PRICED: ReadonlyArray<readonly [string, number, number, number]> = [
  // Fable / Mythos 5.1: cache read is 0.025x, not 0.1x.
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1],
  ['claude-mythos-5', 10, 50, 1],
  ['claude-mythos-preview', 10, 50, 1],
  // Opus
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-5', 5, 25, 0.5],
  ['claude-opus-5-20260101', 5, 25, 0.5],
  ['claude-opus-4-8', 5, 25, 0.5],
  ['claude-opus-4-7', 5, 25, 0.5],
  ['claude-opus-4-6', 5, 25, 0.5],
  ['claude-opus-4-5', 5, 25, 0.5],
  ['claude-opus-4-5-20251101', 5, 25, 0.5],
  ['claude-opus-4-1', 15, 75, 1.5],
  ['claude-opus-4-1-20250805', 15, 75, 1.5],
  ['claude-opus-4-0', 15, 75, 1.5],
  ['claude-opus-4-20250514', 15, 75, 1.5],
  ['claude-3-opus-20240229', 15, 75, 1.5],
  ['claude-3-opus-latest', 15, 75, 1.5],
  // Sonnet
  ['claude-sonnet-5-5', 2, 10, 0.2],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet-4-6', 3, 15, 0.3],
  ['claude-sonnet-4-5', 3, 15, 0.3],
  ['claude-sonnet-4-5-20250929', 3, 15, 0.3],
  ['claude-sonnet-4-0', 3, 15, 0.3],
  ['claude-sonnet-4-20250514', 3, 15, 0.3],
  ['claude-3-7-sonnet-20250219', 3, 15, 0.3],
  ['claude-3-7-sonnet-latest', 3, 15, 0.3],
  ['claude-3-5-sonnet-20241022', 3, 15, 0.3],
  ['claude-3-5-sonnet-20240620', 3, 15, 0.3],
  // Haiku
  ['claude-haiku-4-5', 1, 5, 0.1],
  ['claude-haiku-4-5-20251001', 1, 5, 0.1],
  ['claude-3-5-haiku-20241022', 0.8, 4, 0.08],
  ['claude-3-5-haiku-latest', 0.8, 4, 0.08],
  ['claude-3-haiku-20240307', 0.25, 1.25, 0.03],
];

describe('getModelPrices', () => {
  it.each(PRICED)('%s → $%s in / $%s out / $%s cache read', (model, input, output, read) => {
    expect(getModelPrices(model)).toEqual({
      inputPerMillion: input,
      outputPerMillion: output,
      cacheReadPerMillion: read,
    });
    expect(getBaseInputPricePerMillion(model)).toBe(input);
    expect(getCacheReadPricePerMillion(model)).toBe(read);
  });

  it.each([
    // A bare family prefix must not swallow a later minor version.
    ['claude-opus-5-5', 4, 'claude-opus-5 row would give 5'],
    ['claude-sonnet-5-5', 2, 'claude-sonnet-5 row is also 2, but must match its own row'],
    ['claude-opus-4-5', 5, 'claude-opus-4 row would give 15'],
    ['claude-opus-4-6', 5, 'claude-opus-4 row would give 15'],
    ['claude-fable-5-1', 10, 'claude-fable-5 row would read at 1.00'],
    ['claude-haiku-3-5', 0.8, 'claude-haiku-3 row would give 0.25'],
  ])('%s is not captured by a shorter key (%s, %s)', (model, input) => {
    expect(getBaseInputPricePerMillion(model)).toBe(input);
  });

  it('does not price an unknown minor version as its family', () => {
    // An unreleased minor version is an honest blank rather than a guess.
    expect(getModelPrices('claude-opus-5-9')).toBeNull();
    expect(getModelPrices('claude-opus-4-9')).toBeNull();
  });

  it.each([
    ['anthropic.claude-opus-5-5', 4, 0.2],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 3, 0.3],
    ['global.anthropic.claude-fable-5-1-v1:0', 10, 0.25],
    ['anthropic.claude-3-haiku-20240307-v1:0', 0.25, 0.03],
    [
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-1-20250805-v1:0',
      15,
      1.5,
    ],
    ['claude-opus-4-5@20251101', 5, 0.5],
    ['claude-3-5-sonnet-v2@20241022', 3, 0.3],
    ['claude-opus-4-7[1m]', 5, 0.5],
    ['claude-sonnet-4-6[1M]', 3, 0.3],
    ['anthropic/claude-sonnet-5-5', 2, 0.2],
    ['claude-opus-4.5', 5, 0.5],
    ['  Claude-Opus-5-5  ', 4, 0.2],
    ['CLAUDE-OPUS-4-7', 5, 0.5],
  ])('tolerates the provider-shaped id %s', (model, input, read) => {
    expect(getBaseInputPricePerMillion(model)).toBe(input);
    expect(getCacheReadPricePerMillion(model)).toBe(read);
  });

  it('returns null for an unknown model rather than guessing', () => {
    // Unlike getBaseInputPricePerMillion, which falls back so cache-TTL keeps a
    // usable relative comparison. A whole-request cost is read as money.
    expect(getModelPrices('some-future-model')).toBeNull();
    expect(getModelPrices('gpt-4')).toBeNull();
  });

  it('returns null for a null or empty model', () => {
    expect(getModelPrices(null)).toBeNull();
    expect(getModelPrices('')).toBeNull();
  });
});

describe('normalizeModelId', () => {
  it.each([
    ['claude-3-5-sonnet-20241022', 'claude-sonnet-3-5-20241022'],
    ['claude-3-opus-20240229', 'claude-opus-3-20240229'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5-20250929'],
    ['claude-opus-4-5@20251101', 'claude-opus-4-5-20251101'],
    ['claude-opus-4-7[1m]', 'claude-opus-4-7'],
    ['anthropic/claude-opus-4.5', 'claude-opus-4-5'],
  ])('%s → %s', (raw, normalized) => {
    expect(normalizeModelId(raw)).toBe(normalized);
  });
});

describe('fallback rates', () => {
  it('falls back to Sonnet-tier input and read for an unknown model', () => {
    expect(getBaseInputPricePerMillion('gpt-4')).toBe(3);
    expect(getBaseInputPricePerMillion('')).toBe(3);
    expect(getCacheReadPricePerMillion('some-future-model')).toBe(0.3);
  });
});

describe('cache write multipliers', () => {
  it('encodes the published write multipliers', () => {
    expect(CACHE_WRITE_5M_MULTIPLIER).toBe(1.25);
    expect(CACHE_WRITE_1H_MULTIPLIER).toBe(2.0);
  });
});

describe('computeCacheCosts', () => {
  it('writes at multiples of input and reads at the model read rate', () => {
    const { cost5mWrite, cost1hWrite, costRead } = computeCacheCosts(
      'claude-sonnet-4-6',
      1_000_000,
      1_000_000,
      1_000_000,
    );
    expect(cost5mWrite).toBeCloseTo(3.75, 10);
    expect(cost1hWrite).toBeCloseTo(6, 10);
    expect(costRead).toBeCloseTo(0.3, 10);
  });

  it('reads Fable 5.1 at 0.025x of input', () => {
    const { cost5mWrite, cost1hWrite, costRead } = computeCacheCosts(
      'claude-fable-5-1',
      1_000_000,
      1_000_000,
      1_000_000,
    );
    expect(cost5mWrite).toBeCloseTo(12.5, 10);
    expect(cost1hWrite).toBeCloseTo(20, 10);
    expect(costRead).toBeCloseTo(0.25, 10);
  });

  it('scales linearly with token counts', () => {
    const half = computeCacheCosts('claude-opus-4-7', 500_000, 500_000, 500_000);
    const full = computeCacheCosts('claude-opus-4-7', 1_000_000, 1_000_000, 1_000_000);
    expect(half.cost5mWrite * 2).toBeCloseTo(full.cost5mWrite, 10);
    expect(half.cost1hWrite * 2).toBeCloseTo(full.cost1hWrite, 10);
    expect(half.costRead * 2).toBeCloseTo(full.costRead, 10);
  });

  it('returns zeros when no tokens are supplied', () => {
    expect(computeCacheCosts('claude-sonnet-4-6', 0, 0, 0)).toEqual({
      cost5mWrite: 0,
      cost1hWrite: 0,
      costRead: 0,
    });
  });

  it('uses the Sonnet-tier fallback for unknown models', () => {
    const unknown = computeCacheCosts('future-model', 1_000_000, 0, 1_000_000);
    expect(unknown.cost5mWrite).toBeCloseTo(3.75, 10);
    expect(unknown.costRead).toBeCloseTo(0.3, 10);
  });
});

describe('computeRequestCost', () => {
  /** 1M of each token kind, so the cost is the sum of the five $/MTok rates. */
  const ONE_M_EACH = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreate5m: 1_000_000,
    cacheCreate1h: 1_000_000,
    cacheRead: 1_000_000,
  };

  it.each([
    // input + output + 5m write (1.25x in) + 1h write (2x in) + cache read
    ['claude-fable-5-1', 10 + 50 + 12.5 + 20 + 0.25],
    ['claude-mythos-5', 10 + 50 + 12.5 + 20 + 1],
    ['claude-opus-5-5', 4 + 20 + 5 + 8 + 0.2],
    ['claude-opus-5', 5 + 25 + 6.25 + 10 + 0.5],
    ['claude-opus-4-8', 5 + 25 + 6.25 + 10 + 0.5],
    ['claude-opus-4-1', 15 + 75 + 18.75 + 30 + 1.5],
    ['claude-sonnet-5-5', 2 + 10 + 2.5 + 4 + 0.2],
    ['claude-sonnet-4-6', 3 + 15 + 3.75 + 6 + 0.3],
    ['claude-3-5-sonnet-20241022', 3 + 15 + 3.75 + 6 + 0.3],
    ['claude-haiku-4-5', 1 + 5 + 1.25 + 2 + 0.1],
    ['claude-3-5-haiku-20241022', 0.8 + 4 + 1 + 1.6 + 0.08],
    ['claude-3-haiku-20240307', 0.25 + 1.25 + 0.3125 + 0.5 + 0.03],
  ])('%s costs $%s for 1M of every token kind', (model, expected) => {
    expect(computeRequestCost(model, ONE_M_EACH)).toBeCloseTo(expected, 10);
  });

  it('charges input and output at their own rates', () => {
    expect(
      computeRequestCost('claude-sonnet-4-6', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        cacheRead: 0,
      }),
    ).toBeCloseTo(18, 10);
  });

  it('is null for an unpriced model so the caller records tokens without a cost', () => {
    expect(computeRequestCost('some-future-model', ONE_M_EACH)).toBeNull();
    expect(computeRequestCost(null, ONE_M_EACH)).toBeNull();
  });

  it('is zero for a priced model with no tokens', () => {
    expect(
      computeRequestCost('claude-opus-4-8', {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        cacheRead: 0,
      }),
    ).toBe(0);
  });
});
