import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Network, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type {
  CodeModeAuditRow,
  CodeModeStatus,
  McpContextCosts,
  McpContextInsight,
  McpContextSavings,
  McpInstallScope,
  McpRecommendationBadge,
  MetricsWindow,
} from '@claude-sentinel/shared';
import { sendToSentinel, onDaemonMessage } from '../../lib/ipc.js';
import { formatTokens } from '../../lib/optimizeUnits.js';
import { formatUsd } from './charts/shared.js';

/**
 * Context section of the Optimize tab: per-MCP-server definition costs
 * measured from live request tools[] arrays, cross-referenced with observed
 * usage, plus the code-execution bridge controls ("code mode").
 *
 * The headline number per server is the context-window tax: tokens its tool
 * definitions occupy in every request that carries them. Definitions are
 * cache reads most of the time, so the dollar figure shown is the smaller,
 * honest one: estimated cache-write amplification, prefixed with `~`.
 *
 * Self-contained (CompressionPanel pattern): owns its fetches; subscribes to
 * `mcp_context_costs_updated`, `code_mode_status`, and `settings_changed`.
 */

/** Per-row actions. Migrate can take several seconds (the daemon connects to
 *  the server, lists tools, and generates the workspace + skill), so the UI
 *  must show in-flight feedback rather than appearing to hang. */
type ServerAction = 'migrate' | 'revert' | 'disable' | 'enable';

const EMPTY_COSTS: McpContextCosts = {
  insights: [],
  nativeDefBytes: 0,
  measuredRequests: 0,
  savings: {
    realized: { estTokens: 0, estUsd: 0 },
    potential: { estTokens: 0, estUsd: 0 },
    byServer: [],
  },
};

const EMPTY_STATUS: CodeModeStatus = {
  enabled: false,
  skillInstalled: false,
  migrations: [],
  endpointUrl: '',
  workspaceDir: '',
};

const BADGE_STYLES: Record<McpRecommendationBadge['kind'], string> = {
  'code-mode': 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  unused: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  duplicate: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  disabled: 'border-border-subtle/20 bg-surface-overlay/10 text-foreground/55',
};

function badgeLabel(b: McpRecommendationBadge): string {
  switch (b.kind) {
    case 'code-mode':
      return 'switch to code execution';
    case 'unused':
      return 'unused in 7 days';
    case 'duplicate':
      return `overlaps ${b.detail ?? 'another server'}`;
    case 'disabled':
      return 'disabled';
  }
}

/** Last path segment, for a compact project label. */
function dirBasename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

/** Pick the scope + directory a row action applies to. Global entries act at
 *  user scope; single-project entries at the scope that configures them
 *  (`local` for ~/.claude.json project entries, `project` for .mcp.json
 *  entries); multi-project entries use the project the user picked in the
 *  row's selector. */
function actionTarget(
  insight: McpContextInsight,
  pickedProject: string | undefined,
): { scope: McpInstallScope; directory?: string } | null {
  if (insight.global) return { scope: 'user' };
  const project = pickedProject ?? insight.projects[0] ?? insight.mcpJsonProjects[0];
  if (!project) return null;
  const scope = insight.projects.includes(project) ? 'local' : 'project';
  return { scope, directory: project };
}

