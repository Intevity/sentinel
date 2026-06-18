import type {
  DaemonToAppMessage,
  SecurityKind,
  SecurityOsNotifyThreshold,
  SecuritySeverity,
} from '@sentinel/shared';
import { shouldFireSecurityOsNotification } from '../lib/security-threshold.js';

export type SecurityBannerPayload =
  | {
      kind: 'event';
      severity: SecuritySeverity;
      title: string;
      eventKind: SecurityKind;
      eventId?: number;
      blocked: boolean;
    }
  | {
      kind: 'pending';
      severity: SecuritySeverity;
      title: string;
    };

/**
 * Pure helper: map an incoming daemon broadcast + the user's severity
 * threshold to a banner payload (or null when the broadcast shouldn't
 * surface in-app). Extracted from {@link useSecurityBanner} so the
 * gating + payload-shape logic is testable without a React renderer.
 */
export function buildSecurityBannerPayload(
  msg: DaemonToAppMessage,
  threshold: SecurityOsNotifyThreshold,
): SecurityBannerPayload | null {
  if (msg.type === 'security_event_detected') {
    if (!shouldFireSecurityOsNotification(msg.severity, threshold)) return null;
    const payload: SecurityBannerPayload = {
      kind: 'event',
      severity: msg.severity,
      title: msg.title,
      eventKind: msg.kind,
      blocked: msg.blocked,
    };
    if (msg.eventId !== undefined) payload.eventId = msg.eventId;
    return payload;
  }
  if (msg.type === 'security_block_pending') {
    if (!shouldFireSecurityOsNotification(msg.pending.severity, threshold)) return null;
    return {
      kind: 'pending',
      severity: msg.pending.severity,
      title: msg.pending.title,
    };
  }
  return null;
}
