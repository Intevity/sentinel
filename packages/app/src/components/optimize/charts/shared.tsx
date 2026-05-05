import React from 'react';
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

export const TOOLTIP_STYLE: React.CSSProperties = {
  background: 'rgba(20,20,20,0.92)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  fontSize: 11,
};
export const TOOLTIP_LABEL_STYLE: React.CSSProperties = { color: '#8E8E93', fontSize: 11 };
export const AXIS_TICK_STYLE = { fontSize: 10, fill: '#8E8E93' } as const;

export function ChartEmptyState({ children }: { children?: React.ReactNode }): React.ReactElement {
  return (
    <div className="glass-card px-4 py-6 text-center text-xs text-white/55">
      {children ??
        'Once Sentinel sees enough Claude Code traffic, your daily savings will appear here.'}
    </div>
  );
}

export function ChartFrame({
  title,
  children,
  legend,
}: {
  title: string;
  children: React.ReactNode;
  legend?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="glass-card px-4 pt-4 pb-3">
      <p className="mb-3 text-[11px] font-semibold text-[#8E8E93]">{title}</p>
      {children}
      {legend !== undefined && <div className="mt-2 flex flex-wrap gap-3">{legend}</div>}
    </div>
  );
}

export function LegendDot({ color, label }: { color: string; label: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      <span className="text-[10px] text-[#8E8E93]">{label}</span>
    </div>
  );
}
