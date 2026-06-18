import type { Alert } from '@sentinel/shared';

type AlertSummaryInput = Pick<Alert, 'thresholdPct' | 'enabled'>;

/**
 * One-line description of an alert list's state, shown in the collapsed
 * SettingsCard header on the Alerts tab. Mirrors describeScanSummary's
 * shape: short, present-tense, `·` separators.
 *
 * `available` is the same signal AlertList uses to decide whether to show
 * unavailableCopy — false means "no account context," typical when the
 * user hasn't switched onto an account yet.
 */
export function describeAlertsSummary(
  alerts: ReadonlyArray<AlertSummaryInput> | null | undefined,
  available: boolean,
): string {
  if (!available) return 'No account selected';
  if (!alerts || alerts.length === 0) return 'None set';
  const total = alerts.length;
  const disabled = alerts.filter((a) => !a.enabled).length;
  const thresholds = [...alerts]
    .map((a) => a.thresholdPct)
    .sort((x, y) => x - y)
    .map((t) => `${t}%`)
    .join(', ');
  const countLabel = total === 1 ? '1 alert' : `${total} alerts`;
  const offLabel = disabled > 0 ? ` (${disabled} off)` : '';
  return `${countLabel}${offLabel} · ${thresholds}`;
}
