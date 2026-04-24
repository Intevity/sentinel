/**
 * Unit tests for the pure-function surface of claude-ai-usage.ts.
 *
 * HTTP-touching tests (fetchOrgUsage, ClaudeAiUsageStore) live in
 * `claude-ai-usage.integration.test.ts`, which drives the real code
 * path against the fake Anthropic server. This file exists for the
 * string-in, value-out helpers where a real HTTP round-trip adds no
 * signal. Zero mocks by design.
 *
 * Sprint 3 of `documentation/TEST_MIGRATION_PLAN.md` — trimmed from 502
 * lines + ~18 mock sites after the integration tests landed.
 */

import { describe, it, expect } from 'vitest';
import {
  isOAuthForbiddenBodyString,
  OAUTH_FORBIDDEN_MESSAGE_RE,
  parseUsage,
} from './claude-ai-usage.js';

describe('isOAuthForbiddenBodyString', () => {
  it('matches the canonical Anthropic message verbatim', () => {
    const body = JSON.stringify({
      error: {
        type: 'permission_error',
        message: 'OAuth authentication is currently not allowed for this organization.',
      },
    });
    const verdict = isOAuthForbiddenBodyString(body);
    expect(verdict.forbidden).toBe(true);
    if (verdict.forbidden) {
      expect(verdict.message).toMatch(OAUTH_FORBIDDEN_MESSAGE_RE);
    }
  });

  it('is case-insensitive on the message text', () => {
    const body = JSON.stringify({
      error: {
        type: 'permission_error',
        message: 'OAUTH authentication is currently NOT allowed for org X',
      },
    });
    expect(isOAuthForbiddenBodyString(body).forbidden).toBe(true);
  });

  it('rejects non-permission_error 403 bodies', () => {
    const body = JSON.stringify({ error: { type: 'rate_limit', message: 'slow down' } });
    expect(isOAuthForbiddenBodyString(body).forbidden).toBe(false);
  });

  it('rejects permission_error with a different message', () => {
    const body = JSON.stringify({
      error: { type: 'permission_error', message: 'Some other rule' },
    });
    expect(isOAuthForbiddenBodyString(body).forbidden).toBe(false);
  });

  it('rejects unparseable body', () => {
    expect(isOAuthForbiddenBodyString('not json').forbidden).toBe(false);
  });
});

describe('parseUsage', () => {
  // Regression: claude.ai returns utilization as a 0-100 percent for
  // every window (verified against live Max + Team responses). Previously
  // the parser used a heuristic that only scaled values >1.01 — so a
  // real 1% utilization (`1.0`) was left as `1.0`, which statusFor()
  // downstream interpreted as 100% and marked the window as blocked,
  // permanently pausing Team accounts whose weekly quota sat near the
  // bottom of the range. Always-scale-by-100 is the correct behavior.
  it('scales a 1% seven-day utilization to 0.01 (not 1.0)', () => {
    const snap = parseUsage({
      five_hour: { utilization: 7.0, resets_at: null },
      seven_day: { utilization: 1.0, resets_at: null },
    });
    expect(snap.sevenDayUtilization).toBe(0.01);
    expect(snap.fiveHourUtilization).toBe(0.07);
  });

  it('scales a Max-shaped response end-to-end', () => {
    const snap = parseUsage({
      five_hour: { utilization: 36.0, resets_at: null },
      seven_day: { utilization: 3.0, resets_at: null },
      seven_day_sonnet: { utilization: 0.0, resets_at: null },
      extra_usage: {
        is_enabled: true,
        monthly_limit: 10000,
        used_credits: 7722.0,
        utilization: 77.22,
        currency: 'USD',
      },
    });
    expect(snap.fiveHourUtilization).toBeCloseTo(0.36, 5);
    expect(snap.sevenDayUtilization).toBeCloseTo(0.03, 5);
    expect(snap.sevenDaySonnetUtilization).toBe(0);
    expect(snap.extraUsage?.utilizationPct).toBe(77.22);
  });

  it('represents a saturated 100% utilization as 1.0', () => {
    const snap = parseUsage({
      seven_day: { utilization: 100.0, resets_at: null },
    });
    expect(snap.sevenDayUtilization).toBe(1.0);
  });

  it('passes null through when a window is absent', () => {
    const snap = parseUsage({ five_hour: null, seven_day: null });
    expect(snap.fiveHourUtilization).toBeNull();
    expect(snap.sevenDayUtilization).toBeNull();
  });

  it('rejects non-finite utilization values by returning null', () => {
    const snap = parseUsage({
      five_hour: { utilization: Number.NaN, resets_at: null },
    });
    expect(snap.fiveHourUtilization).toBeNull();
  });
});
