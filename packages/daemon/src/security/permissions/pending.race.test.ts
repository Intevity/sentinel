/**
 * Race-condition and lifecycle tests for the permissions pending
 * registry. The existing `pending.test.ts` covers the happy paths
 * and error swallowing; this suite pins the behavior under genuinely
 * concurrent timer + IPC events, plus the contract for double-resolve,
 * unknown ids, and the no-de-dup guarantee for concurrent identical
 * requests.
 */

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

describe('pending registry: timer-vs-resolve races', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('IPC approve arriving AFTER timeout fires is a no-op (timeout already finalized)', async () => {
    const deps = makeDeps({ getHoldSec: () => 1 });
    const registry = createPermissionsPendingRegistry(deps);
    const id = registry.beginPending({
      accountId: 'acct-1',
      toolName: 'Bash',
      matchedRule: makeRule(),
      source: 'permissions_strip',
    });
    const promise = registry.awaitPendingResolution(id);

    // Trip the timeout first.
    vi.advanceTimersByTime(1_000);
    await expect(promise).resolves.toBe('timeout');

    // The user finally taps approve well after the deadline. The
    // contract: returns false (entry is gone) and never re-fires
    // onFinalized — otherwise the security event would be recorded
    // twice with conflicting outcomes.
    const finalizeCount = deps.onFinalized.mock.calls.length;
    expect(registry.resolvePending(id, 'approve')).toBe(false);
    expect(deps.onFinalized.mock.calls).toHaveLength(finalizeCount);
  });

  it('IPC approve arriving BEFORE timeout cancels the timer; finalize fires once', async () => {
    const deps = makeDeps({ getHoldSec: () => 5 });
    const registry = createPermissionsPendingRegistry(deps);
    const id = registry.beginPending({
      accountId: 'acct-2',
      toolName: 'Bash',
      matchedRule: makeRule(),
      source: 'permissions_strip',
    });
    const promise = registry.awaitPendingResolution(id);

    // User decides at T+1s.
    vi.advanceTimersByTime(1_000);
    expect(registry.resolvePending(id, 'approve')).toBe(true);
    await expect(promise).resolves.toBe('approve');

    // Push past the original 5s deadline. The timer must have been
    // cleared — if it hadn't been, onFinalized would fire a second
    // time with outcome='timeout'.
    vi.advanceTimersByTime(10_000);
    expect(deps.onFinalized).toHaveBeenCalledTimes(1);
    expect(deps.onFinalized.mock.calls[0]![1]).toBe('approve');
  });

  it('two beginPending calls with identical (toolName, rule) produce DISTINCT pending ids', () => {
    // Pinning the no-de-dup contract from D4. Two simultaneous
    // identical prompts should each produce their own banner so the
    // user never approves a second invocation by accident.
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);
    const rule = makeRule({ raw: 'Bash(rm -rf *)' });
    const id1 = registry.beginPending({
      accountId: 'acct-A',
      toolName: 'Bash',
      matchedRule: rule,
      source: 'permissions_tool_use',
      toolInputFields: { command: 'rm -rf /tmp/a' },
    });
    const id2 = registry.beginPending({
      accountId: 'acct-A',
      toolName: 'Bash',
      matchedRule: rule,
      source: 'permissions_tool_use',
      toolInputFields: { command: 'rm -rf /tmp/a' },
    });
    expect(id1).not.toBe(id2);
    expect(registry.listPending()).toHaveLength(2);

    registry.resolvePending(id1, 'deny');
    registry.resolvePending(id2, 'deny');
    expect(registry.listPending()).toHaveLength(0);
  });

  it('resolving id1 does not affect a sibling id2 (independent state machines)', () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);
    const id1 = registry.beginPending({
      accountId: 'acct-X',
      toolName: 'Bash',
      matchedRule: makeRule(),
      source: 'permissions_strip',
    });
    const id2 = registry.beginPending({
      accountId: 'acct-X',
      toolName: 'Bash',
      matchedRule: makeRule(),
      source: 'permissions_strip',
    });

    expect(registry.resolvePending(id1, 'approve')).toBe(true);
    expect(registry.listPending().map((p) => p.pendingId)).toEqual([id2]);

    expect(registry.resolvePending(id2, 'deny')).toBe(true);
    expect(registry.listPending()).toHaveLength(0);

    // onFinalized must have fired exactly twice with the right outcomes.
    expect(deps.onFinalized).toHaveBeenCalledTimes(2);
    const outcomes = deps.onFinalized.mock.calls.map((c) => c[1]);
    expect(outcomes).toContain('approve');
    expect(outcomes).toContain('deny');
  });

  it('awaitPendingResolution called twice for the same id: ONLY the most recent awaiter settles (contract-pinned)', async () => {
    // Pinning the actual contract: the second `_installResolver` call
    // overwrites the first, so only the LATER awaiter settles when the
    // entry resolves. The earlier awaiter hangs. This is intentional
    // (the interceptor is the canonical single caller) but easy to
    // accidentally change. The assertion below would fail loudly if a
    // future refactor switched to a multi-listener API — at which
    // point the test should be flipped to assert both resolve.
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);
    const id = registry.beginPending({
      accountId: 'acct-dup',
      toolName: 'Bash',
      matchedRule: makeRule(),
      source: 'permissions_tool_use',
    });
    const p1 = registry.awaitPendingResolution(id);
    const p2 = registry.awaitPendingResolution(id);

    const states = { p1: 'pending', p2: 'pending' };
    void p1.then((v) => {
      states.p1 = `resolved:${v}`;
    });
    void p2.then((v) => {
      states.p2 = `resolved:${v}`;
    });

    registry.resolvePending(id, 'approve');

    // Drain a few microtask ticks so any synchronously-scheduled
    // resolutions run. Microtasks are not faked by vi.useFakeTimers().
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(states.p2).toBe('resolved:approve');
    expect(states.p1).toBe('pending');
  });
});

