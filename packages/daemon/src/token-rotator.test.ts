import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import { getDb, closeDb, upsertAccount } from './db.js';
import { RateLimitStore } from './rate-limit-store.js';
import { TokenRotator } from './token-rotator.js';
import * as accounts from './accounts.js';

const TEST_DB = () =>
  join(tmpdir(), `sentinel-rotator-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function seed(db: ReturnType<typeof getDb>, id: string, email: string): void {
  upsertAccount(db, {
    id,
    accountUuid: id,
    email,
    displayName: email,
    orgUuid: '',
    orgName: '',
    planType: 'max',
    isActive: false,
    createdAt: Date.now(),
    color: null,
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
    rotator.pick();
    rotator.pick();
    rotator.pick();
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
      accessToken: 'active-tok',
      refreshToken: '',
      expiresAt: 0,
      scopes: [],
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

  it('prefers the lower-utilization account until the gap closes', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    seed(db, 'b', 'b@x');
    const store = new RateLimitStore();
    store.update('a', { 'anthropic-ratelimit-unified-5h-utilization': '0.9' });
    store.update('b', { 'anthropic-ratelimit-unified-5h-utilization': '0.26' });
    const rotator = new TokenRotator(db, store, { value: 'a' });
    // The gap (64 points) is well outside the 1% tie band, so every pick
    // should route to `b` until utilizations converge.
    expect(rotator.pick()?.accountId).toBe('b');
    expect(rotator.pick()?.accountId).toBe('b');
    expect(rotator.pick()?.accountId).toBe('b');
  });

  it('round-robins within the 1% tie band when accounts are converged', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    seed(db, 'b', 'b@x');
    const store = new RateLimitStore();
    // 0.5 points apart — both inside the 1% band.
    store.update('a', { 'anthropic-ratelimit-unified-5h-utilization': '0.500' });
    store.update('b', { 'anthropic-ratelimit-unified-5h-utilization': '0.505' });
    const rotator = new TokenRotator(db, store, { value: 'a' });
    const ids = [
      rotator.pick()?.accountId,
      rotator.pick()?.accountId,
      rotator.pick()?.accountId,
      rotator.pick()?.accountId,
    ];
    // Both accounts must appear in any 4-pick window, and the cycle repeats.
    expect(new Set(ids)).toEqual(new Set(['a', 'b']));
    expect(ids[0]).toBe(ids[2]);
    expect(ids[1]).toBe(ids[3]);
  });

  it('treats missing utilization as 0 so fresh accounts are preferred', () => {
    const db = getDb(dbPath);
    seed(db, 'fresh', 'fresh@x');
    seed(db, 'hot', 'hot@x');
    const store = new RateLimitStore();
    store.update('hot', { 'anthropic-ratelimit-unified-5h-utilization': '0.5' });
    const rotator = new TokenRotator(db, store, { value: 'fresh' });
    // `fresh` has no rate-limit data → scored as 0 and picked every time.
    expect(rotator.pick()?.accountId).toBe('fresh');
    expect(rotator.pick()?.accountId).toBe('fresh');
  });

  it('omits accounts listed in getExcludedIds from the pool', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    seed(db, 'b', 'b@x');
    seed(db, 'c', 'c@x');
    const store = new RateLimitStore();
    const excluded = new Set<string>(['b']);
    const rotator = new TokenRotator(db, store, { value: 'a' }, () => excluded);
    expect(rotator.size()).toBe(2);
    const ids = [rotator.pick()?.accountId, rotator.pick()?.accountId];
    expect(new Set(ids)).toEqual(new Set(['a', 'c']));
  });

  it('returns null when every account is excluded', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    seed(db, 'b', 'b@x');
    const store = new RateLimitStore();
    const excluded = new Set<string>(['a', 'b']);
    const rotator = new TokenRotator(db, store, { value: 'a' }, () => excluded);
    expect(rotator.size()).toBe(0);
    expect(rotator.pick()).toBeNull();
  });

  it('re-reads the excluded set on each refresh() so toggles take effect', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    seed(db, 'b', 'b@x');
    const store = new RateLimitStore();
    const excluded = new Set<string>();
    const rotator = new TokenRotator(db, store, { value: 'a' }, () => excluded);
    expect(rotator.size()).toBe(2);

    excluded.add('a');
    rotator.refresh();
    expect(rotator.size()).toBe(1);
    expect(rotator.pick()?.accountId).toBe('b');

    excluded.delete('a');
    rotator.refresh();
    expect(rotator.size()).toBe(2);
  });

  it('skips blocked accounts even when they would be the minimum', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    seed(db, 'b', 'b@x');
    const store = new RateLimitStore();
    // `a` is 0% utilization (would be the min) but blocked — must be skipped.
    store.update('a', {
      'anthropic-ratelimit-unified-5h-status': 'blocked',
      'anthropic-ratelimit-unified-5h-utilization': '0.0',
    });
    store.update('b', { 'anthropic-ratelimit-unified-5h-utilization': '0.5' });
    const rotator = new TokenRotator(db, store, { value: 'a' });
    expect(rotator.pick()?.accountId).toBe('b');
    expect(rotator.pick()?.accountId).toBe('b');
  });
});

describe('TokenRotator (earliest-reset strategy)', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = TEST_DB();
    vi.spyOn(accounts, 'readSentinelCredentials').mockImplementation((key: string) => ({
      accessToken: `tok-${key}`,
      refreshToken: '',
      expiresAt: 0,
      scopes: [],
    }));
    vi.spyOn(accounts, 'readActiveCredentials').mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  function setResetAndUtil(
    store: RateLimitStore,
    accountId: string,
    reset: number,
    utilization = 0.5,
  ): void {
    store.update(accountId, {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': String(utilization),
      'anthropic-ratelimit-unified-5h-reset': String(reset),
    });
  }

  it('picks the account whose window resets soonest, ignoring utilization', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    seed(db, 'b', 'b@x');
    const store = new RateLimitStore();
    // `a` resets later but has low utilization; `b` resets soonest.
    setResetAndUtil(store, 'a', 1_000_000, 0.1);
    setResetAndUtil(store, 'b', 500_000, 0.9);
    const rotator = new TokenRotator(
      db,
      store,
      { value: 'a' },
      () => new Set(),
      () => 'earliest-reset',
    );
    expect(rotator.pick()?.accountId).toBe('b');
  });

  it('sticks to the same account across sequential picks (no cursor advance)', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    seed(db, 'b', 'b@x');
    seed(db, 'c', 'c@x');
    const store = new RateLimitStore();
    setResetAndUtil(store, 'a', 3_000);
    setResetAndUtil(store, 'b', 1_000); // soonest
    setResetAndUtil(store, 'c', 2_000);
    const rotator = new TokenRotator(
      db,
      store,
      { value: 'a' },
      () => new Set(),
      () => 'earliest-reset',
    );
    expect(rotator.pick()?.accountId).toBe('b');
    expect(rotator.pick()?.accountId).toBe('b');
    expect(rotator.pick()?.accountId).toBe('b');
  });

  it('deprioritizes accounts with no reset data (treated as +Infinity)', () => {
    const db = getDb(dbPath);
    seed(db, 'known', 'k@x');
    seed(db, 'unknown', 'u@x');
    const store = new RateLimitStore();
    // `known` has a reset; `unknown` has no rate-limit data at all.
    setResetAndUtil(store, 'known', 10_000, 0.9);
    const rotator = new TokenRotator(
      db,
      store,
      { value: 'known' },
      () => new Set(),
      () => 'earliest-reset',
    );
    expect(rotator.pick()?.accountId).toBe('known');
  });

  it('skips blocked accounts even when their reset is earliest', () => {
    const db = getDb(dbPath);
    seed(db, 'blocked', 'b@x');
    seed(db, 'ok', 'o@x');
    const store = new RateLimitStore();
    // `blocked` would win by reset time but is blocked — skip.
    store.update('blocked', {
      'anthropic-ratelimit-unified-5h-status': 'blocked',
      'anthropic-ratelimit-unified-5h-utilization': '1.0',
      'anthropic-ratelimit-unified-5h-reset': '100',
    });
    setResetAndUtil(store, 'ok', 9_999);
    const rotator = new TokenRotator(
      db,
      store,
      { value: 'ok' },
      () => new Set(),
      () => 'earliest-reset',
    );
    expect(rotator.pick()?.accountId).toBe('ok');
  });

  it('breaks reset ties by lower utilization', () => {
    const db = getDb(dbPath);
    seed(db, 'hot', 'h@x');
    seed(db, 'cold', 'c@x');
    const store = new RateLimitStore();
    setResetAndUtil(store, 'hot', 500, 0.99);
    setResetAndUtil(store, 'cold', 500, 0.1);
    const rotator = new TokenRotator(
      db,
      store,
      { value: 'hot' },
      () => new Set(),
      () => 'earliest-reset',
    );
    expect(rotator.pick()?.accountId).toBe('cold');
  });

  it('honours live strategy changes between picks', () => {
    const db = getDb(dbPath);
    seed(db, 'fresh', 'f@x');
    seed(db, 'soon', 's@x');
    const store = new RateLimitStore();
    // `fresh` has lower utilization (balance wants it); `soon` resets earliest (earliest-reset wants it).
    setResetAndUtil(store, 'fresh', 9_000, 0.1);
    setResetAndUtil(store, 'soon', 1_000, 0.8);

    let strategy: 'balance' | 'earliest-reset' = 'balance';
    const rotator = new TokenRotator(
      db,
      store,
      { value: 'fresh' },
      () => new Set(),
      () => strategy,
    );
    expect(rotator.pick()?.accountId).toBe('fresh');
    strategy = 'earliest-reset';
    expect(rotator.pick()?.accountId).toBe('soon');
    strategy = 'balance';
    expect(rotator.pick()?.accountId).toBe('fresh');
  });

  it('returns null when every account is blocked in earliest-reset mode', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    seed(db, 'b', 'b@x');
    const store = new RateLimitStore();
    store.update('a', {
      'anthropic-ratelimit-unified-5h-status': 'blocked',
      'anthropic-ratelimit-unified-5h-reset': '100',
    });
    store.update('b', {
      'anthropic-ratelimit-unified-5h-status': 'blocked',
      'anthropic-ratelimit-unified-5h-reset': '200',
    });
    const rotator = new TokenRotator(
      db,
      store,
      { value: 'a' },
      () => new Set(),
      () => 'earliest-reset',
    );
    expect(rotator.pick()).toBeNull();
  });
});

describe('TokenRotator overage gate', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = TEST_DB();
    vi.spyOn(accounts, 'readSentinelCredentials').mockImplementation((key: string) => ({
      accessToken: `tok-${key}`,
      refreshToken: '',
      expiresAt: 0,
      scopes: [],
    }));
    vi.spyOn(accounts, 'readActiveCredentials').mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  function setSession(store: RateLimitStore, id: string, util: number, reset = 1_000): void {
    store.update(id, {
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': String(util),
      'anthropic-ratelimit-unified-5h-reset': String(reset),
    });
  }

  function setOverage(
    store: RateLimitStore,
    id: string,
    opts: { status?: 'allowed' | 'disabled' | null; inUse?: boolean | null; reset?: number } = {},
  ): void {
    const { status = 'allowed', inUse = null, reset } = opts;
    const headers: Record<string, string> = {};
    if (status != null) headers['anthropic-ratelimit-unified-overage-status'] = status;
    if (inUse != null) headers['anthropic-ratelimit-unified-overage-in-use'] = String(inUse);
    if (reset != null) headers['anthropic-ratelimit-unified-overage-reset'] = String(reset);
    store.update(id, headers);
  }

  it('prefers non-overage accounts even in earliest-reset when another pool member is saturated', () => {
    const db = getDb(dbPath);
    seed(db, 'fresh', 'f@x');
    seed(db, 'hot', 'h@x');
    const store = new RateLimitStore();
    // `hot` is saturated with overage allowed (would use overage), `fresh` has headroom.
    setSession(store, 'hot', 1.0, 500);
    setOverage(store, 'hot', { status: 'allowed' });
    setSession(store, 'fresh', 0.2, 9_000);

    const rotator = new TokenRotator(
      db,
      store,
      { value: 'fresh' },
      () => new Set(),
      () => 'earliest-reset',
      () => new Set(['hot']), // opted in — but shouldn't matter when fresh exists
    );
    // `hot` resets earlier (500 vs 9000) but would draw overage — must skip.
    expect(rotator.pick()?.accountId).toBe('fresh');
    expect(rotator.pick()?.accountId).toBe('fresh');
  });

  it('skips a saturated account that is NOT in the overage allow-list', () => {
    const db = getDb(dbPath);
    seed(db, 'saturated', 's@x');
    seed(db, 'spare', 'p@x');
    const store = new RateLimitStore();
    setSession(store, 'saturated', 1.0);
    setOverage(store, 'saturated', { status: 'allowed' });
    setSession(store, 'spare', 0.5);

    const rotator = new TokenRotator(
      db,
      store,
      { value: 'spare' },
      () => new Set(),
      () => 'balance',
      () => new Set(), // no overage-allowed accounts
    );
    expect(rotator.pick()?.accountId).toBe('spare');
    expect(rotator.pick()?.accountId).toBe('spare');
  });

  it('falls through to an overage-opted-in account when no fresh candidates remain', () => {
    const db = getDb(dbPath);
    seed(db, 'only', 'o@x');
    const store = new RateLimitStore();
    // Single account, saturated, overage allowed + opted in.
    setSession(store, 'only', 1.0);
    setOverage(store, 'only', { status: 'allowed' });

    const rotator = new TokenRotator(
      db,
      store,
      { value: 'only' },
      () => new Set(),
      () => 'balance',
      () => new Set(['only']),
    );
    expect(rotator.pick()?.accountId).toBe('only');
  });

  it('returns null when the only saturated account is not opted into overage', () => {
    const db = getDb(dbPath);
    seed(db, 'only', 'o@x');
    const store = new RateLimitStore();
    setSession(store, 'only', 1.0);
    setOverage(store, 'only', { status: 'allowed' });

    const rotator = new TokenRotator(
      db,
      store,
      { value: 'only' },
      () => new Set(),
      () => 'balance',
      () => new Set(),
    );
    expect(rotator.pick()).toBeNull();
  });

  it('treats overage.inUse=true as "will use overage" regardless of 5h utilization', () => {
    const db = getDb(dbPath);
    seed(db, 'inuse', 'i@x');
    seed(db, 'spare', 'p@x');
    const store = new RateLimitStore();
    // `inuse` has low 5h util but is already drawing on overage (e.g. previous
    // request tripped it). Must be skipped unless opted in.
    setSession(store, 'inuse', 0.3);
    setOverage(store, 'inuse', { status: 'allowed', inUse: true });
    setSession(store, 'spare', 0.5);

    const rotator = new TokenRotator(
      db,
      store,
      { value: 'spare' },
      () => new Set(),
      () => 'balance',
      () => new Set(),
    );
    expect(rotator.pick()?.accountId).toBe('spare');
    expect(rotator.pick()?.accountId).toBe('spare');
  });

  it('does not treat saturated accounts as overage when overage-status is not "allowed"', () => {
    // An account at 100% util with overage disabled is not "about to spend
    // overage" — it's just exhausted. The rotator's existing blocked-status
    // skip covers that case; the overage gate should NOT claim it.
    const db = getDb(dbPath);
    seed(db, 'exhausted', 'e@x');
    const store = new RateLimitStore();
    setSession(store, 'exhausted', 1.0);
    setOverage(store, 'exhausted', { status: 'disabled' });

    const rotator = new TokenRotator(
      db,
      store,
      { value: 'exhausted' },
      () => new Set(),
      () => 'balance',
      () => new Set(), // not opted in
    );
    // `exhausted` has overage disabled so isn't "will use overage" — the
    // rotator keeps it in the fresh tier and picks it (the proxy will then
    // observe Anthropic's 429 and the overage machine will react).
    expect(rotator.pick()?.accountId).toBe('exhausted');
  });

  it('skips paused accounts entirely (paused wins over any other gate)', () => {
    const db = getDb(dbPath);
    seed(db, 'paused', 'p@x');
    seed(db, 'active', 'a@x');
    const store = new RateLimitStore();
    setSession(store, 'paused', 0.0); // low util — would be preferred
    setSession(store, 'active', 0.5);

    const rotator = new TokenRotator(
      db,
      store,
      { value: 'active' },
      () => new Set(),
      () => 'balance',
      () => new Set(),
      () => new Set(['paused']),
    );
    expect(rotator.pick()?.accountId).toBe('active');
    expect(rotator.pick()?.accountId).toBe('active');
  });

  it('returns null when every account is paused', () => {
    const db = getDb(dbPath);
    seed(db, 'a', 'a@x');
    seed(db, 'b', 'b@x');
    const store = new RateLimitStore();
    setSession(store, 'a', 0.1);
    setSession(store, 'b', 0.2);

    const rotator = new TokenRotator(
      db,
      store,
      { value: 'a' },
      () => new Set(),
      () => 'balance',
      () => new Set(),
      () => new Set(['a', 'b']),
    );
    expect(rotator.pick()).toBeNull();
  });

  it('drains the fresh tier across multiple picks before allowing overage to spill', () => {
    const db = getDb(dbPath);
    seed(db, 'fresh1', 'f1@x');
    seed(db, 'fresh2', 'f2@x');
    seed(db, 'hot', 'h@x');
    const store = new RateLimitStore();
    setSession(store, 'fresh1', 0.3);
    setSession(store, 'fresh2', 0.3);
    setSession(store, 'hot', 1.0);
    setOverage(store, 'hot', { status: 'allowed' });

    const rotator = new TokenRotator(
      db,
      store,
      { value: 'fresh1' },
      () => new Set(),
      () => 'balance',
      () => new Set(['hot']), // opted in, but fresh candidates exist
    );
    const picked = [rotator.pick(), rotator.pick(), rotator.pick(), rotator.pick()];
    for (const p of picked) {
      expect(p?.accountId).not.toBe('hot');
    }
  });

  // ── Configurable buffer ────────────────────────────────────────────
  // The overage gate now reads a live `overageBufferPct` getter instead of
  // using a hardcoded 99.5% threshold. These cases prove the threshold
  // tracks the buffer through the full documented range.

  it('buffer=10 excludes accounts at 91% util (default safety margin)', () => {
    const db = getDb(dbPath);
    seed(db, 'nearFull', 'n@x');
    seed(db, 'spare', 's@x');
    const store = new RateLimitStore();
    // 91% util + overage allowed → inside the 10% buffer, should skip.
    setSession(store, 'nearFull', 0.91);
    setOverage(store, 'nearFull', { status: 'allowed' });
    setSession(store, 'spare', 0.2);

    const rotator = new TokenRotator(
      db,
      store,
      { value: 'spare' },
      () => new Set(),
      () => 'balance',
      () => new Set(), // not opted in → must skip
      () => new Set(),
      () => 10, // default buffer
    );
    expect(rotator.pick()?.accountId).toBe('spare');
    expect(rotator.pick()?.accountId).toBe('spare');
  });

  it('buffer=10 still allows accounts below the 90% cut-off', () => {
    const db = getDb(dbPath);
    seed(db, 'below', 'b@x');
    const store = new RateLimitStore();
    setSession(store, 'below', 0.85);
    setOverage(store, 'below', { status: 'allowed' });

    const rotator = new TokenRotator(
      db,
      store,
      { value: 'below' },
      () => new Set(),
      () => 'balance',
      () => new Set(),
      () => new Set(),
      () => 10,
    );
    expect(rotator.pick()?.accountId).toBe('below');
  });

  it('buffer=0 preserves the legacy "only cut off at saturation" behavior', () => {
    const db = getDb(dbPath);
    seed(db, 'high', 'h@x');
    const store = new RateLimitStore();
    // 99% util + overage allowed. With buffer=0 (threshold=1.0) the account
    // is still pickable; any saner buffer would reject it.
    setSession(store, 'high', 0.99);
    setOverage(store, 'high', { status: 'allowed' });

    const rotator = new TokenRotator(
      db,
      store,
      { value: 'high' },
      () => new Set(),
      () => 'balance',
      () => new Set(),
      () => new Set(),
      () => 0,
    );
    expect(rotator.pick()?.accountId).toBe('high');
  });

  it('buffer=50 excludes accounts at 50% util and above', () => {
    const db = getDb(dbPath);
    seed(db, 'fifty', 'f@x');
    seed(db, 'low', 'l@x');
    const store = new RateLimitStore();
    setSession(store, 'fifty', 0.5);
    setOverage(store, 'fifty', { status: 'allowed' });
    setSession(store, 'low', 0.2);

    const rotator = new TokenRotator(
      db,
      store,
      { value: 'low' },
      () => new Set(),
      () => 'balance',
      () => new Set(),
      () => new Set(),
      () => 50,
    );
    expect(rotator.pick()?.accountId).toBe('low');
    expect(rotator.pick()?.accountId).toBe('low');
  });

  it('clamps out-of-range buffer values to [0, 50]', () => {
    const db = getDb(dbPath);
    seed(db, 'high', 'h@x');
    const store = new RateLimitStore();
    setSession(store, 'high', 0.6);
    setOverage(store, 'high', { status: 'allowed' });

    // Buffer = 99 (way out of range). Clamped to 50, so threshold = 0.5.
    // 60% util is above 0.5 → account should be skipped for the gate.
    const rotator = new TokenRotator(
      db,
      store,
      { value: 'high' },
      () => new Set(),
      () => 'balance',
      () => new Set(),
      () => new Set(),
      () => 99,
    );
    expect(rotator.pick()).toBeNull();
  });

  it('buffer gate ignores overage status=disabled (same as pre-fix)', () => {
    // Defensive: even a big buffer shouldn't treat a saturated-but-
    // overage-disabled account as "will burn overage" — there's no
    // overage to burn. Exactly-saturated + disabled still uses the
    // blocked-status skip, not our gate.
    const db = getDb(dbPath);
    seed(db, 'capped', 'c@x');
    const store = new RateLimitStore();
    setSession(store, 'capped', 0.95);
    setOverage(store, 'capped', { status: 'disabled' });

    const rotator = new TokenRotator(
      db,
      store,
      { value: 'capped' },
      () => new Set(),
      () => 'balance',
      () => new Set(),
      () => new Set(),
      () => 10,
    );
    expect(rotator.pick()?.accountId).toBe('capped');
  });
});
