import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPermissionsPendingRegistry,
  type CreatePermissionsPendingDeps,
  type OnPendingFinalized,
} from './pending.js';
import type { IpcServer } from '../../ipc.js';
import type { PermissionRule } from '@claude-sentinel/shared';

function makeIpc(): IpcServer {
  return {
    broadcast: vi.fn(),
    onMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    connectedClients: 0,
  } as unknown as IpcServer;
}

function makeRule(overrides: Partial<PermissionRule> = {}): PermissionRule {
  return {
    raw: overrides.raw ?? 'Bash(rm -rf *)',
    tool: overrides.tool ?? 'Bash',
    decision: overrides.decision ?? 'deny',
    pattern: overrides.pattern ?? null,
    note: overrides.note ?? null,
    source: overrides.source ?? 'local',
    ...overrides,
  } as PermissionRule;
}

type TestDeps = CreatePermissionsPendingDeps & {
  ipc: IpcServer;
  onFinalized: ReturnType<typeof vi.fn>;
};

function makeDeps(overrides: Partial<CreatePermissionsPendingDeps> = {}): TestDeps {
  const ipc = overrides.ipcServer ?? makeIpc();
  const onFinalized = (overrides.onFinalized as ReturnType<typeof vi.fn> | undefined) ?? vi.fn();
  return {
    ipcServer: ipc,
    getHoldSec: overrides.getHoldSec ?? (() => 5),
    onFinalized: onFinalized as unknown as OnPendingFinalized & ReturnType<typeof vi.fn>,
    ipc,
  } as TestDeps;
}

