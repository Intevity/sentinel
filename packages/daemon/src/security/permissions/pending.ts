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
} from '@sentinel/shared';
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
  /** Optional pre-truncated scalar field map from the parsed tool_use
   *  input. Populated only for `permissions_tool_use` callers; forwarded
   *  verbatim into the `security_block_pending` snapshot. `null` for the
   *  strip path (no specific call exists yet). */
  toolInputFields: Record<string, string> | null;
  matchedRule: PermissionRule;
  expiresAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  settle: (outcome: PendingOutcome) => void;
  /** Sprint 9 — populated when the enforcer hands them in. Carried
   *  through into the snapshot + finalize hook unchanged. */
  provenance: { createdAt: number; source: 'local' | 'claude-code'; ruleId: string } | null;
  recentApproveCount: number | null;
  sessionId: string | null;
}

/** Extra per-resolution metadata the IPC layer can pass alongside an
 *  approve/deny to steer side effects.
 *  - `addBypass` (legacy v1.x): inserts a permission_bypass row so
 *    future identical inputs skip the banner.
 *  - `mode` (Sprint 9): user-picked approval scope. 'once' just
 *    resolves; 'session' inserts a session_approval_grants row so the
 *    same Claude Code session skips this rule until the grant
 *    expires; 'always' is the new spelling of `addBypass: true`.
 *  When both are set, `mode` wins. The enforcer maps unknown values
 *  to 'once' for forward-compat. */
export interface ResolveOpts {
  addBypass?: boolean;
  mode?: 'once' | 'session' | 'always';
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
  /** Sprint 9 — request's session_id if the enforcer extracted one,
   *  null otherwise. The onFinalized hook uses this to write
   *  session_approval_grants rows on `mode === 'session'`. */
  sessionId: string | null;
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
    /** Optional scalar field map for tool_use sources. Caller is
     *  responsible for per-field truncation; the registry forwards
     *  verbatim and omits the field from the snapshot when empty/absent. */
    toolInputFields?: Record<string, string>;
    /** Sprint 9: pulled from the matched rule's row at evaluation
     *  time so the banner can render "rule added X days ago, by Y". */
    provenance?: { createdAt: number; source: 'local' | 'claude-code'; ruleId: string };
    /** Sprint 9: count of approves the user has issued for this exact
     *  pattern in this session within the last 5 minutes. Drives the
     *  "consider editing the rule" pill. */
    recentApproveCount?: number;
    /** Sprint 9: session_id of the request that triggered this block.
     *  Used by the registry to thread the value back into the
     *  finalized entry so the enforcer's onFinalized hook can write
     *  session_approval_grants rows on approve. */
    sessionId?: string | null;
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

/** Sprint 10: hard cap on live pending entries. Above this, new
 *  beginPending() calls fail-open (let the request through with an
 *  immediate 'approve' resolution) and log a WARN. The cap exists so a
 *  buggy client that holds requests indefinitely or a flood of
 *  malicious "ask" matches can't grow the registry without bound. */
export const PERMISSIONS_PENDING_MAX = 1000;

/** Build a permissions pending registry. Lives for the lifetime of
 *  the daemon; the enforcer owns a single instance. */
export function createPermissionsPendingRegistry(
  deps: CreatePermissionsPendingDeps,
): PermissionsPendingRegistry {
  const entries = new Map<string, PendingPermissionEntry>();
  // Tracks ids issued under the fail-open path so awaitPendingResolution
  // can resolve them to 'approve' instead of the unknown-id 'timeout'.
  // Each id is consumed by its single awaiter; the set never holds more
  // than the in-flight burst that triggered the cap.
  const failOpenIds = new Set<string>();

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
    // Omit the field entirely when the caller didn't supply one or it
    // collapsed to {}. Older clients and the strip path stay byte-
    // identical to today.
    ...(entry.toolInputFields && Object.keys(entry.toolInputFields).length > 0
      ? { toolInputFields: entry.toolInputFields }
      : {}),
    ...(entry.provenance ? { provenance: entry.provenance } : {}),
    ...(entry.recentApproveCount !== null && entry.recentApproveCount !== undefined
      ? { recentApproveCount: entry.recentApproveCount }
      : {}),
  });

  const beginPending = (args: {
    accountId: string;
    toolName: string;
    matchedRule: PermissionRule;
    source: 'permissions_strip' | 'permissions_tool_use';
    toolInputFields?: Record<string, string>;
    provenance?: { createdAt: number; source: 'local' | 'claude-code'; ruleId: string };
    recentApproveCount?: number;
    sessionId?: string | null;
  }): string => {
    if (entries.size >= PERMISSIONS_PENDING_MAX) {
      // Cap reached. Fail-open: skip the hold, let the caller through
      // (awaitPendingResolution returns 'approve' for this id). No
      // broadcast, no onFinalized — fail-open is a system-level event
      // and we don't want a flood of audit rows masking the underlying
      // capacity issue. The WARN is the operator signal.
      const id = randomUUID();
      failOpenIds.add(id);
      console.warn(
        `[Permissions] pending registry at cap (${PERMISSIONS_PENDING_MAX}); failing open for rule=${args.matchedRule.raw || args.matchedRule.id}`,
      );
      return id;
    }
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
            sessionId: entry.sessionId,
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
      toolInputFields: args.toolInputFields ?? null,
      matchedRule: args.matchedRule,
      expiresAt,
      timeoutHandle,
      settle: (outcome) => {
        externalSettle(outcome);
      },
      provenance: args.provenance ?? null,
      recentApproveCount: args.recentApproveCount ?? null,
      sessionId: args.sessionId ?? null,
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
    if (failOpenIds.has(pendingId)) {
      failOpenIds.delete(pendingId);
      return Promise.resolve('approve');
    }
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
          sessionId: entry.sessionId,
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
