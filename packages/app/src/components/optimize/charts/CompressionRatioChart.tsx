import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { CompressionMetrics } from '@claude-sentinel/shared';
import {
  AXIS_TICK_STYLE,
  ChartEmptyState,
  ChartFrame,
  TOOLTIP_LABEL_STYLE,
  TOOLTIP_STYLE,
  yAxisWidth,
} from './shared.js';

const COLOR = '#60a5fa';

/** Daily line of the percentage of tool_result bytes removed by compression
 *  (`(1 - bytesOut/bytesIn) * 100`). Higher is more compression. */
export default function CompressionRatioChart({
  daily,
}: {
  daily: CompressionMetrics['daily'];
}): React.ReactElement {
  const data = daily.map((d) => ({
    day: d.day.slice(5), // drop the year for a compact axis label
    removedPct: d.bytesIn > 0 ? Math.round((1 - d.bytesOut / d.bytesIn) * 100) : 0,
  }));
  if (data.length === 0) {
    return <ChartEmptyState>No compression activity yet.</ChartEmptyState>;
  }
  return (
    <ChartFrame title="Bytes removed per day" collapsible defaultOpen={false}>
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          <XAxis dataKey="day" tick={AXIS_TICK_STYLE} axisLine={false} tickLine={false} />
          <YAxis
            tick={AXIS_TICK_STYLE}
            axisLine={false}
            tickLine={false}
            domain={[0, 100]}
            width={yAxisWidth(['100%'])}
            tickFormatter={(v: number) => `${v}%`}
          />
          <Tooltip
            cursor={{ stroke: 'rgba(255,255,255,0.1)' }}
            formatter={(v: number) => [`${v}%`, 'Removed']}
            labelStyle={TOOLTIP_LABEL_STYLE}
            contentStyle={TOOLTIP_STYLE}
          />
          <Line
            type="monotone"
            dataKey="removedPct"
            name="Removed"
            stroke={COLOR}
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
