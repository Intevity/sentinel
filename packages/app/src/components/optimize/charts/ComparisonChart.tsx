import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { OptimizationMetrics } from '@claude-sentinel/shared';
import type { SavingsUnits } from '../../../lib/optimizeUnits.js';
import { buildComparisonSeries } from '../../../lib/optimizeCharts.js';
import {
  AXIS_TICK_STYLE,
  ChartEmptyState,
  ChartFrame,
  LegendDot,
  TOOLTIP_LABEL_STYLE,
  TOOLTIP_STYLE,
  valueFormatter,
} from './shared.js';

const COLOR_REALIZED = '#34d399';
const COLOR_POTENTIAL = '#60a5fa';

/** Horizontal stacked-bar comparison: each row is a curated subagent,
 *  with the realized contribution stacked next to the potential. The
 *  daemon already sorts `bySubagent` by total impact desc so the top
 *  row is always the highest-impact subagent. Bars are sized to the
 *  largest combined value, which keeps proportions honest across the
 *  list. Height grows with row count so all subagents fit without
 *  scroll inside the chart card. */
export default function ComparisonChart({
  bySubagent,
  units,
  embedded = false,
}: {
  bySubagent: OptimizationMetrics['bySubagent'];
  units: SavingsUnits;
  embedded?: boolean;
}): React.ReactElement {
  const data = buildComparisonSeries(bySubagent, units);
  if (data.length === 0) return <ChartEmptyState embedded={embedded} />;
  const fmt = valueFormatter(units);
  // 28 px per row + 30 px padding for axis. Caps tall enough for the
  // full curated library without dominating the dashboard.
  const height = Math.min(data.length * 28 + 30, 360);
  return (
    <ChartFrame
      title="Subagent comparison"
      embedded={embedded}
      legend={
        <>
          <LegendDot color={COLOR_REALIZED} label="Realized" />
          <LegendDot color={COLOR_POTENTIAL} label="Potential" />
        </>
      }
    >
      <ResponsiveContainer width="100%" height={height}>
        <BarChart
          data={data}
          layout="vertical"
          barSize={14}
          margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
        >
          <XAxis
            type="number"
            tick={AXIS_TICK_STYLE}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => fmt(v)}
          />
          <YAxis
            type="category"
            dataKey="curatedId"
            tick={AXIS_TICK_STYLE}
            axisLine={false}
            tickLine={false}
            width={130}
          />
          <Tooltip
            cursor={{ fill: 'rgba(0,0,0,0.04)' }}
            formatter={(v: number, name: string) => [fmt(v), name]}
            labelStyle={TOOLTIP_LABEL_STYLE}
            contentStyle={TOOLTIP_STYLE}
          />
          <Bar dataKey="realized" name="Realized" stackId="cmp" fill={COLOR_REALIZED} />
          <Bar
            dataKey="potential"
            name="Potential"
            stackId="cmp"
            fill={COLOR_POTENTIAL}
            radius={[0, 4, 4, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