describe('pending registry: edge cases pinned for safety', () => {
  it('awaitPendingResolution for an unknown id resolves synchronously to "timeout"', async () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);
    const before = deps.onFinalized.mock.calls.length;
    await expect(registry.awaitPendingResolution('definitely-not-a-real-id')).resolves.toBe(
      'timeout',
    );
    // CRITICAL: an unknown id must NOT trigger onFinalized — otherwise
    // a stray IPC message with a typo would record a phantom security
    // event. Pin via call-count delta.
    expect(deps.onFinalized.mock.calls.length).toBe(before);
  });

  it('resolvePending for an unknown id returns false and never calls onFinalized', () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);
    expect(registry.resolvePending('nonexistent', 'approve', { addBypass: true })).toBe(false);
    expect(deps.onFinalized).not.toHaveBeenCalled();
  });

  it('100 concurrent beginPending entries are all listed and all resolvable', () => {
    // Stress test: nothing in the registry's API caps the number of
    // pending entries. If a future change introduces a max, this test
    // will fail and force the cap to be made explicit.
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      ids.push(
        registry.beginPending({
          accountId: `acct-${i}`,
          toolName: 'Bash',
          matchedRule: makeRule(),
          source: 'permissions_strip',
        }),
      );
    }
    expect(new Set(ids).size).toBe(100); // all unique
    expect(registry.listPending()).toHaveLength(100);

    for (const id of ids) registry.resolvePending(id, 'deny');
    expect(registry.listPending()).toHaveLength(0);
    expect(deps.onFinalized).toHaveBeenCalledTimes(100);
  });

  it('getHoldSec returning a negative value is clamped to at least 1 second', () => {
    // The clamp protects against pathological settings (user typed -1,
    // upgrade migration left a 0). A 0 or negative timer would fire
    // synchronously and race the registration broadcast.
    const deps = makeDeps({ getHoldSec: () => -10 });
    const registry = createPermissionsPendingRegistry(deps);
    const id = registry.beginPending({
      accountId: 'acct-neg',
      toolName: 'Bash',
      matchedRule: makeRule(),
      source: 'permissions_strip',
    });
    const snapshot = registry.listPending()[0]!;
    // Expiry should be ~1s in the future (allow some slop for slow CI).
    const dt = snapshot.expiresAt - Date.now();
    expect(dt).toBeGreaterThanOrEqual(500);
    expect(dt).toBeLessThanOrEqual(2_000);
    registry.resolvePending(id, 'deny');
  });
});
