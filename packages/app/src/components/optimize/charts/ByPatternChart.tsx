import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { OptimizationMetrics } from '@sentinel/shared';
import type { SavingsUnits } from '../../../lib/optimizeUnits.js';
import { buildPatternSeries } from '../../../lib/optimizeCharts.js';
import { formatTokens } from '../../../lib/optimizeUnits.js';
import {
  AXIS_TICK_STYLE,
  ChartEmptyState,
  ChartFrame,
  TOOLTIP_LABEL_STYLE,
  TOOLTIP_STYLE,
  formatUsd,
} from './shared.js';

const COLOR = '#a78bfa';

/** Horizontal bars ranking detection heuristics by opportunity count.
 *  The primary metric is count (it's the most useful answer to "which
 *  pattern fires most often?"); the tooltip surfaces the savings in the
 *  active units as a secondary annotation. Caps at 8 rows; everything
 *  past that rolls into "Other (N)". */
export default function ByPatternChart({
  byPattern,
  units,
  embedded = false,
}: {
  byPattern: OptimizationMetrics['byPattern'];
  units: SavingsUnits;
  embedded?: boolean;
}): React.ReactElement {
  const data = buildPatternSeries(byPattern);
  if (data.length === 0) return <ChartEmptyState embedded={embedded} />;
  const height = Math.min(data.length * 28 + 30, 320);
  const renderTooltip = (
    v: number,
    _name: string,
    p: { payload?: { savingsUsd?: number; tokens?: number } },
  ): [string, string] => {
    const savings =
      units === 'cost'
        ? formatUsd(p.payload?.savingsUsd ?? 0)
        : formatTokens(p.payload?.tokens ?? 0);
    const opps = `${v} opportunit${v === 1 ? 'y' : 'ies'}`;
    return [`${opps} · ${savings}`, 'Pattern'];
  };
  return (
    <ChartFrame title="Detection patterns by frequency" embedded={embedded}>
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
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={AXIS_TICK_STYLE}
            axisLine={false}
            tickLine={false}
            width={170}
          />
          <Tooltip
            cursor={{ fill: 'rgba(0,0,0,0.04)' }}
            formatter={renderTooltip}
            labelStyle={TOOLTIP_LABEL_STYLE}
            contentStyle={TOOLTIP_STYLE}
          />
          <Bar dataKey="opportunities" fill={COLOR} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
