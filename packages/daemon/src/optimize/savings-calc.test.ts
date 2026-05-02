import { describe, it, expect } from 'vitest';
import { computeSavings } from './savings-calc.js';

describe('computeSavings', () => {
  it('returns zero savings when the parent turn has no input tokens', () => {
    const r = computeSavings({
      toolCalls: [{ responseSizeBytes: 1000 }],
      parentTurn: {
        cacheRead: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        uncachedInput: 0,
        totalInputTokens: 0,
      },
      actualModel: 'claude-opus-4-7',
      curatedId: 'file-explorer',
      hypoModel: 'claude-haiku-4-5',
    });
    expect(r.savingsUsd).toBe(0);
    expect(r.actualCostUsd).toBe(0);
    expect(r.hypotheticalCostUsd).toBe(0);
  });

  it('returns zero savings when no tool calls are attributed', () => {
    const r = computeSavings({
      toolCalls: [],
      parentTurn: {
        cacheRead: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        uncachedInput: 100_000,
        totalInputTokens: 100_000,
      },
      actualModel: 'claude-opus-4-7',
      curatedId: 'file-explorer',
      hypoModel: 'claude-haiku-4-5',
    });
    expect(r.savingsUsd).toBe(0);
    expect(r.shareOfTurn).toBe(0);
  });

  it('positive savings on a fully-uncached Opus turn dominated by a Read', () => {
    // 30k bytes Read result, no cache hits, total input ~100k tokens.
    // shareOfTurn = 30000 / (100000 * 3.5) = ~0.086.
    const r = computeSavings({
      toolCalls: [{ responseSizeBytes: 30_000 }],
      parentTurn: {
        cacheRead: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        uncachedInput: 100_000,
        totalInputTokens: 100_000,
      },
      actualModel: 'claude-opus-4-7',
      curatedId: 'file-explorer',
      hypoModel: 'claude-haiku-4-5',
    });
    // Actual: 0.086 share × 100k uncached × $15/M = ~$0.129
    // Hypo:   (30k/3.5 tokens × $1) + (500 tokens × $15/M) = ~$0.0086 + $0.0075 = ~$0.0161
    // Savings ~= $0.113
    expect(r.actualCostUsd).toBeGreaterThan(0.1);
    expect(r.hypotheticalCostUsd).toBeLessThan(r.actualCostUsd);
    expect(r.savingsUsd).toBeGreaterThan(0);
  });

  it('cache-aware: heavily cached turns produce smaller savings', () => {
    // Same turn but with 90% of input from cache reads (0.1x rate).
    const cached = computeSavings({
      toolCalls: [{ responseSizeBytes: 30_000 }],
      parentTurn: {
        cacheRead: 90_000,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        uncachedInput: 10_000,
        totalInputTokens: 100_000,
      },
      actualModel: 'claude-opus-4-7',
      curatedId: 'file-explorer',
      hypoModel: 'claude-haiku-4-5',
    });
    const uncached = computeSavings({
      toolCalls: [{ responseSizeBytes: 30_000 }],
      parentTurn: {
        cacheRead: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        uncachedInput: 100_000,
        totalInputTokens: 100_000,
      },
      actualModel: 'claude-opus-4-7',
      curatedId: 'file-explorer',
      hypoModel: 'claude-haiku-4-5',
    });
    // Heavily-cached actual cost is much lower → smaller savings or
    // even negative savings (subagent overhead exceeds the cached
    // benefit). Honest math even when it doesn't favor routing.
    expect(cached.actualCostUsd).toBeLessThan(uncached.actualCostUsd);
    expect(cached.savingsUsd).toBeLessThan(uncached.savingsUsd);
  });

  it('clamps shareOfTurn to 1.0 when tool bytes exceed turn input bytes', () => {
    // Pathological case: a tool result way bigger than the
    // turn's reported input tokens (rounding/over-count). shareOfTurn
    // clamps to 1.0 so savings stays sane.
    const r = computeSavings({
      toolCalls: [{ responseSizeBytes: 10_000_000 }],
      parentTurn: {
        cacheRead: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        uncachedInput: 1000,
        totalInputTokens: 1000,
      },
      actualModel: 'claude-opus-4-7',
      curatedId: 'file-explorer',
      hypoModel: 'claude-haiku-4-5',
    });
    expect(r.shareOfTurn).toBe(1);
  });

  it('uses curated-id-specific digest size where defined', () => {
    const fe = computeSavings({
      toolCalls: [{ responseSizeBytes: 30_000 }],
      parentTurn: {
        cacheRead: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        uncachedInput: 100_000,
        totalInputTokens: 100_000,
      },
      actualModel: 'claude-opus-4-7',
      curatedId: 'file-explorer',
      hypoModel: 'claude-haiku-4-5',
    });
    const repoMapper = computeSavings({
      toolCalls: [{ responseSizeBytes: 30_000 }],
      parentTurn: {
        cacheRead: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        uncachedInput: 100_000,
        totalInputTokens: 100_000,
      },
      actualModel: 'claude-opus-4-7',
      curatedId: 'repo-mapper', // larger digest
      hypoModel: 'claude-haiku-4-5',
    });
    // repo-mapper has a 1500-token digest vs file-explorer's 500;
    // higher hypothetical cost = lower savings.
    expect(repoMapper.hypotheticalCostUsd).toBeGreaterThan(fe.hypotheticalCostUsd);
    expect(repoMapper.savingsUsd).toBeLessThan(fe.savingsUsd);
  });

  it('uses default digest size for unknown curated ids', () => {
    const r = computeSavings({
      toolCalls: [{ responseSizeBytes: 30_000 }],
      parentTurn: {
        cacheRead: 0,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        uncachedInput: 100_000,
        totalInputTokens: 100_000,
      },
      actualModel: 'claude-opus-4-7',
      curatedId: 'someone-typed-this-wrong',
      hypoModel: 'claude-haiku-4-5',
    });
    expect(r.hypotheticalCostUsd).toBeGreaterThan(0);
  });

  it('attributes a fraction of input + cached tokens proportional to shareOfTurn', () => {
    const r = computeSavings({
      toolCalls: [{ responseSizeBytes: 35_000 }],
      parentTurn: {
        cacheRead: 50_000,
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        uncachedInput: 50_000,
        totalInputTokens: 100_000,
      },
      actualModel: 'claude-opus-4-7',
      curatedId: 'file-explorer',
      hypoModel: 'claude-haiku-4-5',
    });
    // shareOfTurn = 35000 / (100000 * 3.5) = 0.1
    expect(r.shareOfTurn).toBeCloseTo(0.1, 2);
    expect(r.attributedInputTokens).toBeCloseTo(10000, -1);
    expect(r.attributedCachedTokens).toBeCloseTo(5000, -1);
  });
});