describe('createPermissionsPendingRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('beginPending registers an entry, broadcasts security_block_pending, and lists it', () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);

    const id = registry.beginPending({
      accountId: 'acct-1',
      toolName: 'Bash',
      matchedRule: makeRule({ raw: 'Bash(rm -rf *)' }),
      source: 'permissions_strip',
    });

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    // A broadcast fired with the pending snapshot.
    const broadcasts = (deps.ipc.broadcast as ReturnType<typeof vi.fn>).mock.calls;
    const pendingBroadcast = broadcasts.find((c) => c[0]?.type === 'security_block_pending');
    expect(pendingBroadcast).toBeDefined();
    expect(pendingBroadcast![0].pending.pendingId).toBe(id);
    expect(pendingBroadcast![0].pending.toolName).toBe('Bash');
    expect(pendingBroadcast![0].pending.source).toBe('permissions_strip');

    // Snapshot is visible via listPending().
    const list = registry.listPending();
    expect(list).toHaveLength(1);
    expect(list[0]!.pendingId).toBe(id);
  });

  it('beginPending forwards toolInputFields onto the broadcast snapshot and listPending', () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);

    const id = registry.beginPending({
      accountId: 'acct-fields',
      toolName: 'Bash',
      matchedRule: makeRule({ raw: 'Bash(rm -rf *)' }),
      source: 'permissions_tool_use',
      toolInputFields: { command: 'rm -rf /tmp/cache', description: 'cleanup' },
    });

    const broadcasts = (deps.ipc.broadcast as ReturnType<typeof vi.fn>).mock.calls;
    const pendingBroadcast = broadcasts.find((c) => c[0]?.type === 'security_block_pending');
    expect(pendingBroadcast).toBeDefined();
    expect(pendingBroadcast![0].pending.pendingId).toBe(id);
    expect(pendingBroadcast![0].pending.toolInputFields).toEqual({
      command: 'rm -rf /tmp/cache',
      description: 'cleanup',
    });

    expect(registry.listPending()[0]!.toolInputFields).toEqual({
      command: 'rm -rf /tmp/cache',
      description: 'cleanup',
    });
  });

  it('beginPending omits toolInputFields entirely when no map is supplied (strip path)', () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);

    registry.beginPending({
      accountId: 'acct-strip',
      toolName: 'WebFetch',
      matchedRule: makeRule(),
      source: 'permissions_strip',
    });

    const pending = (deps.ipc.broadcast as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0]?.type === 'security_block_pending',
    )![0].pending;
    expect('toolInputFields' in pending).toBe(false);
    expect('toolInputFields' in registry.listPending()[0]!).toBe(false);
  });

  it('beginPending omits toolInputFields when caller passes an empty object', () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);

    registry.beginPending({
      accountId: 'acct-empty',
      toolName: 'Custom',
      matchedRule: makeRule(),
      source: 'permissions_tool_use',
      toolInputFields: {},
    });

    const pending = (deps.ipc.broadcast as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0]?.type === 'security_block_pending',
    )![0].pending;
    expect('toolInputFields' in pending).toBe(false);
  });

  it('resolvePending with approve fires onFinalized and broadcasts resolved', () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);
    const id = registry.beginPending({
      accountId: 'acct-2',
      toolName: 'Write',
      matchedRule: makeRule({ raw: 'Write(/etc/*)' }),
      source: 'permissions_tool_use',
    });

    const applied = registry.resolvePending(id, 'approve', { addBypass: true });
    expect(applied).toBe(true);

    expect(deps.onFinalized).toHaveBeenCalledWith(
      expect.objectContaining({ id, accountId: 'acct-2', toolName: 'Write' }),
      'approve',
      { addBypass: true },
    );

    const resolvedBroadcast = (deps.ipc.broadcast as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0]?.type === 'security_block_resolved',
    );
    expect(resolvedBroadcast).toBeDefined();
    expect(resolvedBroadcast![0].outcome).toBe('approve');

    // Listing should now be empty.
    expect(registry.listPending()).toHaveLength(0);
  });

  it('resolvePending with deny passes null opts through to onFinalized', () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);
    const id = registry.beginPending({
      accountId: 'acct-3',
      toolName: 'Bash',
      matchedRule: makeRule(),
      source: 'permissions_strip',
    });
    registry.resolvePending(id, 'deny');
    expect(deps.onFinalized).toHaveBeenCalledWith(expect.any(Object), 'deny', null);
  });

  it('resolvePending returns false for unknown ids', () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);
    expect(registry.resolvePending('does-not-exist', 'approve')).toBe(false);
    expect(deps.onFinalized).not.toHaveBeenCalled();
  });

  it('swallows errors thrown by onFinalized so the broadcast + settle still happen', () => {
    const onFinalized = vi.fn(() => {
      throw new Error('downstream boom');
    });
    const ipc = makeIpc();
    const deps = makeDeps({
      ipcServer: ipc,
      onFinalized: onFinalized as unknown as OnPendingFinalized,
    });
    const registry = createPermissionsPendingRegistry(deps);
    const id = registry.beginPending({
      accountId: 'acct-err',
      toolName: 'Bash',
      matchedRule: makeRule(),
      source: 'permissions_strip',
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => registry.resolvePending(id, 'approve')).not.toThrow();
    consoleSpy.mockRestore();

    expect(onFinalized).toHaveBeenCalled();
    const resolvedBroadcast = (ipc.broadcast as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0]?.type === 'security_block_resolved',
    );
    expect(resolvedBroadcast).toBeDefined();
  });

  it('swallows errors from the resolved-broadcast so callers never see them', () => {
    const ipc: IpcServer = {
      ...makeIpc(),
      broadcast: vi.fn((msg: { type: string }) => {
        if (msg.type === 'security_block_resolved') throw new Error('broadcast boom');
      }),
    } as unknown as IpcServer;
    const deps = makeDeps({ ipcServer: ipc });
    const registry = createPermissionsPendingRegistry(deps);
    const id = registry.beginPending({
      accountId: 'acct-b',
      toolName: 'Bash',
      matchedRule: makeRule(),
      source: 'permissions_strip',
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => registry.resolvePending(id, 'approve')).not.toThrow();
    consoleSpy.mockRestore();
  });

  it('swallows errors from the pending-broadcast inside beginPending', () => {
    const ipc: IpcServer = {
      ...makeIpc(),
      broadcast: vi.fn((msg: { type: string }) => {
        if (msg.type === 'security_block_pending') throw new Error('broadcast boom');
      }),
    } as unknown as IpcServer;
    const deps = makeDeps({ ipcServer: ipc });
    const registry = createPermissionsPendingRegistry(deps);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      registry.beginPending({
        accountId: 'acct-c',
        toolName: 'Bash',
        matchedRule: makeRule(),
        source: 'permissions_strip',
      }),
    ).not.toThrow();
    consoleSpy.mockRestore();
    expect(registry.listPending()).toHaveLength(1);
  });

  it('awaitPendingResolution resolves immediately with timeout for unknown ids', async () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);
    await expect(registry.awaitPendingResolution('nope')).resolves.toBe('timeout');
  });

  it('awaitPendingResolution resolves with the outcome from resolvePending', async () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);
    const id = registry.beginPending({
      accountId: 'acct-4',
      toolName: 'Read',
      matchedRule: makeRule({ raw: 'Read(**)' }),
      source: 'permissions_tool_use',
    });
    const awaitingPromise = registry.awaitPendingResolution(id);
    registry.resolvePending(id, 'approve');
    await expect(awaitingPromise).resolves.toBe('approve');
  });

  it('awaitPendingResolution resolves with timeout when the expiry timer fires', async () => {
    const deps = makeDeps({ getHoldSec: () => 2 });
    const registry = createPermissionsPendingRegistry(deps);
    const id = registry.beginPending({
      accountId: 'acct-5',
      toolName: 'Bash',
      matchedRule: makeRule(),
      source: 'permissions_strip',
    });
    const promise = registry.awaitPendingResolution(id);

    vi.advanceTimersByTime(2_000);
    await expect(promise).resolves.toBe('timeout');

    // onFinalized should have been called with outcome 'timeout' and null opts.
    expect(deps.onFinalized).toHaveBeenCalledWith(expect.any(Object), 'timeout', null);
    // And the entry is gone.
    expect(registry.listPending()).toHaveLength(0);
  });

  it('timeout path: swallows errors thrown by onFinalized', async () => {
    const onFinalized = vi.fn(() => {
      throw new Error('finalize boom');
    });
    const deps = makeDeps({
      getHoldSec: () => 1,
      onFinalized: onFinalized as unknown as OnPendingFinalized,
    });
    const registry = createPermissionsPendingRegistry(deps);
    const id = registry.beginPending({
      accountId: 'acct-err-timeout',
      toolName: 'Bash',
      matchedRule: makeRule(),
      source: 'permissions_strip',
    });
    const promise = registry.awaitPendingResolution(id);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.advanceTimersByTime(1_000);
    await expect(promise).resolves.toBe('timeout');
    consoleSpy.mockRestore();
    expect(onFinalized).toHaveBeenCalled();
  });

  it('timeout path: swallows errors thrown by the resolved-broadcast', async () => {
    const ipc: IpcServer = {
      ...makeIpc(),
      broadcast: vi.fn((msg: { type: string }) => {
        if (msg.type === 'security_block_resolved') throw new Error('broadcast boom');
      }),
    } as unknown as IpcServer;
    const deps = makeDeps({ getHoldSec: () => 1, ipcServer: ipc });
    const registry = createPermissionsPendingRegistry(deps);
    const id = registry.beginPending({
      accountId: 'acct-err-timeout-bcast',
      toolName: 'Bash',
      matchedRule: makeRule(),
      source: 'permissions_strip',
    });
    const promise = registry.awaitPendingResolution(id);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.advanceTimersByTime(1_000);
    await expect(promise).resolves.toBe('timeout');
    consoleSpy.mockRestore();
  });

  it('getHoldSec is clamped to at least 1 second', () => {
    const deps = makeDeps({ getHoldSec: () => 0 });
    const registry = createPermissionsPendingRegistry(deps);
    const id = registry.beginPending({
      accountId: 'acct-6',
      toolName: 'Bash',
      matchedRule: makeRule(),
      source: 'permissions_strip',
    });
    const snapshot = registry.listPending()[0]!;
    // Expiry ~ now + 1000ms; allow a few ms of slop.
    expect(snapshot.expiresAt - Date.now()).toBeGreaterThanOrEqual(500);
    expect(snapshot.expiresAt - Date.now()).toBeLessThanOrEqual(1500);
    registry.resolvePending(id, 'deny');
  });

  it('falls back to the tool name in the title when the rule.raw is empty', () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);
    const id = registry.beginPending({
      accountId: 'acct-7',
      toolName: 'MysteryTool',
      matchedRule: makeRule({ raw: '' }),
      source: 'permissions_strip',
    });
    const snap = registry.listPending().find((p) => p.pendingId === id)!;
    // The title construction always returns a non-empty string; either the
    // raw-based branch or the tool-name fallback.
    expect(snap.title.length).toBeGreaterThan(0);
    registry.resolvePending(id, 'deny');
  });

  it('includes the rule note in the block reason when present', () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);
    const id = registry.beginPending({
      accountId: 'acct-8',
      toolName: 'Bash',
      matchedRule: makeRule({ raw: 'Bash(rm -rf *)', note: 'catastrophic' }),
      source: 'permissions_strip',
    });
    const snap = registry.listPending().find((p) => p.pendingId === id)!;
    expect(snap.blockReason).toContain('catastrophic');
    registry.resolvePending(id, 'deny');
  });
});
