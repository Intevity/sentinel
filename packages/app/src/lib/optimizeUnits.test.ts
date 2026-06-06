import { describe, it, expect } from 'vitest';
import { windowMultiplierLabel } from './optimizeUnits.js';

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
