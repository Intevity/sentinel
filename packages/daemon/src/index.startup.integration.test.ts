/**
 * Integration tests for `startDaemon()`'s bootstrap sequence. Exercises the
 * real startup path in-process against the fake Anthropic upstream. Shutdown
 * is covered here too because teardown-correctness is load-bearing for every
 * other test in this family.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { makeCreds, startTestDaemon, type TestDaemon } from './index.test-helpers.js';
import { IpcClient } from './ipc.js';
import type { OAuthAccount } from '@claude-sentinel/shared';

let ctx: TestDaemon | null = null;
afterEach(async () => {
  if (ctx) {
    await ctx.cleanup();
    ctx = null;
  }
});

describe('startDaemon — bring-up', () => {
  it('returns a handle with httpServer, ipcServer, and shutdown', async () => {
    ctx = await startTestDaemon();
    expect(ctx.handle.httpServer).toBeDefined();
    expect(ctx.handle.ipcServer).toBeDefined();
    expect(typeof ctx.handle.shutdown).toBe('function');
  });

  it('binds the HTTP proxy on the requested port and answers /health with 200', async () => {
    ctx = await startTestDaemon();
    const res = await fetch(`http://127.0.0.1:${ctx.daemonPort}/health`);
    expect(res.status).toBe(200);
    await res.text();
  });

  it('binds the IPC socket at the test path and accepts client connections', async () => {
    ctx = await startTestDaemon();
    expect(ctx.handle.ipcServer.connectedClients).toBeGreaterThanOrEqual(1);
  });

  it('responds to get_accounts with an empty list on a fresh DB', async () => {
    ctx = await startTestDaemon();
    const resp = await ctx.request<unknown[]>({ type: 'get_accounts' });
    expect(resp.success).toBe(true);
    expect(resp.data).toEqual([]);
  });

  it('honors the tmp settings file via CLAUDE_SENTINEL_TEST_SETTINGS_FILE', async () => {
    ctx = await startTestDaemon({ settings: { switchingMode: 'round-robin' } });
    const resp = await ctx.request<{ switchingMode: string }>({ type: 'get_settings' });
    expect(resp.success).toBe(true);
    expect(resp.data?.switchingMode).toBe('round-robin');
  });

  it('snaps persisted range presets onto each page retention ladder at boot', async () => {
    // A pre-upgrade file can hold a range wider than a (newly shrunk)
    // retention window; the daemon must serve the snapped value so the
    // selector never renders a preset its ladder does not offer.
    ctx = await startTestDaemon({
      settings: {
        optimizeRetentionDays: 90,
        optimizeRange: '6m',
        metricsRetentionDays: 180,
        metricsRange: '1y',
      },
    });
    const resp = await ctx.request<{ optimizeRange: string; metricsRange: string }>({
      type: 'get_settings',
    });
    expect(resp.success).toBe(true);
    expect(resp.data?.optimizeRange).toBe('3m');
    expect(resp.data?.metricsRange).toBe('6m');
  });
});

describe('startDaemon — preseeded state', () => {
  it('loads the pre-seeded active account from claude.json', async () => {
    // Use the fake's default profile UUIDs so verifyStartupActiveAccount
    // does not detect drift and realign. That keeps the test focused on
    // the seeding path rather than the drift path.
    const account: OAuthAccount = {
      accountUuid: '00000000-0000-0000-0000-000000000001',
      organizationUuid: '00000000-0000-0000-0000-000000000002',
      emailAddress: 'test@example.com',
      displayName: 'Test User',
      organizationName: 'Test Org',
      organizationRole: 'owner',
      workspaceRole: null,
      hasExtraUsageEnabled: true,
      billingType: 'max',
      accountCreatedAt: new Date().toISOString(),
      subscriptionCreatedAt: new Date().toISOString(),
    };
    const key = account.organizationUuid;
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: account },
      sentinelCredentials: {
        [key]: makeCreds({ accessToken: 'seeded-token', subscriptionType: 'max' }),
      },
      registerTokens: ['seeded-token'],
    });
    const resp = await ctx.request<Array<{ email: string; isActive: boolean }>>({
      type: 'get_accounts',
    });
    expect(resp.success).toBe(true);
    const accounts = resp.data ?? [];
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.email).toBe('test@example.com');
    expect(accounts[0]!.isActive).toBe(true);
  });

  it('heals drifted plan_type rows on startup when subscriptionType disagrees', async () => {
    // Seed with DEFAULT_PROFILE org_type='claude_max' (so the fake's profile
    // returns org_type='claude_max' which maps to subscriptionType='max'),
    // but store a credential carrying subscriptionType='team'. The startup
    // heal loop re-derives planType from the credential — since
    // inferPlanType trusts the cred's subscriptionType, the DB row should
    // end up as 'team' even though inferPlanType would have classified a
    // raw OAuthAccount as 'max'.
    const key = '00000000-0000-0000-0000-000000000002';
    const account: OAuthAccount = {
      accountUuid: '00000000-0000-0000-0000-000000000001',
      organizationUuid: key,
      emailAddress: 'test@example.com',
      displayName: 'Drifted',
      organizationName: 'Team Org',
      organizationRole: 'user',
      workspaceRole: null,
      hasExtraUsageEnabled: true,
      billingType: 'team',
      accountCreatedAt: new Date().toISOString(),
      subscriptionCreatedAt: new Date().toISOString(),
    };
    ctx = await startTestDaemon({
      claudeState: { oauthAccount: account },
      sentinelCredentials: {
        [key]: makeCreds({ accessToken: 'drift-token', subscriptionType: 'team' }),
      },
      registerTokens: ['drift-token'],
    });
    const resp = await ctx.request<Array<{ planType: string }>>({
      type: 'get_accounts',
    });
    expect(resp.success).toBe(true);
    expect(resp.data?.[0]?.planType).toBe('team');
  });
});

describe('startDaemon — shutdown', () => {
  it('shutdown() closes the IPC socket and the HTTP proxy', async () => {
    ctx = await startTestDaemon();
    const port = ctx.daemonPort;
    await ctx.handle.shutdown();
    // After shutdown, /health should no longer resolve.
    await expect(
      fetch(`http://127.0.0.1:${port}/health`).catch((e) => Promise.reject(e)),
    ).rejects.toThrow();
    // IPC socket no longer accepts new connections.
    await expect(
      new Promise<void>((resolve, reject) => {
        const client = new IpcClient();
        client.onConnect(() => {
          client.close();
          resolve();
        });
        client.onError(reject);
        try {
          client.connect(ctx!.socketPath);
        } catch (err) {
          reject(err);
        }
      }),
    ).rejects.toThrow();
    // Mark cleanup done so afterEach's call is a no-op (shutdown is idempotent).
    await ctx.cleanup();
    ctx = null;
  });

  it('shutdown() is idempotent when called twice', async () => {
    ctx = await startTestDaemon();
    await ctx.handle.shutdown();
    // Second call must resolve cleanly, not throw.
    await expect(ctx.handle.shutdown()).resolves.toBeUndefined();
  });
});

describe('startDaemon — settings file writeback', () => {
  it('writes DEFAULT_SETTINGS fields back when update_settings merges a partial', async () => {
    ctx = await startTestDaemon();
    const update = await ctx.request<unknown>({
      type: 'update_settings',
      settings: { logLevel: 'debug' },
    });
    expect(update.success).toBe(true);
    // settings_changed must broadcast.
    await ctx.waitForBroadcast((m) => m.type === 'settings_changed');
    // Written file reflects the merge.
    const onDisk = JSON.parse(readFileSync(ctx.settingsPath, 'utf-8'));
    expect(onDisk.logLevel).toBe('debug');
    // DEFAULT_SETTINGS fields persisted too (e.g. overageBufferPct).
    expect(onDisk.overageBufferPct).toBe(5);
  });
});

describe('startDaemon — socket isolation', () => {
  it('uses distinct tmp sockets per harness instance', async () => {
    ctx = await startTestDaemon();
    const a = ctx.socketPath;
    const port1 = ctx.daemonPort;
    await ctx.cleanup();
    ctx = await startTestDaemon();
    expect(ctx.socketPath).not.toBe(a);
    expect(ctx.daemonPort).not.toBe(port1);
  });
});

describe('startDaemon — IPC round-trip fidelity', () => {
  it('handles an unknown message type without hanging (no response expected)', async () => {
    ctx = await startTestDaemon();
    // Send a bogus type. The server won't respond — our request() will time out,
    // but other requests should still work.
    const bogus = ctx.request({ type: 'nonexistent_type' as never }).catch(() => 'timeout');
    await new Promise((r) => setTimeout(r, 100));
    // Other requests on the same connection are unaffected.
    const good = await ctx.request({ type: 'get_accounts' });
    expect(good.success).toBe(true);
    // Clean up the lingering timeout.
    await bogus;
  }, 10_000);

  it('handles two sequential same-type requests with FIFO response correlation', async () => {
    ctx = await startTestDaemon();
    const [a, b] = await Promise.all([
      ctx.request({ type: 'get_accounts' }),
      ctx.request({ type: 'get_accounts' }),
    ]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
  });
});

describe('startDaemon — logger initialization', () => {
  it('applies persisted logLevel to the logger singleton', async () => {
    ctx = await startTestDaemon({ settings: { logLevel: 'debug' } });
    // get_daemon_logs response carries the LogEntry[] directly in data.
    const resp = await ctx.request<Array<{ message: string }>>({
      type: 'get_daemon_logs',
    });
    expect(resp.success).toBe(true);
    expect(resp.data?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('startDaemon — startup collision probe (test-daemon is alone)', () => {
  it('does not exit when no other daemon is listening on the test port', async () => {
    // In test mode the daemon skips the production double-launch /health probe and
    // binds an OS-assigned port (listen(0)), so a port collision between parallel
    // workers can no longer fire process.exit and kill the worker. Reaching this
    // assertion with a listening server confirms the daemon bound cleanly.
    ctx = await startTestDaemon();
    expect(ctx.handle.httpServer.listening).toBe(true);
  });
});

describe('startDaemon — isolated tmp workspaces', () => {
  it('writes its DB to the tmp path and cleans it up on cleanup()', async () => {
    ctx = await startTestDaemon();
    const dbPath = ctx.dbPath;
    // Write something through the DB to ensure the file is materialized.
    await ctx.request({ type: 'refresh_accounts' });
    const { existsSync } = await import('fs');
    expect(existsSync(dbPath)).toBe(true);
    await ctx.cleanup();
    ctx = null;
    expect(existsSync(dbPath)).toBe(false);
  });

  it('unique workdir per harness prevents state leak between tests', async () => {
    ctx = await startTestDaemon();
    const firstWorkdir = ctx.workdir;
    await ctx.cleanup();
    ctx = await startTestDaemon();
    expect(ctx.workdir).not.toBe(firstWorkdir);
  });
});

describe('startDaemon — env vars cleared on cleanup', () => {
  it('removes all test env vars after cleanup', async () => {
    ctx = await startTestDaemon();
    expect(process.env.CLAUDE_SENTINEL_TEST_DB_FILE).toBe(ctx.dbPath);
    await ctx.cleanup();
    ctx = null;
    expect(process.env.CLAUDE_SENTINEL_TEST_DB_FILE).toBeUndefined();
    expect(process.env.CLAUDE_SENTINEL_TEST_IPC_SOCKET).toBeUndefined();
    expect(process.env.ANTHROPIC_UPSTREAM_URL).toBeUndefined();
  });
});
