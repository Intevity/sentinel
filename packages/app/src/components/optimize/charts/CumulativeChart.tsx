import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { OptimizationMetrics } from '@sentinel/shared';
import type { SavingsUnits } from '../../../lib/optimizeUnits.js';
import { buildCumulativeSeries } from '../../../lib/optimizeCharts.js';
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
const COLOR_TOTAL = '#60a5fa';

/** Two-line cumulative trajectory: realized (what we actually delivered)
 *  and total (the optimistic ceiling assuming every potential opportunity
 *  had been realized). The gap between the two lines is the running
 *  "missed value" — it's the most motivating framing for the user to
 *  install more curated subagents. */
export default function CumulativeChart({
  daily,
  units,
  embedded = false,
}: {
  daily: OptimizationMetrics['daily'];
  units: SavingsUnits;
  embedded?: boolean;
}): React.ReactElement {
  if (daily.length === 0) return <ChartEmptyState embedded={embedded} />;
  const data = buildCumulativeSeries(daily, units);
  const fmt = valueFormatter(units);
  return (
    <ChartFrame
      title="Cumulative savings"
      embedded={embedded}
      legend={
        <>
          <LegendDot color={COLOR_REALIZED} label="Realized" />
          <LegendDot color={COLOR_TOTAL} label="If fully realized" />
        </>
      }
    >
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <XAxis dataKey="day" tick={AXIS_TICK_STYLE} axisLine={false} tickLine={false} />
          <YAxis
            tick={AXIS_TICK_STYLE}
            axisLine={false}
            tickLine={false}
            width={yAxisWidth(data.map((d) => fmt(d.total)))}
            tickFormatter={(v: number) => fmt(v)}
          />
          <Tooltip
            cursor={{ stroke: 'rgba(255,255,255,0.1)' }}
            formatter={(v: number, name: string) => [fmt(v), name]}
            labelStyle={TOOLTIP_LABEL_STYLE}
            contentStyle={TOOLTIP_STYLE}
          />
          <Line
            type="monotone"
            dataKey="total"
            name="If fully realized"
            stroke={COLOR_TOTAL}
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="realized"
            name="Realized"
            stroke={COLOR_REALIZED}
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
