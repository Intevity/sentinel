import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { OptimizationMetrics } from '@claude-sentinel/shared';
import type { SavingsUnits } from '../../../lib/optimizeUnits.js';
import { buildBySubagentSeries, colorForCuratedId } from '../../../lib/optimizeCharts.js';
import {
  AXIS_TICK_STYLE,
  ChartEmptyState,
  ChartFrame,
  LegendDot,
  TOOLTIP_LABEL_STYLE,
  TOOLTIP_STYLE,
  valueFormatter,
} from './shared.js';

/** Daily stacked bar chart broken out per curated subagent. Each color
 *  is one subagent; the stack height is total opportunity (realized +
 *  potential) per day in the active units. Lets the user see *which*
 *  subagent is driving today's savings rather than just realized vs
 *  potential in aggregate. */
export default function BySubagentChart({
  dailyBySubagent,
  units,
}: {
  dailyBySubagent: OptimizationMetrics['dailyBySubagent'];
  units: SavingsUnits;
}): React.ReactElement {
  if (dailyBySubagent.length === 0) return <ChartEmptyState />;
  const { data, curatedIds } = buildBySubagentSeries(dailyBySubagent, units);
  const fmt = valueFormatter(units);
  return (
    <ChartFrame
      title="Daily savings by subagent"
      legend={curatedIds.map((id) => (
        <LegendDot key={id} color={colorForCuratedId(id)} label={id} />
      ))}
    >
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} barSize={14} margin={{ top: 0, right: 0, bottom: 0, left: -12 }}>
          <XAxis dataKey="day" tick={AXIS_TICK_STYLE} axisLine={false} tickLine={false} />
          <YAxis
            tick={AXIS_TICK_STYLE}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => fmt(v)}
          />
          <Tooltip
            cursor={{ fill: 'rgba(0,0,0,0.04)' }}
            formatter={(v: number, name: string) => [fmt(v), name]}
            labelStyle={TOOLTIP_LABEL_STYLE}
            contentStyle={TOOLTIP_STYLE}
          />
          {curatedIds.map((id, i) => (
            <Bar
              key={id}
              dataKey={id}
              name={id}
              stackId="bySub"
              fill={colorForCuratedId(id)}
              radius={i === curatedIds.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
