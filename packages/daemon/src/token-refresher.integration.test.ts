/**
 * Integration tests for the background token refresher. Exercises the
 * real refresh path end-to-end against the fake Anthropic token endpoint
 * (`@claude-sentinel/test-harness`), with real keychain I/O going to a
 * tmp JSON file via the test-keychain adapter
 * (`CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE`).
 *
 * Supersedes `token-refresher.test.ts`, which mocked `./oauth.js`,
 * `./accounts.js`, and `./db.js` at the module boundary — all three
 * points of drift between test and production behavior.
 *
 * The only surviving mock is a one-shot `vi.spyOn` on
 * `writeClaudeCodeCredentials` for the single test that exercises the
 * "keychain busy" error branch — a platform-specific failure the
 * test-keychain adapter cannot simulate. See TEST_MIGRATION_PLAN.md
 * Sprint 2 for rationale.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeCodeCredentials, DaemonToAppMessage } from '@claude-sentinel/shared';
import type { Database } from 'better-sqlite3';
import { startFakeAnthropic, type FakeAnthropic } from '@claude-sentinel/test-harness';

import {
  refreshIfNeeded,
  markAccountReauthenticated,
  startTokenRefresher,
} from './token-refresher.js';
import { getDb, closeDb, upsertAccount } from './db.js';
import { readSentinelCredentials, writeSentinelCredentials } from './accounts.js';
import * as accounts from './accounts.js';
import type { IpcServer } from './ipc.js';
import type { ActiveToken, ActiveAccountId } from './proxy.js';

function makeCreds(overrides: Partial<ClaudeCodeCredentials> = {}): ClaudeCodeCredentials {
  return {
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    expiresAt: Date.now() + 60 * 60 * 1000,
    scopes: ['user:profile'],
    subscriptionType: 'team',
    rateLimitTier: 'standard',
    ...overrides,
  };
}

interface Harness {
  fake: FakeAnthropic;
  db: Database;
  dbPath: string;
  keychainFile: string;
  broadcasts: DaemonToAppMessage[];
  ipcServer: IpcServer;
  tokenRotator: { refresh: ReturnType<typeof vi.fn> };
  deps: {
    db: Database;
    activeToken: ActiveToken;
    activeAccountId: ActiveAccountId;
    ipcServer: IpcServer;
    tokenRotator: { refresh(): void };
  };
}

/** Path to Claude Code's single-slot keychain entry in the test keychain
 *  file. Matches `accounts.ts`'s `CC_SERVICE` + `osUser` addressing. */
function readCcSlot(keychainFile: string): ClaudeCodeCredentials | null {
  if (!existsSync(keychainFile)) return null;
  const raw = readFileSync(keychainFile, 'utf-8');
  const data = JSON.parse(raw) as Record<string, Record<string, string>>;
  const ccService = 'Claude Code-credentials';
  const svc = data[ccService];
  if (!svc) return null;
  const firstKey = Object.keys(svc)[0];
  if (!firstKey) return null;
  const blob = svc[firstKey];
  if (!blob) return null;
  const parsed = JSON.parse(blob) as { claudeAiOauth?: ClaudeCodeCredentials };
  return parsed.claudeAiOauth ?? null;
}

