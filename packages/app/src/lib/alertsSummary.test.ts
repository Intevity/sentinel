import { describe, expect, it } from 'vitest';
import { describeAlertsSummary } from './alertsSummary.js';

describe('describeAlertsSummary', () => {
  it('returns "No account selected" when available is false, regardless of alerts', () => {
    expect(describeAlertsSummary([], false)).toBe('No account selected');
    expect(describeAlertsSummary([{ thresholdPct: 90, enabled: true }], false)).toBe(
      'No account selected',
    );
    expect(describeAlertsSummary(null, false)).toBe('No account selected');
    expect(describeAlertsSummary(undefined, false)).toBe('No account selected');
  });

  it('returns "None set" for an empty alert list when available', () => {
    expect(describeAlertsSummary([], true)).toBe('None set');
    expect(describeAlertsSummary(null, true)).toBe('None set');
    expect(describeAlertsSummary(undefined, true)).toBe('None set');
  });

  it('singularizes "1 alert" when exactly one alert exists', () => {
    expect(describeAlertsSummary([{ thresholdPct: 90, enabled: true }], true)).toBe(
      '1 alert · 90%',
    );
  });

  it('uses plural "alerts" and sorts thresholds ascending', () => {
    expect(
      describeAlertsSummary(
        [
          { thresholdPct: 95, enabled: true },
          { thresholdPct: 60, enabled: true },
          { thresholdPct: 80, enabled: true },
        ],
        true,
      ),
    ).toBe('3 alerts · 60%, 80%, 95%');
  });

  it('appends "(N off)" when any alerts are disabled', () => {
    expect(
      describeAlertsSummary(
        [
          { thresholdPct: 90, enabled: true },
          { thresholdPct: 80, enabled: false },
        ],
        true,
      ),
    ).toBe('2 alerts (1 off) · 80%, 90%');
  });

  it('omits the "(N off)" suffix when all alerts are enabled', () => {
    expect(
      describeAlertsSummary(
        [
          { thresholdPct: 70, enabled: true },
          { thresholdPct: 90, enabled: true },
        ],
        true,
      ),
    ).toBe('2 alerts · 70%, 90%');
  });

  it('counts every disabled alert, including single-alert lists', () => {
    expect(describeAlertsSummary([{ thresholdPct: 50, enabled: false }], true)).toBe(
      '1 alert (1 off) · 50%',
    );
  });

  it('does not mutate the input array when sorting thresholds', () => {
    const alerts: Array<{ thresholdPct: number; enabled: boolean }> = [
      { thresholdPct: 95, enabled: true },
      { thresholdPct: 60, enabled: true },
    ];
    describeAlertsSummary(alerts, true);
    expect(alerts.map((a) => a.thresholdPct)).toEqual([95, 60]);
  });
});
