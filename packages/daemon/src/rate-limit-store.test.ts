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
      windows: import('@sentinel/shared').RateLimitWindow[];
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

  // ── syncFromClaudeAiSnapshot ────────────────────────────────────────────────

  describe('syncFromClaudeAiSnapshot', () => {
    const baseSnapshot = (): import('@sentinel/shared').ClaudeAiUsageSnapshot => ({
      fiveHourUtilization: 0.2,
      fiveHourResetsAt: '2026-04-22T03:00:00Z',
      sevenDayUtilization: 0.65,
      sevenDayResetsAt: '2026-04-28T00:00:00Z',
      sevenDaySonnetUtilization: 0.1,
      sevenDaySonnetResetsAt: '2026-04-28T00:00:00Z',
      extraUsage: null,
      perUserBudget: null,
      fetchedAt: 2000,
    });

    it('populates 5h / 7d / sonnet windows when store is empty', () => {
      const store = new RateLimitStore();
      const synced = store.syncFromClaudeAiSnapshot('acc-1', baseSnapshot());
      expect(synced).toBe(3);
      const windows = store.getAll('acc-1');
      const fiveHour = windows.find((w) => w.name === 'unified-5h');
      const weekly = windows.find((w) => w.name === 'unified-7d');
      const sonnet = windows.find((w) => w.name === 'unified-7d_sonnet');
      expect(fiveHour?.utilization).toBeCloseTo(0.2);
      expect(fiveHour?.status).toBe('allowed');
      expect(fiveHour?.reset).toBe(Math.floor(Date.parse('2026-04-22T03:00:00Z') / 1000));
      expect(weekly?.utilization).toBeCloseTo(0.65);
      expect(sonnet?.utilization).toBeCloseTo(0.1);
    });

    it('infers status from utilization', () => {
      const store = new RateLimitStore();
      store.syncFromClaudeAiSnapshot('acc-1', {
        ...baseSnapshot(),
        fiveHourUtilization: 0.95,
        sevenDayUtilization: 1,
        sevenDaySonnetUtilization: null,
        sevenDaySonnetResetsAt: null,
      });
      const windows = store.getAll('acc-1');
      expect(windows.find((w) => w.name === 'unified-5h')?.status).toBe('allowed_warning');
      expect(windows.find((w) => w.name === 'unified-7d')?.status).toBe('blocked');
      // sonnet row with both util + reset null → skipped
      expect(windows.find((w) => w.name === 'unified-7d_sonnet')).toBeUndefined();
    });

    it('writes an overage window when extraUsage is enabled', () => {
      const store = new RateLimitStore();
      const synced = store.syncFromClaudeAiSnapshot('acc-1', {
        ...baseSnapshot(),
        extraUsage: {
          isEnabled: true,
          limitUsd: 100,
          usedUsd: 50,
          utilizationPct: 50,
          currency: 'USD',
        },
      });
      expect(synced).toBe(4);
      const overage = store.getAll('acc-1').find((w) => w.name === 'unified-overage');
      expect(overage?.utilization).toBeCloseTo(0.5);
      expect(overage?.inUse).toBe(false);
    });

    it('skips overage window when extraUsage is disabled', () => {
      const store = new RateLimitStore();
      store.syncFromClaudeAiSnapshot('acc-1', {
        ...baseSnapshot(),
        extraUsage: {
          isEnabled: false,
          limitUsd: 0,
          usedUsd: 0,
          utilizationPct: 0,
          currency: 'USD',
        },
      });
      expect(store.getAll('acc-1').find((w) => w.name === 'unified-overage')).toBeUndefined();
    });

    it('does not overwrite fresher header-sourced data', () => {
      const store = new RateLimitStore();
      // First: live headers arrive with lastUpdated = Date.now() (fresh).
      store.update('acc-1', {
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.5',
        'anthropic-ratelimit-unified-5h-reset': '9999',
      });
      const before = store.getAll('acc-1').find((w) => w.name === 'unified-5h')!;
      // Then: a claude.ai snapshot captured BEFORE those headers (older fetchedAt).
      const synced = store.syncFromClaudeAiSnapshot('acc-1', {
        ...baseSnapshot(),
        fiveHourUtilization: 0.9, // stale, should be ignored
        fetchedAt: before.lastUpdated! - 10_000,
      });
      // Only 7d + sonnet are new; 5h stays at 0.5 from fresh headers.
      expect(synced).toBe(2);
      expect(store.getAll('acc-1').find((w) => w.name === 'unified-5h')?.utilization).toBe(0.5);
    });

    it('keeps a header-derived reset when the synced value drifts by seconds (same window)', () => {
      // claude.ai reports resets_at as an ISO timestamp that can disagree
      // with the API header epoch by seconds for the SAME window. Letting
      // that through gave the earliest-reset rotator a phantom ordering
      // change on every sync — the sticky tie broke and traffic flipped
      // to the other pool account.
      const store = new RateLimitStore();
      store.update('acc-1', {
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.5',
        'anthropic-ratelimit-unified-5h-reset': '1781135400',
      });
      const headerAt = store.getAll('acc-1').find((w) => w.name === 'unified-5h')!.lastUpdated!;
      const synced = store.syncFromClaudeAiSnapshot('acc-1', {
        ...baseSnapshot(),
        fiveHourUtilization: 0.52,
        // 47 seconds later than the header epoch — source jitter, not a rollover.
        fiveHourResetsAt: new Date((1781135400 + 47) * 1000).toISOString(),
        fetchedAt: headerAt + 10_000,
      });
      expect(synced).toBe(3);
      const fiveHour = store.getAll('acc-1').find((w) => w.name === 'unified-5h')!;
      expect(fiveHour.utilization).toBeCloseTo(0.52); // sync data applied…
      expect(fiveHour.reset).toBe(1781135400); // …but the window boundary held
    });

    it('adopts the synced reset when it names a different window (rollover)', () => {
      const store = new RateLimitStore();
      store.update('acc-1', {
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.9',
        'anthropic-ratelimit-unified-5h-reset': '1781135400',
      });
      const headerAt = store.getAll('acc-1').find((w) => w.name === 'unified-5h')!.lastUpdated!;
      const nextWindow = 1781135400 + 5 * 3600;
      store.syncFromClaudeAiSnapshot('acc-1', {
        ...baseSnapshot(),
        fiveHourUtilization: 0.01,
        fiveHourResetsAt: new Date(nextWindow * 1000).toISOString(),
        fetchedAt: headerAt + 10_000,
      });
      expect(store.getAll('acc-1').find((w) => w.name === 'unified-5h')!.reset).toBe(nextWindow);
    });

    it('overwrites existing windows when the snapshot is newer', () => {
      const store = new RateLimitStore();
      // Older header-sourced data.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1000));
      store.update('acc-1', { 'anthropic-ratelimit-unified-5h-utilization': '0.1' });
      vi.useRealTimers();
      // Newer claude.ai snapshot (fetchedAt = 2000 > lastUpdated = 1000).
      const synced = store.syncFromClaudeAiSnapshot('acc-1', {
        ...baseSnapshot(),
        fiveHourUtilization: 0.42,
        fetchedAt: 2000,
      });
      expect(synced).toBe(3);
      expect(store.getAll('acc-1').find((w) => w.name === 'unified-5h')?.utilization).toBeCloseTo(
        0.42,
      );
    });

    it('skips fields that have no data on the snapshot', () => {
      const store = new RateLimitStore();
      const synced = store.syncFromClaudeAiSnapshot('acc-1', {
        fiveHourUtilization: null,
        fiveHourResetsAt: null,
        sevenDayUtilization: 0.4,
        sevenDayResetsAt: null,
        sevenDaySonnetUtilization: null,
        sevenDaySonnetResetsAt: null,
        extraUsage: null,
        perUserBudget: null,
        fetchedAt: 1000,
      });
      expect(synced).toBe(1);
      const windows = store.getAll('acc-1');
      expect(windows.map((w) => w.name)).toEqual(['unified-7d']);
    });

    it('fires onUpdate callbacks with the synced windows', () => {
      const store = new RateLimitStore();
      const cb = vi.fn();
      store.onUpdate(cb);
      store.syncFromClaudeAiSnapshot('acc-1', baseSnapshot());
      expect(cb).toHaveBeenCalledTimes(1);
      const [accountId, windows] = cb.mock.calls[0]!;
      expect(accountId).toBe('acc-1');
      expect(windows).toHaveLength(3);
    });

    it('does not fire onUpdate when nothing was written', () => {
      const store = new RateLimitStore();
      // Pre-seed all three windows with a newer timestamp so the sync is a
      // no-op — no upserts.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(3000));
      store.update('acc-1', {
        'anthropic-ratelimit-unified-5h-utilization': '0.5',
        'anthropic-ratelimit-unified-7d-utilization': '0.5',
        'anthropic-ratelimit-unified-7d_sonnet-utilization': '0.5',
      });
      vi.useRealTimers();
      const cb = vi.fn();
      store.onUpdate(cb);
      const synced = store.syncFromClaudeAiSnapshot('acc-1', {
        ...baseSnapshot(),
        fetchedAt: 1000, // older than the existing windows
      });
      expect(synced).toBe(0);
      expect(cb).not.toHaveBeenCalled();
    });

    it('tolerates a malformed reset ISO string', () => {
      const store = new RateLimitStore();
      store.syncFromClaudeAiSnapshot('acc-1', {
        ...baseSnapshot(),
        fiveHourResetsAt: 'not-a-date',
      });
      expect(store.getAll('acc-1').find((w) => w.name === 'unified-5h')?.reset).toBeNull();
    });

    it('preserves an existing reset when the sync payload has none', () => {
      // Regression: claude.ai snapshots occasionally arrive with
      // fiveHourResetsAt=null. The sync used to REPLACE the entire window,
      // wiping a reset timestamp the proxy-header path had already captured.
      // Alert dedup keys on reset, so the wipe made the next header update
      // look like a fresh window and re-fired the alert.
      const store = new RateLimitStore();
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1000));
      store.update('acc-1', {
        'anthropic-ratelimit-unified-5h-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.5',
        'anthropic-ratelimit-unified-5h-reset': '1776909600',
      });
      vi.useRealTimers();

      store.syncFromClaudeAiSnapshot('acc-1', {
        ...baseSnapshot(),
        fiveHourUtilization: 0.6,
        fiveHourResetsAt: null,
        fetchedAt: 2000,
      });

      const fiveHour = store.getAll('acc-1').find((w) => w.name === 'unified-5h');
      expect(fiveHour?.reset).toBe(1_776_909_600);
      expect(fiveHour?.utilization).toBeCloseTo(0.6);
    });

    it('preserves an existing inUse flag when the sync passes null', () => {
      // Sync always passes inUse=null for unified-5h/7d/7d_sonnet (those
      // windows don't carry that flag in the claude.ai snapshot). The
      // overage window's header-derived inUse=false is load-bearing for
      // the overage state machine; sync must not wipe it.
      const store = new RateLimitStore();
      vi.useFakeTimers();
      vi.setSystemTime(new Date(1000));
      store.update('acc-1', {
        'anthropic-ratelimit-unified-overage-status': 'allowed',
        'anthropic-ratelimit-unified-overage-in-use': 'false',
      });
      vi.useRealTimers();

      store.syncFromClaudeAiSnapshot('acc-1', {
        ...baseSnapshot(),
        extraUsage: {
          isEnabled: true,
          limitUsd: 100,
          usedUsd: 50,
          utilizationPct: 50,
          currency: 'USD',
        },
        fetchedAt: 2000,
      });

      const overage = store.getAll('acc-1').find((w) => w.name === 'unified-overage');
      expect(overage?.inUse).toBe(false);
    });
  });
});
