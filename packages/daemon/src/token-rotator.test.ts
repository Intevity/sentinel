import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import { getDb, closeDb, upsertAccount } from './db.js';
import { RateLimitStore } from './rate-limit-store.js';
import { TokenRotator } from './token-rotator.js';
import * as accounts from './accounts.js';

const TEST_DB = () => join(tmpdir(), `sentinel-rotator-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function seed(db: ReturnType<typeof getDb>, id: string, email: string): void {
  upsertAccount(db, {
    id, accountUuid: id, email, displayName: email, orgUuid: '', orgName: '',
    planType: 'max', isActive: false, createdAt: Date.now(),
  });
}

describe('TokenRotator', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = TEST_DB();
    // Mock credential reads — the real ones hit the OS keychain.
    vi.spyOn(accounts, 'readSentinelCredentials').mockImplementation((key: string) => {
      // Every account in the DB is assumed to have creds — return a token derived
      // from the key so tests can assert which one was picked.
      return { accessToken: `tok-${key}`, refreshToken: '', expiresAt: 0, scopes: [] };
    });
    vi.spyOn(accounts, 'readActiveCredentials').mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('returns null when the pool is empty', () => {
    const db = getDb(dbPath);
    const store = new RateLimitStore();
    const rotator = new TokenRotator(db, store, { value: 'none' });
    expect(rotator.size()).toBe(0);
    expect(rotator.pick()).toBeNull();
  });

  it('rotates through accounts in deterministic order', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    seed(db, 'b', 'b@x');
    seed(db, 'c', 'c@x');
    const store = new RateLimitStore();
    const rotator = new TokenRotator(db, store, { value: 'a' });
    expect(rotator.size()).toBe(3);

    const picked = [rotator.pick(), rotator.pick(), rotator.pick(), rotator.pick()];
    const ids = picked.map((p) => p?.accountId);
    // Cycle repeats after N picks
    expect(ids[0]).toBe(ids[3]);
    // All three accounts seen in one cycle
    expect(new Set(ids.slice(0, 3))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('skips accounts whose rate-limit store shows blocked status', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    seed(db, 'b', 'b@x');
    const store = new RateLimitStore();
    // Mark account "a" as blocked.
    store.update('a', {
      'anthropic-ratelimit-unified-5h-status': 'blocked',
      'anthropic-ratelimit-unified-5h-utilization': '1.0',
    });
    const rotator = new TokenRotator(db, store, { value: 'a' });
    // Three picks in a row should all land on "b".
    expect(rotator.pick()?.accountId).toBe('b');
    expect(rotator.pick()?.accountId).toBe('b');
    expect(rotator.pick()?.accountId).toBe('b');
  });

  it('returns null when every account is blocked', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    seed(db, 'b', 'b@x');
    const store = new RateLimitStore();
    store.update('a', { 'anthropic-ratelimit-unified-5h-status': 'blocked' });
    store.update('b', { 'anthropic-ratelimit-unified-5h-status': 'blocked' });
    const rotator = new TokenRotator(db, store, { value: 'a' });
    expect(rotator.pick()).toBeNull();
  });

  it('refresh picks up newly-added accounts', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    const store = new RateLimitStore();
    const rotator = new TokenRotator(db, store, { value: 'a' });
    expect(rotator.size()).toBe(1);
    seed(db, 'b', 'b@x');
    rotator.refresh();
    expect(rotator.size()).toBe(2);
  });

  it('refresh picks up account removals without going out of bounds', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    seed(db, 'b', 'b@x');
    seed(db, 'c', 'c@x');
    const store = new RateLimitStore();
    const rotator = new TokenRotator(db, store, { value: 'a' });
    // Advance cursor to end.
    rotator.pick(); rotator.pick(); rotator.pick();
    // Remove two accounts.
    db.prepare('DELETE FROM accounts WHERE id = ?').run('b');
    db.prepare('DELETE FROM accounts WHERE id = ?').run('c');
    rotator.refresh();
    expect(rotator.size()).toBe(1);
    expect(rotator.pick()?.accountId).toBe('a');
  });

  it('falls back to readActiveCredentials for the active account', () => {
    const db = getDb(dbPath);
    seed(db, 'active', 'a@x');
    // Sentinel store doesn't have creds for this key.
    vi.spyOn(accounts, 'readSentinelCredentials').mockReturnValue(null);
    vi.spyOn(accounts, 'readActiveCredentials').mockReturnValue({
      accessToken: 'active-tok', refreshToken: '', expiresAt: 0, scopes: [],
    });
    const store = new RateLimitStore();
    const rotator = new TokenRotator(db, store, { value: 'active' });
    expect(rotator.size()).toBe(1);
    expect(rotator.pick()?.token).toBe('active-tok');
  });

  it('excludes accounts that have no credentials anywhere', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    seed(db, 'b', 'b@x');
    vi.spyOn(accounts, 'readSentinelCredentials').mockImplementation((key: string) =>
      key === 'a' ? { accessToken: 'tok-a', refreshToken: '', expiresAt: 0, scopes: [] } : null,
    );
    vi.spyOn(accounts, 'readActiveCredentials').mockReturnValue(null);
    const store = new RateLimitStore();
    const rotator = new TokenRotator(db, store, { value: 'a' });
    expect(rotator.size()).toBe(1);
    expect(rotator.pick()?.accountId).toBe('a');
  });
});
