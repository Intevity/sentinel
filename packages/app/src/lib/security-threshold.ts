import type { SecuritySeverity, SecurityOsNotifyThreshold } from '@sentinel/shared';

const SEVERITY_ORDER: Record<SecuritySeverity, number> = { low: 0, medium: 1, high: 2 };
const THRESHOLD_ORDER: Record<SecurityOsNotifyThreshold, number> = {
  low: 0,
  medium: 1,
  high: 2,
  off: 99,
};

export function shouldFireSecurityOsNotification(
  severity: SecuritySeverity,
  threshold: SecurityOsNotifyThreshold,
): boolean {
  if (threshold === 'off') return false;
  return SEVERITY_ORDER[severity] >= THRESHOLD_ORDER[threshold];
}
