import React, { useState, useEffect, useCallback } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import type {
  MetricsSummary,
  MetricsByDayModel,
  CacheTtlSessionRow,
  OptimizeRangePreset,
} from '@sentinel/shared';
import { useMetricsSummary, type MetricsScope } from '../hooks/useMetricsSummary.js';
import { useSettings } from '../hooks/useSettings.js';
import InfoTooltip from './InfoTooltip.js';
import OtelDriftBanner from './OtelDriftBanner.js';
import { RangeSelector } from './RangeSelector.js';
import { RANGE_LABELS } from '../lib/dateRange.js';

const MODEL_COLORS: Record<string, string> = {
  'claude-opus-4': '#BF5AF2',
  'claude-sonnet-4-6': '#007AFF',
  'claude-haiku-4-5': '#30D158',
};

function modelColor(model: string): string {
  // Handle model variants like "claude-opus-4-7[1m]" → opus
  const base = model.match(/claude-(opus|sonnet|haiku)/)?.[0];
  if (base === 'claude-opus') return '#BF5AF2';
  if (base === 'claude-sonnet') return '#007AFF';
  if (base === 'claude-haiku') return '#30D158';
  return MODEL_COLORS[model] ?? '#8E8E93';
}

const TOKEN_TYPE_COLORS: Record<string, string> = {
  input: '#007AFF',
  output: '#5E5CE6',
  cacheRead: '#30D158',
  cacheCreate: '#FF9F0A',
};

const OTEL_PROVENANCE = [
  'Metrics are emitted by Claude Code via OpenTelemetry and sent to',
  "Sentinel's local receiver. Sentinel enables this automatically by",
  'setting CLAUDE_CODE_ENABLE_TELEMETRY=1, OTEL_METRICS_EXPORTER=otlp,',
  'and OTEL_LOGS_EXPORTER=otlp in ~/.claude/settings.json.',
].join(' ');

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; fill: string; dataKey: string }>;
  label?: string;
  valueFormatter?: (v: number) => string;
}

function StackedTooltip({
  active,
  payload,
  label,
  valueFormatter,
}: ChartTooltipProps): React.ReactElement | null {
  if (!active || !payload?.length) return null;
  const fmt = valueFormatter ?? ((v: number): string => v.toLocaleString());
  const total = payload.reduce((s, p) => s + p.value, 0);
  return (
    <div className="bg-white dark:bg-[#2C2C2E] rounded-xl shadow-card-md px-3 py-2 text-[11px] min-w-[140px]">
      <p className="font-semibold text-black dark:text-white mb-1">{label}</p>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.fill }} />
          <span className="text-muted">{p.name}</span>
          <span className="font-medium text-black dark:text-white ml-auto pl-4">
            {fmt(p.value)}
          </span>
        </div>
      ))}
      {payload.length > 1 && (
        <div className="border-t border-black/5 dark:border-white/10 mt-1 pt-1 flex justify-between">
          <span className="text-muted">Total</span>
          <span className="font-semibold text-black dark:text-white">{fmt(total)}</span>
        </div>
      )}
    </div>
  );
}

interface MetricsDashboardProps {
  /** Describes which accounts this dashboard renders. When omitted or
   *  { kind: 'active' } the daemon falls back to the active account.
   *  Pool/all scopes pass a pre-computed member list so the daemon doesn't
   *  need to know about pool semantics. Set by the per-tab
   *  AccountViewPicker in App.tsx. */
  scope?: MetricsScope | undefined;
}

