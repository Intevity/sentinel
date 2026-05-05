import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ServerCog } from 'lucide-react';
import type { ContextInventory } from '@claude-sentinel/shared';
import { sendToSentinel } from '../../lib/ipc.js';
import {
  formatBytes,
  formatTokens,
  totalEstimatedTokens,
  truncatePath,
  visibleMcpServers,
} from '../../lib/contextInventory.js';

/**
 * Read-only inventory of every surface that bloats Claude Code's
 * per-request context: configured MCP servers (per-project), CLAUDE.md
 * files, memory directories, enabled plugins, and globally-installed
 * subagents. Helps the user spot things they should disable manually
 * (we don't yet provide a write-back API — it's deferred until we
 * have a project-vs-global scope model that won't surprise users).
 *
 * Lives at the bottom of the Optimize tab as a collapsible section so
 * it doesn't compete for attention with the savings chart.
 */

const EMPTY: ContextInventory = {
  mcpServers: [],
  claudeMdFiles: [],
  memoryDirs: [],
  plugins: [],
  globalSubagents: [],
};

export default function ContextInventoryPanel(): React.ReactElement {
  const [inventory, setInventory] = useState<ContextInventory>(EMPTY);
  const [open, setOpen] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await sendToSentinel<ContextInventory>({ type: 'get_context_inventory' });
    if (r.success && r.data) setInventory(r.data);
    else setError(r.error ?? 'failed to load context inventory');
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const headerSummary = useMemoTotal(inventory);
  const mcpServers = visibleMcpServers(inventory.mcpServers);

  return (
    <div className="glass-card px-4 py-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 text-white/55" />
        ) : (
          <ChevronRight className="h-3 w-3 text-white/55" />
        )}
        <ServerCog className="h-3 w-3 text-white/65" />
        <h3 className="section-label">Context-bloat inventory</h3>
        <span className="ml-auto text-[10px] text-white/55">{headerSummary}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-[11px] text-white/55">
            Each item below contributes to every Claude Code request's context. Disable items you
            don't actively use to reduce token cost. To disable, edit{' '}
            <code className="text-white/75">~/.claude.json</code> or use Claude Code's native
            config; Sentinel doesn't yet write to these files.
          </p>

          {error !== null && (
            <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          <Section title={`MCP servers (${mcpServers.length})`}>
            {mcpServers.length === 0 ? (
              <Empty text="No MCP servers configured." />
            ) : (
              <ul className="space-y-1">
                {mcpServers.map((s) => (
                  <li
                    key={`${s.project}:${s.name}`}
                    className="grid grid-cols-[1fr_auto_auto_auto] items-baseline gap-2 text-[11px] text-white/80"
                  >
                    <span className="truncate">
                      <span className="font-mono">{s.name}</span>
                      <span className="ml-1 text-[10px] text-white/45">
                        {truncatePath(s.project)}
                      </span>
                    </span>
                    {s.enabled ? (
                      <span className="rounded bg-emerald-500/15 px-1 py-px text-[9px] uppercase text-emerald-300">
                        enabled
                      </span>
                    ) : (
                      <span className="rounded bg-white/10 px-1 py-px text-[9px] uppercase text-white/55">
                        disabled
                      </span>
                    )}
                    <span className="tabular-nums text-white/55">
                      {s.recent7d.calls} call{s.recent7d.calls === 1 ? '' : 's'}
                    </span>
                    <span className="tabular-nums text-white/65">
                      {formatTokens(s.recent7d.estimatedTokens)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`CLAUDE.md files (${inventory.claudeMdFiles.length})`}>
            {inventory.claudeMdFiles.length === 0 ? (
              <Empty text="No CLAUDE.md files detected." />
            ) : (
              <ul className="space-y-1">
                {inventory.claudeMdFiles.map((f) => (
                  <li
                    key={f.path}
                    className="grid grid-cols-[1fr_auto_auto] items-baseline gap-2 text-[11px] text-white/80"
                  >
                    <span className="truncate font-mono text-white/75">{truncatePath(f.path)}</span>
                    <span className="rounded bg-white/10 px-1 py-px text-[9px] uppercase text-white/55">
                      {f.scope}
                    </span>
                    <span className="tabular-nums">{formatBytes(f.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`Memory directories (${inventory.memoryDirs.length})`}>
            {inventory.memoryDirs.length === 0 ? (
              <Empty text="No project memory directories with files." />
            ) : (
              <ul className="space-y-1">
                {inventory.memoryDirs.map((m) => (
                  <li
                    key={m.projectId}
                    className="grid grid-cols-[1fr_auto_auto] items-baseline gap-2 text-[11px] text-white/80"
                  >
                    <span className="truncate font-mono text-white/75">{m.projectId}</span>
                    <span className="tabular-nums text-white/55">
                      {m.fileCount} file{m.fileCount === 1 ? '' : 's'}
                    </span>
                    <span className="tabular-nums">{formatBytes(m.totalBytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`Plugins (${inventory.plugins.length})`}>
            {inventory.plugins.length === 0 ? (
              <Empty text="No plugins enabled." />
            ) : (
              <ul className="flex flex-wrap gap-1">
                {inventory.plugins.map((p) => (
                  <li
                    key={p.name}
                    className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/80"
                  >
                    {p.name}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={`Globally enabled subagents (${inventory.globalSubagents.length})`}>
            {inventory.globalSubagents.length === 0 ? (
              <Empty text="No subagents installed." />
            ) : (
              <ul className="flex flex-wrap gap-1">
                {inventory.globalSubagents.map((s) => (
                  <li
                    key={s.name}
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      s.source === 'curated'
                        ? 'bg-sky-500/15 text-sky-200'
                        : 'bg-white/10 text-white/80'
                    }`}
                  >
                    {s.name}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <h4 className="mb-1 text-[10px] uppercase tracking-wide text-white/55">{title}</h4>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }): React.ReactElement {
  return <p className="text-[11px] text-white/45">{text}</p>;
}

function useMemoTotal(inventory: ContextInventory): string {
  return React.useMemo(() => {
    const tokens = totalEstimatedTokens(inventory);
    if (tokens === 0) return 'no detected sources';
    return `${formatTokens(tokens)} estimated tokens`;
  }, [inventory]);
}
