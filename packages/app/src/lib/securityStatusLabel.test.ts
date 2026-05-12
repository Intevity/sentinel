import { describe, expect, it } from 'vitest';
import type { SecurityEvent } from '@claude-sentinel/shared';
import { securityStatusInfo, securityRowAction } from './securityStatusLabel.js';

type StatusInput = Pick<SecurityEvent, 'blocked' | 'kind' | 'resolution'>;

const detected: StatusInput = { blocked: false, kind: 'secret', resolution: null };
const blockedTimeout: StatusInput = { blocked: true, kind: 'secret', resolution: 'timeout' };
const blockedUserDeny: StatusInput = {
  blocked: true,
  kind: 'tool_permission_blocked',
  resolution: 'user_deny',
};
const allowedByUser: StatusInput = {
  blocked: false,
  kind: 'tool_permission_blocked',
  resolution: 'user_approve',
};
const diagnostic: StatusInput = { blocked: false, kind: 'scan_truncated', resolution: null };

describe('securityStatusInfo', () => {
  it('returns Detected for observe-only findings (not blocked, no resolution)', () => {
    expect(securityStatusInfo(detected)).toEqual({ label: 'Detected', variant: 'detected' });
  });

  it('returns Blocked when the held request timed out without a user decision', () => {
    expect(securityStatusInfo(blockedTimeout)).toEqual({ label: 'Blocked', variant: 'blocked' });
  });

  it('returns Blocked when the user actively denied the held request', () => {
    expect(securityStatusInfo(blockedUserDeny)).toEqual({ label: 'Blocked', variant: 'blocked' });
  });

  it('returns "Allowed by you" when the user approved the hold (blocked=false, resolution=user_approve)', () => {
    expect(securityStatusInfo(allowedByUser)).toEqual({
      label: 'Allowed by you',
      variant: 'allowed',
    });
  });

  it('returns Diagnostic for synthetic scan_* telemetry kinds', () => {
    expect(securityStatusInfo(diagnostic)).toEqual({ label: 'Diagnostic', variant: 'diagnostic' });
    expect(
      securityStatusInfo({ blocked: false, kind: 'scan_skipped_encoding', resolution: null }),
    ).toEqual({ label: 'Diagnostic', variant: 'diagnostic' });
    expect(
      securityStatusInfo({ blocked: false, kind: 'scan_deferred_oversized', resolution: null }),
    ).toEqual({ label: 'Diagnostic', variant: 'diagnostic' });
  });

  it('treats synthetic kinds as Diagnostic even when blocked=true (defensive)', () => {
    expect(
      securityStatusInfo({ blocked: true, kind: 'scan_truncated', resolution: 'timeout' }),
    ).toEqual({ label: 'Diagnostic', variant: 'diagnostic' });
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
