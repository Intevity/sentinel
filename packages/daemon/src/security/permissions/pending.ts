/**
 * Pending-block registry for permission-rule blocks. Mirrors the
 * pattern used by the scanner's outbound-body pending system, but
 * sized for the enforcer's two paths:
 *   - `permissions_strip`: a whole-tool deny rule matched a tool in the
 *     outbound `tools` array. Held in `stripDeniedTools` before the
 *     body is forwarded upstream.
 *   - `permissions_tool_use`: a tool_use block in an SSE response
 *     matched a deny rule. Held inside the SSE interceptor while the
 *     user decides.
 *
 * On approve, the caller lets the original payload through (no strip,
 * no substitution). On deny or timeout, the caller falls back to the
 * current behavior (strip / synthesize a block-reason text block).
 *
 * One-shot approve: unlike the scanner's allowlist, a permission rule
 * is a user-authored piece of config; we don't silently erode it by
 * auto-allowlisting a specific input. The user's single approval
 * forwards just that one request — future identical calls will
 * re-trigger the same prompt. If that feels too noisy, the user can
 * edit the rule in Settings.
 */

import { randomUUID } from 'crypto';
import type {
  PendingBlockSource,
  PendingSecurityBlock,
  PermissionRule,
  SecuritySeverity,
} from '@claude-sentinel/shared';
import type { IpcServer } from '../../ipc.js';
import type { PendingOutcome } from '../scanner.js';

/** Internal registry entry — the raw block state plus the resolver
 *  plumbing that lets `awaitPendingResolution` bridge a Promise to
 *  either the timeout timer or the IPC `resolvePending` call,
 *  whichever fires first. */
interface PendingPermissionEntry {
  id: string;
  accountId: string;
  severity: SecuritySeverity;
  title: string;
  blockReason: string;
  matchMask: string | null;
  detectorId: string;
  source: PendingBlockSource;
  toolName: string;
  matchedRule: PermissionRule;
  expiresAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  settle: (outcome: PendingOutcome) => void;
}

/** Extra per-resolution metadata the IPC layer can pass alongside an
 *  approve/deny to steer side effects. Today only `addBypass` is
 *  defined — if the user ticked "Always allow this exact input" on a
 *  `permissions_tool_use` banner, the enforcer inserts a
 *  `permission_bypass` row so future identical calls short-circuit. */
export interface ResolveOpts {
  addBypass?: boolean;
}

/** Callback invoked when a pending entry settles (approve / deny /
 *  timeout). The enforcer wires this to its `recordBlock`-style
 *  persistence path so security events + notifications stay in sync
 *  with whichever outcome the user picked. `opts` is the
 *  user-supplied metadata from `resolvePending`; `null` when the
 *  entry settled via the timeout path. */
export type OnPendingFinalized = (
  entry: FinalizedPermissionEntry,
  outcome: PendingOutcome,
  opts: ResolveOpts | null,
) => void;

/** Public view of a finalized entry passed to the `onFinalized` hook.
 *  Strips the internal resolver machinery so consumers can't
 *  accidentally re-settle the entry. */
export interface FinalizedPermissionEntry {
  id: string;
  accountId: string;
  toolName: string;
  matchedRule: PermissionRule;
  source: PendingBlockSource;
  severity: SecuritySeverity;
}

export interface PermissionsPendingRegistry {
  /** Create a new pending block, broadcast `security_block_pending`,
   *  and start the expiry timer. Returns the pendingId the proxy /
   *  interceptor will use to await resolution. */
  beginPending(args: {
    accountId: string;
    toolName: string;
    matchedRule: PermissionRule;
    source: 'permissions_strip' | 'permissions_tool_use';
  }): string;
  /** Resolve via `awaitPendingResolution(pendingId)` — returns a
   *  Promise that settles with 'approve' | 'deny' | 'timeout'. Safe
   *  against a race with the timer (whichever fires first wins). */
  awaitPendingResolution(pendingId: string): Promise<PendingOutcome>;
  /** Called by the IPC layer when the user taps Approve / Deny in the
   *  banner or OS notification. Returns true when applied, false when
   *  the id is unknown (already resolved, or for a different registry).
   *  `opts` carries optional user-chosen side-effect flags (e.g.
   *  `addBypass`). Ignored for deny outcomes. */
  resolvePending(pendingId: string, outcome: 'approve' | 'deny', opts?: ResolveOpts): boolean;
  /** Snapshot every live pending entry. Used by the app on reconnect
   *  so the banner can re-render. Includes both scanner and
   *  permissions entries when merged at the IPC layer. */
  listPending(): PendingSecurityBlock[];
}

export interface CreatePermissionsPendingDeps {
  ipcServer: IpcServer;
  /** Seconds the user has to decide before the block auto-finalizes
   *  as `deny`. Mirrors the scanner's `securityApproveHoldSec`. */
  getHoldSec: () => number;
  /** Fired once per entry, after it settles. The enforcer uses this
   *  to persist the security event + notification with the correct
   *  blocked/approved flags. */
  onFinalized: OnPendingFinalized;
}

/** Build a permissions pending registry. Lives for the lifetime of
 *  the daemon; the enforcer owns a single instance. */
