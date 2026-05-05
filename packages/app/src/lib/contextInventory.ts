/**
 * Pure helpers for the ContextInventoryPanel component. Extracted to a
 * sibling .ts so they're testable without a React renderer.
 */

import type { ContextInventory, ContextInventoryMcpServer } from '@claude-sentinel/shared';

/** Human-readable byte formatting. Same algorithm as
 *  `opportunityList.formatBytes` but kept separate for the inventory
 *  context so each surface stays free to evolve independently. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** Approximate token count rendered with a leading "~" so users don't
 *  read it as exact (the estimator uses 4 bytes / token, which over-
 *  counts pure-text and under-counts JSON). */
export function formatTokens(n: number): string {
  if (n < 1000) return `~${n}`;
  if (n < 1_000_000) return `~${(n / 1000).toFixed(1)}K`;
  return `~${(n / 1_000_000).toFixed(2)}M`;
}

/** Truncate an absolute path to the last two segments, prefixed with
 *  "…/" if any segments were dropped. Keeps the table from blowing out
 *  horizontally on long monorepo paths while staying readable. */
export function truncatePath(path: string): string {
  const segs = path.split('/').filter((s) => s.length > 0);
  if (segs.length <= 2) return path;
  return `…/${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
}

/** Sum the inventory's tracked context contributors into a single
 *  number for the panel header. CLAUDE.md and memory bytes are treated
 *  as 4 bytes / token to match the MCP estimator. Plugins / subagents
 *  contribute zero here because we don't have a static cost model for
 *  them yet. */
export function totalEstimatedTokens(inv: ContextInventory): number {
  let mcp = 0;
  for (const s of inv.mcpServers) mcp += s.recent7d.estimatedTokens;
  let mdBytes = 0;
  for (const f of inv.claudeMdFiles) mdBytes += f.sizeBytes;
  let memBytes = 0;
  for (const m of inv.memoryDirs) memBytes += m.totalBytes;
  return mcp + Math.floor((mdBytes + memBytes) / 4);
}

/** Filter out MCP servers that are disabled AND have zero recent
 *  activity. They're inert and would just clutter the table. Disabled
 *  servers with recent activity stay (means the user disabled it
 *  recently and the activity window hasn't rolled off yet). */
export function visibleMcpServers(
  servers: ContextInventoryMcpServer[],
): ContextInventoryMcpServer[] {
  return servers.filter((s) => s.enabled || s.recent7d.calls > 0);
}
