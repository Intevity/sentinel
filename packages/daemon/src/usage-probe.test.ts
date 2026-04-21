import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ClaudeCodeCredentials, AccountInfo } from '@claude-sentinel/shared';

const probeRateLimitsMock = vi.fn<(accountId: string, ipc?: unknown, token?: string) => void>();
const listAccountsMock = vi.fn<() => AccountInfo[]>();
const readSentinelCredentialsMock = vi.fn<(key: string) => ClaudeCodeCredentials | null>();

vi.mock('./rate-limit-probe.js', () => ({
  probeRateLimits: (id: string, ipc?: unknown, tok?: string) => probeRateLimitsMock(id, ipc, tok),
}));

vi.mock('./db.js', () => ({
  listAccounts: () => listAccountsMock(),
}));

vi.mock('./accounts.js', () => ({
  readSentinelCredentials: (k: string) => readSentinelCredentialsMock(k),
}));

const { startUsageProber } = await import('./usage-probe.js');

function makeAccount(id: string, email = `${id}@example.com`): AccountInfo {
  return {
    id,
    accountUuid: id,
    email,
    displayName: email,
    orgUuid: id,
    orgName: 'Org',
    planType: 'pro',
    isActive: false,
    createdAt: 0,
  } as AccountInfo;
}

function makeCreds(token: string): ClaudeCodeCredentials {
  return {
    accessToken: token,
    refreshToken: 'rt',
    expiresAt: Date.now() + 60 * 60 * 1000,
    scopes: ['user:profile'],
    subscriptionType: 'team',
    rateLimitTier: 'standard',
  };
}

function makeDeps(intervalSec = 300) {
  const broadcast = vi.fn();
  return {
    deps: {
      db: {} as never,
      ipcServer: { broadcast } as never,
      getIntervalSec: () => intervalSec,
    },
    broadcast,
  };
}

describe('startUsageProber', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    probeRateLimitsMock.mockReset();
    listAccountsMock.mockReset();
    readSentinelCredentialsMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('probes every account (including the active one) — active account drifts just like inactive ones when consumed via claude.ai', () => {
    listAccountsMock.mockReturnValue([
      makeAccount('active'),
      makeAccount('other-1'),
      makeAccount('other-2'),
    ]);
    readSentinelCredentialsMock.mockImplementation((k) => makeCreds(`token-${k}`));

    const { deps } = makeDeps(300);
    const handle = startUsageProber(deps);

    // First probe fires immediately (t=0) for the first listed account.
    expect(probeRateLimitsMock).toHaveBeenCalledTimes(1);
    expect(probeRateLimitsMock).toHaveBeenNthCalledWith(
      1,
      'active',
      deps.ipcServer,
      'token-active',
    );

    // Stride = 300_000 / 3 = 100_000 ms. Advance to t=100s for other-1.
    vi.advanceTimersByTime(100_000);
    expect(probeRateLimitsMock).toHaveBeenCalledTimes(2);
    expect(probeRateLimitsMock).toHaveBeenNthCalledWith(
      2,
      'other-1',
      deps.ipcServer,
      'token-other-1',
    );

    // And t=200s for other-2.
    vi.advanceTimersByTime(100_000);
    expect(probeRateLimitsMock).toHaveBeenCalledTimes(3);
    expect(probeRateLimitsMock).toHaveBeenNthCalledWith(
      3,
      'other-2',
      deps.ipcServer,
      'token-other-2',
    );

    handle.stop();
  });

  it('skips accounts with no stored credentials', () => {
    listAccountsMock.mockReturnValue([makeAccount('a1'), makeAccount('a2')]);
    readSentinelCredentialsMock.mockImplementation((k) => (k === 'a1' ? makeCreds('tok') : null));

    const { deps } = makeDeps(300);
    const handle = startUsageProber(deps);

    // Immediate: a1 fires with creds, a2 scheduled.
    expect(probeRateLimitsMock).toHaveBeenCalledTimes(1);
    expect(probeRateLimitsMock).toHaveBeenCalledWith('a1', deps.ipcServer, 'tok');

    // When a2's scheduled fire runs, it finds no creds and skips (no extra call).
    vi.advanceTimersByTime(200_000);
    expect(probeRateLimitsMock).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('fires a new cycle on every interval tick', () => {
    listAccountsMock.mockReturnValue([makeAccount('a1')]);
    readSentinelCredentialsMock.mockImplementation((k) => makeCreds(`t-${k}`));

    const { deps } = makeDeps(60); // min interval
    const handle = startUsageProber(deps);

    expect(probeRateLimitsMock).toHaveBeenCalledTimes(1); // immediate

    vi.advanceTimersByTime(60_000);
    expect(probeRateLimitsMock).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(60_000);
    expect(probeRateLimitsMock).toHaveBeenCalledTimes(3);

    handle.stop();
  });

  it('restart() cancels pending staggered probes and kicks off a fresh cycle', () => {
    listAccountsMock.mockReturnValue([makeAccount('a1'), makeAccount('a2')]);
    readSentinelCredentialsMock.mockImplementation((k) => makeCreds(`t-${k}`));

    const { deps } = makeDeps(300);
    const handle = startUsageProber(deps);

    expect(probeRateLimitsMock).toHaveBeenCalledTimes(1); // a1 immediate

    // Before the a2 stagger fires (at t=150s), restart.
    vi.advanceTimersByTime(10_000);
    handle.restart();

    // Restart fires a1 immediately again; a2 is re-scheduled.
    expect(probeRateLimitsMock).toHaveBeenCalledTimes(2);
    expect(probeRateLimitsMock.mock.calls[1]?.[0]).toBe('a1');

    // The pre-restart a2 stagger (originally at t=150s) must NOT fire —
    // only the post-restart one at t≈160s (10s elapsed + 150s stride).
    vi.advanceTimersByTime(140_000);
    expect(probeRateLimitsMock).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(20_000);
    expect(probeRateLimitsMock).toHaveBeenCalledTimes(3);
    expect(probeRateLimitsMock.mock.calls[2]?.[0]).toBe('a2');

    handle.stop();
  });

  it('does nothing when there are no accounts', () => {
    listAccountsMock.mockReturnValue([]);

    const { deps } = makeDeps(300);
    const handle = startUsageProber(deps);

    expect(probeRateLimitsMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300_000);
    expect(probeRateLimitsMock).not.toHaveBeenCalled();

    handle.stop();
  });

  it('stop() prevents further probes', () => {
    listAccountsMock.mockReturnValue([makeAccount('a1')]);
    readSentinelCredentialsMock.mockImplementation((k) => makeCreds(`t-${k}`));

    const { deps } = makeDeps(60);
    const handle = startUsageProber(deps);

    expect(probeRateLimitsMock).toHaveBeenCalledTimes(1);
    handle.stop();

    vi.advanceTimersByTime(60_000);
    expect(probeRateLimitsMock).toHaveBeenCalledTimes(1);
  });
});
