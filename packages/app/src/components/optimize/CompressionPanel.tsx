import React, { useEffect, useState, useCallback } from 'react';
import { Wand2, FolderOpen, Globe, Trash2 } from 'lucide-react';
import type {
  CompressionMetrics,
  CompressionLevel,
  McpInstallScope,
  McpInstallRecord,
  MetricsWindow,
  RetrievalMcpStatus,
} from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../../lib/ipc.js';
import { Switch } from '../settings/primitives.js';
import InfoModal from '../InfoModal.js';
import { useSettings } from '../../hooks/useSettings.js';
import { formatTokens } from '../../lib/optimizeUnits.js';
import { formatUsd } from './charts/shared.js';
import { MetricTile } from './MetricTile.js';
import CompressionByToolChart from './charts/CompressionByToolChart.js';
import CompressionRatioChart from './charts/CompressionRatioChart.js';

/**
 * Compression section of the Optimize tab. Surfaces the savings from
 * in-flight tool_result compression (an opt-in proxy feature) and exposes a
 * quick on/off + aggressiveness control that mirrors Settings → Compression.
 *
 * Self-contained: it owns its own metrics fetch and subscribes to the
 * `compression_metrics_updated` broadcast (and `settings_changed`, so the
 * toggle reflects edits made in Settings). Token and cost figures are
 * estimates: the API never reports the counterfactual uncompressed token
 * count, so savings are derived from bytes removed. The cache-health tile is
 * the honest cross-check that the byte savings aren't being lost to cache
 * busting.
 */

const EMPTY_METRICS: CompressionMetrics = {
  totals: {
    bytesIn: 0,
    bytesOut: 0,
    estTokensIn: 0,
    estTokensSaved: 0,
    estCostSavedUsd: 0,
    requestsCompressed: 0,
    requestsSkipped: 0,
    ratio: 0,
    estTokensPotential: 0,
    estCostPotential: 0,
  },
  daily: [],
  byTool: [],
  byRule: [],
  errors: [],
  cacheHealth: { cacheReadTokens: 0, cacheCreateTokens: 0, hitRatio: 1 },
};

const LEVELS: Array<{ value: CompressionLevel; label: string }> = [
  { value: 'conservative', label: 'Conservative' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'aggressive', label: 'Aggressive' },
];

const SKIP_LABELS: Record<string, string> = {
  parse_error: 'Unparseable body',
  oversized: 'Body too large',
  no_tool_results: 'No tool output',
  already_compressed: 'Already minimal',
  no_gain: 'No size gain',
};

const SCOPE_LABELS: Record<McpInstallScope, string> = {
  user: 'All projects',
  local: 'This directory (private)',
  project: 'This directory (shared)',
};

const EMPTY_STATUS: RetrievalMcpStatus = {
  enabled: false,
  toolName: 'mcp__sentinel__retrieve',
  url: '',
  installs: [],
};

/** Last path segment, for a compact install label. */
function dirBasename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

