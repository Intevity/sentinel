import React, { useEffect, useState, useCallback } from 'react';
import { Sparkles, CheckCircle2, Trash2 } from 'lucide-react';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

/**
 * Optimize tab — recommends curated subagents based on observed
 * Claude Code session traffic and lets the user install them into
 * `~/.claude/agents/` with one click. v1 ships the install loop and
 * the curated library; the analyzer-driven recommendations land in
 * M3 (handlers currently return an empty list).
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

interface OptimizationMetrics {
  totals: { savingsUsd: number; opportunities: number; installs: number };
  daily: Array<{ day: string; savingsUsd: number }>;
}

export default function OptimizeDashboard(): React.ReactElement {
  const [library, setLibrary] = useState<CuratedEntry[]>([]);
  const [installed, setInstalled] = useState<InstalledRow[]>([]);
  const [metrics, setMetrics] = useState<OptimizationMetrics | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [lib, inst, met] = await Promise.all([
      sendToSentinel<CuratedEntry[]>({ type: 'get_curated_library' }),
      sendToSentinel<InstalledRow[]>({ type: 'list_installed_subagents' }),
      sendToSentinel<OptimizationMetrics>({
        type: 'get_optimization_metrics',
        days: 7,
      }),
    ]);
    if (lib.success) setLibrary(lib.data ?? []);
    if (inst.success) setInstalled(inst.data ?? []);
    if (met.success) setMetrics(met.data ?? null);
  }, []);

  useEffect(() => {
    void refresh();
    const unsubP = onDaemonMessage((msg) => {
      if (
        msg.type === 'subagent_installed' ||
        msg.type === 'subagent_uninstalled' ||
        msg.type === 'agents_sync_status'
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

function SavingsHeader({ metrics }: { metrics: OptimizationMetrics | null }): React.ReactElement {
  const totalSavings = metrics?.totals.savingsUsd ?? 0;
  const installs = metrics?.totals.installs ?? 0;
  return (
    <div className="glass-card flex items-center justify-between px-4 py-3">
      <div>
        <h2 className="text-base font-semibold text-white">Optimize</h2>
        <p className="text-xs text-white/60">
          Reduce token costs by routing routine tasks to cheaper-model subagents.
        </p>
      </div>
      <div className="text-right">
        <div className="text-xs uppercase tracking-wide text-white/60">7-day savings</div>
        <div className="text-lg font-semibold text-emerald-300">${totalSavings.toFixed(2)}</div>
        <div className="text-[11px] text-white/50">
          {installs} subagent{installs === 1 ? '' : 's'} installed
        </div>
      </div>
    </div>
  );
}
