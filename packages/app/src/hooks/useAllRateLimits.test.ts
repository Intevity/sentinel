import { describe, it, expect } from 'vitest';
import type { RateLimitWindow } from '@sentinel/shared';
import { isWindowExhausted } from './useAllRateLimits.js';

function win(name: string, over: Partial<RateLimitWindow>): RateLimitWindow {
  return {
    name,
    status: 'allowed',
    utilization: 0.2,
    limit: null,
    remaining: null,
    reset: 90_000,
    inUse: null,
    lastUpdated: 1,
    ...over,
  };
}

describe('isWindowExhausted', () => {
  it('is true for a blocked window and for one at full utilization', () => {
    expect(isWindowExhausted([win('unified-7d', { status: 'blocked' })], 'unified-7d')).toBe(true);
    expect(isWindowExhausted([win('unified-7d', { utilization: 1 })], 'unified-7d')).toBe(true);
  });

  it('is false below full utilization, for another window, or with no data', () => {
    expect(isWindowExhausted([win('unified-7d', { utilization: 0.99 })], 'unified-7d')).toBe(false);
    expect(isWindowExhausted([win('unified-5h', { status: 'blocked' })], 'unified-7d')).toBe(false);
    expect(isWindowExhausted([win('unified-7d', { utilization: null })], 'unified-7d')).toBe(false);
    expect(isWindowExhausted(undefined, 'unified-7d')).toBe(false);
  });
});
