import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ClaudeCodeCredentials } from '@claude-sentinel/shared';

const readSentinelCredentialsMock = vi.fn<(key: string) => ClaudeCodeCredentials | null>();
const writeSentinelCredentialsMock = vi.fn<(key: string, c: ClaudeCodeCredentials) => void>();
const writeClaudeCodeCredentialsMock = vi.fn<(c: ClaudeCodeCredentials) => void>();
const refreshAccessTokenMock = vi.fn<(rt: string) => Promise<unknown>>();
const listAccountsMock = vi.fn<() => Array<{ id: string; email: string }>>();

vi.mock('./accounts.js', () => ({
  readSentinelCredentials: (k: string) => readSentinelCredentialsMock(k),
  writeSentinelCredentials: (k: string, c: ClaudeCodeCredentials) => writeSentinelCredentialsMock(k, c),
  writeClaudeCodeCredentials: (c: ClaudeCodeCredentials) => writeClaudeCodeCredentialsMock(c),
}));

vi.mock('./oauth.js', () => ({
  REFRESH_TOKEN_EXPIRED: 'REFRESH_TOKEN_EXPIRED',
  refreshAccessToken: (rt: string) => refreshAccessTokenMock(rt),
}));

vi.mock('./db.js', () => ({
  listAccounts: () => listAccountsMock(),
}));

const {
  refreshIfNeeded,
  markAccountReauthenticated,
  startTokenRefresher,
} = await import('./token-refresher.js');

function makeCreds(overrides: Partial<ClaudeCodeCredentials> = {}): ClaudeCodeCredentials {
  return {
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    expiresAt: Date.now() + 60 * 60 * 1000, // 1h out
    scopes: ['user:profile'],
    subscriptionType: 'team',
    rateLimitTier: 'standard',
    ...overrides,
  };
}

function makeDeps() {
  const broadcast = vi.fn();
  return {
    deps: {
      db: {} as never,
      activeToken: { value: null as string | null },
      activeAccountId: { value: 'acct-1' },
      ipcServer: { broadcast } as never,
    },
    broadcast,
  };
}

