import { describe, it, expect } from 'vitest';
import { rangeLadder, snapRangeToLadder } from '@claude-sentinel/shared';

describe('rangeLadder', () => {
  it('returns the historical six presets for retention of a year or more', () => {
    for (const days of [365, 730, 1095]) {
      expect(rangeLadder(days)).toEqual(['1d', '1w', '1m', '3m', '6m', '1y']);
    }
  });

  it('swaps in 2W below a year and 2M below six months', () => {
    for (const days of [180, 200, 364]) {
      expect(rangeLadder(days)).toEqual(['1d', '1w', '2w', '1m', '3m', '6m']);
    }
    for (const days of [90, 179]) {
      expect(rangeLadder(days)).toEqual(['1d', '1w', '2w', '1m', '2m', '3m']);
    }
  });

  it('always offers exactly six rungs topped by the widest covered preset', () => {
    for (const days of [90, 179, 180, 364, 365, 730, 1095]) {
      expect(rangeLadder(days)).toHaveLength(6);
    }
    expect(rangeLadder(364)[5]).toBe('6m');
    expect(rangeLadder(365)[5]).toBe('1y');
    expect(rangeLadder(179)[5]).toBe('3m');
  });

  it('falls back to the 3M ladder on input below the daemon clamp', () => {
    expect(rangeLadder(1)).toEqual(['1d', '1w', '2w', '1m', '2m', '3m']);
  });
});

describe('snapRangeToLadder', () => {
  it('passes through on-ladder presets and all/custom', () => {
    expect(snapRangeToLadder('6m', 180)).toBe('6m');
    expect(snapRangeToLadder('1d', 90)).toBe('1d');
    expect(snapRangeToLadder('all', 90)).toBe('all');
    expect(snapRangeToLadder('custom', 90)).toBe('custom');
  });

  it('snaps presets wider than the window down to the ladder top', () => {
    expect(snapRangeToLadder('1y', 180)).toBe('6m');
    expect(snapRangeToLadder('1y', 90)).toBe('3m');
    expect(snapRangeToLadder('6m', 90)).toBe('3m');
  });

  it('snaps fine-grained presets to the adjacent narrower rung when the ladder lacks them', () => {
    expect(snapRangeToLadder('2w', 365)).toBe('1w');
    expect(snapRangeToLadder('2m', 365)).toBe('1m');
    expect(snapRangeToLadder('2m', 180)).toBe('1m');
  });
});
