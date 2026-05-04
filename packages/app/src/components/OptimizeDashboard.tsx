import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Sparkles, CheckCircle2, Trash2 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { OptimizationMetrics, OptimizationMetricsBySubagent } from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

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
    opportunities: 0,
    installs: 0,
  },
  daily: [],
  bySubagent: [],
};

export default function OptimizeDashboard(): React.ReactElement {
  const [library, setLibrary] = useState<CuratedEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledRow[]>([]);
  const [metrics, setMetrics] = useState<OptimizationMetrics>(EMPTY_METRICS);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [lib, inst, met] = await Promise.all([
      sendToSentinel<CuratedEntry[]>({ type: 'get_curated_library' }),
      sendToSentinel<InstalledRow[]>({ type: 'list_installed_subagents' }),
      sendToSentinel<OptimizationMetrics>({ type: 'get_optimization_metrics', days: 0 }),
    ]);
    if (lib.success) setLibrary(lib.data ?? []);
    if (inst.success) setInstalled(inst.data ?? []);
    if (met.success && met.data) setMetrics(met.data);
  }, []);

  useEffect(() => {
    void refresh();
    const unsubP = onDaemonMessage((msg) => {
      if (
        msg.type === 'subagent_installed' ||
        msg.type === 'subagent_uninstalled' ||
        msg.type === 'agents_sync_status' ||
        msg.type === 'optimization_metrics_updated'
      ) {
        void refresh();
      }
    });
    return () => {
      void unsubP.then((u) => u());
    };
  }, [refresh]);

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
      <SavingsHeader metrics={metrics} />
      <SavingsChart daily={metrics.daily} />

      {error !== null && <div className="glass-card px-4 py-3 text-sm text-red-300">{error}</div>}

      <div className="glass-card px-4 py-3">
        <h3 className="section-label mb-2">Curated subagents</h3>
        <p className="mb-3 text-xs text-white/60">
          Sentinel ships these. Installing one writes a file to{' '}
          <code className="text-white/80">~/.claude/agents/</code> that Claude Code uses on its next
          session. Routing happens through Claude Code's own subagent system; we never reroute
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
                className="flex items-start justify-between rounded-md border border-white/10 px-3 py-2"
              >
                <div className="min-w-0 flex-1 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white">{entry.name}</span>
                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-white/70">
                      {entry.model}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-white/60">{entry.description}</p>
                  <SubagentSavingsBadge installed={isInstalled} subSavings={subSavings} />
                </div>
                {isInstalled ? (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void onUninstall(entry.curatedId)}
                    className="flex shrink-0 items-center gap-1 rounded border border-white/15 px-2 py-1 text-xs text-white/70 hover:bg-white/5"
                  >
                    <Trash2 className="h-3 w-3" /> Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void onInstall(entry.curatedId)}
                    className="flex shrink-0 items-center gap-1 rounded bg-white/15 px-2 py-1 text-xs text-white hover:bg-white/25"
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
          <p className="mb-2 text-xs text-white/60">
            Subagents you authored in <code className="text-white/80">~/.claude/agents/</code>.
            Sentinel discovers these but does not modify them.
          </p>
          <ul className="space-y-1">
            {installed
              .filter((s) => s.source === 'local' && s.uninstalledAt === null)
              .map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 rounded-md border border-white/10 px-3 py-1.5 text-sm text-white/80"
                >
                  <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                  {s.name}
                </li>
              ))}
          </ul>
        </div>
      )}
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
  if (n > 0) return 'text-emerald-300';
  if (n < 0) return 'text-red-400';
  return 'text-white/70';
}

