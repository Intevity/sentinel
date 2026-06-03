import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatTokens, type SavingsUnits } from '../../../lib/optimizeUnits.js';

/** Always show 2 decimals; preserve sign so negative values read as
 *  such. Mirrors the local `formatUsd` that previously lived in
 *  OptimizeDashboard.tsx; lifted here so every chart variant uses the
 *  exact same rendering. */
export function formatUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export function valueFormatter(units: SavingsUnits): (v: number) => string {
  return units === 'cost' ? formatUsd : formatTokens;
}

/** Explicit YAxis width sized to the longest expected tick label. Recharts
 *  defaults to width=60, and the charts here used negative left margins to
 *  trim the dead space — which clipped long labels (e.g. "$1,234.56") on
 *  the left. Sizing the axis to the data (~6.2px per character at the 10px
 *  tick font, one character of headroom for rounded tick values) removes
 *  the clipping without re-introducing a fixed gutter of dead space. */
export function yAxisWidth(labels: string[]): number {
  const longest = labels.reduce((max, l) => Math.max(max, l.length), 0);
  return Math.max(28, Math.ceil((longest + 1) * 6.2));
}

// Recharts reads these as inline styles, so we can't use Tailwind classes.
// The `rgb(var(--muted))` pattern lets the tick color adapt to the active
// theme (darker gray in light mode for AA contrast on a white chart
// background; medium gray in dark mode). The tooltip stays dark in both
// themes — dark tooltips on light apps are a common, deliberate pattern
// and the chart-data colors were tuned against a dark backdrop.
export const TOOLTIP_STYLE: React.CSSProperties = {
  background: 'rgba(20,20,20,0.92)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  fontSize: 11,
};
// Label sits on the dark tooltip background in both themes, so it
// stays fixed-gray rather than following --muted (which goes darker
// in light mode and would lose contrast against the tooltip).
export const TOOLTIP_LABEL_STYLE: React.CSSProperties = { color: '#8E8E93', fontSize: 11 };
// Axis ticks sit on the chart's surface, which IS theme-aware (glass
// card flips light/dark), so the tick color follows --muted to keep
// AA contrast in both modes.
export const AXIS_TICK_STYLE = { fontSize: 10, fill: 'rgb(var(--muted))' } as const;

export function ChartEmptyState({
  children,
  embedded = false,
}: {
  children?: React.ReactNode;
  /** Render without the glass-card chrome, for use inside a parent pane. */
  embedded?: boolean;
}): React.ReactElement {
  return (
    <div
      className={`${embedded ? '' : 'glass-card '}px-4 py-6 text-center text-xs text-foreground/55`}
    >
      {children ??
        'Once Sentinel sees enough Claude Code traffic, your daily savings will appear here.'}
    </div>
  );
}

export function ChartFrame({
  title,
  children,
  legend,
  embedded = false,
  collapsible = false,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  legend?: React.ReactNode;
  /** Render without the glass-card chrome and without the title row, for
   *  charts hosted inside a parent pane whose section header already names
   *  the chart (e.g. the Optimize pane's collapsible savings section). */
  embedded?: boolean;
  /** Title row becomes a chevron toggle that shows/hides the chart body.
   *  Ignored when `embedded` (the host pane owns collapsing there). */
  collapsible?: boolean;
  defaultOpen?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const body = (
    <>
      {children}
      {legend !== undefined && <div className="mt-2 flex flex-wrap gap-3">{legend}</div>}
    </>
  );
  if (embedded) return <div>{body}</div>;
  return (
    <div className="glass-card px-4 pt-4 pb-3">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`flex w-full items-center gap-1.5 text-left ${open ? 'mb-3' : 'pb-1'}`}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-foreground/55" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-foreground/55" />
          )}
          <p className="text-[11px] font-semibold text-muted">{title}</p>
        </button>
      ) : (
        <p className="mb-3 text-[11px] font-semibold text-muted">{title}</p>
      )}
      {(!collapsible || open) && body}
    </div>
  );
}

export function LegendDot({ color, label }: { color: string; label: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      <span className="text-[10px] text-muted">{label}</span>
    </div>
  );
}