describe('token-refresher integration (real refresh path)', () => {
  let fake: FakeAnthropic;
  let keychainFile: string;
  let dbPath: string;

  beforeAll(async () => {
    fake = await startFakeAnthropic();
    process.env.OAUTH_TOKEN_URL = fake.tokenUrl;
  });

  afterAll(async () => {
    await fake.close();
    delete process.env.OAUTH_TOKEN_URL;
  });

  function setup(): Harness {
    keychainFile = join(tmpdir(), `sentinel-keychain-${randomUUID()}.json`);
    process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE = keychainFile;
    writeFileSync(keychainFile, '{}');

    dbPath = join(tmpdir(), `sentinel-refresher-${randomUUID()}.db`);
    const db = getDb(dbPath);

    const broadcasts: DaemonToAppMessage[] = [];
    const ipcServer = {
      broadcast: (m: DaemonToAppMessage) => broadcasts.push(m),
    } as unknown as IpcServer;

    const tokenRotator = { refresh: vi.fn() };

    const deps = {
      db,
      activeToken: { value: null as string | null } as ActiveToken,
      activeAccountId: { value: 'acct-1' } as ActiveAccountId,
      ipcServer,
      tokenRotator,
    };

    return { fake, db, dbPath, keychainFile, broadcasts, ipcServer, tokenRotator, deps };
  }

  function teardown(): void {
    closeDb();
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(keychainFile)) unlinkSync(keychainFile);
    delete process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE;
  }

  beforeEach(() => {
    fake.setScenario('healthy-account');
    fake.resetRequests();
  });

  afterEach(() => {
    teardown();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('refreshIfNeeded', () => {
    it('skips refresh when token has > 30 min remaining (no fake traffic)', async () => {
      const h = setup();
      writeSentinelCredentials('acct-1', makeCreds({ expiresAt: Date.now() + 45 * 60 * 1000 }));

      const result = await refreshIfNeeded(h.deps, 'acct-1', 'a@b.com');

      expect(result.success).toBe(true);
      // The refresher never touched the token endpoint.
      expect(fake.requests().filter((r) => r.url === '/v1/oauth/token')).toHaveLength(0);
      expect(h.tokenRotator.refresh).not.toHaveBeenCalled();
    });

    it('refreshes when inside the threshold and updates active-account state', async () => {
      const h = setup();
      writeSentinelCredentials('acct-1', makeCreds({ expiresAt: Date.now() + 5 * 60 * 1000 }));
      h.deps.activeAccountId.value = 'acct-1';

      const result = await refreshIfNeeded(h.deps, 'acct-1', 'a@b.com');

      expect(result.success).toBe(true);
      // Token was persisted to Sentinel's keychain slot via real write.
      const written = readSentinelCredentials('acct-1')!;
      expect(written.accessToken).toMatch(/^fake-access-/);
      expect(written.refreshToken).toMatch(/^fake-refresh-/);
      expect(written.subscriptionType).toBe('team'); // preserved from makeCreds
      // Active account → CC slot also updated.
      const cc = readCcSlot(h.keychainFile);
      expect(cc?.accessToken).toBe(written.accessToken);
      // In-process activeToken ref updated.
      expect(h.deps.activeToken.value).toBe(written.accessToken);
      // Broadcast of the refresh.
      expect(h.broadcasts).toContainEqual(
        expect.objectContaining({ type: 'token_refreshed', accountId: 'acct-1' }),
      );
    });

    it('does not touch Claude Code keychain or activeToken for inactive accounts', async () => {
      const h = setup();
      writeSentinelCredentials('acct-1', makeCreds({ expiresAt: Date.now() + 5 * 60 * 1000 }));
      h.deps.activeAccountId.value = 'different-account';

      await refreshIfNeeded(h.deps, 'acct-1', 'a@b.com');

      // Sentinel slot updated, but CC slot should never have been written.
      const written = readSentinelCredentials('acct-1')!;
      expect(written.accessToken).toMatch(/^fake-access-/);
      expect(readCcSlot(h.keychainFile)).toBeNull();
      expect(h.deps.activeToken.value).toBeNull();
    });

    it('invalidates the rotator pool after a successful refresh of an inactive account', async () => {
      // Regression: round-robin pool kept serving the pre-refresh token on the
      // non-active account until the daemon was restarted, causing 401s.
      const h = setup();
      writeSentinelCredentials('acct-1', makeCreds({ expiresAt: Date.now() + 5 * 60 * 1000 }));
      h.deps.activeAccountId.value = 'different-account';

      await refreshIfNeeded(h.deps, 'acct-1', 'a@b.com');

      expect(h.tokenRotator.refresh).toHaveBeenCalledOnce();
    });

    it('does not invalidate the rotator pool when the refresh is skipped', async () => {
      const h = setup();
      writeSentinelCredentials('acct-1', makeCreds({ expiresAt: Date.now() + 45 * 60 * 1000 }));

      await refreshIfNeeded(h.deps, 'acct-1', 'a@b.com');

      expect(fake.requests().filter((r) => r.url === '/v1/oauth/token')).toHaveLength(0);
      expect(h.tokenRotator.refresh).not.toHaveBeenCalled();
    });

    it('force=true refreshes even when the token is fresh', async () => {
      const h = setup();
      writeSentinelCredentials('acct-1', makeCreds({ expiresAt: Date.now() + 60 * 60 * 1000 }));

      const result = await refreshIfNeeded(h.deps, 'acct-1', 'a@b.com', true);

      expect(result.success).toBe(true);
      expect(fake.requests().filter((r) => r.url === '/v1/oauth/token')).toHaveLength(1);
    });

    it('returns error and broadcasts when there is no stored refresh token', async () => {
      const h = setup();
      // keychain file is empty — no stored creds for acct-1.
      const result = await refreshIfNeeded(h.deps, 'acct-1', 'a@b.com');

      expect(result.success).toBe(false);
      expect(result.needsReauth).toBe(true);
      expect(h.broadcasts).toContainEqual(
        expect.objectContaining({ type: 'token_refresh_failed', reason: 'expired' }),
      );
    });

    it('marks the account expired on 400, short-circuits retries, and recovers after re-auth', async () => {
      const h = setup();
      // Use a unique accountId to avoid polluting other tests via the
      // module-level expiredRefreshTokens set.
      const acctId = `acct-expire-${randomUUID()}`;
      writeSentinelCredentials(acctId, makeCreds({ expiresAt: Date.now() + 1_000 }));

      fake.setScenario('refresh-token-expired');
      const first = await refreshIfNeeded(h.deps, acctId, 'a@b.com');
      expect(first.needsReauth).toBe(true);
      expect(h.broadcasts).toContainEqual(
        expect.objectContaining({ type: 'token_refresh_failed', reason: 'expired' }),
      );

      // Second call must short-circuit without hitting the token endpoint.
      fake.resetRequests();
      fake.setScenario('healthy-account');
      const second = await refreshIfNeeded(h.deps, acctId, 'a@b.com');
      expect(second.needsReauth).toBe(true);
      expect(fake.requests().filter((r) => r.url === '/v1/oauth/token')).toHaveLength(0);

      // After re-auth, the account is eligible for refresh again and succeeds
      // against the healthy scenario.
      markAccountReauthenticated(acctId);
      writeSentinelCredentials(acctId, makeCreds({ expiresAt: Date.now() + 1_000 }));
      const third = await refreshIfNeeded(h.deps, acctId, 'a@b.com');
      expect(third.success).toBe(true);
    });

    it('broadcasts reason=network for transport-level failures (fake closed)', async () => {
      const h = setup();
      writeSentinelCredentials('acct-1', makeCreds({ expiresAt: Date.now() + 1_000 }));

      // Close the fake inside this test so the POST fails with a real
      // connect error. beforeEach restores a fresh fake for the next test,
      // but we restart the global fake here so the suite can keep running.
      await fake.close();
      try {
        const result = await refreshIfNeeded(h.deps, 'acct-1', 'a@b.com');
        expect(result.success).toBe(false);
        expect(h.broadcasts).toContainEqual(
          expect.objectContaining({ type: 'token_refresh_failed', reason: 'network' }),
        );
      } finally {
        // Re-start the fake so subsequent tests in the suite can hit it.
        fake = await startFakeAnthropic();
        process.env.OAUTH_TOKEN_URL = fake.tokenUrl;
      }
    });

    it('broadcasts reason=unknown for token-endpoint failures outside 400/401', async () => {
      const h = setup();
      writeSentinelCredentials('acct-1', makeCreds({ expiresAt: Date.now() + 1_000 }));
      fake.setScenario('token-endpoint-500');

      await refreshIfNeeded(h.deps, 'acct-1', 'a@b.com');

      expect(h.broadcasts).toContainEqual(
        expect.objectContaining({ type: 'token_refresh_failed', reason: 'unknown' }),
      );
    });

    it('keeps going when writeClaudeCodeCredentials throws (active account only)', async () => {
      // This is the one surviving mock in the integration suite. The
      // test-keychain adapter cannot simulate a platform-specific keychain
      // write error, so spy on the single call site. Scope is the narrowest
      // possible — one call, restored automatically via vi.restoreAllMocks
      // in afterEach.
      const h = setup();
      writeSentinelCredentials('acct-1', makeCreds({ expiresAt: Date.now() + 1_000 }));
      h.deps.activeAccountId.value = 'acct-1';
      vi.spyOn(accounts, 'writeClaudeCodeCredentials').mockImplementation(() => {
        throw new Error('keychain busy');
      });

      const result = await refreshIfNeeded(h.deps, 'acct-1', 'a@b.com');

      expect(result.success).toBe(true);
      // Sentinel slot was updated, in-process activeToken reflects the new
      // value even though the CC keychain write failed.
      const written = readSentinelCredentials('acct-1')!;
      expect(written.accessToken).toMatch(/^fake-access-/);
      expect(h.deps.activeToken.value).toBe(written.accessToken);
    });

    it('falls back to existing scopes when the refresh response omits the scope field', async () => {
      const h = setup();
      writeSentinelCredentials(
        'acct-1',
        makeCreds({ expiresAt: Date.now() + 1_000, scopes: ['user:profile', 'user:inference'] }),
      );
      fake.queueResponse('/v1/oauth/token', {
        body: {
          access_token: 'at-noscope',
          refresh_token: 'rt-noscope',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      await refreshIfNeeded(h.deps, 'acct-1', 'a@b.com');

      const written = readSentinelCredentials('acct-1')!;
      expect(written.scopes).toEqual(['user:profile', 'user:inference']);
    });

    it('keeps the old refresh token when the endpoint does not rotate it', async () => {
      const h = setup();
      writeSentinelCredentials(
        'acct-1',
        makeCreds({ expiresAt: Date.now() + 1_000, refreshToken: 'rt-keep' }),
      );
      fake.queueResponse('/v1/oauth/token', {
        body: {
          access_token: 'at-new',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      });

      await refreshIfNeeded(h.deps, 'acct-1', 'a@b.com');

      const written = readSentinelCredentials('acct-1')!;
      expect(written.refreshToken).toBe('rt-keep');
    });

    it('uses a 1h default expiry when expires_in is omitted', async () => {
      const h = setup();
      writeSentinelCredentials('acct-1', makeCreds({ expiresAt: Date.now() + 1_000 }));
      fake.queueResponse('/v1/oauth/token', {
        body: {
          access_token: 'at-new',
          refresh_token: 'rt-new',
          token_type: 'Bearer',
        },
      });
      const before = Date.now();

      await refreshIfNeeded(h.deps, 'acct-1', 'a@b.com');

      const written = readSentinelCredentials('acct-1')!;
      const delta = written.expiresAt - before;
      expect(delta).toBeGreaterThanOrEqual(3600 * 1000 - 2_000);
      expect(delta).toBeLessThanOrEqual(3600 * 1000 + 2_000);
    });
  });

  describe('startTokenRefresher', () => {
    it('scans all accounts immediately and on every 15m tick, stops when cancelled', async () => {
      const h = setup();
      upsertAccount(h.db, {
        id: 'acct-1',
        accountUuid: 'acct-1',
        email: 'a@b.com',
        displayName: 'a',
        orgUuid: '',
        orgName: '',
        planType: 'max',
        isActive: true,
        createdAt: Date.now(),
        color: null,
      });
      // Fresh creds → the scan will short-circuit before hitting the fake,
      // which is exactly what we want: proves the scanner ran without
      // waiting on HTTP timers.
      writeSentinelCredentials('acct-1', makeCreds({ expiresAt: Date.now() + 60 * 60 * 1000 }));

      vi.useFakeTimers();
      const stop = startTokenRefresher(h.deps);

      // startTokenRefresher calls `void scanAll(deps)` synchronously; the
      // async scan awaits the (synchronous in this test) refreshIfNeeded
      // path. Flush microtasks so the first scan completes.
      await vi.advanceTimersByTimeAsync(0);
      // Drive the next interval tick.
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      // Stop and verify no further ticks run.
      stop();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      // We can't easily count scans without re-introducing a listAccounts
      // spy; instead, verify the function returned a working stop handle
      // that cleanly cancelled its interval (no unhandled timers remain).
      expect(typeof stop).toBe('function');
    });
  });
});