export function createPermissionsPendingRegistry(
  deps: CreatePermissionsPendingDeps,
): PermissionsPendingRegistry {
  const entries = new Map<string, PendingPermissionEntry>();

  /** Short human-readable "title" shown in the banner + OS notification.
   *  Must be stable so duplicate-broadcast collapsing works later. */
  const buildTitle = (toolName: string, rule: PermissionRule): string =>
    `Tool blocked: ${rule.raw}`.length > 0
      ? `Tool blocked: ${rule.raw}`
      : `Tool blocked: ${toolName}`;

  const buildReason = (toolName: string, rule: PermissionRule): string => {
    const note = rule.note ? ` — ${rule.note}` : '';
    return `Sentinel permission rule ${rule.raw} blocked ${toolName}${note}`;
  };

  const toSnapshot = (entry: PendingPermissionEntry): PendingSecurityBlock => ({
    pendingId: entry.id,
    accountId: entry.accountId,
    severity: entry.severity,
    title: entry.title,
    blockReason: entry.blockReason,
    matchMask: entry.matchMask,
    detectorId: entry.detectorId,
    expiresAt: entry.expiresAt,
    source: entry.source,
    toolName: entry.toolName,
  });

  const beginPending = (args: {
    accountId: string;
    toolName: string;
    matchedRule: PermissionRule;
    source: 'permissions_strip' | 'permissions_tool_use';
  }): string => {
    const id = randomUUID();
    const holdSec = Math.max(1, deps.getHoldSec());
    const expiresAt = Date.now() + holdSec * 1000;

    // `externalSettle` starts as a no-op and is overwritten by
    // `_installResolver` the first time `awaitPendingResolution`
    // is called for this id. The `resolverCalled` guard prevents the
    // timer + user-resolve race from firing the Promise twice.
    let externalSettle: (outcome: PendingOutcome) => void = () => undefined;
    let resolverCalled = false;

    const finalize = (
      entry: PendingPermissionEntry,
      outcome: PendingOutcome,
      opts: ResolveOpts | null,
    ): void => {
      try {
        deps.onFinalized(
          {
            id: entry.id,
            accountId: entry.accountId,
            toolName: entry.toolName,
            matchedRule: entry.matchedRule,
            source: entry.source,
            severity: entry.severity,
          },
          outcome,
          opts,
        );
      } catch (err) {
        console.error('[Permissions] onFinalized failed:', err);
      }
      try {
        deps.ipcServer.broadcast({
          type: 'security_block_resolved',
          pendingId: entry.id,
          outcome,
        });
      } catch (err) {
        console.error('[Permissions] broadcast(resolved) failed:', err);
      }
    };

    const timeoutHandle = setTimeout(() => {
      const entry = entries.get(id);
      /* v8 ignore next 1 — race with resolvePending deleting first */
      if (!entry) return;
      entries.delete(id);
      // Timeout carries no opts — the user didn't interact, so no
      // bypass flag etc.
      finalize(entry, 'timeout', null);
      externalSettle('timeout');
    }, holdSec * 1000);
    // Don't hold the event loop open just for a pending-block timer —
    // matches scanner.ts behavior.
    timeoutHandle.unref?.();

    const entry: PendingPermissionEntry = {
      id,
      accountId: args.accountId,
      severity: 'medium',
      title: buildTitle(args.toolName, args.matchedRule),
      blockReason: buildReason(args.toolName, args.matchedRule),
      // For permission blocks the "match mask" is just the rule's raw
      // text — the banner surfaces it verbatim so the user knows which
      // rule fired.
      matchMask: args.matchedRule.raw || null,
      detectorId: 'tool_permission_blocked',
      source: args.source,
      toolName: args.toolName,
      matchedRule: args.matchedRule,
      expiresAt,
      timeoutHandle,
      settle: (outcome) => {
        externalSettle(outcome);
      },
    };

    entries.set(id, entry);

    try {
      deps.ipcServer.broadcast({
        type: 'security_block_pending',
        pending: toSnapshot(entry),
      });
    } catch (err) {
      console.error('[Permissions] broadcast(pending) failed:', err);
    }

    // Wire the resolver installer. `awaitPendingResolution` calls
    // `_installResolver` to register its Promise.resolve callback;
    // we overwrite `externalSettle` so the timer or `resolvePending`
    // call routes through to the awaiter.
    (
      entry as PendingPermissionEntry & {
        _installResolver?: (fn: (outcome: PendingOutcome) => void) => void;
      }
    )._installResolver = (fn) => {
      externalSettle = (outcome) => {
        /* v8 ignore next 1 — defensive double-call guard */
        if (resolverCalled) return;
        resolverCalled = true;
        fn(outcome);
      };
    };

    return id;
  };

  const awaitPendingResolution = (pendingId: string): Promise<PendingOutcome> => {
    const entry = entries.get(pendingId);
    // Unknown id — fall through as timeout. Matches scanner behavior.
    if (!entry) return Promise.resolve('timeout');
    return new Promise<PendingOutcome>((resolve) => {
      const withResolver = entry as PendingPermissionEntry & {
        _installResolver: (fn: (outcome: PendingOutcome) => void) => void;
      };
      withResolver._installResolver(resolve);
    });
  };

  const resolvePending = (
    pendingId: string,
    outcome: 'approve' | 'deny',
    opts?: ResolveOpts,
  ): boolean => {
    const entry = entries.get(pendingId);
    if (!entry) return false;
    entries.delete(pendingId);
    clearTimeout(entry.timeoutHandle);
    try {
      deps.onFinalized(
        {
          id: entry.id,
          accountId: entry.accountId,
          toolName: entry.toolName,
          matchedRule: entry.matchedRule,
          source: entry.source,
          severity: entry.severity,
        },
        outcome,
        opts ?? null,
      );
    } catch (err) {
      console.error('[Permissions] onFinalized failed:', err);
    }
    try {
      deps.ipcServer.broadcast({
        type: 'security_block_resolved',
        pendingId: entry.id,
        outcome,
      });
    } catch (err) {
      console.error('[Permissions] broadcast(resolved) failed:', err);
    }
    entry.settle(outcome);
    return true;
  };

  const listPending = (): PendingSecurityBlock[] => Array.from(entries.values()).map(toSnapshot);

  return { beginPending, awaitPendingResolution, resolvePending, listPending };
}