export default function MetricsDashboard({
  scope,
}: MetricsDashboardProps = {}): React.ReactElement {
  // Same range selector as the Optimize page (shared RangeSelector +
  // windowForRange). The preset persists in Settings.metricsRange; the custom
  // start/end dates are client-held only, mirroring the Optimize page.
  const { settings, update } = useSettings();
  const [range, setRange] = useState<OptimizeRangePreset>('1w');
  const [customStart, setCustomStart] = useState<string>('');
  const [customEnd, setCustomEnd] = useState<string>('');
  const persistedRange = settings?.metricsRange;
  useEffect(() => {
    if (persistedRange) setRange(persistedRange);
  }, [persistedRange]);
  const onChangeRange = useCallback(
    (next: OptimizeRangePreset) => {
      setRange(next);
      void update({ metricsRange: next }).catch(() => undefined);
    },
    [update],
  );

  const { summary, loading, error } = useMetricsSummary(scope, range, customStart, customEnd);

  return (
    <div className="space-y-3 pt-1">
      <OtelDriftBanner />

      {/* ── Header + range selector (same control as the Optimize page) ── */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="section-label">Metrics</span>
          <InfoTooltip text={OTEL_PROVENANCE} />
        </div>
        <div className="min-w-0 flex-1">
          <RangeSelector
            range={range}
            retentionDays={settings?.metricsRetentionDays ?? 365}
            customStart={customStart}
            customEnd={customEnd}
            onChangeRange={onChangeRange}
            onChangeCustomStart={setCustomStart}
            onChangeCustomEnd={setCustomEnd}
          />
        </div>
      </div>

      {error && (
        <div className="rounded-2xl bg-ios-red/10 px-4 py-3">
          <p className="text-[12px] text-ios-red">{error}</p>
        </div>
      )}

      {loading && !summary && (
        <div className="glass-card px-4 py-8 text-center">
          <p className="text-[12px] text-muted">Loading…</p>
        </div>
      )}

      {summary && <MetricsContent summary={summary} rangeLabel={RANGE_LABELS[range]} />}
    </div>
  );
}

function MetricsContent({
  summary,
  rangeLabel,
}: {
  summary: MetricsSummary;
  /** Human phrase for the selected range ("today", "in the last 7 days",
   *  "all-time"), used in tile subtexts. */
  rangeLabel: string;
}): React.ReactElement {
  const { settings } = useSettings();
  // Aggregate totals across the period for the summary tiles.
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;
  for (const models of Object.values(summary.byDayModel)) {
    for (const m of Object.values(models)) {
      totalCost += m.costUsd;
      totalInput += m.inputTokens;
      totalOutput += m.outputTokens;
      totalCacheRead += m.cacheReadTokens;
      totalCacheCreate += m.cacheCreationTokens;
    }
  }
  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheCreate;
  const cacheDenom = totalInput + totalCacheRead;
  const overallCacheRate = cacheDenom > 0 ? totalCacheRead / cacheDenom : 0;
  const errorCount = Object.values(summary.errors.byDay).reduce(
    (sum, byStatus) => sum + Object.values(byStatus).reduce((a, b) => a + b, 0),
    0,
  );

  // Days the period touches, used as the x-axis backbone for each chart so
  // empty days render as a gap instead of compressing the layout.
  const allDays = Object.keys(summary.byDayModel).sort();
  const allModels = [...new Set(Object.values(summary.byDayModel).flatMap((m) => Object.keys(m)))];

  return (
    <>
      {/* ── Summary tiles ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2">
        <Tile label="Total Cost" sub={rangeLabel}>
          <span className="text-[22px] font-bold tracking-tight text-black dark:text-white">
            ${formatCost(totalCost)}
          </span>
        </Tile>
        <Tile
          label="Tokens"
          sub={`cache-read ${compact(totalCacheRead)} · cache-create ${compact(totalCacheCreate)}`}
          title="Reported by Claude Code telemetry for the selected accounts. Sessions running without telemetry are not counted; the Optimize page measures at the proxy across all accounts, so its totals can read higher."
        >
          <span className="text-[22px] font-bold tracking-tight text-black dark:text-white">
            {compact(totalTokens)}
          </span>
        </Tile>
        <Tile label="Cache Hit Rate" sub="cache-read / (input + cache-read)">
          <span className="text-[22px] font-bold tracking-tight text-black dark:text-white">
            {(overallCacheRate * 100).toFixed(1)}%
          </span>
        </Tile>
        <Tile
          label="Errors"
          sub={
            summary.errors.retryExhaustedCount > 0
              ? `${summary.errors.retryExhaustedCount} retry-exhausted`
              : rangeLabel
          }
        >
          <span
            className={`text-[22px] font-bold tracking-tight ${errorCount > 0 ? 'text-ios-orange' : 'text-black dark:text-white'}`}
          >
            {errorCount}
          </span>
        </Tile>
      </div>

      {/* ── Tokens chart ──────────────────────────────────────────────── */}
      {totalTokens > 0 ? (
        <TokensChart byDayModel={summary.byDayModel} allDays={allDays} />
      ) : (
        <EmptyCard
          title="Tokens"
          hint="Token breakdown appears once Claude Code emits api_request log events."
        />
      )}

      {/* ── Cost chart ────────────────────────────────────────────────── */}
      {totalCost > 0 && (
        <CostChart byDayModel={summary.byDayModel} allDays={allDays} allModels={allModels} />
      )}

      {/* ── Cache-hit rate per model ──────────────────────────────────── */}
      {Object.keys(summary.cacheHitRate).length > 0 && (
        <div className="glass-card px-4 py-3">
          <p className="text-[11px] font-semibold text-muted mb-2">Cache hit rate by model</p>
          <div className="space-y-2">
            {Object.entries(summary.cacheHitRate).map(([model, r]) => (
              <div key={model} className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-black dark:text-white flex-1 truncate">
                  {model}
                </span>
                {r.rate > 0 && (
                  <div className="h-[4px] w-24 rounded-full bg-black/[0.08] dark:bg-white/[0.10] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-ios-green"
                      style={{ width: `${Math.min(100, r.rate * 100)}%` }}
                    />
                  </div>
                )}
                <span className="text-[11px] font-bold tabular-nums text-black dark:text-white w-12 text-right">
                  {(r.rate * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Cache TTL (proxy-sourced, 5m vs 1h split) ─────────────────── */}
      {hasCacheTtlData(summary.cacheTtl) && (
        <CacheTtlSection
          ttl={summary.cacheTtl}
          overrideForceOneHour={settings?.cacheTtlForceOneHour ?? false}
        />
      )}

      {/* ── Errors timeline ──────────────────────────────────────────── */}
      {errorCount > 0 && (
        <ErrorsTimeline
          errors={summary.errors}
          allDays={Object.keys(summary.errors.byDay).sort()}
        />
      )}

      {/* ── Top tools ────────────────────────────────────────────────── */}
      {summary.tools.length > 0 && <TopTools tools={summary.tools} />}

      {/* ── Productivity sparklines ──────────────────────────────────── */}
      {hasProductivityData(summary) && <ProductivityRow activity={summary.activity} />}

      {/* ── Active time ──────────────────────────────────────────────── */}
      {Object.keys(summary.activity.activeTimePerDay).length > 0 && (
        <ActiveTimeChart perDay={summary.activity.activeTimePerDay} />
      )}

      {/* ── Edit accept rate ─────────────────────────────────────────── */}
      {summary.editAcceptRate.overall.accepts + summary.editAcceptRate.overall.rejects > 0 && (
        <EditAcceptRateCard rate={summary.editAcceptRate} />
      )}

      {/* ── Tool-permission decisions (all tools) ────────────────────── */}
      {summary.toolDecisions.overall.accepts + summary.toolDecisions.overall.rejects > 0 && (
        <ToolDecisionsCard decisions={summary.toolDecisions} />
      )}

      {/* ── Prompts submitted ────────────────────────────────────────── */}
      {summary.prompts.total > 0 && <PromptsCard prompts={summary.prompts} />}

      {/* ── Skills & Plugins ─────────────────────────────────────────── */}
      {(summary.skills.length > 0 || summary.plugins.length > 0) && (
        <SkillsAndPlugins skills={summary.skills} plugins={summary.plugins} />
      )}

      {/* Friendly nudge when the whole dashboard is empty */}
      {totalTokens === 0 && totalCost === 0 && errorCount === 0 && summary.tools.length === 0 && (
        <div className="glass-card px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-black dark:text-white">Awaiting telemetry</p>
          <p className="text-[11px] text-muted mt-1 leading-relaxed">
            Run a Claude Code session — metrics appear here once OTEL events flush.
          </p>
        </div>
      )}
    </>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Tile({
  label,
  sub,
  title,
  children,
}: {
  label: string;
  sub?: string;
  /** Optional hover tooltip, e.g. the data-source note on the Tokens tile. */
  title?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="glass-card px-4 py-3" title={title}>
      <p className="text-[11px] text-muted font-medium">{label}</p>
      <p className="mt-0.5">{children}</p>
      {sub && <p className="text-[10px] text-muted mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

function EmptyCard({ title, hint }: { title: string; hint: string }): React.ReactElement {
  return (
    <div className="glass-card px-4 py-5">
      <p className="text-[11px] font-semibold text-muted mb-1">{title}</p>
      <p className="text-[11px] text-muted">{hint}</p>
    </div>
  );
}

/** Stacked bar: input / output / cacheRead / cacheCreation per day. */
function TokensChart({
  byDayModel,
  allDays,
}: {
  byDayModel: Record<string, Record<string, MetricsByDayModel>>;
  allDays: string[];
}): React.ReactElement {
  const data = allDays.map((date) => {
    const entry: Record<string, string | number> = { date: date.slice(5) };
    let input = 0,
      output = 0,
      cacheRead = 0,
      cacheCreate = 0;
    for (const m of Object.values(byDayModel[date] ?? {})) {
      input += m.inputTokens;
      output += m.outputTokens;
      cacheRead += m.cacheReadTokens;
      cacheCreate += m.cacheCreationTokens;
    }
    entry['input'] = input;
    entry['output'] = output;
    entry['cacheRead'] = cacheRead;
    entry['cacheCreate'] = cacheCreate;
    return entry;
  });

  const keys = ['input', 'output', 'cacheRead', 'cacheCreate'] as const;

  return (
    <div className="glass-card px-4 pt-4 pb-2">
      <p className="text-[11px] font-semibold text-muted mb-3">Tokens by day</p>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} barSize={18} margin={{ top: 0, right: 0, bottom: 0, left: -12 }}>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: 'rgb(var(--muted))' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: 'rgb(var(--muted))' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => compact(v)}
          />
          <Tooltip content={<StackedTooltip />} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
          {keys.map((k, idx) => (
            <Bar
              key={k}
              dataKey={k}
              name={tokenLabel(k)}
              stackId="tokens"
              fill={TOKEN_TYPE_COLORS[k]}
              radius={idx === keys.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap gap-3 mt-2">
        {keys.map((k) => (
          <div key={k} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: TOKEN_TYPE_COLORS[k] }} />
            <span className="text-[10px] text-muted">{tokenLabel(k)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Stacked bar: cost per day colored by model. */
function CostChart({
  byDayModel,
  allDays,
  allModels,
}: {
  byDayModel: Record<string, Record<string, MetricsByDayModel>>;
  allDays: string[];
  allModels: string[];
}): React.ReactElement {
  const data = allDays.map((date) => {
    const entry: Record<string, string | number> = { date: date.slice(5) };
    for (const model of allModels) {
      entry[model] = Math.round((byDayModel[date]?.[model]?.costUsd ?? 0) * 100000) / 100000;
    }
    return entry;
  });

  return (
    <div className="glass-card px-4 pt-4 pb-2">
      <p className="text-[11px] font-semibold text-muted mb-3">Cost by day (USD)</p>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} barSize={18} margin={{ top: 0, right: 0, bottom: 0, left: -12 }}>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: 'rgb(var(--muted))' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: 'rgb(var(--muted))' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => `$${v.toFixed(2)}`}
          />
          <Tooltip
            content={<StackedTooltip valueFormatter={(v) => `$${v.toFixed(4)}`} />}
            cursor={{ fill: 'rgba(0,0,0,0.04)' }}
          />
          {allModels.map((model, idx) => (
            <Bar
              key={model}
              dataKey={model}
              stackId="cost"
              radius={idx === allModels.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={modelColor(model)} />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap gap-3 mt-2">
        {allModels.map((model) => (
          <div key={model} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: modelColor(model) }} />
            <span className="text-[10px] text-muted truncate max-w-[140px]">{model}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorsTimeline({
  errors,
  allDays,
}: {
  errors: MetricsSummary['errors'];
  allDays: string[];
}): React.ReactElement {
  // Bucket by status-code family so we don't explode into dozens of bars.
  const data = allDays.map((date) => {
    const byStatus = errors.byDay[date] ?? {};
    let c4xx = 0,
      c5xx = 0,
      other = 0;
    for (const [code, n] of Object.entries(byStatus)) {
      const cc = Number(code);
      if (cc >= 400 && cc < 500) c4xx += n;
      else if (cc >= 500 && cc < 600) c5xx += n;
      else other += n;
    }
    return { date: date.slice(5), '4xx': c4xx, '5xx': c5xx, other };
  });
  return (
    <div className="glass-card px-4 pt-4 pb-2">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold text-muted">API errors</p>
        {errors.retryExhaustedCount > 0 && (
          <span className="text-[10px] font-semibold text-ios-red bg-ios-red/10 px-2 py-0.5 rounded-full">
            {errors.retryExhaustedCount} retry-exhausted
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={120}>
        <BarChart data={data} barSize={14} margin={{ top: 0, right: 0, bottom: 0, left: -16 }}>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: 'rgb(var(--muted))' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: 'rgb(var(--muted))' }}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
          />
          <Tooltip content={<StackedTooltip />} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
          <Bar dataKey="4xx" stackId="e" fill="#FF9F0A" />
          <Bar dataKey="5xx" stackId="e" fill="#FF453A" radius={[4, 4, 0, 0]} />
          <Bar dataKey="other" stackId="e" fill="#8E8E93" />
        </BarChart>
      </ResponsiveContainer>
      <div className="flex gap-3 mt-2">
        <LegendDot color="#FF9F0A" label="4xx" />
        <LegendDot color="#FF453A" label="5xx" />
        <LegendDot color="#8E8E93" label="other" />
      </div>
    </div>
  );
}

function TopTools({ tools }: { tools: MetricsSummary['tools'] }): React.ReactElement {
  return (
    <div className="glass-card px-4 py-3">
      <p className="text-[11px] font-semibold text-muted mb-2">Top tools</p>
      <div className="space-y-1.5">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 text-[10px] text-muted uppercase tracking-wider pb-1 border-b border-black/5 dark:border-white/5">
          <span>Tool</span>
          <span className="text-right">Calls</span>
          <span className="text-right">p50 / p95</span>
          <span className="text-right">OK</span>
        </div>
        {tools.map((t) => (
          <div
            key={t.toolName}
            className="grid grid-cols-[1fr_auto_auto_auto] gap-3 text-[11px] items-center"
          >
            <span
              className="font-medium text-black dark:text-white truncate"
              title={t.topError ?? undefined}
            >
              {t.toolName}
            </span>
            <span className="text-right tabular-nums text-black dark:text-white">{t.calls}</span>
            <span className="text-right tabular-nums text-muted">
              {Math.round(t.p50Ms)}/{Math.round(t.p95Ms)}ms
            </span>
            <span
              className={`text-right tabular-nums font-semibold ${t.successRate >= 0.95 ? 'text-ios-green' : t.successRate >= 0.8 ? 'text-ios-orange' : 'text-ios-red'}`}
            >
              {(t.successRate * 100).toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function hasProductivityData(summary: MetricsSummary): boolean {
  const a = summary.activity;
  return (
    Object.keys(a.linesPerDay).length > 0 ||
    Object.keys(a.commitsPerDay).length > 0 ||
    Object.keys(a.prsPerDay).length > 0
  );
}

function ProductivityRow({
  activity,
}: {
  activity: MetricsSummary['activity'];
}): React.ReactElement {
  const linesAdded = sumRecord(activity.linesPerDay, (v) => v.added);
  const linesRemoved = sumRecord(activity.linesPerDay, (v) => v.removed);
  const commits = sumRecord(activity.commitsPerDay, (v) => v);
  const prs = sumRecord(activity.prsPerDay, (v) => v);

  return (
    <div className="grid grid-cols-3 gap-2">
      <Tile label="Lines" sub={`+${compact(linesAdded)} / −${compact(linesRemoved)}`}>
        <span className="text-[18px] font-bold text-black dark:text-white">
          {compact(linesAdded + linesRemoved)}
        </span>
      </Tile>
      <Tile label="Commits" sub={`last ${Object.keys(activity.commitsPerDay).length}d`}>
        <span className="text-[18px] font-bold text-black dark:text-white">{commits}</span>
      </Tile>
      <Tile label="PRs" sub={`last ${Object.keys(activity.prsPerDay).length}d`}>
        <span className="text-[18px] font-bold text-black dark:text-white">{prs}</span>
      </Tile>
    </div>
  );
}

function ActiveTimeChart({
  perDay,
}: {
  perDay: Record<string, { user: number; cli: number }>;
}): React.ReactElement {
  const days = Object.keys(perDay).sort();
  const data = days.map((d) => ({
    date: d.slice(5),
    user: Math.round(perDay[d]!.user / 60), // seconds → minutes
    cli: Math.round(perDay[d]!.cli / 60),
  }));
  return (
    <div className="glass-card px-4 pt-4 pb-2">
      <p className="text-[11px] font-semibold text-muted mb-3">Active time (minutes / day)</p>
      <ResponsiveContainer width="100%" height={120}>
        <BarChart data={data} barSize={16} margin={{ top: 0, right: 0, bottom: 0, left: -16 }}>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: 'rgb(var(--muted))' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: 'rgb(var(--muted))' }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            content={<StackedTooltip valueFormatter={(v) => `${v}m`} />}
            cursor={{ fill: 'rgba(0,0,0,0.04)' }}
          />
          <Bar dataKey="user" stackId="t" fill="#007AFF" name="user" />
          <Bar dataKey="cli" stackId="t" fill="#5E5CE6" radius={[4, 4, 0, 0]} name="cli" />
        </BarChart>
      </ResponsiveContainer>
      <div className="flex gap-3 mt-2">
        <LegendDot color="#007AFF" label="user" />
        <LegendDot color="#5E5CE6" label="cli" />
      </div>
    </div>
  );
}

function EditAcceptRateCard({
  rate,
}: {
  rate: MetricsSummary['editAcceptRate'];
}): React.ReactElement {
  const { overall, byLanguage } = rate;
  const overallPct = (overall.rate * 100).toFixed(1);
  const overallColor =
    overall.rate >= 0.8
      ? 'text-ios-green'
      : overall.rate >= 0.5
        ? 'text-ios-orange'
        : 'text-ios-red';
  return (
    <div className="glass-card px-4 py-3">
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-[11px] font-semibold text-muted">Edit accept rate</p>
        <p className={`text-[18px] font-bold tabular-nums ${overallColor}`}>{overallPct}%</p>
      </div>
      <p className="text-[10px] text-muted mb-2">
        {overall.accepts} accepted · {overall.rejects} rejected
      </p>
      {Object.keys(byLanguage).length > 0 && (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {Object.entries(byLanguage).map(([lang, r]) => (
            <div key={lang} className="flex items-center justify-between text-[11px]">
              <span className="text-black dark:text-white truncate">{lang}</span>
              <span className="text-muted tabular-nums">{(r.rate * 100).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolDecisionsCard({
  decisions,
}: {
  decisions: MetricsSummary['toolDecisions'];
}): React.ReactElement {
  const { overall, byTool, bySource } = decisions;
  const overallPct = (overall.rate * 100).toFixed(1);
  const overallColor =
    overall.rate >= 0.8
      ? 'text-ios-green'
      : overall.rate >= 0.5
        ? 'text-ios-orange'
        : 'text-ios-red';

  // Rank tools by total decisions, highest first. Limit to 6 to keep the
  // card compact — the rest are already summarized in "overall".
  const topTools = Object.entries(byTool)
    .map(([tool, r]) => ({ tool, ...r, total: r.accepts + r.rejects }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);

  // Sources are bounded (config/hook/user_permanent/user_temporary/
  // user_abort/user_reject) so just show them all.
  const sourceEntries = Object.entries(bySource)
    .map(([source, r]) => ({ source, ...r, total: r.accepts + r.rejects }))
    .sort((a, b) => b.total - a.total);

  return (
    <div className="glass-card px-4 py-3">
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-[11px] font-semibold text-muted">Tool permission decisions</p>
        <p className={`text-[18px] font-bold tabular-nums ${overallColor}`}>{overallPct}%</p>
      </div>
      <p className="text-[10px] text-muted mb-2">
        {overall.accepts} accepted · {overall.rejects} rejected · all tools (Bash, Read, Write, MCP,
        …)
      </p>
      {topTools.length > 0 && (
        <div className="mb-2">
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">By tool</p>
          <div className="space-y-1">
            {topTools.map((t) => (
              <div
                key={t.tool}
                className="grid grid-cols-[1fr_auto_auto] gap-3 text-[11px] items-center"
              >
                <span className="font-medium text-black dark:text-white truncate">{t.tool}</span>
                <span className="text-[10px] text-muted tabular-nums">
                  {t.accepts}✓ / {t.rejects}✗
                </span>
                <span className="text-[11px] font-semibold tabular-nums text-black dark:text-white w-10 text-right">
                  {(t.rate * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {sourceEntries.length > 0 && (
        <div>
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">By source</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {sourceEntries.map((s) => (
              <div key={s.source} className="flex items-center justify-between text-[11px]">
                <span
                  className="text-black dark:text-white truncate"
                  title={sourceDescription(s.source)}
                >
                  {s.source}
                </span>
                <span className="text-muted tabular-nums">
                  {s.total} · {(s.rate * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PromptsCard({ prompts }: { prompts: MetricsSummary['prompts'] }): React.ReactElement {
  const days = Object.keys(prompts.perDay).sort();
  const data = days.map((d) => ({
    date: d.slice(5),
    prompts: prompts.perDay[d]!.count,
  }));
  const avgLen = prompts.avgLength > 0 ? Math.round(prompts.avgLength) : 0;

  return (
    <div className="glass-card px-4 pt-4 pb-2">
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-[11px] font-semibold text-muted">Prompts per day</p>
        <p className="text-[18px] font-bold tabular-nums text-black dark:text-white">
          {prompts.total.toLocaleString()}
        </p>
      </div>
      <p className="text-[10px] text-muted mb-2">
        avg {avgLen.toLocaleString()} chars · {prompts.total} total
      </p>
      {data.length > 0 && (
        <ResponsiveContainer width="100%" height={100}>
          <BarChart data={data} barSize={14} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: 'rgb(var(--muted))' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: 'rgb(var(--muted))' }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<StackedTooltip />} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
            <Bar dataKey="prompts" fill="#5E5CE6" radius={[4, 4, 0, 0]} name="prompts" />
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function sourceDescription(source: string): string {
  switch (source) {
    case 'config':
      return 'Pre-approved by settings';
    case 'hook':
      return 'Allowed by a hook';
    case 'user_permanent':
      return '"Always allow": you approved permanently';
    case 'user_temporary':
      return 'You approved for this session';
    case 'user_abort':
      return 'You cancelled (abort)';
    case 'user_reject':
      return 'You explicitly rejected';
    default:
      return source;
  }
}

function SkillsAndPlugins({
  skills,
  plugins,
}: {
  skills: MetricsSummary['skills'];
  plugins: MetricsSummary['plugins'];
}): React.ReactElement {
  return (
    <div className="glass-card px-4 py-3">
      <p className="text-[11px] font-semibold text-muted mb-2">Skills &amp; plugins</p>
      {skills.length > 0 && (
        <div className="mb-2">
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Top skills</p>
          <div className="flex flex-wrap gap-1.5">
            {skills.slice(0, 8).map((s) => (
              <span
                key={s.name}
                className="inline-flex items-center gap-1 text-[10px] font-medium bg-black/[0.04] dark:bg-white/[0.06] px-2 py-0.5 rounded-full"
              >
                <span className="text-black dark:text-white">{s.name}</span>
                <span className="text-muted tabular-nums">{s.count}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {plugins.length > 0 && (
        <div>
          <p className="text-[10px] text-muted uppercase tracking-wider mb-1">Recent plugins</p>
          <div className="space-y-0.5">
            {plugins.map((p) => (
              <div
                key={`${p.name}-${p.installedAt}`}
                className="flex items-center justify-between text-[11px]"
              >
                <span className="text-black dark:text-white truncate">
                  {p.name}
                  {p.version && <span className="text-muted ml-1">v{p.version}</span>}
                </span>
                <span className="text-[10px] text-muted tabular-nums">
                  {formatRelative(p.installedAt)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      <span className="text-[10px] text-muted">{label}</span>
    </div>
  );
}

// ─── Cache TTL ────────────────────────────────────────────────────────────────

const CACHE_TTL_COLORS = {
  create5m: '#FF9F0A',
  create1h: '#BF5AF2',
  read: '#30D158',
} as const;

function hasCacheTtlData(ttl: MetricsSummary['cacheTtl']): boolean {
  if (!ttl) return false;
  if (ttl.bySession.length > 0) return true;
  for (const models of Object.values(ttl.byDayModel)) {
    for (const row of Object.values(models)) {
      if (row.create5m > 0 || row.create1h > 0 || row.read > 0) return true;
    }
  }
  return false;
}

type CacheTtlView = 'tokens' | 'cost';

export function CacheTtlSection({
  ttl,
  overrideForceOneHour = false,
}: {
  ttl: MetricsSummary['cacheTtl'];
  overrideForceOneHour?: boolean;
}): React.ReactElement {
  const [view, setView] = useState<CacheTtlView>('tokens');

  const allDays = Object.keys(ttl.byDayModel).sort();

  // When the override is active, compute the 1h share of cache writes across
  // the current window. If it stays low despite the toggle being on, it's a
  // strong signal that Anthropic's server is enforcing a TTL downgrade on
  // this account tier (see research note in the plan / settings description).
  let totalCreate5m = 0;
  let totalCreate1h = 0;
  for (const models of Object.values(ttl.byDayModel)) {
    for (const row of Object.values(models)) {
      totalCreate5m += row.create5m;
      totalCreate1h += row.create1h;
    }
  }
  const totalWrites = totalCreate5m + totalCreate1h;
  const share1h = totalWrites > 0 ? totalCreate1h / totalWrites : null;
  const showDowngradeHint = overrideForceOneHour && share1h !== null && share1h < 0.1;
  const dailyData = allDays.map((date) => {
    let create5m = 0,
      create1h = 0,
      read = 0;
    let cost5m = 0,
      cost1h = 0,
      costRead = 0;
    for (const row of Object.values(ttl.byDayModel[date] ?? {})) {
      create5m += row.create5m;
      create1h += row.create1h;
      read += row.read;
      cost5m += row.cost5mWrite;
      cost1h += row.cost1hWrite;
      costRead += row.costRead;
    }
    return {
      date: date.slice(5),
      create5m: view === 'tokens' ? create5m : cost5m,
      create1h: view === 'tokens' ? create1h : cost1h,
      read: view === 'tokens' ? read : costRead,
    };
  });

  const fmt =
    view === 'tokens'
      ? (v: number): string => compact(v)
      : (v: number): string => `$${formatCost(v)}`;

  return (
    <div className="glass-card px-4 pt-4 pb-2">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold text-muted">Cache TTL breakdown</p>
        <div className="flex bg-black/[0.06] dark:bg-white/[0.08] rounded-lg p-[2px] gap-[2px]">
          {(['tokens', 'cost'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setView(mode)}
              className={`px-2.5 py-0.5 rounded-md text-[10px] font-semibold transition-all duration-150 ${
                view === mode
                  ? 'bg-white dark:bg-[#3A3A3C] text-black dark:text-white shadow-[0_1px_2px_rgba(0,0,0,0.12)]'
                  : 'text-muted'
              }`}
            >
              {mode === 'tokens' ? 'Tokens' : 'Cost'}
            </button>
          ))}
        </div>
      </div>

      {overrideForceOneHour && share1h !== null && (
        <p className={`text-[10px] mb-2 ${showDowngradeHint ? 'text-ios-orange' : 'text-muted'}`}>
          Override active: {(share1h * 100).toFixed(0)}% of cache writes landed at 1h
          {showDowngradeHint ? ' (server may be enforcing a downgrade on this account)' : ''}
        </p>
      )}

      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={dailyData} barSize={18} margin={{ top: 0, right: 0, bottom: 0, left: -12 }}>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: 'rgb(var(--muted))' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: 'rgb(var(--muted))' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => fmt(v)}
          />
          <Tooltip
            content={<StackedTooltip valueFormatter={fmt} />}
            cursor={{ fill: 'rgba(0,0,0,0.04)' }}
          />
          <Bar
            dataKey="create5m"
            stackId="t"
            fill={CACHE_TTL_COLORS.create5m}
            name="5m cache writes"
          />
          <Bar
            dataKey="create1h"
            stackId="t"
            fill={CACHE_TTL_COLORS.create1h}
            name="1h cache writes"
          />
          <Bar
            dataKey="read"
            stackId="t"
            fill={CACHE_TTL_COLORS.read}
            name="cache reads"
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>

      <div className="flex flex-wrap gap-3 mt-2 mb-1">
        <LegendDot color={CACHE_TTL_COLORS.create5m} label="5-minute writes" />
        <LegendDot color={CACHE_TTL_COLORS.create1h} label="1-hour writes" />
        <LegendDot color={CACHE_TTL_COLORS.read} label="cache reads" />
      </div>

      {ttl.bySession.length > 0 && (
        <CacheTtlSessionTable sessions={ttl.bySession} view={view} fmt={fmt} />
      )}
    </div>
  );
}

function CacheTtlSessionTable({
  sessions,
  view,
  fmt,
}: {
  sessions: CacheTtlSessionRow[];
  view: CacheTtlView;
  fmt: (v: number) => string;
}): React.ReactElement {
  return (
    <div className="mt-3 pt-3 border-t border-black/5 dark:border-white/5">
      <p className="text-[10px] text-muted uppercase tracking-wider mb-2">Recent sessions</p>
      <div className="space-y-1.5">
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 text-[10px] text-muted uppercase tracking-wider pb-1 border-b border-black/5 dark:border-white/5">
          <span>Session</span>
          <span className="text-right">5m</span>
          <span className="text-right">1h</span>
          <span className="text-right">Reads</span>
          <span className="text-right">{view === 'tokens' ? 'Requests' : 'Cost'}</span>
        </div>
        {sessions.map((s) => {
          const write5m = view === 'tokens' ? s.create5m : s.cost5mWrite;
          const write1h = view === 'tokens' ? s.create1h : s.cost1hWrite;
          const reads = view === 'tokens' ? s.read : s.costRead;
          const rightCol =
            view === 'tokens'
              ? String(s.requestCount)
              : `$${formatCost(s.cost5mWrite + s.cost1hWrite + s.costRead)}`;
          return (
            <div
              key={s.sessionId}
              className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 text-[11px] items-center"
              title={`${s.sessionId} · ${s.model || 'unknown model'}`}
            >
              <span className="font-medium text-black dark:text-white truncate">
                {shortSessionId(s.sessionId)}
                <span className="text-muted font-normal ml-2">{formatRelative(s.lastTs)}</span>
              </span>
              <span className="text-right tabular-nums text-black dark:text-white">
                {fmt(write5m)}
              </span>
              <span className="text-right tabular-nums text-black dark:text-white">
                {fmt(write1h)}
              </span>
              <span className="text-right tabular-nums text-black dark:text-white">
                {fmt(reads)}
              </span>
              <span className="text-right tabular-nums text-muted">{rightCol}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function shortSessionId(id: string): string {
  if (id.length <= 8) return id;
  return id.slice(0, 8);
}

// Re-exported for testing.
export { hasCacheTtlData };

// ─── Utilities ────────────────────────────────────────────────────────────────

function tokenLabel(k: string): string {
  if (k === 'cacheRead') return 'cache read';
  if (k === 'cacheCreate') return 'cache create';
  return k;
}

function compact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(n: number): string {
  if (n === 0) return '0.00';
  if (n < 0.01) return n.toFixed(4);
  return n.toFixed(2);
}

function sumRecord<T>(rec: Record<string, T>, extract: (v: T) => number): number {
  let total = 0;
  for (const v of Object.values(rec)) total += extract(v);
  return total;
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}
