import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { CompressionMetrics } from '@sentinel/shared';
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

const COLOR_SAVED = '#34d399';

/** Daily bars of estimated savings from in-flight tool_result compression,
 *  in the active units. The "Compression" entry in the chart-view switcher:
 *  the other views slice subagent savings, this one shows the compression
 *  half of the header totals. Figures are estimates derived from bytes
 *  removed (see CompressionMetrics docs); the per-tool and ratio drill-downs
 *  live in the Compression pane below. */
export default function CompressionSavingsChart({
  daily,
  units,
  embedded = false,
}: {
  daily: CompressionMetrics['daily'];
  units: SavingsUnits;
  embedded?: boolean;
}): React.ReactElement {
  if (daily.length === 0) {
    return <ChartEmptyState embedded={embedded}>No compression activity yet.</ChartEmptyState>;
  }
  const data = daily.map((d) => ({
    day: d.day.slice(5).replace('-', '/'),
    saved: units === 'cost' ? Number(d.estCostSavedUsd.toFixed(2)) : Math.round(d.estTokensSaved),
  }));
  const fmt = valueFormatter(units);
  return (
    <ChartFrame
      title="Compression savings"
      embedded={embedded}
      legend={<LegendDot color={COLOR_SAVED} label="Est. saved" />}
    >
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} barSize={14} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <XAxis dataKey="day" tick={AXIS_TICK_STYLE} axisLine={false} tickLine={false} />
          <YAxis
            tick={AXIS_TICK_STYLE}
            axisLine={false}
            tickLine={false}
            width={yAxisWidth(data.map((d) => fmt(d.saved)))}
            tickFormatter={(v: number) => fmt(v)}
          />
          <Tooltip
            cursor={{ fill: 'rgba(0,0,0,0.04)' }}
            formatter={(v: number) => [fmt(v), 'Est. saved']}
            labelStyle={TOOLTIP_LABEL_STYLE}
            contentStyle={TOOLTIP_STYLE}
          />
          <Bar dataKey="saved" name="Est. saved" fill={COLOR_SAVED} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
