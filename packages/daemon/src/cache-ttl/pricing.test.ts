import { describe, expect, it } from 'vitest';
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  computeCacheCosts,
  getBaseInputPricePerMillion,
} from './pricing.js';

describe('getBaseInputPricePerMillion', () => {
  it('prices Opus family at 15', () => {
    expect(getBaseInputPricePerMillion('claude-opus-4-7')).toBe(15);
    expect(getBaseInputPricePerMillion('claude-opus-4-7-20260101')).toBe(15);
    expect(getBaseInputPricePerMillion('claude-opus-3-5-sonnet')).toBe(15);
  });

  it('prices Sonnet family at 3', () => {
    expect(getBaseInputPricePerMillion('claude-sonnet-4-6')).toBe(3);
    expect(getBaseInputPricePerMillion('claude-sonnet-4-5-20251015')).toBe(3);
    expect(getBaseInputPricePerMillion('claude-sonnet-3-7')).toBe(3);
  });

  it('prices Haiku 4 family at 1', () => {
    expect(getBaseInputPricePerMillion('claude-haiku-4-5')).toBe(1);
    expect(getBaseInputPricePerMillion('claude-haiku-4-5-20251001')).toBe(1);
  });

  it('prices Haiku 3 family at 0.8', () => {
    expect(getBaseInputPricePerMillion('claude-haiku-3-5')).toBe(0.8);
  });

  it('is case-insensitive', () => {
    expect(getBaseInputPricePerMillion('Claude-Sonnet-4-6')).toBe(3);
    expect(getBaseInputPricePerMillion('CLAUDE-OPUS-4-7')).toBe(15);
  });

  it('returns a safe fallback for unknown models', () => {
    expect(getBaseInputPricePerMillion('gpt-4')).toBe(3);
    expect(getBaseInputPricePerMillion('')).toBe(3);
    expect(getBaseInputPricePerMillion('some-future-model')).toBe(3);
  });
});

describe('cache multipliers', () => {
  it('encodes published multipliers', () => {
    expect(CACHE_WRITE_5M_MULTIPLIER).toBe(1.25);
    expect(CACHE_WRITE_1H_MULTIPLIER).toBe(2.0);
    expect(CACHE_READ_MULTIPLIER).toBe(0.1);
  });
});

describe('computeCacheCosts', () => {
  it('applies the three multipliers against the base input price', () => {
    const { cost5mWrite, cost1hWrite, costRead } = computeCacheCosts(
      'claude-sonnet-4-6',
      1_000_000,
      1_000_000,
      1_000_000,
    );
    expect(cost5mWrite).toBeCloseTo(3 * 1.25, 10);
    expect(cost1hWrite).toBeCloseTo(3 * 2.0, 10);
    expect(costRead).toBeCloseTo(3 * 0.1, 10);
  });

  it('scales linearly with token counts', () => {
    const half = computeCacheCosts('claude-opus-4-7', 500_000, 500_000, 500_000);
    const full = computeCacheCosts('claude-opus-4-7', 1_000_000, 1_000_000, 1_000_000);
    expect(half.cost5mWrite * 2).toBeCloseTo(full.cost5mWrite, 10);
    expect(half.cost1hWrite * 2).toBeCloseTo(full.cost1hWrite, 10);
    expect(half.costRead * 2).toBeCloseTo(full.costRead, 10);
  });

  it('returns zeros when no tokens are supplied', () => {
    const { cost5mWrite, cost1hWrite, costRead } = computeCacheCosts('claude-sonnet-4-6', 0, 0, 0);
    expect(cost5mWrite).toBe(0);
    expect(cost1hWrite).toBe(0);
    expect(costRead).toBe(0);
  });

  it('uses the fallback rate for unknown models', () => {
    const known = computeCacheCosts('claude-sonnet-4-6', 1_000_000, 0, 0);
    const unknown = computeCacheCosts('future-model', 1_000_000, 0, 0);
    expect(unknown.cost5mWrite).toBeCloseTo(known.cost5mWrite, 10);
  });
});
