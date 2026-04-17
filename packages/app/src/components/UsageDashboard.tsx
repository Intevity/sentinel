import React, { useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { useUsage } from '../hooks/useUsage.js';

const MODEL_COLORS: Record<string, string> = {
  'claude-opus-4':    '#BF5AF2',
  'claude-sonnet-4-6': '#007AFF',
  'claude-haiku-4-5':  '#30D158',
};

function modelColor(model: string): string {
  return MODEL_COLORS[model] ?? '#8E8E93';
}

const PERIODS = [
  { days: 7,  label: '7d' },
  { days: 14, label: '14d' },
  { days: 30, label: '30d' },
];

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; fill: string }>;
  label?: string;
}

function CustomTooltip({ active, payload, label }: TooltipProps): React.ReactElement | null {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white dark:bg-[#2C2C2E] rounded-xl shadow-card-md px-3 py-2 text-[11px]">
      <p className="font-semibold text-black dark:text-white mb-1">{label}</p>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.fill }} />
          <span className="text-[#8E8E93]">{p.name}</span>
          <span className="font-medium text-black dark:text-white ml-auto pl-4">
            ${p.value.toFixed(4)}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function UsageDashboard(): React.ReactElement {
  const [days, setDays] = useState(7);
  const { usage, loading, error } = useUsage();

  const chartData = usage
    ? Object.entries(usage.byDayModel).map(([date, models]) => {
        const entry: Record<string, string | number> = { date: date.slice(5) };
        for (const [model, stats] of Object.entries(models)) {
          entry[model] = Math.round(stats.costUsd * 100000) / 100000;
        }
        return entry;
      })
    : [];

  const allModels = usage
    ? [...new Set(Object.values(usage.byDayModel).flatMap((m) => Object.keys(m)))]
    : [];

  const totalCost = usage
    ? Object.values(usage.byDayModel).reduce(
        (sum, models) => sum + Object.values(models).reduce((s, m) => s + m.costUsd, 0), 0)
    : 0;

  const totalTokens = usage
    ? Object.values(usage.byDayModel).reduce(
        (sum, models) => sum + Object.values(models).reduce((s, m) => s + m.tokens, 0), 0)
    : 0;

  return (
    <div className="space-y-3 pt-1">

      {/* Section header + period selector */}
      <div className="flex items-center justify-between mb-3">
        <span className="section-label">Usage</span>
        <div className="flex bg-black/[0.06] dark:bg-white/[0.08] rounded-lg p-[2px] gap-[2px]">
          {PERIODS.map(({ days: d, label }) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all duration-150 ${
                days === d
                  ? 'bg-white dark:bg-[#3A3A3C] text-black dark:text-white shadow-[0_1px_2px_rgba(0,0,0,0.12)]'
                  : 'text-[#8E8E93]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Metric tiles */}
      <div className="grid grid-cols-2 gap-2">
        <div className="glass-card px-4 py-3">
          <p className="text-[11px] text-[#8E8E93] font-medium">Total Cost</p>
          <p className="text-[22px] font-bold tracking-tight text-black dark:text-white mt-0.5">
            ${totalCost < 0.01 && totalCost > 0 ? totalCost.toFixed(4) : totalCost.toFixed(2)}
          </p>
          <p className="text-[10px] text-[#8E8E93]">last {days} days</p>
        </div>
        <div className="glass-card px-4 py-3">
          <p className="text-[11px] text-[#8E8E93] font-medium">Tokens</p>
          <p className="text-[22px] font-bold tracking-tight text-black dark:text-white mt-0.5">
            {totalTokens >= 1_000_000
              ? `${(totalTokens / 1_000_000).toFixed(1)}M`
              : `${(totalTokens / 1_000).toFixed(1)}K`}
          </p>
          <p className="text-[10px] text-[#8E8E93]">last {days} days</p>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl bg-ios-red/10 px-4 py-3">
          <p className="text-[12px] text-ios-red">{error}</p>
        </div>
      )}

      {loading && (
        <div className="glass-card px-4 py-8 text-center">
          <p className="text-[12px] text-[#8E8E93]">Loading…</p>
        </div>
      )}

      {!loading && chartData.length === 0 && !error && (
        <div className="glass-card px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-black dark:text-white">No data yet</p>
          <p className="text-[11px] text-[#8E8E93] mt-1">
            Usage appears after your first proxied API call.
          </p>
        </div>
      )}

      {/* Bar chart */}
      {chartData.length > 0 && (
        <div className="glass-card px-4 pt-4 pb-2">
          <p className="text-[11px] font-semibold text-[#8E8E93] mb-3">Cost by Day (USD)</p>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={chartData} barSize={20} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: '#8E8E93' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#8E8E93' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => `$${v.toFixed(2)}`}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
              {allModels.map((model) => (
                <Bar key={model} dataKey={model} stackId="a" radius={model === allModels[allModels.length - 1] ? [4, 4, 0, 0] : [0, 0, 0, 0]}>
                  {chartData.map((_, i) => (
                    <Cell key={i} fill={modelColor(model)} />
                  ))}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>

          {/* Legend */}
          <div className="flex flex-wrap gap-3 mt-2">
            {allModels.map((model) => (
              <div key={model} className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: modelColor(model) }} />
                <span className="text-[10px] text-[#8E8E93]">{model.split('-').slice(0, 3).join('-')}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
