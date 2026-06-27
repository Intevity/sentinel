import { describe, expect, it } from 'vitest';
import { formatInt, formatPercent, formatUsd } from './format.js';

describe('formatUsd', () => {
  it('adds thousands separators and a $ with two decimals', () => {
    expect(formatUsd(15824.62)).toBe('$15,824.62');
    expect(formatUsd(1000000)).toBe('$1,000,000.00');
    expect(formatUsd(1234.5)).toBe('$1,234.50');
  });

  it('renders zero and preserves the sign on negatives', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(-12)).toBe('-$12.00');
  });

  it('widens fraction digits when options are supplied', () => {
    // sub-cent cost shown to 4 places
    expect(formatUsd(0.0034, { minFractionDigits: 4, maxFractionDigits: 4 })).toBe('$0.0034');
  });

  it('falls back to two-decimal defaults for partial options', () => {
    // only maxFractionDigits given → minFractionDigits defaults to 2
    expect(formatUsd(0.5, { maxFractionDigits: 4 })).toBe('$0.50');
    // only minFractionDigits given → maxFractionDigits defaults to 2
    expect(formatUsd(1234, { minFractionDigits: 4 })).toBe('$1,234.0000');
  });
});

describe('formatInt', () => {
  it('groups thousands', () => {
    expect(formatInt(10000)).toBe('10,000');
    expect(formatInt(39684)).toBe('39,684');
    expect(formatInt(0)).toBe('0');
  });

  it('rounds floats and keeps the sign', () => {
    expect(formatInt(1234.6)).toBe('1,235');
    expect(formatInt(-5000)).toBe('-5,000');
  });
});

describe('formatPercent', () => {
  it('appends % with no decimals by default', () => {
    expect(formatPercent(48)).toBe('48%');
    expect(formatPercent(0)).toBe('0%');
  });

  it('honors an explicit decimal count', () => {
    expect(formatPercent(92.8, 1)).toBe('92.8%');
    expect(formatPercent(33.333, 2)).toBe('33.33%');
  });
});
