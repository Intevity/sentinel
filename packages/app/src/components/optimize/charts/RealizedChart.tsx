import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { OptimizationMetrics } from '@sentinel/shared';
import type { SavingsUnits } from '../../../lib/optimizeUnits.js';
import {
  AXIS_TICK_STYLE,
  ChartEmptyState,
  ChartFrame,
  LegendDot,
  TOOLTIP_LABEL_STYLE,
  TOOLTIP_STYLE,
  valueFormatter,
  yAxisWidth,
} from './shared.js';

const COLOR_REALIZED = '#34d399';
const COLOR_POTENTIAL = '#60a5fa';

/** The original "Daily savings" view: a stacked bar of realized vs.
 *  potential per day. Behavior is unchanged from the inline `SavingsChart`
 *  it replaced, just lifted into its own file so the new view-switcher
 *  can dispatch to it the same way it dispatches to the new variants. */
export default function RealizedChart({
  daily,
  units,
  embedded = false,
}: {
  daily: OptimizationMetrics['daily'];
  units: SavingsUnits;
  embedded?: boolean;
}): React.ReactElement {
  if (daily.length === 0) return <ChartEmptyState embedded={embedded} />;
  const data = daily.map((d) => ({
    day: d.day.slice(5).replace('-', '/'),
    realized:
      units === 'cost' ? Number(d.savingsRealized.toFixed(2)) : Math.round(d.tokensRealized),
    potential:
      units === 'cost' ? Number(d.savingsPotential.toFixed(2)) : Math.round(d.tokensPotential),
  }));
  const fmt = valueFormatter(units);
  return (
    <ChartFrame
      title="Daily savings"
      embedded={embedded}
      legend={
        <>
          <LegendDot color={COLOR_REALIZED} label="Realized" />
          <LegendDot color={COLOR_POTENTIAL} label="Potential" />
        </>
      }
    >
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} barSize={14} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <XAxis dataKey="day" tick={AXIS_TICK_STYLE} axisLine={false} tickLine={false} />
          <YAxis
            tick={AXIS_TICK_STYLE}
            axisLine={false}
            tickLine={false}
            width={yAxisWidth(data.map((d) => fmt(d.realized + d.potential)))}
            tickFormatter={(v: number) => fmt(v)}
          />
          <Tooltip
            cursor={{ fill: 'rgba(0,0,0,0.04)' }}
            formatter={(v: number, name: string) => [fmt(v), name]}
            labelStyle={TOOLTIP_LABEL_STYLE}
            contentStyle={TOOLTIP_STYLE}
          />
          <Bar
            dataKey="realized"
            name="Realized"
            stackId="savings"
            fill={COLOR_REALIZED}
            radius={[0, 0, 0, 0]}
          />
          <Bar
            dataKey="potential"
            name="Potential"
            stackId="savings"
            fill={COLOR_POTENTIAL}
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