export default function ContextPanel({
  metricsWindow,
}: {
  /** Window from the page-level range selector; definition costs describe
   *  the same span as the sticky savings bar above. */
  metricsWindow: MetricsWindow;
}): React.ReactElement {
  const [costs, setCosts] = useState<McpContextCosts>(EMPTY_COSTS);
  const [status, setStatus] = useState<CodeModeStatus>(EMPTY_STATUS);
  const [audit, setAudit] = useState<CodeModeAuditRow[]>([]);
  // The in-flight action, set the instant a button is clicked and held until
  // the refresh after success/failure lands — drives the spinner on the
  // clicked button and disables every action button (concurrent migrations
  // would race on the daemon's settings/skill writes).
  const [busy, setBusy] = useState<{ server: string; kind: ServerAction } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pickedProjects, setPickedProjects] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    const [c, s, a] = await Promise.all([
      sendToSentinel<McpContextCosts>({ type: 'get_mcp_context_costs', window: metricsWindow }),
      sendToSentinel<CodeModeStatus>({ type: 'get_code_mode_status' }),
      sendToSentinel<CodeModeAuditRow[]>({ type: 'get_code_mode_audit', limit: 20 }),
    ]);
    if (c.success && c.data) setCosts(c.data);
    if (s.success && s.data) setStatus(s.data);
    if (a.success && a.data) setAudit(a.data);
  }, [metricsWindow]);

  useEffect(() => {
    void refresh();
    const unsubP = onDaemonMessage((msg) => {
      if (
        msg.type === 'mcp_context_costs_updated' ||
        msg.type === 'code_mode_status' ||
        msg.type === 'settings_changed'
      ) {
        void refresh();
      }
    });
    return () => {
      void unsubP.then((u) => u());
    };
  }, [refresh]);

  const act = useCallback(
    async (insight: McpContextInsight, kind: ServerAction): Promise<void> => {
      setBusy({ server: insight.server, kind });
      setError(null);
      setNotice(null);
      try {
        let r: Awaited<
          ReturnType<
            typeof sendToSentinel<{
              restartRequired?: boolean;
              toolCount?: number;
              entriesDisabled?: number;
            }>
          >
        >;
        if (kind === 'migrate' || kind === 'revert') {
          // Migration and revert act on EVERY configured entry for the
          // server (the daemon discovers user + per-project scopes itself):
          // Claude Code resolves same-named servers local-over-global, so a
          // single-scope migration would leave projects loading the
          // definitions natively. No scope to pick.
          r = await sendToSentinel({
            type:
              kind === 'migrate'
                ? ('migrate_server_to_code_mode' as const)
                : ('revert_server_from_code_mode' as const),
            server: insight.server,
          });
        } else {
          const target = actionTarget(insight, pickedProjects[insight.server]);
          if (!target) {
            setError(`No project scope resolved for ${insight.server}`);
            return;
          }
          r = await sendToSentinel({
            type:
              kind === 'disable' ? ('disable_mcp_server' as const) : ('enable_mcp_server' as const),
            server: insight.server,
            scope: target.scope,
            ...(target.directory !== undefined ? { directory: target.directory } : {}),
          });
        }
        if (!r.success) {
          setError(r.error ?? `${kind} failed`);
          return;
        }
        if (kind === 'migrate') {
          const n = r.data?.entriesDisabled ?? 0;
          setNotice(
            `${insight.server} is now bridged (${r.data?.toolCount ?? 0} tools, ${n} native ${
              n === 1 ? 'entry' : 'entries'
            } disabled); restart your Claude Code session to apply.`,
          );
        } else if (r.data?.restartRequired) {
          setNotice('Done; restart your Claude Code session to apply.');
        }
        // Refresh inside the busy window so the spinner holds until the row
        // re-renders with its new state (bridged pill, badges) instead of
        // flashing the old label first.
        await refresh();
      } finally {
        setBusy(null);
      }
    },
    [pickedProjects, refresh],
  );

  const bridgedServers = useMemo(
    () => new Set(status.migrations.map((m) => m.server)),
    [status.migrations],
  );
  const drifted = status.migrations.filter((m) => m.drifted);
  const mcpDefBytes = costs.insights.reduce((acc, i) => acc + i.definition.bytes, 0);
  const mcpDefTokens = costs.insights.reduce((acc, i) => acc + i.definition.estTokens, 0);
  const totalToolBytes = mcpDefBytes + costs.nativeDefBytes;
  const mcpShare = totalToolBytes > 0 ? Math.round((100 * mcpDefBytes) / totalToolBytes) : 0;

  return (
    <div className="glass-card px-4 py-3">
      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <Network className="h-3.5 w-3.5" /> MCP context costs
      </h3>
      <p className="mb-3 text-xs text-foreground/60">
        Every request carries the tool definitions of each enabled MCP server: a context-window tax
        paid before the conversation starts. Servers with heavy definitions and light usage are
        candidates for code execution; Sentinel bridges them locally so their definitions leave your
        context entirely.
      </p>

      {costs.measuredRequests > 0 ? (
        <p className="mb-3 text-[11px] text-foreground/45">
          Measured across {costs.measuredRequests} request
          {costs.measuredRequests === 1 ? '' : 's'}: ~{formatTokens(mcpDefTokens)} tokens of MCP
          definitions per request ({mcpShare}% of the tools block).
        </p>
      ) : (
        <p className="mb-3 text-[11px] text-foreground/45">
          No tools[] measurements in this window yet; run a Claude Code session through Sentinel and
          the per-server costs appear here.
        </p>
      )}

      {/* Context's own realized/potential totals, mirroring the Subagents and
          Compression sections. Same figures the sticky bar folds into its
          combined totals; dollars use cached rates (definitions ride as
          cache reads), hence the ~ prefix. */}
      {(costs.savings.realized.estTokens > 0 || costs.savings.potential.estTokens > 0) && (
        <div className="mb-3 grid grid-cols-2 gap-2">
          <div
            className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2"
            title="Definition tokens kept out of requests since bridging: each bridged server's definition size times the requests observed after its migration. Estimated at cached rates."
          >
            <div className="text-[10px] uppercase tracking-wide text-foreground/55">Saved</div>
            <div className="mt-0.5 text-xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">
              ~{formatTokens(costs.savings.realized.estTokens)}
            </div>
            <div className="mt-0.5 text-[11px] text-foreground/45">
              ≈{formatUsd(costs.savings.realized.estUsd)} · kept out of context since bridging
            </div>
          </div>
          <div
            className="rounded-lg border border-border-subtle/10 px-3 py-2"
            title="Definition tokens the recommended servers actually carried over this window: what bridging them would have saved."
          >
            <div className="text-[10px] uppercase tracking-wide text-foreground/55">Potential</div>
            <div className="mt-0.5 text-xl font-semibold tabular-nums text-sky-700 dark:text-sky-300">
              ~{formatTokens(costs.savings.potential.estTokens)}
            </div>
            <div className="mt-0.5 text-[11px] text-foreground/45">
              ≈{formatUsd(costs.savings.potential.estUsd)} · bridge recommended servers
            </div>
          </div>
        </div>
      )}

      {error !== null && (
        <p className="mb-2 text-xs text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      )}
      {notice !== null && (
        <p className="mb-2 text-xs text-emerald-700 dark:text-emerald-300">{notice}</p>
      )}
      {drifted.length > 0 && (
        <p className="mb-2 text-xs text-amber-700 dark:text-amber-300">
          {drifted.map((m) => m.server).join(', ')}: native entry was restored outside Sentinel; the
          bridge is still active. Use Switch back to clean up.
        </p>
      )}

      <ul className="space-y-2">
        {costs.insights.map((insight) => (
          <ServerRow
            key={insight.server}
            insight={insight}
            bridged={bridgedServers.has(insight.server)}
            realized={costs.savings.byServer.find((s) => s.server === insight.server)}
            busyAction={busy?.server === insight.server ? busy.kind : null}
            actionsDisabled={busy !== null}
            pickedProject={pickedProjects[insight.server]}
            onPickProject={(p) => setPickedProjects((prev) => ({ ...prev, [insight.server]: p }))}
            onAct={(kind) => void act(insight, kind)}
          />
        ))}
        {costs.insights.length === 0 && (
          <li className="rounded-md border border-border-subtle/10 px-3 py-2 text-xs text-foreground/55">
            No MCP servers detected in ~/.claude.json or recent traffic.
          </li>
        )}
      </ul>

      {status.migrations.length > 0 && <CodeModeStatusSection status={status} audit={audit} />}
    </div>
  );
}

function ServerRow({
  insight,
  bridged,
  realized,
  busyAction,
  actionsDisabled,
  pickedProject,
  onPickProject,
  onAct,
}: {
  insight: McpContextInsight;
  bridged: boolean;
  /** Realized-savings attribution for bridged servers (undefined until the
   *  first post-migration request lands). */
  realized: McpContextSavings['byServer'][number] | undefined;
  /** This row's in-flight action, if any: the matching button shows a
   *  spinner until the daemon answers and the panel refreshes. */
  busyAction: ServerAction | null;
  /** True while ANY row's action is in flight; disables every button. */
  actionsDisabled: boolean;
  pickedProject: string | undefined;
  onPickProject: (project: string) => void;
  onAct: (kind: ServerAction) => void;
}): React.ReactElement {
  const d = insight.definition;
  const statusPill =
    insight.bridgeStatus === 'bridged'
      ? { label: 'bridged', cls: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' }
      : insight.bridgeStatus === 'unavailable'
        ? { label: 'bridge unavailable', cls: 'bg-red-500/10 text-red-700 dark:text-red-300' }
        : null;
  const disabledOnly = insight.recommendations.some((b) => b.kind === 'disabled');
  /** Every directory whose config carries this server, whichever scope. */
  const allProjects = [...new Set([...insight.projects, ...insight.mcpJsonProjects])];
  return (
    <li className="rounded-md border border-border-subtle/10 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{insight.server}</span>
        {insight.global && (
          <span className="rounded bg-surface-overlay/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-foreground/70">
            global
          </span>
        )}
        {statusPill && (
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${statusPill.cls}`}
          >
            {statusPill.label}
          </span>
        )}
        <span className="ml-auto shrink-0 text-right">
          {d.measured ? (
            <span
              className="text-sm font-semibold tabular-nums text-foreground"
              title={`Max observed size of this server's tool definitions in a single request; ~${formatUsd(insight.cacheWriteEstUsd)} estimated cache-write cost over the window.`}
            >
              ~{formatTokens(d.estTokens)}
              <span className="ml-1 text-[10px] font-normal uppercase tracking-wide text-foreground/55">
                tok/request
              </span>
            </span>
          ) : (
            <span className="text-[11px] text-foreground/45">not measured yet</span>
          )}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-foreground/55">
        {d.measured && (
          <span>
            {d.toolCount} tool{d.toolCount === 1 ? '' : 's'}
          </span>
        )}
        <span>
          {insight.usage7d.calls} call{insight.usage7d.calls === 1 ? '' : 's'} in 7 days
        </span>
        {d.measured && insight.cacheWriteEstUsd > 0 && (
          <span title="Definitions are cache reads on most requests; the recurring cost is re-writing them to cache, roughly once per session.">
            ~{formatUsd(insight.cacheWriteEstUsd)} cache writes
          </span>
        )}
        {allProjects.length === 1 && <span>{dirBasename(allProjects[0]!)}</span>}
      </div>

      {/* Recommendation badges: their own row, never inline with the metadata
          above, so they read as calls to action rather than more stats. */}
      {insight.recommendations.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {insight.recommendations.map((b) => (
            <span
              key={`${b.kind}-${b.detail ?? ''}`}
              className={`rounded border px-1.5 py-0.5 text-[10px] ${BADGE_STYLES[b.kind]}`}
            >
              {badgeLabel(b)}
            </span>
          ))}
        </div>
      )}

      {/* Realized attribution, mirroring the Subagents tab's per-row savings
          badge: what the bridge has actually kept out of context so far. */}
      {bridged && realized !== undefined && realized.requests > 0 && (
        <p
          className="mt-1 text-[11px] text-emerald-700 dark:text-emerald-300"
          title="Definition tokens kept out of context: this server's definition size times the requests observed since its migration, estimated at cached rates."
        >
          Saved ~{formatTokens(realized.estTokens)} (≈{formatUsd(realized.estUsd)}) across{' '}
          {realized.requests} request{realized.requests === 1 ? '' : 's'} since bridging
        </p>
      )}

      {/* Bridged servers can still carry native per-project entries (e.g. a
          server that was configured globally AND per-project: migrating the
          global entry leaves the project ones loading definitions natively).
          Surface that honestly instead of letting the bridged pill imply the
          definitions are fully gone. */}
      {bridged && insight.enabled && allProjects.length > 0 && (
        <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          Native entries are still configured in {allProjects.length} project
          {allProjects.length === 1 ? '' : 's'}; those projects keep loading this server's
          definitions natively.
        </p>
      )}

      {/* Action-target picker for multi-project servers: it chooses which
          project's entry Disable / Enable act on (no effect until one of
          those is clicked). Switch to code execution always bridges every
          entry, and Switch back restores every recorded one, so the picker
          is hidden while bridged. */}
      {!insight.global && !bridged && allProjects.length > 1 && (
        <div
          className="mt-1.5 text-[11px] text-foreground/60"
          title="This server is configured in more than one project. Disable and Enable act on the selected project's entry; Switch to code execution always bridges every entry."
        >
          <label className="mr-1" htmlFor={`ctx-project-${insight.server}`}>
            Apply to:
          </label>
          <select
            id={`ctx-project-${insight.server}`}
            value={pickedProject ?? allProjects[0]}
            onChange={(e) => onPickProject(e.target.value)}
            className="rounded border border-border-subtle/15 bg-transparent px-1 py-0.5 text-foreground"
          >
            {allProjects.map((p) => (
              <option key={p} value={p}>
                {dirBasename(p)}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Measured-only servers (Claude Code plugins, remote connectors)
          have no config entry Sentinel can disable: bridging one would
          leave the native definitions loading alongside the bridge. No
          actions, just the honest explanation. */}
      {!insight.managed && (
        <p className="mt-1.5 text-[11px] text-foreground/55">
          Configured outside Claude Code's local config (plugin or remote connector); Sentinel can't
          bridge or disable it.
        </p>
      )}

      {insight.managed && (
        <div className="mt-2 flex flex-wrap gap-2">
          {bridged ? (
            <>
              {insight.enabled && allProjects.length > 0 && (
                <ActionButton
                  label="Bridge remaining native entries"
                  primary
                  spinning={busyAction === 'migrate'}
                  disabled={actionsDisabled}
                  onClick={() => onAct('migrate')}
                  title="Some projects still have their own enabled entry for this server (project entries shadow the global one in Claude Code). Bridge those too so the definitions stop loading everywhere."
                />
              )}
              <ActionButton
                label="Switch back to native MCP"
                spinning={busyAction === 'revert'}
                disabled={actionsDisabled}
                onClick={() => onAct('revert')}
                title="Restores every entry this migration disabled, byte-identically."
              />
            </>
          ) : disabledOnly ? (
            <ActionButton
              label="Enable"
              spinning={busyAction === 'enable'}
              disabled={actionsDisabled}
              onClick={() => onAct('enable')}
            />
          ) : (
            <>
              <ActionButton
                label="Switch to code execution"
                primary
                spinning={busyAction === 'migrate'}
                disabled={actionsDisabled}
                onClick={() => onAct('migrate')}
                title="Sentinel connects to this server itself and generates on-demand tool docs plus a skill; the native entry is disabled so its definitions stop loading. Reversible."
              />
              <ActionButton
                label="Disable"
                spinning={busyAction === 'disable'}
                disabled={actionsDisabled}
                onClick={() => onAct('disable')}
                title="Remove the server from Claude Code's config (stashed in Sentinel for one-click re-enable)."
              />
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** Row action button with instant in-flight feedback: the clicked button
 *  swaps in a spinner and every action button dims + disables until the
 *  daemon answers (migrate verifies connectivity and generates files, which
 *  can take a few seconds). The spinner is rendered only while busy so an idle
 *  button has no leading gap; when it appears the flex row grows to fit it.
 *  Labels never re-wrap (whitespace-nowrap) and there is no opacity transition
 *  (it blurs text mid-fade on Windows WebView2). */
function ActionButton({
  label,
  spinning,
  disabled,
  onClick,
  primary = false,
  title,
}: {
  label: string;
  spinning: boolean;
  disabled: boolean;
  onClick: () => void;
  primary?: boolean;
  title?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-busy={spinning}
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1.5 whitespace-nowrap rounded px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
        primary
          ? 'bg-surface-overlay/15 text-foreground hover:bg-surface-overlay/25'
          : 'border border-border-subtle/15 text-foreground/70 hover:bg-surface-overlay/5'
      }`}
    >
      {spinning && <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden />}
      {label}
    </button>
  );
}

/** Bridge details: endpoint, workspace, and the recent call audit. Collapsed
 *  by default; the audit is metadata only (server, tool, outcome, size). */
function CodeModeStatusSection({
  status,
  audit,
}: {
  status: CodeModeStatus;
  audit: CodeModeAuditRow[];
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 border-t border-border-subtle/10 pt-2">
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
        <span className="text-[11px] font-semibold text-muted">
          Code-mode bridge: {status.migrations.length} server
          {status.migrations.length === 1 ? '' : 's'}, {audit.length} recent call
          {audit.length === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <div className="mt-1 space-y-2 text-[11px] text-foreground/60">
          <p>
            Endpoint: <code className="text-foreground/80">{status.endpointUrl}</code>
            <br />
            Tool docs: <code className="text-foreground/80">{status.workspaceDir}</code>
            <br />
            Claude reads the per-tool docs on demand and calls tools with curl through its normal
            Bash permission prompts; arguments and results never appear in this audit.
          </p>
          {audit.length > 0 && (
            <ul className="space-y-0.5">
              {audit.map((row, i) => (
                <li key={`${row.ts}-${i}`} className="flex items-center gap-2 tabular-nums">
                  <span
                    className={
                      row.ok
                        ? 'text-emerald-700 dark:text-emerald-300'
                        : 'text-red-600 dark:text-red-400'
                    }
                  >
                    {row.ok ? 'ok' : 'err'}
                  </span>
                  <span className="truncate text-foreground/80">
                    {row.server}.{row.tool}
                  </span>
                  <span className="ml-auto shrink-0">
                    {formatTokens(Math.round(row.bytesOut / 3.5))} tok · {row.durationMs}ms ·{' '}
                    {new Date(row.ts).toLocaleTimeString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
