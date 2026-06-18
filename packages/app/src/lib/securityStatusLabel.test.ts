import { describe, expect, it } from 'vitest';
import type { SecurityEvent } from '@sentinel/shared';
import { securityStatusInfo, securityRowAction } from './securityStatusLabel.js';

type StatusInput = Pick<SecurityEvent, 'blocked' | 'kind' | 'resolution' | 'acknowledged'>;

const detected: StatusInput = {
  blocked: false,
  kind: 'secret',
  resolution: null,
  acknowledged: false,
};
const blockedTimeout: StatusInput = {
  blocked: true,
  kind: 'secret',
  resolution: 'timeout',
  acknowledged: false,
};
const blockedUserDeny: StatusInput = {
  blocked: true,
  kind: 'tool_permission_blocked',
  resolution: 'user_deny',
  acknowledged: false,
};
const allowedByUser: StatusInput = {
  blocked: false,
  kind: 'tool_permission_blocked',
  resolution: 'user_approve',
  acknowledged: false,
};
const mutedObserve: StatusInput = {
  blocked: false,
  kind: 'secret',
  resolution: null,
  acknowledged: true,
};
const diagnostic: StatusInput = {
  blocked: false,
  kind: 'scan_truncated',
  resolution: null,
  acknowledged: false,
};

describe('securityStatusInfo', () => {
  it('returns Detected for observe-only findings (not blocked, no resolution, not acknowledged)', () => {
    expect(securityStatusInfo(detected)).toEqual({ label: 'Detected', variant: 'detected' });
  });

  it('returns "Timed out" when the held request expired without a user decision', () => {
    expect(securityStatusInfo(blockedTimeout)).toEqual({
      label: 'Timed out',
      variant: 'timed-out',
    });
  });

  it('returns "Denied by you" when the user actively denied the held request', () => {
    expect(securityStatusInfo(blockedUserDeny)).toEqual({
      label: 'Denied by you',
      variant: 'denied',
    });
  });

  it('returns "Allowed by you" when the user approved the hold (blocked=false, resolution=user_approve)', () => {
    expect(securityStatusInfo(allowedByUser)).toEqual({
      label: 'Allowed by you',
      variant: 'allowed',
    });
  });

  it('returns Muted when the user dismissed an observe-only row (acknowledged with no resolution)', () => {
    expect(securityStatusInfo(mutedObserve)).toEqual({ label: 'Muted', variant: 'muted' });
  });

  it('returns Diagnostic for synthetic scan_* telemetry kinds', () => {
    expect(securityStatusInfo(diagnostic)).toEqual({ label: 'Diagnostic', variant: 'diagnostic' });
    expect(
      securityStatusInfo({
        blocked: false,
        kind: 'scan_skipped_encoding',
        resolution: null,
        acknowledged: false,
      }),
    ).toEqual({ label: 'Diagnostic', variant: 'diagnostic' });
    expect(
      securityStatusInfo({
        blocked: false,
        kind: 'scan_deferred_oversized',
        resolution: null,
        acknowledged: false,
      }),
    ).toEqual({ label: 'Diagnostic', variant: 'diagnostic' });
  });

  it('treats synthetic kinds as Diagnostic even when blocked=true (defensive)', () => {
    expect(
      securityStatusInfo({
        blocked: true,
        kind: 'scan_truncated',
        resolution: 'timeout',
        acknowledged: false,
      }),
    ).toEqual({ label: 'Diagnostic', variant: 'diagnostic' });
  });

  it('prefers a resolution over acknowledged when both are present', () => {
    expect(
      securityStatusInfo({
        blocked: false,
        kind: 'secret',
        resolution: 'user_approve',
        acknowledged: true,
      }),
    ).toEqual({ label: 'Allowed by you', variant: 'allowed' });
  });
});

describe('securityRowAction', () => {
  it('returns mute-synthetic for scan_* rows so the existing "Mute these" UI fires', () => {
    expect(securityRowAction(diagnostic)).toBe('mute-synthetic');
  });

  it('returns allowlist for blocked rows so the button reads "Always allow"', () => {
    expect(securityRowAction(blockedTimeout)).toBe('allowlist');
    expect(securityRowAction(blockedUserDeny)).toBe('allowlist');
  });

  it('returns mute for observe-only rows so the button reads "Mute" (the request was not blocked)', () => {
    expect(securityRowAction(detected)).toBe('mute');
  });

  it('returns none for user-approved holds (no further action; allowlist already added)', () => {
    expect(securityRowAction(allowedByUser)).toBe('none');
  });
});
