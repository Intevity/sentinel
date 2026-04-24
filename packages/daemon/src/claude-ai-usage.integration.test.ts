/**
 * Integration tests for `fetchOrgUsage` and `ClaudeAiUsageStore` against
 * the fake Anthropic `/api/oauth/usage` endpoint and the real keychain
 * via the test-keychain adapter (`CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE`).
 *
 * Supersedes the fetchOrgUsage + ClaudeAiUsageStore describe blocks in
 * `claude-ai-usage.test.ts` (which mocked `./accounts.js`, mocked
 * `./claude-ai-run-budget.js`, and stubbed `global.fetch`). Pure-function
 * tests (`isOAuthForbiddenBodyString`, `parseUsage`) stayed behind in the
 * trimmed unit file.
 *
 * The only surviving mocks here are:
 *   - `refreshCredential`: a structurally-typed injected dep
 *     (`ClaudeAiUsageStoreDeps.refreshCredential`) whose production
 *     wiring is covered end-to-end by token-refresher.integration.test.ts.
 *     Each auth_expired-path test uses one `vi.fn().mockResolvedValue(...)`.
 *   - One `vi.spyOn(console, 'error')` in the "subscriber throws" test to
 *     swallow the intentional log.
 *
 * Sprint 3 of `documentation/TEST_MIGRATION_PLAN.md` — lifts the coverage
 * exemption on `claude-ai-usage.ts`.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ClaudeAiUsageSnapshot,
  ClaudeCodeCredentials,
  DaemonToAppMessage,
} from '@claude-sentinel/shared';
import { startFakeAnthropic, type FakeAnthropic } from '@claude-sentinel/test-harness';

import {
  fetchOrgUsage,
  ClaudeAiUsageStore,
  type UsageStoreRefreshOutcome,
} from './claude-ai-usage.js';
import { writeSentinelCredentials } from './accounts.js';
import type { IpcServer } from './ipc.js';

function makeCreds(overrides: Partial<ClaudeCodeCredentials> = {}): ClaudeCodeCredentials {
  return {
    accessToken: 'at-live',
    refreshToken: 'rt-live',
    expiresAt: Date.now() + 60 * 60 * 1000,
    scopes: ['user:profile'],
    ...overrides,
  };
}

describe('claude-ai-usage integration (real fetch, fake endpoint)', () => {
  let fake: FakeAnthropic;
  const TOKEN = 'at-live';

  beforeAll(async () => {
    fake = await startFakeAnthropic();
    fake.registerToken(TOKEN);
    fake.registerToken('at-new');
    process.env.ANTHROPIC_UPSTREAM_URL = fake.origin;
  });

  afterAll(async () => {
    await fake.close();
    delete process.env.ANTHROPIC_UPSTREAM_URL;
  });

  beforeEach(() => {
    fake.resetRequests();
  });

  describe('fetchOrgUsage', () => {
    it('returns a parsed snapshot on healthy 200 JSON', async () => {
      const result = await fetchOrgUsage('org-1', TOKEN);
      expect(result.error).toBeNull();
      expect(result.snapshot).not.toBeNull();
      // Default fake body is `five_hour.utilization: 0.1`, scaled by /100.
      expect(result.snapshot!.fiveHourUtilization).toBeCloseTo(0.001, 6);
    });

    it('returns oauth_forbidden on 403 permission_error body', async () => {
      fake.queueResponse('/api/oauth/usage', {
        status: 403,
        body: {
          error: {
            type: 'permission_error',
            message: 'OAuth authentication is currently not allowed for this organization.',
          },
        },
      });
      const result = await fetchOrgUsage('org-1', TOKEN);
      expect(result).toEqual({ snapshot: null, error: 'oauth_forbidden' });
    });

    it('returns auth_expired on 403 with a non-permission_error body', async () => {
      fake.queueResponse('/api/oauth/usage', {
        status: 403,
        body: { error: { type: 'authentication_error' } },
      });
      const result = await fetchOrgUsage('org-1', TOKEN);
      expect(result).toEqual({ snapshot: null, error: 'auth_expired' });
    });

    it('returns auth_expired on 403 with an unparseable body', async () => {
      // Covers the `isOAuthForbiddenBodyString` catch branch (JSON.parse
      // throws) as well as `isOAuthForbiddenBody`'s happy-path `await
      // resp.text()` success — verdict.forbidden = false, so fall
      // through to auth_expired.
      fake.queueResponse('/api/oauth/usage', { status: 403, body: 'nope' });
      const result = await fetchOrgUsage('org-1', TOKEN);
      expect(result).toEqual({ snapshot: null, error: 'auth_expired' });
    });

    it('returns auth_expired on 401 (unregistered bearer)', async () => {
      const result = await fetchOrgUsage('org-1', 'not-a-registered-token');
      expect(result).toEqual({ snapshot: null, error: 'auth_expired' });
    });

    it('returns missing_key for empty accessToken (no request made)', async () => {
      const result = await fetchOrgUsage('org-1', '   ');
      expect(result).toEqual({ snapshot: null, error: 'missing_key' });
      expect(fake.requests().filter((r) => r.url === '/api/oauth/usage')).toHaveLength(0);
    });

    it('returns network on transport failure (fake closed)', async () => {
      await fake.close();
      try {
        const result = await fetchOrgUsage('org-1', TOKEN);
        expect(result).toEqual({ snapshot: null, error: 'network' });
      } finally {
        fake = await startFakeAnthropic();
        fake.registerToken(TOKEN);
        fake.registerToken('at-new');
        process.env.ANTHROPIC_UPSTREAM_URL = fake.origin;
      }
    });

    it('returns network on non-2xx non-auth response (500)', async () => {
      fake.queueResponse('/api/oauth/usage', { status: 500, body: '' });
      const result = await fetchOrgUsage('org-1', TOKEN);
      expect(result).toEqual({ snapshot: null, error: 'network' });
    });

    it('returns parse on malformed JSON body', async () => {
      fake.queueResponse('/api/oauth/usage', { status: 200, body: 'not json' });
      const result = await fetchOrgUsage('org-1', TOKEN);
      expect(result).toEqual({ snapshot: null, error: 'parse' });
    });
  });

  describe('ClaudeAiUsageStore', () => {
    let keychainFile: string;
    let broadcasts: DaemonToAppMessage[];
    let ipcServer: IpcServer;

    beforeEach(() => {
      keychainFile = join(tmpdir(), `sentinel-usage-${randomUUID()}.json`);
      process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE = keychainFile;
      writeFileSync(keychainFile, '{}');
      broadcasts = [];
      ipcServer = {
        broadcast: (m: DaemonToAppMessage) => broadcasts.push(m),
      } as unknown as IpcServer;
    });

    afterEach(() => {
      if (existsSync(keychainFile)) unlinkSync(keychainFile);
      delete process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE;
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it('stores snapshot on successful fetch and broadcasts with error:null', async () => {
      writeSentinelCredentials('acct-1', makeCreds({ accessToken: TOKEN }));
      const store = new ClaudeAiUsageStore({
        ipcServer,
        getOrgUuid: () => 'org-1',
        getAccountIds: () => ['acct-1'],
      });
      await store.refresh('acct-1');
      const snap = store.getSnapshot('acct-1');
      expect(snap).not.toBeNull();
      expect(store.getLastError('acct-1')).toBeNull();
      expect(broadcasts).toContainEqual(
        expect.objectContaining({ type: 'claude_ai_usage_updated', error: null }),
      );
    });

    it('records oauth_forbidden without attempting to refresh', async () => {
      writeSentinelCredentials('acct-1', makeCreds({ accessToken: TOKEN }));
      fake.queueResponse('/api/oauth/usage', {
        status: 403,
        body: {
          error: {
            type: 'permission_error',
            message: 'OAuth authentication is currently not allowed for this organization.',
          },
        },
      });
      const refreshCredential = vi.fn<(id: string) => Promise<UsageStoreRefreshOutcome>>();
      const store = new ClaudeAiUsageStore({
        ipcServer,
        getOrgUuid: () => 'org-1',
        getAccountIds: () => ['acct-1'],
        refreshCredential,
      });
      await store.refresh('acct-1');
      expect(store.getLastError('acct-1')).toBe('oauth_forbidden');
      expect(refreshCredential).not.toHaveBeenCalled();
      expect(broadcasts).toContainEqual(
        expect.objectContaining({
          type: 'claude_ai_usage_updated',
          error: 'oauth_forbidden',
        }),
      );
    });

    it('auto-refreshes on auth_expired and retries the fetch once with rotated creds', async () => {
      writeSentinelCredentials('acct-1', makeCreds({ accessToken: 'stale-token' }));
      // First call uses stale-token (unregistered) → fake naturally 401s
      // from requireAuth. DON'T queueResponse — requireAuth returns before
      // popOverride runs, so a queued 401 override would get consumed by
      // the *retry* (with at-new registered), not the initial call.
      // Retry uses at-new (registered) → default 200 body.
      const refreshCredential = vi
        .fn<(id: string) => Promise<UsageStoreRefreshOutcome>>()
        .mockImplementation(async (acctId) => {
          // Simulate a real refresh: rotate the stored credential to one
          // the fake already has registered (at-new).
          writeSentinelCredentials(acctId, makeCreds({ accessToken: 'at-new' }));
          return { success: true };
        });

      const store = new ClaudeAiUsageStore({
        ipcServer,
        getOrgUuid: () => 'org-1',
        getAccountIds: () => ['acct-1'],
        refreshCredential,
      });
      await store.refresh('acct-1');

      expect(refreshCredential).toHaveBeenCalledTimes(1);
      const hits = fake.requests().filter((r) => r.url === '/api/oauth/usage');
      expect(hits).toHaveLength(2);
      expect(hits[0]!.headers['authorization']).toBe('Bearer stale-token');
      expect(hits[1]!.headers['authorization']).toBe('Bearer at-new');
      expect(store.getSnapshot('acct-1')).not.toBeNull();
      expect(store.getLastError('acct-1')).toBeNull();
    });

    it('records auth_expired without retrying when refresh reports needsReauth', async () => {
      writeSentinelCredentials('acct-1', makeCreds({ accessToken: 'stale' }));
      const refreshCredential = vi
        .fn<(id: string) => Promise<UsageStoreRefreshOutcome>>()
        .mockResolvedValue({ success: false, needsReauth: true });

      const store = new ClaudeAiUsageStore({
        ipcServer,
        getOrgUuid: () => 'org-1',
        getAccountIds: () => ['acct-1'],
        refreshCredential,
      });
      await store.refresh('acct-1');

      expect(refreshCredential).toHaveBeenCalledTimes(1);
      expect(fake.requests().filter((r) => r.url === '/api/oauth/usage')).toHaveLength(1);
      expect(store.getLastError('acct-1')).toBe('auth_expired');
    });

    it('does not recurse when retry after refresh also returns auth_expired', async () => {
      writeSentinelCredentials('acct-1', makeCreds({ accessToken: 'stale' }));
      // refresh succeeds but doesn't actually rotate to a valid token, so
      // the retry hits 401 too. The store must NOT refresh again.
      const refreshCredential = vi
        .fn<(id: string) => Promise<UsageStoreRefreshOutcome>>()
        .mockResolvedValue({ success: true });

      const store = new ClaudeAiUsageStore({
        ipcServer,
        getOrgUuid: () => 'org-1',
        getAccountIds: () => ['acct-1'],
        refreshCredential,
      });
      await store.refresh('acct-1');

      expect(refreshCredential).toHaveBeenCalledTimes(1);
      expect(fake.requests().filter((r) => r.url === '/api/oauth/usage')).toHaveLength(2);
      expect(store.getLastError('acct-1')).toBe('auth_expired');
    });

    it('records auth_expired when refresh succeeds but credentials vanish before retry', async () => {
      writeSentinelCredentials('acct-1', makeCreds({ accessToken: 'stale' }));
      const refreshCredential = vi
        .fn<(id: string) => Promise<UsageStoreRefreshOutcome>>()
        .mockImplementation(async () => {
          // refreshCredential claims success but the keychain has been wiped
          // by the time we get to the retry (TOCTOU / race). Store must NOT
          // retry with stale creds — fall through to auth_expired.
          writeFileSync(keychainFile, '{}');
          return { success: true };
        });

      const store = new ClaudeAiUsageStore({
        ipcServer,
        getOrgUuid: () => 'org-1',
        getAccountIds: () => ['acct-1'],
        refreshCredential,
      });
      await store.refresh('acct-1');

      expect(refreshCredential).toHaveBeenCalledTimes(1);
      expect(fake.requests().filter((r) => r.url === '/api/oauth/usage')).toHaveLength(1);
      expect(store.getLastError('acct-1')).toBe('auth_expired');
    });

    it('falls through to recordFailure when refreshCredential dep is absent', async () => {
      writeSentinelCredentials('acct-1', makeCreds({ accessToken: 'stale' }));
      const store = new ClaudeAiUsageStore({
        ipcServer,
        getOrgUuid: () => 'org-1',
        getAccountIds: () => ['acct-1'],
      });
      await store.refresh('acct-1');
      expect(fake.requests().filter((r) => r.url === '/api/oauth/usage')).toHaveLength(1);
      expect(store.getLastError('acct-1')).toBe('auth_expired');
    });

    it('records missing_key and clears snapshot when credentials are absent', async () => {
      writeSentinelCredentials('acct-1', makeCreds({ accessToken: TOKEN }));
      const store = new ClaudeAiUsageStore({
        ipcServer,
        getOrgUuid: () => 'org-1',
        getAccountIds: () => ['acct-1'],
      });
      await store.refresh('acct-1');
      expect(store.getSnapshot('acct-1')).not.toBeNull();

      // Wipe the keychain so the next refresh sees no credential.
      writeFileSync(keychainFile, '{}');
      await store.refresh('acct-1');
      expect(store.getSnapshot('acct-1')).toBeNull();
      expect(store.getLastError('acct-1')).toBe('missing_key');
    });

    it('records parse and makes no request when orgUuid is unknown', async () => {
      writeSentinelCredentials('acct-1', makeCreds({ accessToken: TOKEN }));
      const store = new ClaudeAiUsageStore({
        ipcServer,
        getOrgUuid: () => null,
        getAccountIds: () => ['acct-1'],
      });
      await store.refresh('acct-1');
      expect(store.getLastError('acct-1')).toBe('parse');
      expect(fake.requests().filter((r) => r.url === '/api/oauth/usage')).toHaveLength(0);
    });

    it('preserves previous snapshot on transient failure (network)', async () => {
      writeSentinelCredentials('acct-1', makeCreds({ accessToken: TOKEN }));
      const store = new ClaudeAiUsageStore({
        ipcServer,
        getOrgUuid: () => 'org-1',
        getAccountIds: () => ['acct-1'],
      });
      await store.refresh('acct-1');
      const firstSnap = store.getSnapshot('acct-1') as ClaudeAiUsageSnapshot;
      expect(firstSnap).not.toBeNull();

      fake.queueResponse('/api/oauth/usage', { status: 500, body: '' });
      await store.refresh('acct-1');
      expect(store.getSnapshot('acct-1')).toBe(firstSnap);
      expect(store.getLastError('acct-1')).toBe('network');
    });

    it('fires onUpdate subscribers after every fetch', async () => {
      writeSentinelCredentials('acct-1', makeCreds({ accessToken: TOKEN }));
      const store = new ClaudeAiUsageStore({
        ipcServer,
        getOrgUuid: () => 'org-1',
        getAccountIds: () => ['acct-1'],
      });
      let receivedId: string | null = null;
      store.onUpdate((id) => {
        receivedId = id;
      });
      await store.refresh('acct-1');
      expect(receivedId).toBe('acct-1');
    });

    it('swallows subscriber exceptions and keeps other subscribers running', async () => {
      writeSentinelCredentials('acct-1', makeCreds({ accessToken: TOKEN }));
      // Suppress the intentional console.error from fireSubscribers. One
      // narrow spy, scoped to this single test via vi.restoreAllMocks in afterEach.
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const store = new ClaudeAiUsageStore({
        ipcServer,
        getOrgUuid: () => 'org-1',
        getAccountIds: () => ['acct-1'],
      });
      let goodCalled = false;
      store.onUpdate(() => {
        throw new Error('boom');
      });
      store.onUpdate(() => {
        goodCalled = true;
      });
      await store.refresh('acct-1');
      expect(goodCalled).toBe(true);
    });

    it('respects per-error backoff: 24h cooldown on oauth_forbidden skips non-forced ticks', async () => {
      writeSentinelCredentials('acct-1', makeCreds({ accessToken: TOKEN }));
      const forbiddenBody = {
        error: {
          type: 'permission_error',
          message: 'OAuth authentication is currently not allowed for this organization.',
        },
      };
      fake.queueResponse('/api/oauth/usage', { status: 403, body: forbiddenBody });

      let clock = 1_000_000;
      const store = new ClaudeAiUsageStore({
        ipcServer,
        getOrgUuid: () => 'org-1',
        getAccountIds: () => ['acct-1'],
        now: () => clock,
      });

      // Poke the scheduler tick directly. `refresh()` always passes
      // force=true which bypasses backoff — we're specifically testing
      // the non-force path in `tick()`. Private method, typed via cast.
      const poll = () => (store as unknown as { tick(): Promise<void> }).tick();

      await poll();
      expect(store.getLastError('acct-1')).toBe('oauth_forbidden');
      const baseline = fake.requests().filter((r) => r.url === '/api/oauth/usage').length;
      expect(baseline).toBe(1);

      // 1h elapsed: nowhere near the 24h OAUTH_FORBIDDEN_BACKOFF_MS.
      // Several ticks must NOT refetch.
      clock += 60 * 60 * 1000;
      await poll();
      await poll();
      await poll();
      expect(fake.requests().filter((r) => r.url === '/api/oauth/usage')).toHaveLength(baseline);

      // Past the 24h backoff: the next tick refetches.
      fake.queueResponse('/api/oauth/usage', { status: 403, body: forbiddenBody });
      clock += 25 * 60 * 60 * 1000;
      await poll();
      expect(fake.requests().filter((r) => r.url === '/api/oauth/usage').length).toBe(baseline + 1);
    });
  });
});
