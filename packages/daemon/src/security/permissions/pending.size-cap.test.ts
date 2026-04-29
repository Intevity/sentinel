import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPermissionsPendingRegistry,
  PERMISSIONS_PENDING_MAX,
  type CreatePermissionsPendingDeps,
} from './pending.js';
import type { IpcServer } from '../../ipc.js';
import type { PermissionRule } from '@claude-sentinel/shared';

// Sprint 10: pin the pending registry's hard cap. New pendings above
// PERMISSIONS_PENDING_MAX fail-open (resolve immediately to 'approve')
// and emit a console.warn so operators see the capacity issue.

function makeIpc(): IpcServer {
  return {
    broadcast: vi.fn(),
    onMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    connectedClients: 0,
  } as unknown as IpcServer;
}

function makeRule(over: Partial<PermissionRule> = {}): PermissionRule {
  return {
    id: 'rule-id',
    raw: 'Bash',
    tool: 'Bash',
    decision: 'deny',
    pattern: null,
    note: null,
    enabled: true,
    priority: 0,
    createdAt: 1,
    source: 'local',
    projectScope: null,
    ...over,
  };
}

function makeDeps(): CreatePermissionsPendingDeps {
  return {
    ipcServer: makeIpc(),
    getHoldSec: () => 5,
    onFinalized: vi.fn(),
  };
}

describe('PERMISSIONS_PENDING_MAX cap', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    // The cap path emits a console.warn per overflow; suppress it for
    // the test's signal-to-noise ratio and assert on it explicitly.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it('exposes a documented constant', () => {
    expect(PERMISSIONS_PENDING_MAX).toBe(1000);
  });

  it('accepts entries up to the cap normally; rejects the next as fail-open', async () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);

    // Fill the registry exactly to the cap.
    const ids: string[] = [];
    for (let i = 0; i < PERMISSIONS_PENDING_MAX; i++) {
      ids.push(
        registry.beginPending({
          accountId: 'acct-1',
          toolName: 'Bash',
          matchedRule: makeRule({ id: `rule-${i}` }),
          source: 'permissions_strip',
        }),
      );
    }
    expect(registry.listPending()).toHaveLength(PERMISSIONS_PENDING_MAX);
    expect(warnSpy).not.toHaveBeenCalled();

    // The 1001st: cap reached → fail-open path. The id returned still
    // resolves through awaitPendingResolution, but to 'approve' (let
    // the caller through) and synchronously, with no broadcast and no
    // entry in listPending.
    const ipcCallsBefore = (deps.ipcServer.broadcast as ReturnType<typeof vi.fn>).mock.calls.length;
    const failOpenId = registry.beginPending({
      accountId: 'acct-1',
      toolName: 'Bash',
      matchedRule: makeRule({ id: 'rule-overflow' }),
      source: 'permissions_strip',
    });
    expect(typeof failOpenId).toBe('string');
    expect(failOpenId.length).toBeGreaterThan(0);
    expect(registry.listPending()).toHaveLength(PERMISSIONS_PENDING_MAX);
    const ipcCallsAfter = (deps.ipcServer.broadcast as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(ipcCallsAfter).toBe(ipcCallsBefore); // no broadcast for fail-open

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/registry at cap/);

    // awaitPendingResolution on the fail-open id resolves to 'approve'.
    const outcome = await registry.awaitPendingResolution(failOpenId);
    expect(outcome).toBe('approve');

    // onFinalized is NOT invoked for fail-open: the WARN log is the
    // operator signal, not an audit row per dropped pending.
    expect(deps.onFinalized).not.toHaveBeenCalled();
  });

  it('resolving a normal entry frees a slot for new pendings', async () => {
    const deps = makeDeps();
    const registry = createPermissionsPendingRegistry(deps);

    // Fill to the cap.
    const ids: string[] = [];
    for (let i = 0; i < PERMISSIONS_PENDING_MAX; i++) {
      ids.push(
        registry.beginPending({
          accountId: 'acct-1',
          toolName: 'Bash',
          matchedRule: makeRule({ id: `rule-${i}` }),
          source: 'permissions_strip',
        }),
      );
    }
    // Resolve one — opens a slot.
    expect(registry.resolvePending(ids[0]!, 'approve')).toBe(true);
    expect(registry.listPending()).toHaveLength(PERMISSIONS_PENDING_MAX - 1);

    // New beginPending now succeeds via the normal path: a real entry
    // is registered and listPending sees it. Crucially, no WARN fires.
    const newId = registry.beginPending({
      accountId: 'acct-1',
      toolName: 'Bash',
      matchedRule: makeRule({ id: 'rule-new' }),
      source: 'permissions_strip',
    });
    expect(registry.listPending()).toHaveLength(PERMISSIONS_PENDING_MAX);
    expect(registry.listPending().some((p) => p.pendingId === newId)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