function SavingsHeader({ metrics }: { metrics: OptimizationMetrics }): React.ReactElement {
  const realized = metrics.totals.savingsUsdRealized;
  const potential = metrics.totals.savingsUsdPotential;
  const installs = metrics.totals.installs;
  const opportunities = metrics.totals.opportunities;
  return (
    <div className="glass-card px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-white">Optimize</h2>
          <p className="text-xs text-white/60">
            Reduce token costs by routing routine tasks to cheaper-model subagents.
            {opportunities > 0 &&
              ' Each item below shows its share of potential savings; install to convert it into realized.'}
          </p>
          <p className="mt-1 text-[11px] text-white/45">
            {installs} subagent{installs === 1 ? '' : 's'} installed
            {' · '}
            {opportunities} opportunit{opportunities === 1 ? 'y' : 'ies'} measured all-time
          </p>
        </div>
        <div className="flex shrink-0 gap-4 text-right">
          <SavingsStat label="Realized" value={realized} />
          <SavingsStat label="Potential" value={potential} />
        </div>
      </div>
    </div>
  );
}

function SavingsStat({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-white/55">{label}</div>
      <div
        className={`text-lg font-semibold tabular-nums ${colorClass(value)}`}
        title={`Estimated. ${
          label === 'Realized'
            ? 'From sessions where the recommended subagent was installed at detection time.'
            : 'From sessions where the recommended subagent was NOT installed.'
        }`}
      >
        {formatUsd(value)}
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
}: {
  installed: boolean;
  subSavings: OptimizationMetricsBySubagent | undefined;
}): React.ReactElement | null {
  if (!subSavings) return null;
  if (installed) {
    if (subSavings.opportunities <= 0) return null;
    return (
      <p
        className={`mt-1 text-[11px] ${colorClass(subSavings.savingsRealized)}`}
        title="Estimated savings from opportunities the analyzer attributed to this subagent while it was installed."
      >
        Saved {formatUsd(subSavings.savingsRealized)}
      </p>
    );
  }
  if (subSavings.savingsPotential <= 0) return null;
  return (
    <p
      className="mt-1 text-[11px] text-sky-300"
      title="Estimated savings the analyzer detected for this subagent's pattern, while it was not installed. Install to start realizing them."
    >
      Could save {formatUsd(subSavings.savingsPotential)}
      <span className="ml-1 text-[10px] text-white/45">
        based on {subSavings.opportunities} opportunit
        {subSavings.opportunities === 1 ? 'y' : 'ies'}
      </span>
    </p>
  );
}

function SavingsChart({
  daily,
}: {
  daily: OptimizationMetrics['daily'];
}): React.ReactElement | null {
  if (daily.length === 0) {
    return (
      <div className="glass-card px-4 py-6 text-center text-xs text-white/55">
        Once Sentinel sees enough Claude Code traffic, your daily savings will appear here.
      </div>
    );
  }
  // Recharts wants short YYYY-MM-DD → MM/DD labels for the X-axis.
  const data = daily.map((d) => ({
    day: d.day.slice(5).replace('-', '/'),
    realized: Number(d.savingsRealized.toFixed(2)),
    potential: Number(d.savingsPotential.toFixed(2)),
  }));
  return (
    <div className="glass-card px-4 pt-4 pb-3">
      <p className="mb-3 text-[11px] font-semibold text-[#8E8E93]">Daily savings</p>
      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={data} barSize={14} margin={{ top: 0, right: 0, bottom: 0, left: -12 }}>
          <XAxis
            dataKey="day"
            tick={{ fontSize: 10, fill: '#8E8E93' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#8E8E93' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v: number) => formatUsd(v)}
          />
          <Tooltip
            cursor={{ fill: 'rgba(0,0,0,0.04)' }}
            formatter={(v: number, name: string) => [formatUsd(v), name]}
            labelStyle={{ color: '#8E8E93', fontSize: 11 }}
            contentStyle={{
              background: 'rgba(20,20,20,0.92)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 6,
              fontSize: 11,
            }}
          />
          <Bar
            dataKey="realized"
            name="Realized"
            stackId="savings"
            fill="#34d399"
            radius={[0, 0, 0, 0]}
          />
          <Bar
            dataKey="potential"
            name="Potential"
            stackId="savings"
            fill="#60a5fa"
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-2 flex flex-wrap gap-3">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: '#34d399' }} />
          <span className="text-[10px] text-[#8E8E93]">Realized</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: '#60a5fa' }} />
          <span className="text-[10px] text-[#8E8E93]">Potential</span>
        </div>
      </div>
    </div>
  );
}
