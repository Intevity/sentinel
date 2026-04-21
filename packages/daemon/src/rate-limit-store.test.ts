import { describe, it, expect, vi } from 'vitest';
import { RateLimitStore } from './rate-limit-store.js';

describe('RateLimitStore', () => {
  it('returns empty array for unknown account', () => {
    const store = new RateLimitStore();
    expect(store.getAll('unknown-account')).toEqual([]);
  });

  describe('clearAccount', () => {
    it('removes every window for the given account', () => {
      const store = new RateLimitStore();
      store.update('acc-a', {
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.5',
        'anthropic-ratelimit-unified-7d-utilization': '0.1',
      });
      expect(store.getAll('acc-a')).toHaveLength(2);
      store.clearAccount('acc-a');
      expect(store.getAll('acc-a')).toEqual([]);
    });

    it('does not affect other accounts', () => {
      const store = new RateLimitStore();
      store.update('acc-a', { 'anthropic-ratelimit-unified-5h-utilization': '0.5' });
      store.update('acc-b', { 'anthropic-ratelimit-unified-5h-utilization': '0.9' });
      store.clearAccount('acc-a');
      expect(store.getAll('acc-a')).toEqual([]);
      expect(store.getAll('acc-b')).toHaveLength(1);
    });

    it('is a no-op for unknown accounts', () => {
      const store = new RateLimitStore();
      expect(() => store.clearAccount('never-stored')).not.toThrow();
    });
  });

  // ── Subscription-plan headers (utilization-based) ─────────────────────────

  it('parses utilization / status / reset for a subscription window', () => {
    const store = new RateLimitStore();
    store.update('acc-1', {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.33',
      'anthropic-ratelimit-unified-5h-reset': '1776362400',
    });
    const windows = store.getAll('acc-1');
    expect(windows).toHaveLength(1);
    expect(windows[0]?.name).toBe('unified-5h');
    expect(windows[0]?.status).toBe('allowed');
    expect(windows[0]?.utilization).toBeCloseTo(0.33);
    expect(windows[0]?.reset).toBe(1776362400);
    expect(windows[0]?.limit).toBeNull();
    expect(windows[0]?.remaining).toBeNull();
    expect(windows[0]?.lastUpdated).toBeGreaterThan(0);
  });

  it('parses multiple subscription windows at once', () => {
    const store = new RateLimitStore();
    store.update('acc-1', {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.33',
      'anthropic-ratelimit-unified-5h-reset': '1776362400',
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.03',
      'anthropic-ratelimit-unified-7d-reset': '1776949200',
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-utilization': '0.0',
      'anthropic-ratelimit-unified-overage-reset': '1777593600',
    });
    const windows = store.getAll('acc-1');
    expect(windows).toHaveLength(3);
    const names = windows.map((w) => w.name).sort();
    expect(names).toEqual(['unified-5h', 'unified-7d', 'unified-overage']);
  });

  it('parses windows with underscore in name (e.g. unified-7d_sonnet)', () => {
    const store = new RateLimitStore();
    store.update('acc-1', {
      'anthropic-ratelimit-unified-7d_sonnet-status': 'allowed',
      'anthropic-ratelimit-unified-7d_sonnet-utilization': '0.68',
      'anthropic-ratelimit-unified-7d_sonnet-reset': '1776430800',
    });
    const windows = store.getAll('acc-1');
    expect(windows).toHaveLength(1);
    expect(windows[0]?.name).toBe('unified-7d_sonnet');
    expect(windows[0]?.utilization).toBeCloseTo(0.68);
  });

  // ── API-key headers (count-based) ─────────────────────────────────────────

  it('parses limit/remaining/reset for an API-key window', () => {
    const store = new RateLimitStore();
    store.update('acc-1', {
      'anthropic-ratelimit-tokens-limit': '40000',
      'anthropic-ratelimit-tokens-remaining': '39500',
      'anthropic-ratelimit-tokens-reset': '1776362400',
    });
    const windows = store.getAll('acc-1');
    expect(windows).toHaveLength(1);
    expect(windows[0]?.name).toBe('tokens');
    expect(windows[0]?.limit).toBe(40000);
    expect(windows[0]?.remaining).toBe(39500);
    expect(windows[0]?.reset).toBe(1776362400);
    expect(windows[0]?.utilization).toBeNull();
  });

  // ── Shared behaviour ──────────────────────────────────────────────────────

  it('handles header values as arrays (takes first element)', () => {
    const store = new RateLimitStore();
    store.update('acc-1', {
      'anthropic-ratelimit-unified-5h-utilization': ['0.50', '0.99'],
      'anthropic-ratelimit-unified-5h-reset': ['1776362400'],
    });
    const windows = store.getAll('acc-1');
    expect(windows[0]?.utilization).toBeCloseTo(0.5);
    expect(windows[0]?.reset).toBe(1776362400);
  });

  it('ignores non-ratelimit headers', () => {
    const store = new RateLimitStore();
    store.update('acc-1', {
      'content-type': 'application/json',
      'x-request-id': 'abc-123',
      // metadata headers (no limit/remaining/reset/utilization/status/in-use suffix)
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-fallback-percentage': '0.5',
    });
    expect(store.getAll('acc-1')).toHaveLength(0);
  });

  it('captures in-use boolean on the overage window', () => {
    const store = new RateLimitStore();
    store.update('acc-1', {
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-utilization': '0',
      'anthropic-ratelimit-unified-overage-reset': '1777593600',
      'anthropic-ratelimit-unified-overage-in-use': 'true',
    });
    const win = store.getAll('acc-1').find((w) => w.name === 'unified-overage');
    expect(win?.inUse).toBe(true);
  });

  it('accepts in-use=1 and ignores non-truthy values', () => {
    const store = new RateLimitStore();
    store.update('a', { 'anthropic-ratelimit-unified-overage-in-use': '1' });
    expect(store.getAll('a')[0]?.inUse).toBe(true);
    store.update('b', { 'anthropic-ratelimit-unified-overage-in-use': 'false' });
    expect(store.getAll('b')[0]?.inUse).toBe(false);
  });

  it('coerces missing in-use to false when any overage header is updated', () => {
    // Regression guard: after a response with in-use=true, a later response
    // with overage-status but no in-use header must flip inUse back to false.
    const store = new RateLimitStore();
    store.update('a', {
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-in-use': 'true',
    });
    store.update('a', {
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-utilization': '0',
    });
    const win = store.getAll('a').find((w) => w.name === 'unified-overage');
    expect(win?.inUse).toBe(false);
  });

  it('handles undefined in-use header value as null', () => {
    const store = new RateLimitStore();
    store.update('a', {
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      // explicitly undefined (Node's header typing allows it)
      'anthropic-ratelimit-unified-overage-in-use': undefined,
    });
    const win = store.getAll('a').find((w) => w.name === 'unified-overage');
    // The header key was observed but the value was missing — we store null
    // to distinguish from "header absent" (no overage window at all).
    expect(win?.inUse).toBeNull();
  });

  it('accepts in-use via array header value', () => {
    const store = new RateLimitStore();
    store.update('a', {
      'anthropic-ratelimit-unified-overage-in-use': ['true', 'extra'],
    });
    expect(store.getAll('a')[0]?.inUse).toBe(true);
  });

  it('merges partial updates into existing windows', () => {
    const store = new RateLimitStore();
    store.update('acc-1', {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.20',
    });
    store.update('acc-1', {
      'anthropic-ratelimit-unified-5h-reset': '1776362400',
      'anthropic-ratelimit-unified-5h-utilization': '0.35',
    });
    const windows = store.getAll('acc-1');
    expect(windows).toHaveLength(1);
    expect(windows[0]?.status).toBe('allowed');
    expect(windows[0]?.utilization).toBeCloseTo(0.35);
    expect(windows[0]?.reset).toBe(1776362400);
  });

  it('keeps accounts isolated from each other', () => {
    const store = new RateLimitStore();
    store.update('acc-1', {
      'anthropic-ratelimit-unified-5h-utilization': '0.10',
      'anthropic-ratelimit-unified-5h-reset': '1',
    });
    store.update('acc-2', {
      'anthropic-ratelimit-unified-5h-utilization': '0.90',
      'anthropic-ratelimit-unified-5h-reset': '2',
    });

    expect(store.getAll('acc-1')[0]?.utilization).toBeCloseTo(0.1);
    expect(store.getAll('acc-2')[0]?.utilization).toBeCloseTo(0.9);
  });

  it('handles undefined header values gracefully', () => {
    const store = new RateLimitStore();
    store.update('acc-1', {
      'anthropic-ratelimit-unified-5h-utilization': undefined,
      'anthropic-ratelimit-unified-5h-reset': undefined,
    });
    const windows = store.getAll('acc-1');
    expect(windows).toHaveLength(1);
    expect(windows[0]?.utilization).toBeNull();
    expect(windows[0]?.reset).toBeNull();
  });

  it('is case-insensitive for header matching', () => {
    const store = new RateLimitStore();
    store.update('acc-1', {
      'Anthropic-RateLimit-Unified-5h-Utilization': '0.45',
      'Anthropic-RateLimit-Unified-5h-Reset': '1776362400',
    });
    const windows = store.getAll('acc-1');
    expect(windows).toHaveLength(1);
    expect(windows[0]?.utilization).toBeCloseTo(0.45);
  });

  // ── Persistence helpers ───────────────────────────────────────────────────────

  it('loadAccount pre-populates windows without firing onUpdate', () => {
    const store = new RateLimitStore();
    const callbackFired = vi.fn();
    store.onUpdate(callbackFired);

    store.loadAccount('acc-1', [
      {
        name: 'unified-5h',
        status: 'allowed',
        utilization: 0.55,
        limit: null,
        remaining: null,
        reset: 1776362400,
        inUse: null,
        lastUpdated: 1,
      },
      {
        name: 'unified-7d',
        status: 'allowed',
        utilization: 0.1,
        limit: null,
        remaining: null,
        reset: 1777000000,
        inUse: null,
        lastUpdated: 1,
      },
    ]);

    const windows = store.getAll('acc-1');
    expect(windows).toHaveLength(2);
    expect(callbackFired).not.toHaveBeenCalled();
  });

  it('onUpdate fires after update() with the updated windows', () => {
    const store = new RateLimitStore();
    const updates: Array<{
      accountId: string;
      windows: import('@claude-sentinel/shared').RateLimitWindow[];
    }> = [];
    store.onUpdate((accountId, windows) => updates.push({ accountId, windows }));

    store.update('acc-1', {
      'anthropic-ratelimit-unified-5h-utilization': '0.33',
      'anthropic-ratelimit-unified-5h-reset': '1776362400',
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.accountId).toBe('acc-1');
    expect(updates[0]?.windows).toHaveLength(1);
    expect(updates[0]?.windows[0]?.name).toBe('unified-5h');
    expect(updates[0]?.windows[0]?.utilization).toBeCloseTo(0.33);
  });

  it('onUpdate fires with only the windows changed in that update call', () => {
    const store = new RateLimitStore();
    const updates: number[] = [];
    store.onUpdate((_id, windows) => updates.push(windows.length));

    // First update: 2 windows
    store.update('acc-1', {
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-5h-reset': '1',
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
      'anthropic-ratelimit-unified-7d-reset': '2',
    });
    // Second update: only 1 window changed
    store.update('acc-1', {
      'anthropic-ratelimit-unified-5h-utilization': '0.5',
      'anthropic-ratelimit-unified-5h-reset': '1',
    });

    expect(updates[0]).toBe(2);
    expect(updates[1]).toBe(1);
  });

  it('onUpdate does not fire when headers contain no rate-limit fields', () => {
    const store = new RateLimitStore();
    const callbackFired = vi.fn();
    store.onUpdate(callbackFired);

    store.update('acc-1', { 'content-type': 'application/json' });

    expect(callbackFired).not.toHaveBeenCalled();
  });

  it('getAllByAccount returns a snapshot keyed by accountId', () => {
    const store = new RateLimitStore();
    store.update('acc-a', { 'anthropic-ratelimit-unified-5h-utilization': '0.25' });
    store.update('acc-b', { 'anthropic-ratelimit-unified-5h-utilization': '0.9' });
    const all = store.getAllByAccount();
    expect(Object.keys(all).sort()).toEqual(['acc-a', 'acc-b']);
    expect(all['acc-a']?.[0]?.utilization).toBeCloseTo(0.25);
    expect(all['acc-b']?.[0]?.utilization).toBeCloseTo(0.9);
  });

  it('getAllByAccount is empty when no accounts have data', () => {
    const store = new RateLimitStore();
    expect(store.getAllByAccount()).toEqual({});
  });
});
