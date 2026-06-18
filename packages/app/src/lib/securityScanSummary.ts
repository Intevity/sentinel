import type { Settings, SecurityEnforcementMode } from '@sentinel/shared';

const MODE_LABEL: Record<SecurityEnforcementMode, string> = {
  observe: 'Observe',
  block_high: 'HIGH',
  block_medium_high: 'MED+HIGH',
};

type ScanSummarySettings = Pick<
  Settings,
  | 'securityScanEnabled'
  | 'securityEnforcementMode'
  | 'securityScanSecrets'
  | 'securityScanInjection'
  | 'securityScanToolUse'
>;

/**
 * One-line description of the current scanning state, shown in the
 * collapsed Scanning card header so the user sees state at a glance
 * without expanding. Returns an empty string when settings is null
 * (card suppresses the summary in that case).
 */
export function describeScanSummary(settings: ScanSummarySettings | null): string {
  if (!settings) return '';
  if (!settings.securityScanEnabled) return 'Scan: OFF';
  const mode = MODE_LABEL[settings.securityEnforcementMode ?? 'observe'];
  const categoryCount = [
    settings.securityScanSecrets,
    settings.securityScanInjection,
    settings.securityScanToolUse,
  ].filter(Boolean).length;
  const cat = `${categoryCount} categor${categoryCount === 1 ? 'y' : 'ies'}`;
  return `Scan: ON · ${mode} · ${cat}`;
}
