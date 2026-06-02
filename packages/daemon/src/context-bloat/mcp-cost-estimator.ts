/**
 * Estimate MCP server cost from observed `tool_calls`. The schema can't
 * link a tool back to its MCP server statically (we don't store the
 * server registration), but Claude Code names MCP tools `mcp__<server>__<tool>`,
 * so we can attribute usage by parsing the tool_name prefix.
 *
 * This is a USAGE signal — how much these tools have been called and
 * how much output they returned — not the static tool-definition cost.
 * The latter requires parsing request bodies' `tools[]` array, which
 * is deferred (see plan).
 */

import type Database from 'better-sqlite3';
import { estimateTokensFromBytes } from '@claude-sentinel/shared';

export interface McpServerCost {
  /** Server name (the `<server>` chunk from `mcp__<server>__<tool>`). */
  server: string;
  callCount: number;
  bytesIn: number;
  bytesOut: number;
  /** Rough token estimate using the shared byte->token ruler (3.5 bytes/token).
   *  Good enough to rank MCP servers by cost; the dashboard shows this
   *  with a "~" prefix so users don't read it as exact. */
  estimatedTokens: number;
}

const LOOKBACK_DAYS = 7;

interface McpToolRow {
  tool_name: string;
  input_size_bytes: number | null;
  response_size_bytes: number | null;
}

/**
 * Scan the last LOOKBACK_DAYS of tool_calls for any tool whose name
 * starts with `mcp__`. Aggregate per server. Returns sorted by
 * estimatedTokens desc so the heaviest servers appear first.
 */
export function estimateMcpCosts(
  db: Database.Database,
  nowMs: number = Date.now(),
): McpServerCost[] {
  const since = nowMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT tool_name, input_size_bytes, response_size_bytes
         FROM tool_calls
         WHERE ts >= ? AND tool_name LIKE 'mcp__%'`,
    )
    .all(since) as McpToolRow[];

  const byServer = new Map<string, { calls: number; bytesIn: number; bytesOut: number }>();
  for (const r of rows) {
    // tool_name shape: mcp__<server>__<toolname>; some custom MCP names
    // include underscores so we split only on the first __ pair.
    const stripped = r.tool_name.slice(5); // drop "mcp__"
    const sepIdx = stripped.indexOf('__');
    const server = sepIdx === -1 ? stripped : stripped.slice(0, sepIdx);
    const slot = byServer.get(server) ?? { calls: 0, bytesIn: 0, bytesOut: 0 };
    slot.calls += 1;
    slot.bytesIn += r.input_size_bytes ?? 0;
    slot.bytesOut += r.response_size_bytes ?? 0;
    byServer.set(server, slot);
  }

  const out: McpServerCost[] = [...byServer.entries()].map(([server, v]) => ({
    server,
    callCount: v.calls,
    bytesIn: v.bytesIn,
    bytesOut: v.bytesOut,
    estimatedTokens: estimateTokensFromBytes(v.bytesIn + v.bytesOut),
  }));
  out.sort((a, b) => b.estimatedTokens - a.estimatedTokens);
  return out;
}