export default function CompressionPanel({
  metricsWindow,
}: {
  /** Window from the page-level range selector; the pane's stats and
   *  charts describe the same span as the Optimize header above it. */
  metricsWindow: MetricsWindow;
}): React.ReactElement {
  const { settings, update } = useSettings();
  const [metrics, setMetrics] = useState<CompressionMetrics>(EMPTY_METRICS);
  const [mcp, setMcp] = useState<RetrievalMcpStatus>(EMPTY_STATUS);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [justInstalled, setJustInstalled] = useState(false);

  const refresh = useCallback(async () => {
    const [m, s] = await Promise.all([
      sendToSentinel<CompressionMetrics>({
        type: 'get_compression_metrics',
        days: 0,
        window: metricsWindow,
      }),
      sendToSentinel<RetrievalMcpStatus>({ type: 'get_retrieval_mcp_status' }),
    ]);
    if (m.success && m.data) setMetrics(m.data);
    if (s.success && s.data) setMcp(s.data);
  }, [metricsWindow]);

  useEffect(() => {
    void refresh();
    const unsubP = onDaemonMessage((msg) => {
      if (msg.type === 'compression_metrics_updated' || msg.type === 'settings_changed') {
        void refresh();
      }
    });
    return () => {
      void unsubP.then((u) => u());
    };
  }, [refresh]);

  const installAt = useCallback(
    async (scope: McpInstallScope, directory?: string) => {
      setMcpBusy(true);
      setMcpError(null);
      const res = await sendToSentinel({
        type: 'install_retrieval_mcp',
        scope,
        ...(directory ? { directory } : {}),
      });
      if (!res.success) setMcpError(res.error ?? 'install failed');
      else setJustInstalled(true);
      setMcpBusy(false);
      await refresh();
    },
    [refresh],
  );

  const pickDirAndInstall = useCallback(
    async (scope: McpInstallScope) => {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        directory: true,
        multiple: false,
        title: 'Choose a project directory',
      });
      if (typeof picked === 'string') await installAt(scope, picked);
    },
    [installAt],
  );

  const uninstall = useCallback(
    async (rec: McpInstallRecord) => {
      setMcpBusy(true);
      setMcpError(null);
      const res = await sendToSentinel({
        type: 'uninstall_retrieval_mcp',
        scope: rec.scope,
        ...(rec.directory ? { directory: rec.directory } : {}),
      });
      if (!res.success) setMcpError(res.error ?? 'uninstall failed');
      setMcpBusy(false);
      await refresh();
    },
    [refresh],
  );

  const setRetrievalEnabled = useCallback(
    (next: boolean) => {
      void update({ compressionRetrievalEnabled: next }).catch(() => undefined);
    },
    [update],
  );

  const enabled = settings?.compressionEnabled ?? false;
  const level = settings?.compressionLevel ?? 'conservative';

  const onToggle = useCallback(
    (next: boolean) => {
      void update({ compressionEnabled: next }).catch(() => undefined);
    },
    [update],
  );
  const onPickLevel = useCallback(
    (next: CompressionLevel) => {
      void update({ compressionLevel: next }).catch(() => undefined);
    },
    [update],
  );

  const t = metrics.totals;
  const removedPct = t.bytesIn > 0 ? Math.round((1 - t.bytesOut / t.bytesIn) * 100) : 0;
  const ch = metrics.cacheHealth;
  const cacheHealthy = ch.cacheCreateTokens === 0 || ch.hitRatio >= 0.7;
  const cachePct = Math.round(ch.hitRatio * 100);

  return (
    <div className="glass-card px-4 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Wand2 className="h-3.5 w-3.5" /> Compression
          </h3>
          <p className="mt-0.5 text-xs text-foreground/60">
            Shrinks tool result text before it reaches Anthropic. Deterministic, so prompt caching
            stays stable. Savings are estimates.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-foreground/55">
            {enabled ? 'On' : 'Off'}
          </span>
          <Switch checked={enabled} onChange={onToggle} label="Enable compression" />
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wide text-foreground/55">
          Aggressiveness
        </span>
        <InfoModal title="Compression levels" ariaLabel="What do the compression levels mean?">
          <p>
            All levels are deterministic, so Anthropic prompt caching stays intact. The difference
            is whether they can drop information Claude might need.
          </p>
          <ul className="space-y-1.5">
            <li>
              <span className="font-semibold text-black dark:text-white">Conservative</span>{' '}
              (default): lossless cleanup only. Strips terminal color codes, collapses repeated
              blank lines, and minifies JSON whitespace.{' '}
              <span className="font-medium text-emerald-700 dark:text-emerald-300">
                No accuracy impact
              </span>{' '}
              : nothing is removed.
            </li>
            <li>
              <span className="font-semibold text-black dark:text-white">Moderate</span>: truncates
              very long tool output (keeping the start and end), collapses repetitive stack traces
              and near-duplicate log lines, folds and samples large JSON arrays, trims oversized
              diffs and search results, and extracts text from HTML.{' '}
              <span className="font-medium text-amber-600 dark:text-amber-400">
                Lossy: may omit detail
              </span>{' '}
              that Claude would have used.
            </li>
            <li>
              <span className="font-semibold text-black dark:text-white">Aggressive</span>: the same
              rules with the lowest thresholds and tightest caps.{' '}
              <span className="font-medium text-amber-600 dark:text-amber-400">Most lossy</span>, so
              the accuracy risk is highest.
            </li>
          </ul>
          <p>
            Turn on{' '}
            <span className="font-medium text-black dark:text-white">Reversible retrieval</span>{' '}
            (below) to remove that risk: the omitted text is kept and Claude can fetch it on demand,
            making even Aggressive safe. Token and cost figures are estimates derived from the bytes
            removed.
          </p>
        </InfoModal>
      </div>

      <div
        className={`mt-1 flex rounded border border-border-subtle/10 p-0.5 text-[10px] uppercase tracking-wide ${
          enabled ? '' : 'opacity-50 pointer-events-none'
        }`}
        role="group"
        aria-label="Compression aggressiveness"
      >
        {LEVELS.map((l) => (
          <button
            key={l.value}
            type="button"
            aria-pressed={level === l.value}
            onClick={() => onPickLevel(l.value)}
            className={`flex-1 rounded px-2 py-0.5 ${
              level === l.value
                ? 'bg-surface-overlay/15 text-foreground'
                : 'text-foreground/55 hover:text-foreground/85'
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>

      {/* At-a-glance accuracy note for the selected level. */}
      {level === 'conservative' ? (
        <p className="mt-1 text-[10px] text-foreground/45">Lossless: no impact on accuracy.</p>
      ) : settings?.compressionRetrievalEnabled ? (
        <p className="mt-1 text-[10px] text-foreground/45">
          Lossy, but Reversible retrieval lets Claude fetch back anything it trims.
        </p>
      ) : (
        <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
          Lossy: may omit detail Claude needs. Turn on Reversible retrieval below to keep it
          recoverable.
        </p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <MetricTile
          label="Est. input tokens saved"
          tone="saved"
          value={formatTokens(t.estTokensSaved)}
          title="Input tokens removed from request bodies before they reach Anthropic. Output tokens are not affected by compression."
        />
        <MetricTile label="Est. cost saved" tone="good" value={formatUsd(t.estCostSavedUsd)} />
        <MetricTile label="Bytes removed" value={`${removedPct}%`} />
        <MetricTile
          label="Cache hit ratio"
          value={`${cachePct}%`}
          tone={cacheHealthy ? 'good' : 'warn'}
          title="Prompt-cache reads vs writes over the same window. A drop after enabling compression would signal cache busting."
        />
      </div>

      <p className="mt-2 text-[11px] text-foreground/45">
        {t.requestsCompressed} request{t.requestsCompressed === 1 ? '' : 's'} compressed
        {' · '}
        {t.requestsSkipped} skipped
      </p>

      {t.estTokensPotential > 0 && level !== 'aggressive' && (
        <p className="mt-1 text-[11px] text-sky-700 dark:text-sky-300">
          {enabled ? 'Raising to Aggressive' : 'Enabling compression'} could save an estimated{' '}
          {formatTokens(t.estTokensPotential)} more ({formatUsd(t.estCostPotential)}) on the traffic
          seen so far.
        </p>
      )}

      {(metrics.byTool.length > 0 || metrics.daily.length > 0) && (
        <div className="mt-3 space-y-3">
          <CompressionByToolChart byTool={metrics.byTool} />
          <CompressionRatioChart daily={metrics.daily} />
        </div>
      )}

      {metrics.errors.length > 0 && (
        <div className="mt-3">
          <h4 className="section-label mb-1">Skips</h4>
          <ul className="space-y-0.5">
            {metrics.errors.map((e) => (
              <li
                key={e.skipReason}
                className="flex justify-between text-[11px] text-foreground/60"
              >
                <span>{SKIP_LABELS[e.skipReason] ?? e.skipReason}</span>
                <span className="tabular-nums">{e.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3 border-t border-border-subtle/10 pt-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="flex items-center gap-1 text-[13px] font-semibold text-foreground">
              Reversible retrieval
              <InfoModal title="Reversible retrieval" ariaLabel="What is reversible retrieval?">
                <p>
                  When compression trims content, Sentinel keeps the full original on your machine
                  and gives Claude a tool to fetch it on demand. So even Aggressive trimming is
                  safe: nothing is truly lost; Claude pulls back the omitted text only when it needs
                  it.
                </p>
                <p>
                  Turning it on installs a small local MCP server into Claude Code that exposes a{' '}
                  <code className="text-black dark:text-white">{mcp.toolName}</code> tool. Pick
                  where it is installed:
                </p>
                <ul className="space-y-1.5">
                  <li>
                    <span className="font-semibold text-black dark:text-white">All projects</span>:
                    available in every Claude Code project.
                  </li>
                  <li>
                    <span className="font-semibold text-black dark:text-white">
                      This directory (private)
                    </span>
                    : just one project, in your personal config.
                  </li>
                  <li>
                    <span className="font-semibold text-black dark:text-white">
                      This directory (shared)
                    </span>
                    : writes a <code className="text-black dark:text-white">.mcp.json</code> in the
                    folder that you can commit so your team gets it too.
                  </li>
                </ul>
                <p>
                  Restart Claude Code after installing for the tool to load. The kept originals
                  never leave your machine, and if the tool is not installed the markers degrade
                  harmlessly: the kept start and end still show, Claude just cannot fetch the
                  middle.
                </p>
              </InfoModal>
            </h4>
            <p className="mt-0.5 text-[11px] text-foreground/60">
              Keep the trimmed content and let Claude fetch it on demand with the{' '}
              <code className="text-foreground/80">{mcp.toolName}</code> tool. Install the Sentinel
              MCP server into Claude Code, then restart Claude Code to load it.
            </p>
          </div>
          <div className="mt-0.5">
            <Switch
              checked={settings?.compressionRetrievalEnabled ?? false}
              onChange={setRetrievalEnabled}
              label="Emit retrieval markers"
            />
          </div>
        </div>

        {mcp.installs.length > 0 ? (
          <ul className="mt-2 space-y-1">
            {mcp.installs.map((rec) => (
              <li
                key={`${rec.scope}:${rec.directory ?? ''}`}
                className="flex items-center justify-between rounded-md border border-border-subtle/10 px-2.5 py-1.5 text-[11px]"
              >
                <span className="min-w-0 truncate text-foreground/80">
                  {SCOPE_LABELS[rec.scope]}
                  {rec.directory ? `: ${dirBasename(rec.directory)}` : ''}
                </span>
                <button
                  type="button"
                  disabled={mcpBusy}
                  onClick={() => void uninstall(rec)}
                  className="flex shrink-0 items-center gap-1 rounded border border-border-subtle/15 px-1.5 py-0.5 text-foreground/70 hover:bg-surface-overlay/5 disabled:opacity-50"
                >
                  <Trash2 className="h-3 w-3" /> Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-[11px] text-foreground/45">Not installed in any scope.</p>
        )}

        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={mcpBusy}
            onClick={() => void installAt('user')}
            className="flex items-center gap-1 rounded bg-surface-overlay/15 px-2 py-1 text-[11px] text-foreground hover:bg-surface-overlay/25 disabled:opacity-50"
          >
            <Globe className="h-3 w-3" /> All projects
          </button>
          <button
            type="button"
            disabled={mcpBusy}
            onClick={() => void pickDirAndInstall('local')}
            className="flex items-center gap-1 rounded bg-surface-overlay/15 px-2 py-1 text-[11px] text-foreground hover:bg-surface-overlay/25 disabled:opacity-50"
          >
            <FolderOpen className="h-3 w-3" /> This directory (private)
          </button>
          <button
            type="button"
            disabled={mcpBusy}
            onClick={() => void pickDirAndInstall('project')}
            className="flex items-center gap-1 rounded bg-surface-overlay/15 px-2 py-1 text-[11px] text-foreground hover:bg-surface-overlay/25 disabled:opacity-50"
          >
            <FolderOpen className="h-3 w-3" /> This directory (shared)
          </button>
        </div>

        {justInstalled && mcpError === null && (
          <p className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
            Installed. Restart Claude Code to load the retrieve tool.
          </p>
        )}
        {mcpError !== null && (
          <p className="mt-2 text-[11px] text-red-600 dark:text-red-400">{mcpError}</p>
        )}
      </div>
    </div>
  );
}
