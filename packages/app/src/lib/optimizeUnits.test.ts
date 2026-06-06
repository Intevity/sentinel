import { describe, it, expect } from 'vitest';
import { windowMultiplierLabel, formatTokenCount, formatTokens } from './optimizeUnits.js';

describe('formatTokenCount', () => {
  it('renders magnitude buckets with no unit suffix', () => {
    expect(formatTokenCount(12)).toBe('12');
    expect(formatTokenCount(1500)).toBe('1.5K');
    expect(formatTokenCount(120_000_000)).toBe('120.00M');
    expect(formatTokenCount(180_220_000)).toBe('180.22M');
  });

  it('clamps near-zero to "0" without a sign', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(-0.5)).toBe('0');
  });

  it('keeps a leading minus for real regressions', () => {
    expect(formatTokenCount(-500)).toBe('-500');
    expect(formatTokenCount(-2_000_000)).toBe('-2.00M');
  });
});

describe('formatTokens', () => {
  it('appends the " tk" unit to the bare magnitude', () => {
    expect(formatTokens(12)).toBe('12 tk');
    expect(formatTokens(1500)).toBe('1.5K tk');
    expect(formatTokens(3_400_000)).toBe('3.40M tk');
  });

  it('clamps near-zero to "0 tk" without a sign', () => {
    expect(formatTokens(0)).toBe('0 tk');
    expect(formatTokens(-0.5)).toBe('0 tk');
  });

  it('keeps a leading minus for real regressions', () => {
    expect(formatTokens(-500)).toBe('-500 tk');
  });
});

describe('windowMultiplierLabel', () => {
  it('computes denom/(denom - saved) with at most two decimals', () => {
    expect(windowMultiplierLabel(67, 100)).toBe('3.03x'); // 67% saved ≈ 3x window
    expect(windowMultiplierLabel(50, 100)).toBe('2x');
    expect(windowMultiplierLabel(60, 100)).toBe('2.5x');
    expect(windowMultiplierLabel(0, 100)).toBe('1x');
  });

  it('trims trailing zeros rather than padding to two decimals', () => {
    expect(windowMultiplierLabel(75, 100)).toBe('4x');
    expect(windowMultiplierLabel(20, 100)).toBe('1.25x');
  });

  it('reads a savings regression as a sub-1x multiplier', () => {
    expect(windowMultiplierLabel(-25, 100)).toBe('0.8x');
  });

  it('returns null when there is nothing to measure or the reduction is total', () => {
    expect(windowMultiplierLabel(0, 0)).toBeNull();
    expect(windowMultiplierLabel(10, 0)).toBeNull();
    expect(windowMultiplierLabel(100, 100)).toBeNull();
    expect(windowMultiplierLabel(150, 100)).toBeNull();
  });
});
