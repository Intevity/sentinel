import { describe, it, expect } from 'vitest';
import { pickRecommendedMb, runScanBenchmark } from './scanner-benchmark.js';

describe('pickRecommendedMb', () => {
  it('returns the largest size whose p99 is within budget', () => {
    // 1 MB and 2 MB both fit; 4, 8, 16 all blow the 50 ms budget.
    const results = [
      { sizeMb: 1,  meanMs: 1,   p99Ms: 2   },
      { sizeMb: 2,  meanMs: 3,   p99Ms: 40  },
      { sizeMb: 4,  meanMs: 60,  p99Ms: 80  },
      { sizeMb: 8,  meanMs: 120, p99Ms: 160 },
      { sizeMb: 16, meanMs: 250, p99Ms: 320 },
    ];
    expect(pickRecommendedMb(results, 50)).toBe(2);
  });

  it('returns the largest size when all fit comfortably', () => {
    // Fast hardware path: even 16 MB stays under budget.
    const results = [
      { sizeMb: 1,  meanMs: 1, p99Ms: 2 },
      { sizeMb: 2,  meanMs: 3, p99Ms: 4 },
      { sizeMb: 4,  meanMs: 7, p99Ms: 8 },
      { sizeMb: 8,  meanMs: 15, p99Ms: 16 },
      { sizeMb: 16, meanMs: 28, p99Ms: 32 },
    ];
    expect(pickRecommendedMb(results, 50)).toBe(16);
  });

  it('falls back to the smallest size when nothing qualifies', () => {
    // Pathological slow-hardware path — even 1 MB exceeds the budget.
    const results = [
      { sizeMb: 1,  meanMs: 60, p99Ms: 80 },
      { sizeMb: 2,  meanMs: 120, p99Ms: 160 },
      { sizeMb: 4,  meanMs: 240, p99Ms: 320 },
    ];
    expect(pickRecommendedMb(results, 50)).toBe(1);
  });

  it('honours a custom budget', () => {
    const results = [
      { sizeMb: 1, meanMs: 1, p99Ms: 5 },
      { sizeMb: 2, meanMs: 3, p99Ms: 15 },
      { sizeMb: 4, meanMs: 7, p99Ms: 30 },
    ];
    // Tight 10 ms budget → only 1 MB fits.
    expect(pickRecommendedMb(results, 10)).toBe(1);
    // Loose 100 ms budget → all fit, pick the largest.
    expect(pickRecommendedMb(results, 100)).toBe(4);
  });
});

describe('runScanBenchmark', () => {
  // Full bench takes 1-3 s. Mark slow so developer runs can skip via
  // --testPathPattern if needed, but keep it in the default suite so
  // a regression in the scanner cost path shows up in CI.
  it('produces the expected shape and valid recommendation', () => {
    const out = runScanBenchmark();
    expect(out.results).toHaveLength(5);
    expect(out.results.map((r) => r.sizeMb)).toEqual([1, 2, 4, 8, 16]);
    for (const r of out.results) {
      expect(r.meanMs).toBeGreaterThan(0);
      // p99 is sampled from the same distribution as mean — must be
      // >= mean by definition (nearest-rank on a sorted array).
      expect(r.p99Ms).toBeGreaterThanOrEqual(r.meanMs - 0.001);
    }
    expect([1, 2, 4, 8, 16]).toContain(out.recommendedMb);
    expect(out.platform).toMatch(/^[a-z0-9]+-[a-z0-9]+$/i);
    expect(out.ranAt).toBeGreaterThan(0);
  }, 30_000);
});
