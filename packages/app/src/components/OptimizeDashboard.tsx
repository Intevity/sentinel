import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Sparkles, CheckCircle2, Trash2 } from 'lucide-react';
import type {
  OptimizationMetrics,
  OptimizationMetricsBySubagent,
  OptimizeChartView,
  Settings,
} from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';
import { formatTokens, type SavingsUnits } from '../lib/optimizeUnits.js';
import OpportunityList from './optimize/OpportunityList.js';
import ContextInventoryPanel from './optimize/ContextInventoryPanel.js';
import {
  RealizedChart,
  BySubagentChart,
  ComparisonChart,
  CumulativeChart,
  ByPatternChart,
  ChartViewSwitcher,
} from './optimize/charts/index.js';

/**
 * Optimize tab — recommends curated subagents based on observed
 * Claude Code session traffic and lets the user install them into
 * `~/.claude/agents/` with one click. The header surfaces two running
 * estimates:
 *
 *   - **Realized**: cumulative counterfactual savings from opportunities
 *     detected in sessions where the recommended curated subagent was
 *     installed at detection time.
 *   - **Potential**: cumulative counterfactual savings from opportunities
 *     in sessions where it was NOT installed.
 *
 * Both are derived from `kind='measured'` rows the analyzer writes every
 * 5 minutes regardless of install state, so the user can watch the value
 * accumulate (or go negative when a curated subagent isn't a good fit
 * for their workload).
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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The units toggle is server-persisted via Settings.optimizeUnits.
  // Default to 'tokens' to match the daemon's default; the first
  // get_settings response may flip it to 'cost' if the user picked it
  // previously. Token savings always render in the parent-context
  // framing — `tokensRealized` on the metrics shape is that single
  // value the daemon computes.
  const [units, setUnits] = useState<SavingsUnits>('tokens');
  // Chart-view selection is server-persisted via Settings.optimizeChartView.
  // Default 'realized' matches the daemon default and preserves the
  // pre-existing chart for users who don't touch the new switcher.
  const [chartView, setChartView] = useState<OptimizeChartView>('realized');

  const refresh = useCallback(async () => {
    const [lib, inst, met, settings] = await Promise.all([
      sendToSentinel<CuratedEntry[]>({ type: 'get_curated_library' }),
      sendToSentinel<InstalledRow[]>({ type: 'list_installed_subagents' }),
      sendToSentinel<OptimizationMetrics>({ type: 'get_optimization_metrics', days: 0 }),
      sendToSentinel<Settings>({ type: 'get_settings' }),
    ]);
    if (lib.success) setLibrary(lib.data ?? []);
    if (inst.success) setInstalled(inst.data ?? []);
    if (met.success && met.data) setMetrics(met.data);
    if (settings.success && settings.data) {
      setUnits(settings.data.optimizeUnits);
      setChartView(settings.data.optimizeChartView);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubP = onDaemonMessage((msg) => {
      if (
        msg.type === 'subagent_installed' ||
        msg.type === 'subagent_uninstalled' ||
        msg.type === 'agents_sync_status' ||
        msg.type === 'optimization_metrics_updated' ||
        msg.type === 'settings_changed'
      ) {
        void refresh();
      }
    });
    return () => {
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
      <SavingsHeader metrics={metrics} units={units} onToggleUnits={onToggleUnits} />
      <div className="flex justify-end">
        <ChartViewSwitcher value={chartView} onChange={onChangeChartView} />
      </div>
      {renderChart(chartView, metrics, units)}

      {error !== null && (
        <div className="glass-card px-4 py-3 text-sm text-red-700 dark:text-red-300">{error}</div>
      )}

      <div className="glass-card px-4 py-3">
        <h3 className="section-label mb-2">Curated subagents</h3>
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
                    onClick={() => void onUninstall(entry.curatedId)}
                    className="flex shrink-0 items-center gap-1 rounded border border-border-subtle/15 px-2 py-1 text-xs text-foreground/70 hover:bg-surface-overlay/5"
                  >
                    <Trash2 className="h-3 w-3" /> Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void onInstall(entry.curatedId)}
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
          <h3 className="section-label mb-2">Your local subagents</h3>
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

      <OpportunityList units={units} />
      <ContextInventoryPanel />
    </div>
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

function SavingsHeader({
  metrics,
  units,
  onToggleUnits,
}: {
  metrics: OptimizationMetrics;
  units: SavingsUnits;
  onToggleUnits: (next: SavingsUnits) => void;
}): React.ReactElement {
  const realizedCost = metrics.totals.savingsUsdRealized;
  const potentialCost = metrics.totals.savingsUsdPotential;
  const realizedTokens = metrics.totals.tokensRealized;
  const potentialTokens = metrics.totals.tokensPotential;
  const installs = metrics.totals.installs;
  const opportunities = metrics.totals.opportunities;
  return (
    <div className="glass-card px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">Optimize</h2>
          <p className="text-xs text-foreground/60">
            Reduce token costs by routing routine tasks to cheaper-model subagents.
            {opportunities > 0 &&
              ' Each item below shows its share of potential savings; install to convert it into realized.'}
          </p>
          <p className="mt-1 text-[11px] text-foreground/45">
            {installs} subagent{installs === 1 ? '' : 's'} installed
            {' · '}
            {opportunities} opportunit{opportunities === 1 ? 'y' : 'ies'} measured all-time
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <UnitsToggle units={units} onChange={onToggleUnits} />
          <div className="flex gap-4 text-right">
            <SavingsStat
              label="Realized"
              cost={realizedCost}
              tokens={realizedTokens}
              units={units}
            />
            <SavingsStat
              label="Potential"
              cost={potentialCost}
              tokens={potentialTokens}
              units={units}
            />
          </div>
        </div>
      </div>
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

function SavingsStat({
  label,
  cost,
  tokens,
  units,
}: {
  label: string;
  cost: number;
  tokens: number;
  units: SavingsUnits;
}): React.ReactElement {
  const value = units === 'cost' ? cost : tokens;
  const display = units === 'cost' ? formatUsd(cost) : formatTokens(tokens);
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-foreground/55">{label}</div>
      <div
        className={`text-lg font-semibold tabular-nums ${colorClass(value)}`}
        title={`Estimated. ${
          label === 'Realized'
            ? 'From sessions where the recommended subagent was installed at detection time.'
            : 'From sessions where the recommended subagent was NOT installed.'
        }`}
      >
        {display}
      </div>
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
  units: SavingsUnits,
): React.ReactElement {
  switch (view) {
    case 'bySubagent':
      return <BySubagentChart dailyBySubagent={metrics.dailyBySubagent} units={units} />;
    case 'comparison':
      return <ComparisonChart bySubagent={metrics.bySubagent} units={units} />;
    case 'cumulative':
      return <CumulativeChart daily={metrics.daily} units={units} />;
    case 'byPattern':
      return <ByPatternChart byPattern={metrics.byPattern} units={units} />;
    case 'realized':
    default:
      return <RealizedChart daily={metrics.daily} units={units} />;
  }
}
