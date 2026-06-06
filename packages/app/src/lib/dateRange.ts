import type { MetricsWindow, OptimizeRangePreset } from '@claude-sentinel/shared';

/**
 * Date-range presets shared by the Optimize and Metrics pages: the mapping
 * from a {@link OptimizeRangePreset} (+ optional custom dates) to an absolute
 * {@link MetricsWindow}, plus the human label for header subtext. The
 * segmented control that drives these lives in `components/RangeSelector.tsx`.
 */

/** Human phrase for each range preset, used in header subtext after verbs like
 *  "processed" / "measured". */
export const RANGE_LABELS: Record<OptimizeRangePreset, string> = {
  '1d': 'today',
  '1w': 'in the last 7 days',
  '1m': 'in the last month',
  '3m': 'in the last 3 months',
  '6m': 'in the last 6 months',
  '1y': 'in the last year',
  all: 'all-time',
  custom: 'in the selected range',
};

/** Local midnight (ms) for the day containing `d`. Aligns client-computed
 *  window bounds with the daemon's local-time day buckets. */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Map a range preset (+ optional custom dates) to an absolute window. Presets
 *  are anchored on local-midnight boundaries; `custom` uses the picked dates
 *  with an end-inclusive upper bound (start of the day after `customEnd`).
 *  Callers should invoke this at FETCH time, not memoize it: it captures
 *  `new Date()`, and a memoized '1d' window goes stale past midnight. */
export function windowForRange(
  range: OptimizeRangePreset,
  customStart: string,
  customEnd: string,
): MetricsWindow {
  const now = new Date();
  const today0 = startOfLocalDay(now);
  const DAY = 86_400_000;
  switch (range) {
    case '1d':
      return { sinceMs: today0 };
    case '1w':
      return { sinceMs: today0 - 6 * DAY };
    case '1m':
      return {
        sinceMs: startOfLocalDay(new Date(now.getFullYear(), now.getMonth() - 1, now.getDate())),
      };
    case '3m':
      return {
        sinceMs: startOfLocalDay(new Date(now.getFullYear(), now.getMonth() - 3, now.getDate())),
      };
    case '6m':
      return {
        sinceMs: startOfLocalDay(new Date(now.getFullYear(), now.getMonth() - 6, now.getDate())),
      };
    case '1y':
      return {
        sinceMs: startOfLocalDay(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())),
      };
    case 'custom': {
      const win: MetricsWindow = {};
      if (customStart) win.sinceMs = startOfLocalDay(new Date(`${customStart}T00:00:00`));
      if (customEnd) win.untilMs = startOfLocalDay(new Date(`${customEnd}T00:00:00`)) + DAY;
      return win;
    }
    case 'all':
    default:
      return {};
  }
}
