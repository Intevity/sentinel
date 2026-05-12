import { describe, expect, it } from 'vitest';
import type {
  DaemonToAppMessage,
  PendingSecurityBlock,
  SecuritySeverity,
} from '@claude-sentinel/shared';
import { buildSecurityBannerPayload } from './useSecurityBanner.logic.js';

function eventMsg(severity: SecuritySeverity, overrides: Partial<DaemonToAppMessage> = {}) {
  return {
    type: 'security_event_detected',
    accountId: 'acct-1',
    severity,
    kind: 'secret',
    title: 'GitHub personal token',
    blocked: false,
    eventId: 42,
    ...overrides,
  } as DaemonToAppMessage;
}

function pendingMsg(severity: SecuritySeverity, overrides: Partial<PendingSecurityBlock> = {}) {
  return {
    type: 'security_block_pending',
    pending: {
      pendingId: 'pend-1',
      accountId: 'acct-1',
      severity,
      title: 'Bash(rm -rf *)',
      blockReason: 'matched deny rule',
      matchMask: 'Bash(rm -rf *)',
      detectorId: 'permissions',
      expiresAt: 1_700_000_000_000,
      ...overrides,
    },
  } as DaemonToAppMessage;
}

describe('buildSecurityBannerPayload', () => {
  describe('security_event_detected', () => {
    it('returns an event payload carrying severity, title, kind, eventId, and blocked', () => {
      const out = buildSecurityBannerPayload(eventMsg('high'), 'low');
      expect(out).toEqual({
        kind: 'event',
        severity: 'high',
        title: 'GitHub personal token',
        eventKind: 'secret',
        eventId: 42,
        blocked: false,
      });
    });

    it('preserves blocked=true', () => {
      const out = buildSecurityBannerPayload(eventMsg('high', { blocked: true }), 'low');
      expect(out).toMatchObject({ kind: 'event', blocked: true });
    });

    it('omits eventId when the broadcast lacks one (older broadcasters)', () => {
      const msg = eventMsg('high');
      // Remove the field rather than setting it to undefined, so we
      // exercise the absent-field branch (older daemons that don't
      // emit eventId at all). Direct assignment of undefined would
      // run afoul of exactOptionalPropertyTypes.
      delete (msg as { eventId?: number }).eventId;
      const out = buildSecurityBannerPayload(msg, 'low');
      expect(out).toEqual({
        kind: 'event',
        severity: 'high',
        title: 'GitHub personal token',
        eventKind: 'secret',
        blocked: false,
      });
      expect(out).not.toHaveProperty('eventId');
    });

    it('returns null when threshold is off', () => {
      expect(buildSecurityBannerPayload(eventMsg('high'), 'off')).toBeNull();
    });

    it('returns null when severity is below threshold (medium event, high threshold)', () => {
      expect(buildSecurityBannerPayload(eventMsg('medium'), 'high')).toBeNull();
    });

    it('returns null when severity is below threshold (low event, medium threshold)', () => {
      expect(buildSecurityBannerPayload(eventMsg('low'), 'medium')).toBeNull();
    });

    it('fires when severity equals threshold', () => {
      expect(buildSecurityBannerPayload(eventMsg('medium'), 'medium')).not.toBeNull();
    });
  });

  describe('security_block_pending', () => {
    it('returns a pending payload with severity and title from the pending block', () => {
      const out = buildSecurityBannerPayload(pendingMsg('high'), 'low');
      expect(out).toEqual({
        kind: 'pending',
        severity: 'high',
        title: 'Bash(rm -rf *)',
      });
    });

    it('returns null when threshold gates the pending severity out', () => {
      expect(buildSecurityBannerPayload(pendingMsg('low'), 'high')).toBeNull();
    });

    it('returns null when threshold is off', () => {
      expect(buildSecurityBannerPayload(pendingMsg('high'), 'off')).toBeNull();
    });
  });

  describe('unrelated broadcasts', () => {
    it('returns null for an alert_triggered broadcast', () => {
      const msg: DaemonToAppMessage = {
        type: 'alert_triggered',
        alertId: 1,
        accountId: 'acct-1',
        scope: 'account',
        thresholdPct: 80,
        utilization: 0.81,
      };
      expect(buildSecurityBannerPayload(msg, 'low')).toBeNull();
    });

    it('returns null for a token_refreshed broadcast', () => {
      const msg: DaemonToAppMessage = {
        type: 'token_refreshed',
        accountId: 'acct-1',
        expiresAt: 1_700_000_000_000,
      };
      expect(buildSecurityBannerPayload(msg, 'low')).toBeNull();
    });
  });
});
