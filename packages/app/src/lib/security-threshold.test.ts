import { describe, expect, it } from 'vitest';
import { shouldFireSecurityOsNotification } from './security-threshold.js';

describe('shouldFireSecurityOsNotification', () => {
  it('returns false when threshold is off, regardless of severity', () => {
    expect(shouldFireSecurityOsNotification('low', 'off')).toBe(false);
    expect(shouldFireSecurityOsNotification('medium', 'off')).toBe(false);
    expect(shouldFireSecurityOsNotification('high', 'off')).toBe(false);
  });

  it('fires for every severity when threshold is low', () => {
    expect(shouldFireSecurityOsNotification('low', 'low')).toBe(true);
    expect(shouldFireSecurityOsNotification('medium', 'low')).toBe(true);
    expect(shouldFireSecurityOsNotification('high', 'low')).toBe(true);
  });

  it('fires only at or above medium when threshold is medium', () => {
    expect(shouldFireSecurityOsNotification('low', 'medium')).toBe(false);
    expect(shouldFireSecurityOsNotification('medium', 'medium')).toBe(true);
    expect(shouldFireSecurityOsNotification('high', 'medium')).toBe(true);
  });

  it('fires only for high when threshold is high', () => {
    expect(shouldFireSecurityOsNotification('low', 'high')).toBe(false);
    expect(shouldFireSecurityOsNotification('medium', 'high')).toBe(false);
    expect(shouldFireSecurityOsNotification('high', 'high')).toBe(true);
  });
});