describe('token-refresher', () => {
  beforeEach(() => {
    readSentinelCredentialsMock.mockReset();
    writeSentinelCredentialsMock.mockReset();
    writeClaudeCodeCredentialsMock.mockReset();
    refreshAccessTokenMock.mockReset();
    listAccountsMock.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('refreshIfNeeded', () => {
    it('skips refresh when token has > 30 min remaining', async () => {
      readSentinelCredentialsMock.mockReturnValue(makeCreds({ expiresAt: Date.now() + 45 * 60 * 1000 }));
      const { deps } = makeDeps();

      const result = await refreshIfNeeded(deps, 'acct-1', 'a@b.com');

      expect(result.success).toBe(true);
      expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    });

    it('refreshes when inside the threshold and updates active-account state', async () => {
      readSentinelCredentialsMock.mockReturnValue(makeCreds({ expiresAt: Date.now() + 5 * 60 * 1000 }));
      refreshAccessTokenMock.mockResolvedValue({
        access_token: 'at-new',
        refresh_token: 'rt-new',
        expires_in: 3600,
        scope: 'user:profile',
        token_type: 'Bearer',
      });
      const { deps, broadcast } = makeDeps();
      deps.activeAccountId.value = 'acct-1';

      const result = await refreshIfNeeded(deps, 'acct-1', 'a@b.com');

      expect(result.success).toBe(true);
      expect(writeSentinelCredentialsMock).toHaveBeenCalledOnce();
      const written = writeSentinelCredentialsMock.mock.calls[0]?.[1];
      expect(written?.accessToken).toBe('at-new');
      expect(written?.refreshToken).toBe('rt-new');
      expect(written?.subscriptionType).toBe('team'); // preserved
      expect(writeClaudeCodeCredentialsMock).toHaveBeenCalledOnce();
      expect(deps.activeToken.value).toBe('at-new');
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'token_refreshed', accountId: 'acct-1' }));
    });

    it('does not touch Claude Code keychain or activeToken for inactive accounts', async () => {
      readSentinelCredentialsMock.mockReturnValue(makeCreds({ expiresAt: Date.now() + 5 * 60 * 1000 }));
      refreshAccessTokenMock.mockResolvedValue({
        access_token: 'at-new',
        refresh_token: 'rt-new',
        expires_in: 3600,
        token_type: 'Bearer',
      });
      const { deps } = makeDeps();
      deps.activeAccountId.value = 'different-account';

      await refreshIfNeeded(deps, 'acct-1', 'a@b.com');

      expect(writeClaudeCodeCredentialsMock).not.toHaveBeenCalled();
      expect(deps.activeToken.value).toBeNull();
    });

    it('force=true refreshes even when token is fresh', async () => {
      readSentinelCredentialsMock.mockReturnValue(makeCreds({ expiresAt: Date.now() + 60 * 60 * 1000 }));
      refreshAccessTokenMock.mockResolvedValue({
        access_token: 'at-new',
        refresh_token: 'rt-new',
        expires_in: 3600,
        token_type: 'Bearer',
      });
      const { deps } = makeDeps();

      const result = await refreshIfNeeded(deps, 'acct-1', 'a@b.com', true);

      expect(result.success).toBe(true);
      expect(refreshAccessTokenMock).toHaveBeenCalledOnce();
    });

    it('returns error when there is no stored refresh token', async () => {
      readSentinelCredentialsMock.mockReturnValue(null);
      const { deps } = makeDeps();
      const result = await refreshIfNeeded(deps, 'acct-1', 'a@b.com');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/sign in/i);
    });

    it('marks the account as expired, broadcasts, and short-circuits on subsequent calls', async () => {
      readSentinelCredentialsMock.mockReturnValue(makeCreds({ expiresAt: Date.now() + 1_000 }));
      refreshAccessTokenMock.mockRejectedValue(new Error('REFRESH_TOKEN_EXPIRED'));
      const { deps, broadcast } = makeDeps();

      const first = await refreshIfNeeded(deps, 'acct-1', 'a@b.com');
      expect(first.needsReauth).toBe(true);
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'token_refresh_failed', reason: 'expired' }));

      // Second call should not re-hit the token endpoint.
      refreshAccessTokenMock.mockClear();
      const second = await refreshIfNeeded(deps, 'acct-1', 'a@b.com');
      expect(second.needsReauth).toBe(true);
      expect(refreshAccessTokenMock).not.toHaveBeenCalled();

      // After markAccountReauthenticated, we should try again.
      markAccountReauthenticated('acct-1');
      refreshAccessTokenMock.mockResolvedValueOnce({
        access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, token_type: 'Bearer',
      });
      readSentinelCredentialsMock.mockReturnValueOnce(makeCreds({ expiresAt: Date.now() + 1_000 }));
      const third = await refreshIfNeeded(deps, 'acct-1', 'a@b.com');
      expect(third.success).toBe(true);
    });

    it('broadcasts reason=network for generic failures', async () => {
      readSentinelCredentialsMock.mockReturnValue(makeCreds({ expiresAt: Date.now() + 1_000 }));
      refreshAccessTokenMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const { deps, broadcast } = makeDeps();

      const result = await refreshIfNeeded(deps, 'acct-1', 'a@b.com');

      expect(result.success).toBe(false);
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'token_refresh_failed', reason: 'network' }));
    });

    it('broadcasts reason=unknown for token-endpoint failures outside 400/401', async () => {
      readSentinelCredentialsMock.mockReturnValue(makeCreds({ expiresAt: Date.now() + 1_000 }));
      refreshAccessTokenMock.mockRejectedValue(new Error('Token refresh failed (503): maintenance'));
      const { deps, broadcast } = makeDeps();

      await refreshIfNeeded(deps, 'acct-1', 'a@b.com');

      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'token_refresh_failed', reason: 'unknown' }));
    });

    it('keeps going when writeClaudeCodeCredentials throws (active account only)', async () => {
      readSentinelCredentialsMock.mockReturnValue(makeCreds({ expiresAt: Date.now() + 1_000 }));
      refreshAccessTokenMock.mockResolvedValue({
        access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, token_type: 'Bearer',
      });
      writeClaudeCodeCredentialsMock.mockImplementation(() => { throw new Error('keychain busy'); });
      const { deps } = makeDeps();
      deps.activeAccountId.value = 'acct-1';

      const result = await refreshIfNeeded(deps, 'acct-1', 'a@b.com');

      expect(result.success).toBe(true);
      expect(deps.activeToken.value).toBe('at-new'); // still updated in-process
    });

    it('falls back to existing scopes when the refresh response omits them', async () => {
      const creds = makeCreds({ expiresAt: Date.now() + 1_000, scopes: ['user:profile', 'user:inference'] });
      readSentinelCredentialsMock.mockReturnValue(creds);
      refreshAccessTokenMock.mockResolvedValue({
        access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, token_type: 'Bearer',
      });
      const { deps } = makeDeps();

      await refreshIfNeeded(deps, 'acct-1', 'a@b.com');

      const written = writeSentinelCredentialsMock.mock.calls[0]?.[1];
      expect(written?.scopes).toEqual(['user:profile', 'user:inference']);
    });

    it('keeps the old refresh token when the endpoint does not rotate it', async () => {
      readSentinelCredentialsMock.mockReturnValue(makeCreds({ expiresAt: Date.now() + 1_000, refreshToken: 'rt-keep' }));
      refreshAccessTokenMock.mockResolvedValue({
        access_token: 'at-new', expires_in: 3600, token_type: 'Bearer',
      });
      const { deps } = makeDeps();

      await refreshIfNeeded(deps, 'acct-1', 'a@b.com');

      const written = writeSentinelCredentialsMock.mock.calls[0]?.[1];
      expect(written?.refreshToken).toBe('rt-keep');
    });

    it('uses a 1h default expiry when expires_in is omitted', async () => {
      readSentinelCredentialsMock.mockReturnValue(makeCreds({ expiresAt: Date.now() + 1_000 }));
      refreshAccessTokenMock.mockResolvedValue({
        access_token: 'at-new', refresh_token: 'rt-new', token_type: 'Bearer',
      });
      const { deps } = makeDeps();
      const before = Date.now();

      await refreshIfNeeded(deps, 'acct-1', 'a@b.com');

      const written = writeSentinelCredentialsMock.mock.calls[0]?.[1];
      const delta = (written?.expiresAt ?? 0) - before;
      expect(delta).toBeGreaterThanOrEqual(3600 * 1000 - 1000);
      expect(delta).toBeLessThanOrEqual(3600 * 1000 + 1000);
    });
  });

  describe('startTokenRefresher', () => {
    it('scans all accounts immediately and on interval, stops when cancelled', async () => {
      vi.useFakeTimers();
      listAccountsMock.mockReturnValue([{ id: 'acct-1', email: 'a@b.com' }]);
      readSentinelCredentialsMock.mockReturnValue(makeCreds({ expiresAt: Date.now() + 60 * 60 * 1000 }));
      const { deps } = makeDeps();

      const stop = startTokenRefresher(deps);
      // Immediate scan already happened synchronously.
      expect(listAccountsMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(listAccountsMock).toHaveBeenCalledTimes(2);

      stop();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(listAccountsMock).toHaveBeenCalledTimes(2);
    });
  });
});
