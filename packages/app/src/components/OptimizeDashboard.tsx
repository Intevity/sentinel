import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Sparkles, CheckCircle2, ChevronDown, ChevronRight, Trash2, Bot, Zap } from 'lucide-react';
import { motion } from 'motion/react';
import type {
  OptimizationMetrics,
  OptimizationMetricsBySubagent,
  OptimizeChartView,
  OptimizeRangePreset,
  OptimizeSubTab,
  CompressionMetrics,
  McpContextCosts,
  ProcessedTokens,
  MetricsWindow,
  Settings,
} from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';
import { formatTokens, type SavingsUnits } from '../lib/optimizeUnits.js';
import OpportunityList from './optimize/OpportunityList.js';
import ContextInventoryPanel from './optimize/ContextInventoryPanel.js';
import CompressionPanel from './optimize/CompressionPanel.js';
import ContextPanel from './optimize/ContextPanel.js';
import {
  RealizedChart,
  BySubagentChart,
  ComparisonChart,
  CumulativeChart,
  ByPatternChart,
  CompressionSavingsChart,
  ChartViewSwitcher,
} from './optimize/charts/index.js';

/**
 * Optimize tab — recommends curated subagents based on observed Claude Code
 * session traffic and surfaces in-flight tool_result compression. The header
 * shows two running estimates, each combining both savings sources:
 *
 *   - **Saved**: realized savings = subagent opportunities detected while the
 *     recommended subagent was installed, PLUS tokens removed by compression.
 *   - **Potential**: additional savings = subagent opportunities where it was
 *     NOT installed, PLUS what enabling (or raising) compression would save
 *     (from a dry-run measured on observed tool_results).
 *
 * A per-source breakdown under the totals splits each into subagents vs
 * compression. Subagent figures come from `kind='measured'` analyzer rows;
 * compression figures from the compression stats store. All are estimates.
 *
 * Settings → Optimize houses the kill switch (`optimizeCaptureEnabled`)
 * and the disclosure copy: "Optimize captures file paths and tool call
 * sizes, not contents." Capture is in-proxy and always-on by default.
 */

interface CuratedEntry {
  curatedId: string;
  name: string;
  description: string;
  model: 'haiku' | 'sonnet' | 'opus' | 'inherit';
  tools: string[];
  fingerprint: string;
}

interface InstalledRow {
  id: number;
  name: string;
  source: 'curated' | 'local';
  curatedId: string | null;
  installedAt: number;
  uninstalledAt: number | null;
  mdPath: string;
}

const EMPTY_METRICS: OptimizationMetrics = {
  totals: {
    savingsUsdRealized: 0,
    savingsUsdPotential: 0,
    tokensRealized: 0,
    tokensPotential: 0,
    hypotheticalInputTokens: 0,
    opportunities: 0,
    installs: 0,
  },
  daily: [],
  bySubagent: [],
  dailyBySubagent: [],
  byPattern: [],
};

