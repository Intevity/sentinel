import React from 'react';
import type { OptimizeRangePreset } from '@claude-sentinel/shared';

/**
 * Shared date-range selector: the segmented preset group (1D…All) plus the
 * custom start/end date inputs. Extracted from the Optimize page so the
 * Metrics page renders the exact same control. Both pages convert the
 * selection to an absolute window via `lib/dateRange.ts`'s `windowForRange`.
 */

const RANGE_OPTIONS: Array<{ value: OptimizeRangePreset; label: string }> = [
  { value: '1d', label: '1D' },
  { value: '1w', label: '1W' },
  { value: '1m', label: '1M' },
  { value: '3m', label: '3M' },
  { value: '6m', label: '6M' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' },
  { value: 'custom', label: 'Custom' },
];

export function RangeSelector({
  range,
  customStart,
  customEnd,
  onChangeRange,
  onChangeCustomStart,
  onChangeCustomEnd,
}: {
  range: OptimizeRangePreset;
  customStart: string;
  customEnd: string;
  onChangeRange: (next: OptimizeRangePreset) => void;
  onChangeCustomStart: (next: string) => void;
  onChangeCustomEnd: (next: string) => void;
}): React.ReactElement {
  // Two layout modes share the row's full width:
  //   - Preset active: the segmented group stretches edge to edge and every
  //     button gets an equal share (flex-1), so nothing looks scrunched left.
  //   - Custom active: the group collapses to its natural width (tighter
  //     button padding) and the two date inputs flex into the freed space.
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
        {RANGE_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={range === o.value}
            onClick={() => onChangeRange(o.value)}
            className={`rounded py-0.5 text-center transition-colors ${
              customActive ? 'px-1.5' : 'flex-1 px-2'
            } ${
              range === o.value
                ? 'bg-surface-overlay/15 text-foreground'
                : 'text-foreground/55 hover:text-foreground/85'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {customActive && (
        <div className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-foreground/60">
          <input
            type="date"
            value={customStart}
            max={customEnd || undefined}
            onChange={(e) => onChangeCustomStart(e.target.value)}
            aria-label="Start date"
            className="min-w-0 flex-1 rounded border border-border-subtle/15 bg-transparent px-1 py-0.5 text-foreground"
          />
          <span className="shrink-0">to</span>
          <input
            type="date"
            value={customEnd}
            min={customStart || undefined}
            onChange={(e) => onChangeCustomEnd(e.target.value)}
            aria-label="End date"
            className="min-w-0 flex-1 rounded border border-border-subtle/15 bg-transparent px-1 py-0.5 text-foreground"
          />
        </div>
      )}
    </div>
  );
}
