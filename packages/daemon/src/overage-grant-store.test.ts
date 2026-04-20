import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { OverageGrantStore } from './overage-grant-store.js';

function tempClaudeJson(): string {
  const dir = join(tmpdir(), `sentinel-grant-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, '.claude.json');
}

describe('OverageGrantStore', () => {
  let path: string;

  beforeEach(() => { path = tempClaudeJson(); });
  afterEach(() => {
    const dir = join(path, '..');
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty map when the claude.json file is missing', () => {
    const store = new OverageGrantStore(path);
    store.load();
    expect(store.getAll()).toEqual({});
    expect(store.getOne('anything')).toBe(null);
  });

  it('returns empty map when the file has no overageCreditGrantCache key', () => {
    writeFileSync(path, JSON.stringify({ oauthAccount: { accountUuid: 'a' } }), 'utf-8');
    const store = new OverageGrantStore(path);
    store.load();
    expect(store.getAll()).toEqual({});
  });

  it('loads valid grant entries keyed by accountUuid (Anthropic nested shape)', () => {
    writeFileSync(path, JSON.stringify({
      overageCreditGrantCache: {
        'uuid-a': {
          info: {
            available: 500, eligible: 1000, granted: 1000,
            amount_minor_units: 2000, currency: 'USD',
          },
          timestamp: 1700000000000,
        },
      },
    }), 'utf-8');
    const store = new OverageGrantStore(path);
    store.load();
    const grant = store.getOne('uuid-a');
    expect(grant).not.toBeNull();
    expect(grant?.available).toBe(500);
    expect(grant?.granted).toBe(1000);
    expect(grant?.amountMinorUnits).toBe(2000);
    expect(grant?.currency).toBe('USD');
  });

  it('still parses legacy flat camelCase shape for back-compat', () => {
    writeFileSync(path, JSON.stringify({
      overageCreditGrantCache: {
        'uuid-a': {
          available: 100, eligible: 200, granted: 200,
          amountMinorUnits: 400, currency: 'USD',
        },
      },
    }), 'utf-8');
    const store = new OverageGrantStore(path);
    store.load();
    expect(store.getOne('uuid-a')?.granted).toBe(200);
  });

  it('skips entries where the grant is not provisioned (all-false info)', () => {
    // This is the most common real-world shape — an account with no overage
    // set up has `{ available: false, eligible: false, granted: false, ... }`.
    writeFileSync(path, JSON.stringify({
      overageCreditGrantCache: {
        'uuid-none': {
          info: {
            available: false, eligible: false, granted: false,
            amount_minor_units: null, currency: null,
          },
          timestamp: 1700000000000,
        },
      },
    }), 'utf-8');
    const store = new OverageGrantStore(path);
    store.load();
    expect(store.getAll()).toEqual({});
  });

  it('skips malformed entries without throwing', () => {
    writeFileSync(path, JSON.stringify({
      overageCreditGrantCache: {
        'uuid-ok': {
          info: { available: 1, eligible: 1, granted: 1, amount_minor_units: 100, currency: 'USD' },
        },
        'uuid-missing-field': {
          info: { available: 1, granted: 1, amount_minor_units: 100, currency: 'USD' },
        },
        'uuid-bad-number': {
          info: { available: 'nope', eligible: 1, granted: 1, amount_minor_units: 100, currency: 'USD' },
        },
        '': {
          info: { available: 1, eligible: 1, granted: 1, amount_minor_units: 100, currency: 'USD' },
        },
        'uuid-null': null,
      },
    }), 'utf-8');
    const store = new OverageGrantStore(path);
    store.load();
    expect(Object.keys(store.getAll())).toEqual(['uuid-ok']);
  });

  it('fires onUpdate subscribers when contents change', () => {
    const store = new OverageGrantStore(path);
    const seen: Array<Record<string, unknown>> = [];
    store.onUpdate((g) => { seen.push(g); });

    // Initial load, empty
    store.load();
    expect(seen).toEqual([]);

    // First real data
    writeFileSync(path, JSON.stringify({
      overageCreditGrantCache: {
        'uuid-a': { available: 1, eligible: 1, granted: 1, amountMinorUnits: 100, currency: 'USD' },
      },
    }), 'utf-8');
    store.load();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.['uuid-a']).toBeDefined();

    // Same contents — no re-fire
    store.load();
    expect(seen).toHaveLength(1);

    // Value change — fires again
    writeFileSync(path, JSON.stringify({
      overageCreditGrantCache: {
        'uuid-a': { available: 500, eligible: 1, granted: 1, amountMinorUnits: 100, currency: 'USD' },
      },
    }), 'utf-8');
    store.load();
    expect(seen).toHaveLength(2);
  });

  it('reloads when grants are removed from the file', () => {
    writeFileSync(path, JSON.stringify({
      overageCreditGrantCache: {
        'uuid-a': { available: 1, eligible: 1, granted: 1, amountMinorUnits: 100, currency: 'USD' },
      },
    }), 'utf-8');
    const store = new OverageGrantStore(path);
    store.load();
    expect(store.getOne('uuid-a')).not.toBeNull();

    writeFileSync(path, JSON.stringify({ overageCreditGrantCache: {} }), 'utf-8');
    store.load();
    expect(store.getAll()).toEqual({});
  });

  it('treats a non-object overageCreditGrantCache as empty', () => {
    writeFileSync(path, JSON.stringify({ overageCreditGrantCache: 'garbage' }), 'utf-8');
    const store = new OverageGrantStore(path);
    store.load();
    expect(store.getAll()).toEqual({});
  });
});
