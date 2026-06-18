import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { CompressionMetrics } from '@sentinel/shared';
import { formatTokens } from '../../../lib/optimizeUnits.js';
import {
  AXIS_TICK_STYLE,
  ChartEmptyState,
  ChartFrame,
  TOOLTIP_LABEL_STYLE,
  TOOLTIP_STYLE,
} from './shared.js';

const COLOR = '#34d399';

/** Horizontal bars ranking tools by estimated tokens saved from compressing
 *  their tool_result output. Caps at 8 rows. */
export default function CompressionByToolChart({
  byTool,
}: {
  byTool: CompressionMetrics['byTool'];
}): React.ReactElement {
  const data = byTool
    .filter((t) => t.estTokensSaved > 0)
    .slice(0, 8)
    .map((t) => ({ label: t.tool, estTokensSaved: t.estTokensSaved, blocks: t.blocks }));
  if (data.length === 0) {
    return <ChartEmptyState>No compression savings recorded yet.</ChartEmptyState>;
  }
  const height = Math.min(data.length * 28 + 30, 280);
  const renderTooltip = (
    v: number,
    _name: string,
    p: { payload?: { blocks?: number } },
  ): [string, string] => {
    const blocks = p.payload?.blocks ?? 0;
    return [`${formatTokens(v)} · ${blocks} block${blocks === 1 ? '' : 's'}`, 'Saved'];
  };
  return (
    <ChartFrame title="Estimated tokens saved by tool" collapsible defaultOpen={false}>
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
            tickFormatter={(v: number) => formatTokens(v)}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={AXIS_TICK_STYLE}
            axisLine={false}
            tickLine={false}
            width={120}
          />
          <Tooltip
            cursor={{ fill: 'rgba(0,0,0,0.04)' }}
            formatter={renderTooltip}
            labelStyle={TOOLTIP_LABEL_STYLE}
            contentStyle={TOOLTIP_STYLE}
          />
          <Bar dataKey="estTokensSaved" fill={COLOR} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