export default function OptimizeDashboard(): React.ReactElement {
  const [library, setLibrary] = useState<CuratedEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledRow[]>([]);
  const [metrics, setMetrics] = useState<OptimizationMetrics>(EMPTY_METRICS);
  // Compression's realized + potential savings, folded into the header totals.
  // The CompressionPanel below still owns the full per-rule/per-tool breakdown.
  const [comp, setComp] = useState<{
    tokens: number;
    cost: number;
    potTokens: number;
    potCost: number;
    /** Gross input tokens of the tool output compression acted on (est. from
     *  bytesIn) — the compression half of the "% of optimized content" ratio. */
    grossTokens: number;
  }>({ tokens: 0, cost: 0, potTokens: 0, potCost: 0, grossTokens: 0 });
  // Daily breakdown for the "Compression" chart view. Kept separate from
  // `comp` (header totals) so the totals shape doesn't have to carry the
  // whole CompressionMetrics payload.
  const [compDaily, setCompDaily] = useState<CompressionMetrics['daily']>([]);
  // Context (code mode) savings, the third source folded into the header
  // totals. The ContextPanel owns the per-server breakdown.
  const [ctx, setCtx] = useState<{
    tokens: number;
    cost: number;
    potTokens: number;
    potCost: number;
  }>({ tokens: 0, cost: 0, potTokens: 0, potCost: 0 });
  // Total input tokens Sentinel forwarded over the window — denominator for
  // the "saved X of Y input tokens" headline.
  const [processed, setProcessed] = useState<ProcessedTokens>({
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    inputSideTokens: 0,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The units toggle is server-persisted via Settings.optimizeUnits.
  // Default to 'tokens' to match the daemon's default; the first
  // get_settings response may flip it to 'cost' if the user picked it
  // previously. Token savings always render in the parent-context
  // framing — `tokensRealized` on the metrics shape is that single
  // value the daemon computes.
  const [units, setUnits] = useState<SavingsUnits>('tokens');
  // Active sub-tab is server-persisted via Settings.optimizeSubTab so the
  // user's last section survives restarts. Each of the three optimization
  // features owns one tab; the sticky savings bar above them stays global.
  const [subTab, setSubTab] = useState<OptimizeSubTab>('subagents');
  // Chart-view selection is server-persisted via Settings.optimizeChartView.
  // Default 'realized' matches the daemon default and preserves the
  // pre-existing chart for users who don't touch the new switcher.
  const [chartView, setChartView] = useState<OptimizeChartView>('realized');
  // Time-range selection. The preset is server-persisted via
  // Settings.optimizeRange; the custom start/end dates (YYYY-MM-DD) live only
  // in component state since they're meaningful only while 'custom' is active.
  const [range, setRange] = useState<OptimizeRangePreset>('all');
  const [customStart, setCustomStart] = useState<string>('');
  const [customEnd, setCustomEnd] = useState<string>('');

  // One window drives all the metric fetches (including the Compression
  // and Opportunities panes below) so every figure describes the same span.
  // Local-midnight boundaries align with the daemon's local-time day
  // buckets. The bounds are resolved fresh inside refresh() rather than
  // memoized: windowForRange captures `new Date()`, and memoizing it froze
  // 1D at the previous midnight when the app ran overnight (the "Optimize
  // shows yesterday's data" bug). The state copy is equality-guarded so
  // unchanged bounds don't loop renders; child panes refetch when the
  // bounds actually move.
  const [metricsWindow, setMetricsWindow] = useState<MetricsWindow>(() =>
    windowForRange('all', '', ''),
  );

  const refresh = useCallback(async () => {
    const win = windowForRange(range, customStart, customEnd);
    setMetricsWindow((prev) =>
      prev.sinceMs === win.sinceMs && prev.untilMs === win.untilMs ? prev : win,
    );
    const [lib, inst, met, compm, proc, settings, ctxCosts] = await Promise.all([
      sendToSentinel<CuratedEntry[]>({ type: 'get_curated_library' }),
      sendToSentinel<InstalledRow[]>({ type: 'list_installed_subagents' }),
      sendToSentinel<OptimizationMetrics>({
        type: 'get_optimization_metrics',
        days: 0,
        window: win,
      }),
      sendToSentinel<CompressionMetrics>({
        type: 'get_compression_metrics',
        days: 0,
        window: win,
      }),
      sendToSentinel<ProcessedTokens>({ type: 'get_processed_tokens', window: win }),
      sendToSentinel<Settings>({ type: 'get_settings' }),
      sendToSentinel<McpContextCosts>({ type: 'get_mcp_context_costs', window: win }),
    ]);
    if (lib.success) setLibrary(lib.data ?? []);
    if (inst.success) setInstalled(inst.data ?? []);
    if (met.success && met.data) setMetrics(met.data);
    if (compm.success && compm.data) {
      setCompDaily(compm.data.daily);
      // `estTokensPotential` is a historical sum of what raising compression
      // would have saved on past traffic, measured at lower tiers. Aggressive
      // is the top tier: there's no further config change to advertise, so we
      // drop the compression-potential component (the CompressionPanel hint
      // hides on the same condition). New traffic at aggressive already
      // contributes 0 potential; the stale historical rows age out.
      const atMaxTier = settings.success && settings.data?.compressionLevel === 'aggressive';
      setComp({
        tokens: compm.data.totals.estTokensSaved,
        cost: compm.data.totals.estCostSavedUsd,
        potTokens: atMaxTier ? 0 : compm.data.totals.estTokensPotential,
        potCost: atMaxTier ? 0 : compm.data.totals.estCostPotential,
        grossTokens: compm.data.totals.estTokensIn,
      });
    }
    if (proc.success && proc.data) setProcessed(proc.data);
    if (settings.success && settings.data) {
      setUnits(settings.data.optimizeUnits);
      setChartView(settings.data.optimizeChartView);
      setRange(settings.data.optimizeRange);
      setSubTab(settings.data.optimizeSubTab);
    }
    if (ctxCosts.success && ctxCosts.data) {
      setCtx({
        tokens: ctxCosts.data.savings.realized.estTokens,
        cost: ctxCosts.data.savings.realized.estUsd,
        potTokens: ctxCosts.data.savings.potential.estTokens,
        potCost: ctxCosts.data.savings.potential.estUsd,
      });
    }
  }, [range, customStart, customEnd]);

  useEffect(() => {
    void refresh();
    // Reopening the tray window re-resolves the range presets: after a day
    // rollover, 1D must move from yesterday's bounds to today's. Same
    // focus-refetch pattern as AccountSwitcher.
    const onFocus = (): void => void refresh();
    window.addEventListener('focus', onFocus);
    const unsubP = onDaemonMessage((msg) => {
      if (
        msg.type === 'subagent_installed' ||
        msg.type === 'subagent_uninstalled' ||
        msg.type === 'agents_sync_status' ||
        msg.type === 'optimization_metrics_updated' ||
        msg.type === 'compression_metrics_updated' ||
        msg.type === 'mcp_context_costs_updated' ||
        msg.type === 'code_mode_status' ||
        msg.type === 'settings_changed'
      ) {
        void refresh();
      }
    });
    return () => {
      window.removeEventListener('focus', onFocus);
      void unsubP.then((u) => u());
    };
  }, [refresh]);

  const onToggleUnits = useCallback(async (next: SavingsUnits) => {
    // Optimistic update: flip locally first so the UI feels instant,
    // then persist. The settings_changed broadcast loops back to confirm.
    setUnits(next);
    await sendToSentinel({
      type: 'update_settings',
      settings: { optimizeUnits: next },
    });
  }, []);

  const onChangeChartView = useCallback(async (next: OptimizeChartView) => {
    // Same optimistic-then-persist pattern as the units toggle.
    setChartView(next);
    await sendToSentinel({
      type: 'update_settings',
      settings: { optimizeChartView: next },
    });
  }, []);

  const onChangeSubTab = useCallback(async (next: OptimizeSubTab) => {
    // Same optimistic-then-persist pattern as the units toggle.
    setSubTab(next);
    await sendToSentinel({
      type: 'update_settings',
      settings: { optimizeSubTab: next },
    });
  }, []);

  const onChangeRange = useCallback(async (next: OptimizeRangePreset) => {
    // Optimistic: flip locally (recomputes the window and re-fetches), then
    // persist so the choice survives restarts.
    setRange(next);
    await sendToSentinel({
      type: 'update_settings',
      settings: { optimizeRange: next },
    });
  }, []);

  const installedNames = new Set(
    installed.filter((s) => s.uninstalledAt === null).map((s) => s.name),
  );

  // Index per-subagent attribution by curated_id for O(1) lookup as we
  // render each curated list row. The daemon returns these sorted by
  // total impact desc, but we render in `library` order so the curated
  // list stays stable across renders; the badge surfaces the priority.
  const savingsByCuratedId = useMemo(() => {
    const m = new Map<string, OptimizationMetricsBySubagent>();
    for (const s of metrics.bySubagent) m.set(s.curatedId, s);
    return m;
  }, [metrics.bySubagent]);

  const onInstall = async (curatedId: string): Promise<void> => {
    setBusy(curatedId);
    setError(null);
    const r = await sendToSentinel({ type: 'install_curated_subagent', curatedId });
    if (!r.success) setError(r.error ?? 'install failed');
    setBusy(null);
    await refresh();
  };

  const onUninstall = async (name: string): Promise<void> => {
    setBusy(name);
    setError(null);
    const r = await sendToSentinel({ type: 'uninstall_subagent', name });
    if (!r.success) setError(r.error ?? 'uninstall failed');
    setBusy(null);
    await refresh();
  };

  return (
    <div className="space-y-3">
      {/* Sticky savings bar: the "Content reduced" headline stays visible
          while any tab scrolls; click to expand into the full metric tiles
          plus the global units + range controls (one MetricsWindow drives
          every tab). <main> in App.tsx is the scrolling ancestor. */}
      <StickySavingsBar
        metrics={metrics}
        compTokens={comp.tokens}
        compCost={comp.cost}
        compPotTokens={comp.potTokens}
        compPotCost={comp.potCost}
        compGrossTokens={comp.grossTokens}
        ctxTokens={ctx.tokens}
        ctxCost={ctx.cost}
        ctxPotTokens={ctx.potTokens}
        ctxPotCost={ctx.potCost}
        processedInputTokens={processed.inputSideTokens}
        rangeLabel={RANGE_LABELS[range]}
        units={units}
        onToggleUnits={onToggleUnits}
        range={range}
        customStart={customStart}
        customEnd={customEnd}
        onChangeRange={(r) => void onChangeRange(r)}
        onChangeCustomStart={setCustomStart}
        onChangeCustomEnd={setCustomEnd}
      />

      <OptimizeSubTabs value={subTab} onChange={(t) => void onChangeSubTab(t)} />

      {error !== null && (
        <div className="glass-card px-4 py-3 text-sm text-red-700 dark:text-red-300">{error}</div>
      )}

      {subTab === 'compression' && (
        <>
          <CompressionPanel metricsWindow={metricsWindow} />
          <div className="glass-card px-4 py-3">
            <SavingsChartSection
              chartView="compression"
              metrics={metrics}
              compDaily={compDaily}
              units={units}
              allowedViews={['compression']}
            />
          </div>
        </>
      )}

      {subTab === 'context' && (
        <>
          <ContextPanel metricsWindow={metricsWindow} />
          <ContextInventoryPanel hideMcpServers />
        </>
      )}

      {subTab === 'subagents' && (
        <SubagentsSection
          library={library}
          installed={installed}
          installedNames={installedNames}
          savingsByCuratedId={savingsByCuratedId}
          busy={busy}
          units={units}
          metricsWindow={metricsWindow}
          chartView={chartView}
          onChangeChartView={(v) => void onChangeChartView(v)}
          metrics={metrics}
          compDaily={compDaily}
          onInstall={(id) => void onInstall(id)}
          onUninstall={(name) => void onUninstall(name)}
        />
      )}
    </div>
  );
}

/** Segmented sub-tab bar separating the three optimization features.
 *  Mirrors SecurityRulesOverlay's nested tab pattern (motion pill). */
function OptimizeSubTabs({
  value,
  onChange,
}: {
  value: OptimizeSubTab;
  onChange: (next: OptimizeSubTab) => void;
}): React.ReactElement {
  const tabs: Array<{ id: OptimizeSubTab; label: string }> = [
    { id: 'subagents', label: 'Subagents' },
    { id: 'compression', label: 'Compression' },
    { id: 'context', label: 'Context' },
  ];
  return (
    <div role="tablist" aria-label="Optimize features" className="flex gap-1">
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={`relative flex-1 text-[11px] font-semibold px-2 py-1 rounded-full transition-colors ${
              active ? 'text-white' : 'text-muted hover:text-black dark:hover:text-white'
            }`}
          >
            {active && (
              <motion.span
                layoutId="optimize-subtab-pill"
                className="absolute inset-0 bg-ios-blue rounded-full"
                transition={{ type: 'spring', stiffness: 420, damping: 34 }}
              />
            )}
            <span className="relative">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Subagents tab content: curated library, local subagents, opportunity
 *  drill-down, and the subagent chart views. Everything here moved verbatim
 *  from the pre-tab single-page layout. */
function SubagentsSection({
  library,
  installed,
  installedNames,
  savingsByCuratedId,
  busy,
  units,
  metricsWindow,
  chartView,
  onChangeChartView,
  metrics,
  compDaily,
  onInstall,
  onUninstall,
}: {
  library: CuratedEntry[];
  installed: InstalledRow[];
  installedNames: Set<string>;
  savingsByCuratedId: Map<string, OptimizationMetricsBySubagent>;
  busy: string | null;
  units: SavingsUnits;
  metricsWindow: MetricsWindow;
  chartView: OptimizeChartView;
  onChangeChartView: (next: OptimizeChartView) => void;
  metrics: OptimizationMetrics;
  compDaily: CompressionMetrics['daily'];
  onInstall: (curatedId: string) => void;
  onUninstall: (name: string) => void;
}): React.ReactElement {
  // The persisted view may be 'compression' (it lives on the Compression
  // tab now); fall back to the default subagent view here.
  const subagentViews: OptimizeChartView[] = [
    'realized',
    'bySubagent',
    'comparison',
    'cumulative',
    'byPattern',
  ];
  const effectiveView = subagentViews.includes(chartView) ? chartView : 'realized';
  return (
    <>
      <div className="glass-card px-4 py-3">
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Sparkles className="h-3.5 w-3.5" /> Curated subagents
        </h3>
        <p className="mb-3 text-xs text-foreground/60">
          Sentinel ships these. Installing one writes a file to{' '}
          <code className="text-foreground/80">~/.claude/agents/</code> that Claude Code uses on its
          next session. Routing happens through Claude Code's own subagent system; we never reroute
          traffic silently.
        </p>
        <ul className="space-y-2">
          {library.map((entry) => {
            const isInstalled = installedNames.has(entry.curatedId);
            const isBusy = busy === entry.curatedId;
            const subSavings = savingsByCuratedId.get(entry.curatedId);
            return (
              <li
                key={entry.curatedId}
                className="flex items-start justify-between rounded-md border border-border-subtle/10 px-3 py-2"
              >
                <div className="min-w-0 flex-1 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{entry.name}</span>
                    <span className="rounded bg-surface-overlay/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-foreground/70">
                      {entry.model}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-foreground/60">{entry.description}</p>
                  <SubagentSavingsBadge
                    installed={isInstalled}
                    subSavings={subSavings}
                    units={units}
                  />
                </div>
                {isInstalled ? (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onUninstall(entry.curatedId)}
                    className="flex shrink-0 items-center gap-1 rounded border border-border-subtle/15 px-2 py-1 text-xs text-foreground/70 hover:bg-surface-overlay/5"
                  >
                    <Trash2 className="h-3 w-3" /> Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onInstall(entry.curatedId)}
                    className="flex shrink-0 items-center gap-1 rounded bg-surface-overlay/15 px-2 py-1 text-xs text-foreground hover:bg-surface-overlay/25"
                  >
                    <Sparkles className="h-3 w-3" /> Install
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {installed.filter((s) => s.source === 'local' && s.uninstalledAt === null).length > 0 && (
        <div className="glass-card px-4 py-3">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Bot className="h-3.5 w-3.5" /> Your local subagents
          </h3>
          <p className="mb-2 text-xs text-foreground/60">
            Subagents you authored in <code className="text-foreground/80">~/.claude/agents/</code>.
            Sentinel discovers these but does not modify them.
          </p>
          <ul className="space-y-1">
            {installed
              .filter((s) => s.source === 'local' && s.uninstalledAt === null)
              .map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 rounded-md border border-border-subtle/10 px-3 py-1.5 text-sm text-foreground/80"
                >
                  <CheckCircle2 className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  {s.name}
                </li>
              ))}
          </ul>
        </div>
      )}

      <OpportunityList units={units} metricsWindow={metricsWindow} />

      <div className="glass-card px-4 py-3">
        <SavingsChartSection
          chartView={effectiveView}
          onChangeChartView={onChangeChartView}
          metrics={metrics}
          compDaily={compDaily}
          units={units}
          allowedViews={subagentViews}
        />
      </div>
    </>
  );
}

function formatUsd(n: number): string {
  // Always show 2 decimals; preserve sign so negative values read as such.
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

/** Color a savings value: emerald when positive, red when negative,
 *  neutral when zero. Tailwind classes only. */
function colorClass(n: number): string {
  if (n > 0) return 'text-emerald-700 dark:text-emerald-300';
  if (n < 0) return 'text-red-600 dark:text-red-400';
  return 'text-foreground/70';
}

/** Human phrase for each range preset, used in header subtext after verbs like
 *  "processed" / "measured". */
const RANGE_LABELS: Record<OptimizeRangePreset, string> = {
  '1d': 'today',
  '1w': 'in the last 7 days',
  '1m': 'in the last month',
  '3m': 'in the last 3 months',
  '6m': 'in the last 6 months',
  '1y': 'in the last year',
  all: 'all-time',
  custom: 'in the selected range',
};

const RANGE_OPTIONS: Array<{ value: OptimizeRangePreset; label: string }> = [
  { value: '1d', label: '1D' },
  { value: '1w', label: '1W' },
  { value: '1m', label: '1M' },
  { value: '3m', label: '3M' },
  { value: '6m', label: '6M' },
  { value: '1y', label: '1Y' },
  { value: 'all', label: 'All' },
  { value: 'custom', label: 'Custom' },
];

/** Local midnight (ms) for the day containing `d`. Aligns client-computed
 *  window bounds with the daemon's local-time day buckets. */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Map a range preset (+ optional custom dates) to an absolute window. Presets
 *  are anchored on local-midnight boundaries; `custom` uses the picked dates
 *  with an end-inclusive upper bound (start of the day after `customEnd`). */
function windowForRange(
  range: OptimizeRangePreset,
  customStart: string,
  customEnd: string,
): MetricsWindow {
  const now = new Date();
  const today0 = startOfLocalDay(now);
  const DAY = 86_400_000;
  switch (range) {
    case '1d':
      return { sinceMs: today0 };
    case '1w':
      return { sinceMs: today0 - 6 * DAY };
    case '1m':
      return {
        sinceMs: startOfLocalDay(new Date(now.getFullYear(), now.getMonth() - 1, now.getDate())),
      };
    case '3m':
      return {
        sinceMs: startOfLocalDay(new Date(now.getFullYear(), now.getMonth() - 3, now.getDate())),
      };
    case '6m':
      return {
        sinceMs: startOfLocalDay(new Date(now.getFullYear(), now.getMonth() - 6, now.getDate())),
      };
    case '1y':
      return {
        sinceMs: startOfLocalDay(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())),
      };
    case 'custom': {
      const win: MetricsWindow = {};
      if (customStart) win.sinceMs = startOfLocalDay(new Date(`${customStart}T00:00:00`));
      if (customEnd) win.untilMs = startOfLocalDay(new Date(`${customEnd}T00:00:00`)) + DAY;
      return win;
    }
    case 'all':
    default:
      return {};
  }
}

function RangeSelector({
  range,
  customStart,
  customEnd,
  onChangeRange,
  onChangeCustomStart,
  onChangeCustomEnd,
}: {
  range: OptimizeRangePreset;
  customStart: string;
  customEnd: string;
  onChangeRange: (next: OptimizeRangePreset) => void;
  onChangeCustomStart: (next: string) => void;
  onChangeCustomEnd: (next: string) => void;
}): React.ReactElement {
  // Two layout modes share the row's full width:
  //   - Preset active: the segmented group stretches edge to edge and every
  //     button gets an equal share (flex-1), so nothing looks scrunched left.
  //   - Custom active: the group collapses to its natural width (tighter
  //     button padding) and the two date inputs flex into the freed space.
  // flex-wrap stays as the safety net: if a platform's native date inputs
  // are too wide to share the row (e.g. Windows), they wrap to their own
  // line instead of overflowing.
  const customActive = range === 'custom';
  return (
    <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1.5">
      <div
        className={`flex min-w-0 rounded border border-border-subtle/10 p-0.5 text-[10px] uppercase tracking-wide ${
          customActive ? '' : 'flex-1'
        }`}
        role="group"
        aria-label="Time range"
      >
        {RANGE_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={range === o.value}
            onClick={() => onChangeRange(o.value)}
            className={`rounded py-0.5 text-center transition-colors ${
              customActive ? 'px-1.5' : 'flex-1 px-2'
            } ${
              range === o.value
                ? 'bg-surface-overlay/15 text-foreground'
                : 'text-foreground/55 hover:text-foreground/85'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {customActive && (
        <div className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-foreground/60">
          <input
            type="date"
            value={customStart}
            max={customEnd || undefined}
            onChange={(e) => onChangeCustomStart(e.target.value)}
            aria-label="Start date"
            className="min-w-0 flex-1 rounded border border-border-subtle/15 bg-transparent px-1 py-0.5 text-foreground"
          />
          <span className="shrink-0">to</span>
          <input
            type="date"
            value={customEnd}
            min={customStart || undefined}
            onChange={(e) => onChangeCustomEnd(e.target.value)}
            aria-label="End date"
            className="min-w-0 flex-1 rounded border border-border-subtle/15 bg-transparent px-1 py-0.5 text-foreground"
          />
        </div>
      )}
    </div>
  );
}

function StickySavingsBar({
  metrics,
  compTokens,
  compCost,
  compPotTokens,
  compPotCost,
  compGrossTokens,
  ctxTokens,
  ctxCost,
  ctxPotTokens,
  ctxPotCost,
  processedInputTokens,
  rangeLabel,
  units,
  onToggleUnits,
  range,
  customStart,
  customEnd,
  onChangeRange,
  onChangeCustomStart,
  onChangeCustomEnd,
}: {
  metrics: OptimizationMetrics;
  /** Compression's realized estimated tokens saved (folded into the total). */
  compTokens: number;
  /** Compression's realized estimated USD saved. */
  compCost: number;
  /** Compression's potential tokens (what enabling/raising it would save). */
  compPotTokens: number;
  /** Compression's potential USD. */
  compPotCost: number;
  /** Gross input tokens of the tool output compression acted on (est. from
   *  bytesIn) — compression half of the "% of optimized content" denominator. */
  compGrossTokens: number;
  /** Context (code mode): definition tokens kept out of requests since
   *  bridging (realized, folded into the total). */
  ctxTokens: number;
  /** Context realized estimated USD (cached rates). */
  ctxCost: number;
  /** Context potential tokens (bridging the recommended servers). */
  ctxPotTokens: number;
  /** Context potential USD. */
  ctxPotCost: number;
  /** Total input-side tokens Sentinel forwarded over the window — the broad
   *  denominator for the savings percentage. */
  processedInputTokens: number;
  /** Human label for the selected range (e.g. "last 7 days"), used in subtext. */
  rangeLabel: string;
  units: SavingsUnits;
  onToggleUnits: (next: SavingsUnits) => void;
  range: OptimizeRangePreset;
  customStart: string;
  customEnd: string;
  onChangeRange: (next: OptimizeRangePreset) => void;
  onChangeCustomStart: (next: string) => void;
  onChangeCustomEnd: (next: string) => void;
}): React.ReactElement {
  // Collapsed by default: the hero number at a glance. Ephemeral component
  // state (like SavingsChartSection's open flag): re-collapses on remount.
  const [open, setOpen] = useState(false);
  // True while the bar is pinned by position:sticky. Drives the visual
  // separation (bottom hairline + lifted shadow) that distinguishes the
  // sticky chrome from content scrolling beneath it. Detected via a 1px
  // sentinel at the bar's natural position: the instant the bar pins, the
  // sentinel scrolls out of <main>'s clipped viewport and stops
  // intersecting. IntersectionObserver clips by overflow ancestors, so the
  // default (viewport) root works.
  const [stuck, setStuck] = useState(false);
  const stuckSentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = stuckSentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) =>
      setStuck(entry ? !entry.isIntersecting : false),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const subTokens = metrics.totals.tokensRealized;
  const subCost = metrics.totals.savingsUsdRealized;
  const subPotTokens = metrics.totals.tokensPotential;
  const subPotCost = metrics.totals.savingsUsdPotential;
  // The totals combine all three sources. Subagent, compression, and context
  // (code mode) savings are all input-token reductions (and all estimates),
  // so summing is meaningful; context dollars use cached rates since
  // definitions ride as cache reads.
  const savedTokens = subTokens + compTokens + ctxTokens;
  const savedCost = subCost + compCost + ctxCost;
  const potentialTokens = subPotTokens + compPotTokens + ctxPotTokens;
  const potentialCost = subPotCost + compPotCost + ctxPotCost;
  const installs = metrics.totals.installs;
  const opportunities = metrics.totals.opportunities;
  const disp = (cost: number, tokens: number): string =>
    units === 'cost' ? formatUsd(cost) : formatTokens(tokens);

  // HEADLINE (compression-ratio, comparable to tool-compression benchmarks):
  // how much smaller Sentinel makes the content it actually optimizes — tokens
  // removed over that content's ORIGINAL size (compressed tool output +
  // subagent-absorbed reads). Independent of prompt caching: it measures the
  // optimized content itself, not its share of the request.
  // Context's slice of the denominator is its realized tokens themselves:
  // removed definitions are a 100% reduction of their original size.
  const optimizedDenom = compGrossTokens + metrics.totals.hypotheticalInputTokens + ctxTokens;
  const optimizedPct = optimizedDenom > 0 ? (savedTokens / optimizedDenom) * 100 : 0;
  // SECONDARY (total-bill): saved as a share of ALL input tokens forwarded over
  // the window (input + cache reads + cache writes). Honest but small and
  // cache-dominated — most input is cached context Sentinel doesn't compress —
  // so it lives in the footnote, not the headline.
  const totalInput = savedTokens + processedInputTokens;
  const totalInputPct = totalInput > 0 ? (savedTokens / totalInput) * 100 : 0;
  const pctStr = (n: number): string => `${n.toFixed(n >= 10 || n === 0 ? 0 : 1)}%`;
  const heroPct = optimizedDenom > 0 ? pctStr(optimizedPct) : '—';
  const srcSaved = `subagents ${disp(subCost, subTokens)} · compression ${disp(compCost, compTokens)} · context ${disp(ctxCost, ctxTokens)}`;
  const srcPotential = `subagents ${disp(subPotCost, subPotTokens)} · compression ${disp(compPotCost, compPotTokens)} · context ${disp(ctxPotCost, ctxPotTokens)}`;
  // `sticky` works because <main> (App.tsx) is the overflow-y-scroll
  // ancestor; the bar pins to its top while tab content scrolls beneath. The
  // range selector renders in BOTH states so the window can be changed at any
  // time without expanding; collapsed surfaces two glance metrics (Content
  // reduced + Saved) so the headline numbers stay visible at a glance.
  return (
    <>
      {/* 1px sentinel at the bar's natural position (net-zero layout via the
          negative margin); see the `stuck` state above. */}
      <div ref={stuckSentinelRef} aria-hidden="true" className="-mb-px h-px" />
      {/* Sticky wrapper — transparent except for a page-colored strip masking
          ONLY the top corner radius (h-4 = the card's rounded-2xl radius).
          Content scrolling beneath can never poke through the TOP corner
          notches (which made them read as squared), but stays visible sliding
          under the card's bottom rounded corners — the card floats over it.
          Separation while stuck comes from the lifted drop shadow alone; no
          hairline (a straight edge-to-edge line fights the rounded corners).
          The card is `relative` so it paints above the mask; `!mt-0` keeps the
          parent's space-y-3 from inserting a gap now that the sentinel is the
          preceding sibling. Mask colors match the page bg OverlayPanel uses
          for its sticky chrome. */}
      <div className="sticky top-0 z-10 !mt-0">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-4 bg-[#F2F2F7] dark:bg-[#111111]"
        />
        <div
          className={`glass-card relative px-4 py-2.5 transition-shadow duration-200 ${
            stuck ? 'shadow-sticky dark:shadow-sticky-dark' : ''
          }`}
        >
          {open ? (
            <div className="flex items-start justify-between gap-4">
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-expanded={true}
                className="min-w-0 text-left"
                title="Collapse to the thin bar"
              >
                <h2 className="flex items-center gap-1.5 text-base font-semibold text-foreground">
                  <Zap className="h-4 w-4" /> Optimize
                  <ChevronDown className="h-3.5 w-3.5 text-foreground/55" />
                </h2>
                <p className="mt-0.5 text-xs text-foreground/60">
                  Cut token costs by routing routine work to cheaper-model subagents, compressing
                  tool output in flight, and moving MCP tool definitions out of context.
                </p>
              </button>
              <UnitsToggle units={units} onChange={onToggleUnits} />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-expanded={false}
              className="flex w-full items-center gap-2 text-left"
              title="Expand for the full savings breakdown"
            >
              <Zap className="h-4 w-4 shrink-0 text-foreground" />
              <span className="text-sm font-semibold text-foreground">Optimize</span>
              <span className="ml-auto flex items-center gap-2.5">
                <GlanceStat
                  label="Content reduced"
                  value={heroPct}
                  valueClass={colorClass(savedTokens)}
                  title="How much smaller Sentinel makes the content it optimizes: tokens removed over that content's original size."
                />
                <span className="h-3.5 w-px bg-border-subtle/15" aria-hidden="true" />
                <GlanceStat
                  label="Saved"
                  value={disp(savedCost, savedTokens)}
                  valueClass={colorClass(savedTokens)}
                  title={srcSaved}
                />
              </span>
              <ChevronRight className="ml-1 h-3.5 w-3.5 shrink-0 text-foreground/55" />
            </button>
          )}

          {open && (
            <>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {/* Hero: how much smaller Sentinel made the content it optimized (a
                compression ratio; cache-independent). */}
                <div
                  className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5"
                  title="How much smaller Sentinel makes the content it optimizes: tokens removed from compressed tool output plus subagent-absorbed reads, over that content's original size. This is a compression ratio (comparable to tool-compression benchmarks) and is independent of prompt caching."
                >
                  <div className="text-[10px] uppercase tracking-wide text-foreground/55">
                    Content reduced
                  </div>
                  <div
                    className={`mt-0.5 text-3xl font-semibold tabular-nums ${colorClass(savedTokens)}`}
                  >
                    {heroPct}
                  </div>
                  <div className="mt-0.5 text-[11px] text-foreground/55">
                    {optimizedDenom > 0
                      ? `${formatTokens(savedTokens)} of ${formatTokens(optimizedDenom)}`
                      : `no compressible content ${rangeLabel}`}
                  </div>
                </div>

                {/* Saved (absolute). Per-source split lives in the tooltip. */}
                <div
                  className="rounded-lg border border-border-subtle/10 px-3 py-2.5"
                  title={srcSaved}
                >
                  <div className="text-[10px] uppercase tracking-wide text-foreground/55">
                    Saved
                  </div>
                  <div
                    className={`mt-0.5 text-2xl font-semibold tabular-nums ${colorClass(savedTokens)}`}
                  >
                    {disp(savedCost, savedTokens)}
                  </div>
                  <div className="mt-0.5 text-[11px] text-foreground/45">realized {rangeLabel}</div>
                </div>

                {/* Potential (absolute). Per-source split lives in the tooltip. */}
                <div
                  className="rounded-lg border border-border-subtle/10 px-3 py-2.5"
                  title={srcPotential}
                >
                  <div className="text-[10px] uppercase tracking-wide text-foreground/55">
                    Potential
                  </div>
                  <div className="mt-0.5 text-2xl font-semibold tabular-nums text-sky-700 dark:text-sky-300">
                    {disp(potentialCost, potentialTokens)}
                  </div>
                  <div className="mt-0.5 text-[11px] text-foreground/45">additional, available</div>
                </div>
              </div>

              <p className="mt-2 text-[11px] text-foreground/45">
                {totalInput > 0 && (
                  <>
                    <span title="Saved as a share of ALL input tokens forwarded over the window, including cached context (cache reads) that Sentinel does not compress. Much smaller than the compression ratio because compressible tool output is only a slice of total input.">
                      ≈{pctStr(totalInputPct)} of total input incl. cached context
                    </span>
                    {' · '}
                  </>
                )}
                {installs} subagent{installs === 1 ? '' : 's'} installed
                {' · '}
                {opportunities} opportunit{opportunities === 1 ? 'y' : 'ies'} {rangeLabel}
              </p>
            </>
          )}

          {/* Range selector — always visible (collapsed or expanded) so the window
          is changeable at any time. */}
          <div className="mt-2.5 border-t border-border-subtle/10 pt-2.5">
            <RangeSelector
              range={range}
              customStart={customStart}
              customEnd={customEnd}
              onChangeRange={onChangeRange}
              onChangeCustomStart={onChangeCustomStart}
              onChangeCustomEnd={onChangeCustomEnd}
            />
          </div>
        </div>
      </div>
    </>
  );
}

/** Compact label+value stat for the collapsed sticky bar. Inline baseline so
 *  the bar stays thin; mirrors the expanded tiles' label styling. */
function GlanceStat({
  label,
  value,
  valueClass,
  title,
}: {
  label: string;
  value: string;
  valueClass: string;
  title?: string;
}): React.ReactElement {
  return (
    <span className="flex items-baseline gap-1.5" title={title}>
      <span className="text-[10px] uppercase tracking-wide text-foreground/55">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${valueClass}`}>{value}</span>
    </span>
  );
}

/** Section-header titles for the collapsible chart area inside the
 *  Optimize pane. Tracks the active view so the collapsed row still says
 *  what it hides; mirrors each chart's own ChartFrame title. */
const CHART_VIEW_TITLES: Record<OptimizeChartView, string> = {
  realized: 'Daily savings',
  bySubagent: 'Daily savings by subagent',
  comparison: 'Subagent comparison',
  cumulative: 'Cumulative savings',
  byPattern: 'Detection patterns by frequency',
  compression: 'Compression savings',
};

/** Collapsible chart area at the bottom of a feature tab: view switcher +
 *  the active chart, rendered embedded (the charts skip their own card +
 *  title since this header carries it). Open by default; collapse state is
 *  local, matching OpportunityList. `allowedViews` scopes the switcher to
 *  the tab's own views; a single-view tab (Compression) hides the switcher
 *  entirely. */
function SavingsChartSection({
  chartView,
  onChangeChartView,
  metrics,
  compDaily,
  units,
  allowedViews,
}: {
  chartView: OptimizeChartView;
  /** Omitted when the tab pins a single view (no switcher rendered). */
  onChangeChartView?: (next: OptimizeChartView) => void;
  metrics: OptimizationMetrics;
  compDaily: CompressionMetrics['daily'];
  units: SavingsUnits;
  allowedViews: OptimizeChartView[];
}): React.ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <div className="border-t border-border-subtle/10 pt-2 first:border-t-0 first:pt-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 py-1 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-foreground/55" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-foreground/55" />
        )}
        <span className="text-[11px] font-semibold text-muted">{CHART_VIEW_TITLES[chartView]}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-2">
          {onChangeChartView && allowedViews.length > 1 && (
            <div className="flex justify-start">
              <ChartViewSwitcher
                value={chartView}
                onChange={onChangeChartView}
                views={allowedViews}
              />
            </div>
          )}
          {renderChart(chartView, metrics, compDaily, units)}
        </div>
      )}
    </div>
  );
}

function UnitsToggle({
  units,
  onChange,
}: {
  units: SavingsUnits;
  onChange: (next: SavingsUnits) => void;
}): React.ReactElement {
  return (
    <div
      className="flex rounded border border-border-subtle/10 p-0.5 text-[10px] uppercase tracking-wide"
      role="group"
      aria-label="Display units"
    >
      <button
        type="button"
        aria-pressed={units === 'tokens'}
        onClick={() => onChange('tokens')}
        className={`rounded px-2 py-0.5 ${units === 'tokens' ? 'bg-surface-overlay/15 text-foreground' : 'text-foreground/55 hover:text-foreground/85'}`}
      >
        Tokens
      </button>
      <button
        type="button"
        aria-pressed={units === 'cost'}
        onClick={() => onChange('cost')}
        className={`rounded px-2 py-0.5 ${units === 'cost' ? 'bg-surface-overlay/15 text-foreground' : 'text-foreground/55 hover:text-foreground/85'}`}
      >
        Cost
      </button>
    </div>
  );
}

/**
 * Per-row attribution under a curated subagent's description. Tells the
 * user *which* dollar of "Potential" in the header maps to *which*
 * uninstalled subagent, so they can see e.g. "log-analyzer is leaving
 * $4.20 on the table" right next to the Install button.
 *
 * Render rules:
 *   - Installed and `opportunities > 0`: "Saved $X.XX" — color follows
 *     `colorClass()` so a misfit subagent (negative realized) reads in red.
 *     That's the honest signal; hiding it would mask a bad install.
 *   - Not installed and `savingsPotential > 0`: "Could save $X.XX" — only
 *     positive, since negative potential is nonsensical to advertise as
 *     a reason to install.
 *   - All other cases (no data, no opportunities, zero/negative potential
 *     for an uninstalled row): render nothing. Avoids visual noise on
 *     fresh users and on subagents like `output-formatter` that have no
 *     detection heuristic.
 */
function SubagentSavingsBadge({
  installed,
  subSavings,
  units,
}: {
  installed: boolean;
  subSavings: OptimizationMetricsBySubagent | undefined;
  units: SavingsUnits;
}): React.ReactElement | null {
  if (!subSavings) return null;
  const realized = units === 'cost' ? subSavings.savingsRealized : subSavings.tokensRealized;
  const potential = units === 'cost' ? subSavings.savingsPotential : subSavings.tokensPotential;
  const fmt = units === 'cost' ? formatUsd : formatTokens;
  if (installed) {
    if (subSavings.opportunities <= 0) return null;
    return (
      <p
        className={`mt-1 text-[11px] ${colorClass(realized)}`}
        title="Estimated savings from opportunities the analyzer attributed to this subagent while it was installed."
      >
        Saved {fmt(realized)}
      </p>
    );
  }
  if (potential <= 0) return null;
  return (
    <p
      className="mt-1 text-[11px] text-sky-700 dark:text-sky-300"
      title="Estimated savings the analyzer detected for this subagent's pattern, while it was not installed. Install to start realizing them."
    >
      Could save {fmt(potential)}
      <span className="ml-1 text-[10px] text-foreground/45">
        based on {subSavings.opportunities} opportunit
        {subSavings.opportunities === 1 ? 'y' : 'ies'}
      </span>
    </p>
  );
}

function renderChart(
  view: OptimizeChartView,
  metrics: OptimizationMetrics,
  compDaily: CompressionMetrics['daily'],
  units: SavingsUnits,
): React.ReactElement {
  switch (view) {
    case 'bySubagent':
      return <BySubagentChart dailyBySubagent={metrics.dailyBySubagent} units={units} embedded />;
    case 'comparison':
      return <ComparisonChart bySubagent={metrics.bySubagent} units={units} embedded />;
    case 'cumulative':
      return <CumulativeChart daily={metrics.daily} units={units} embedded />;
    case 'byPattern':
      return <ByPatternChart byPattern={metrics.byPattern} units={units} embedded />;
    case 'compression':
      return <CompressionSavingsChart daily={compDaily} units={units} embedded />;
    case 'realized':
    default:
      return <RealizedChart daily={metrics.daily} units={units} embedded />;
  }
}
