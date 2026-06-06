import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { windowForRange, RANGE_LABELS } from './dateRange.js';

describe('windowForRange', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // June 15 2026, 15:30 local: mid-month, mid-day, no DST edge within the
    // ranges the assertions cross.
    vi.setSystemTime(new Date(2026, 5, 15, 15, 30, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const midnight = (y: number, m: number, d: number): number => new Date(y, m, d).getTime();

  it('anchors every preset at a local midnight', () => {
    expect(windowForRange('1d', '', '')).toEqual({ sinceMs: midnight(2026, 5, 15) });
    expect(windowForRange('1w', '', '')).toEqual({ sinceMs: midnight(2026, 5, 9) });
    expect(windowForRange('1m', '', '')).toEqual({ sinceMs: midnight(2026, 4, 15) });
    expect(windowForRange('3m', '', '')).toEqual({ sinceMs: midnight(2026, 2, 15) });
    expect(windowForRange('6m', '', '')).toEqual({ sinceMs: midnight(2025, 11, 15) });
    expect(windowForRange('1y', '', '')).toEqual({ sinceMs: midnight(2025, 5, 15) });
  });

  it('returns an unbounded window for all-time', () => {
    expect(windowForRange('all', '', '')).toEqual({});
  });

  it('maps custom dates to an end-inclusive window', () => {
    expect(windowForRange('custom', '2026-06-01', '2026-06-10')).toEqual({
      sinceMs: midnight(2026, 5, 1),
      // Exclusive upper bound = start of the day AFTER the picked end date.
      untilMs: midnight(2026, 5, 11),
    });
  });

  it('leaves missing custom edges unbounded', () => {
    expect(windowForRange('custom', '2026-06-01', '')).toEqual({ sinceMs: midnight(2026, 5, 1) });
    expect(windowForRange('custom', '', '2026-06-10')).toEqual({ untilMs: midnight(2026, 5, 11) });
    expect(windowForRange('custom', '', '')).toEqual({});
  });

  it('is computed from the live clock (no caching): the 1d window moves with the day', () => {
    const before = windowForRange('1d', '', '');
    vi.setSystemTime(new Date(2026, 5, 16, 0, 5, 0)); // five past the next midnight
    const after = windowForRange('1d', '', '');
    expect(before.sinceMs).toBe(midnight(2026, 5, 15));
    expect(after.sinceMs).toBe(midnight(2026, 5, 16));
  });
});

describe('RANGE_LABELS', () => {
  it('has the header phrase for every preset', () => {
    expect(RANGE_LABELS).toEqual({
      '1d': 'today',
      '1w': 'in the last 7 days',
      '1m': 'in the last month',
      '3m': 'in the last 3 months',
      '6m': 'in the last 6 months',
      '1y': 'in the last year',
      all: 'all-time',
      custom: 'in the selected range',
    });
  });
});
