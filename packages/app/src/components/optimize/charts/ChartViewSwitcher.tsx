import React from 'react';
import type { OptimizeChartView } from '@claude-sentinel/shared';

/** Display order + short labels for the segmented control. The order
 *  also drives the underlying enum values exposed via Settings; keep it
 *  stable so that previously-saved selections don't drift. */
export const CHART_VIEW_OPTIONS: ReadonlyArray<{ id: OptimizeChartView; label: string }> = [
  { id: 'realized', label: 'Realized' },
  { id: 'bySubagent', label: 'By subagent' },
  { id: 'comparison', label: 'Comparison' },
  { id: 'cumulative', label: 'Cumulative' },
  { id: 'byPattern', label: 'By pattern' },
];

/** Segmented control that swaps the Optimize dashboard's chart variant.
 *  Mirrors the styling of the existing UnitsToggle (Tokens / Cost) so
 *  the two toggles read as a paired control row in the dashboard
 *  header. */
export default function ChartViewSwitcher({
  value,
  onChange,
}: {
  value: OptimizeChartView;
  onChange: (next: OptimizeChartView) => void;
}): React.ReactElement {
  return (
    <div
      className="flex flex-wrap rounded border border-border-subtle/10 p-0.5 text-[10px] uppercase tracking-wide"
      role="group"
      aria-label="Chart view"
    >
      {CHART_VIEW_OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          aria-pressed={value === opt.id}
          onClick={() => onChange(opt.id)}
          className={`rounded px-2 py-0.5 ${
            value === opt.id
              ? 'bg-surface-overlay/15 text-foreground'
              : 'text-foreground/55 hover:text-foreground/85'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
