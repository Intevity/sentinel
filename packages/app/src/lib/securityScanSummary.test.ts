import { describe, expect, it } from 'vitest';
import { describeScanSummary } from './securityScanSummary.js';

const base = {
  securityScanEnabled: true,
  securityEnforcementMode: 'observe' as const,
  securityScanSecrets: true,
  securityScanInjection: true,
  securityScanToolUse: true,
};

describe('describeScanSummary', () => {
  it('returns empty string when settings is null', () => {
    expect(describeScanSummary(null)).toBe('');
  });

  it('reports OFF when scanning disabled, regardless of other fields', () => {
    expect(describeScanSummary({ ...base, securityScanEnabled: false })).toBe('Scan: OFF');
  });

  it('reports Observe mode with 3 categories by default', () => {
    expect(describeScanSummary(base)).toBe('Scan: ON · Observe · 3 categories');
  });

  it('maps block_high to HIGH', () => {
    expect(describeScanSummary({ ...base, securityEnforcementMode: 'block_high' }))
      .toBe('Scan: ON · HIGH · 3 categories');
  });

  it('maps block_medium_high to MED+HIGH', () => {
    expect(describeScanSummary({ ...base, securityEnforcementMode: 'block_medium_high' }))
      .toBe('Scan: ON · MED+HIGH · 3 categories');
  });

  it('falls back to Observe when mode is null (unset)', () => {
    expect(describeScanSummary({ ...base, securityEnforcementMode: null }))
      .toBe('Scan: ON · Observe · 3 categories');
  });

  it('singularizes "1 category" when only one category is enabled', () => {
    expect(describeScanSummary({
      ...base,
      securityScanSecrets: true,
      securityScanInjection: false,
      securityScanToolUse: false,
    })).toBe('Scan: ON · Observe · 1 category');
  });

  it('reports "0 categories" when no categories are enabled', () => {
    expect(describeScanSummary({
      ...base,
      securityScanSecrets: false,
      securityScanInjection: false,
      securityScanToolUse: false,
    })).toBe('Scan: ON · Observe · 0 categories');
  });

  it('counts a mix of enabled/disabled categories correctly', () => {
    expect(describeScanSummary({
      ...base,
      securityScanSecrets: true,
      securityScanInjection: false,
      securityScanToolUse: true,
    })).toBe('Scan: ON · Observe · 2 categories');
  });
});
