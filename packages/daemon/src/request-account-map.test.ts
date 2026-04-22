import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RequestAccountMap } from './request-account-map.js';

describe('RequestAccountMap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a stored mapping within its TTL', () => {
    const map = new RequestAccountMap();
    map.set('req_1', 'acc-A');
    expect(map.get('req_1')).toBe('acc-A');
    expect(map.size()).toBe(1);
  });

  it('returns null for unknown ids', () => {
    const map = new RequestAccountMap();
    expect(map.get('missing')).toBeNull();
  });

  it('overwrites an existing id with the newer account', () => {
    const map = new RequestAccountMap();
    map.set('req_1', 'acc-A');
    map.set('req_1', 'acc-B');
    expect(map.get('req_1')).toBe('acc-B');
    expect(map.size()).toBe(1);
  });

  it('expires entries past their TTL and removes them on access', () => {
    const map = new RequestAccountMap(1_000);
    map.set('req_1', 'acc-A');
    vi.advanceTimersByTime(1_001);
    expect(map.get('req_1')).toBeNull();
    expect(map.size()).toBe(0);
  });

  it('sweeps expired entries when exceeding max size', () => {
    const map = new RequestAccountMap(1_000, 2);
    map.set('req_1', 'acc-A');
    map.set('req_2', 'acc-B');
    vi.advanceTimersByTime(1_001);
    map.set('req_3', 'acc-C');
    expect(map.size()).toBe(1);
    expect(map.get('req_1')).toBeNull();
    expect(map.get('req_3')).toBe('acc-C');
  });

  it('evicts oldest entries by insertion order when sweep leaves size above cap', () => {
    const map = new RequestAccountMap(60_000, 2);
    map.set('req_1', 'acc-A');
    map.set('req_2', 'acc-B');
    map.set('req_3', 'acc-C');
    expect(map.size()).toBe(2);
    expect(map.get('req_1')).toBeNull();
    expect(map.get('req_2')).toBe('acc-B');
    expect(map.get('req_3')).toBe('acc-C');
  });
});
