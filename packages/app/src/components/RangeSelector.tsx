import React from 'react';
import type { OptimizeRangePreset } from '@claude-sentinel/shared';
import { rangeLadder } from '@claude-sentinel/shared';

/**
 * Shared date-range selector: the segmented preset group plus the custom
 * start/end date inputs. Extracted from the Optimize page so the Metrics
 * page renders the exact same control. Both pages convert the selection to
 * an absolute window via `lib/dateRange.ts`'s `windowForRange`.
 *
 * The preset rungs are not fixed: each page passes its retention window
 * (`Settings.optimizeRetentionDays` / `Settings.metricsRetentionDays`) and
 * the shared `rangeLadder` picks the 6 presets that window fully covers;
 * All and Custom are always appended. The daemon snaps a persisted preset
 * that falls off the ladder (settings coerce), so `range` is always
 * renderable here.
 */

/** Segmented-control label for every preset the ladder can produce. */
const RANGE_OPTION_LABELS: Record<OptimizeRangePreset, string> = {
  '1d': '1D',
  '1w': '1W',
  '2w': '2W',
  '1m': '1M',
  '2m': '2M',
  '3m': '3M',
  '6m': '6M',
  '1y': '1Y',
  all: 'All',
  custom: 'Custom',
};

/** Local YYYY-MM-DD for the day `retentionDays` before today: the earliest
 *  date with any retained data, used as the custom inputs' floor. */
function retentionFloorIso(retentionDays: number): string {
  const d = new Date(Date.now() - retentionDays * 86_400_000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function RangeSelector({
  range,
  retentionDays,
  customStart,
  customEnd,
  onChangeRange,
  onChangeCustomStart,
  onChangeCustomEnd,
}: {
  range: OptimizeRangePreset;
  /** The page's retention window in days; drives which presets render. */
  retentionDays: number;
  customStart: string;
  customEnd: string;
  onChangeRange: (next: OptimizeRangePreset) => void;
  onChangeCustomStart: (next: string) => void;
  onChangeCustomEnd: (next: string) => void;
}): React.ReactElement {
  const options: OptimizeRangePreset[] = [...rangeLadder(retentionDays), 'all', 'custom'];
  // Anything before the retention floor is already purged; constrain the
  // custom pickers so users can't select a window with no data.
  const minIso = retentionFloorIso(retentionDays);
  // Two layout modes share the row's full width:
  // - Preset active: the segmented group stretches edge to edge and every
  //   button gets an equal share (flex-1), so nothing looks scrunched left.
  // - Custom active: the group collapses to its natural width (tighter
  //   button padding) and the two date inputs flex into the freed space.
  // flex-wrap stays as the safety net: if a platform's native date inputs
  // are too wide to share the row (e.g. Windows), they wrap to their own
  // line instead of overflowing.
  const customActive = range === 'custom';
  return (
    <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1.5">
      <div
        className={`flex min-w-0 rounded border border-border-subtle/10 p-0.5 text-[10px] uppercase tracking-wide ${
          customActive ? '' : 'flex-1'
        }`}
        role="group"
        aria-label="Time range"
      >
        {options.map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={range === o}
            onClick={() => onChangeRange(o)}
            className={`rounded py-0.5 text-center transition-colors ${
              customActive ? 'px-1.5' : 'flex-1 px-2'
            } ${
              range === o
                ? 'bg-surface-overlay/15 text-foreground'
                : 'text-foreground/55 hover:text-foreground/85'
            }`}
          >
            {RANGE_OPTION_LABELS[o]}
          </button>
        ))}
      </div>
      {customActive && (
        <div className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-foreground/60">
          <input
            type="date"
            value={customStart}
            min={minIso}
            max={customEnd || undefined}
            onChange={(e) => onChangeCustomStart(e.target.value)}
            aria-label="Start date"
            className="min-w-0 flex-1 rounded border border-border-subtle/15 bg-transparent px-1 py-0.5 text-foreground"
          />
          <span className="shrink-0">to</span>
          <input
            type="date"
            value={customEnd}
            min={customStart || minIso}
            onChange={(e) => onChangeCustomEnd(e.target.value)}
            aria-label="End date"
            className="min-w-0 flex-1 rounded border border-border-subtle/15 bg-transparent px-1 py-0.5 text-foreground"
          />
        </div>
      )}
    </div>
  );
}
