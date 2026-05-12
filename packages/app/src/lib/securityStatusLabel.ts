import type { SecurityEvent } from '@claude-sentinel/shared';

export type SecurityStatusVariant =
  | 'diagnostic'
  | 'allowed'
  | 'denied'
  | 'timed-out'
  | 'muted'
  | 'blocked'
  | 'detected';

export type SecurityStatusLabel =
  | 'Diagnostic'
  | 'Allowed by you'
  | 'Denied by you'
  | 'Timed out'
  | 'Muted'
  | 'Blocked'
  | 'Detected';

export interface SecurityStatusInfo {
  label: SecurityStatusLabel;
  variant: SecurityStatusVariant;
}

/** Pure mapping from a SecurityEvent to its status-pill label + variant.
 *
 *  The decision matrix the StatusPill component renders, evaluated top-down:
 *    - synthetic `scan_*` kinds                  → Diagnostic
 *    - resolution === 'user_approve'             → Allowed by you
 *    - resolution === 'user_deny'                → Denied by you
 *    - resolution === 'timeout'                  → Timed out
 *    - acknowledged === true (no resolution set) → Muted
 *    - blocked === true                          → Blocked
 *    - otherwise (observe-only)                  → Detected
 *
 *  Resolved (approve / deny / timeout / muted) rows stay visible inline
 *  with a status pill so the user can see their past actions; the row
 *  is not removed from the list. */
export function securityStatusInfo(
  event: Pick<SecurityEvent, 'blocked' | 'kind' | 'resolution' | 'acknowledged'>,
): SecurityStatusInfo {
  if (event.kind.startsWith('scan_')) {
    return { label: 'Diagnostic', variant: 'diagnostic' };
  }
  if (event.resolution === 'user_approve') {
    return { label: 'Allowed by you', variant: 'allowed' };
  }
  if (event.resolution === 'user_deny') {
    return { label: 'Denied by you', variant: 'denied' };
  }
  if (event.resolution === 'timeout') {
    return { label: 'Timed out', variant: 'timed-out' };
  }
  if (event.acknowledged) {
    return { label: 'Muted', variant: 'muted' };
  }
  if (event.blocked) {
    return { label: 'Blocked', variant: 'blocked' };
  }
  return { label: 'Detected', variant: 'detected' };
}

/** Action button label for a history row, derived from the same
 *  (blocked, resolution, kind) tuple as the status pill.
 *
 *  - 'mute-synthetic': synthetic scan_* row → "Mute these" (existing
 *    UI; flips a per-kind settings flag).
 *  - 'allowlist':      blocked rows → "Always allow" (semantically
 *    correct here; adds the exact match to security_allowlist so
 *    future identical calls skip the approval row).
 *  - 'mute':           observe-only rows → "Mute" (same allowlist
 *    insert, honest label — the request was never blocked, so
 *    "Always allow" is misleading).
 *  - 'none':           user-approved holds — no further action; the
 *    allowlist entry was already added at approve time.
 */
export type SecurityRowActionKind = 'mute-synthetic' | 'allowlist' | 'mute' | 'none';

export function securityRowAction(
  event: Pick<SecurityEvent, 'blocked' | 'kind' | 'resolution'>,
): SecurityRowActionKind {
  if (event.kind.startsWith('scan_')) return 'mute-synthetic';
  if (event.resolution === 'user_approve') return 'none';
  if (event.blocked) return 'allowlist';
  return 'mute';
}
