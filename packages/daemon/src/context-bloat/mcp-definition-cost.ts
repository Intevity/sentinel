/**
 * Measure the static tool-definition cost of a `/v1/messages` request body's
 * `tools[]` array, attributed per MCP server. This is the measurement that
 * `mcp-cost-estimator.ts` defers to ("requires parsing request bodies'
 * tools[] array"): the USAGE estimator over there counts what tools returned;
 * this counts what their definitions occupy in every request that carries
 * them — the context-window tax.
 *
 * Pure parse, no I/O. The proxy calls this on the body it is about to send
 * upstream (post permissions-strip, post compression — neither touches
 * `tools[]`) and enqueues the result into the ContextCostStore.
 */

import { byteLen } from '../optimize/compress/types.js';

/** Per-server slice of one request's tools[] block. */
export interface ServerDefinitionCost {
  /** Serialized bytes of every tool definition attributed to the server. */
  defBytes: number;
  toolCount: number;
  toolNames: string[];
}

export interface ToolDefinitionMeasurement {
  /** Keyed by server name (the `<server>` chunk of `mcp__<server>__<tool>`). */
  perServer: Map<string, ServerDefinitionCost>;
  /** Bytes of tools whose name does NOT start with `mcp__` (Bash/Read/etc.). */
  nativeBytes: number;
  nativeToolCount: number;
  /** Serialized bytes of the whole tools[] array's entries. */
  totalToolBytes: number;
}

const EMPTY: ToolDefinitionMeasurement = {
  perServer: new Map(),
  nativeBytes: 0,
  nativeToolCount: 0,
  totalToolBytes: 0,
};

/** Split `mcp__<server>__<tool>` into its server chunk. Same rule as
 *  `mcp-cost-estimator.ts`: drop the `mcp__` prefix, then split on the FIRST
 *  `__` pair so tool names containing underscores attribute correctly. */
function serverFromToolName(name: string): string {
  const stripped = name.slice(5);
  const sepIdx = stripped.indexOf('__');
  return sepIdx === -1 ? stripped : stripped.slice(0, sepIdx);
}

/**
 * Walk `parsedBody.tools` and partition definition bytes into per-MCP-server
 * buckets plus a native (built-in tools) bucket. Bodies without a tools array
 * — token-count side channels, summarization requests — return the empty
 * measurement so the caller can skip the store write.
 */
export function measureToolDefinitions(parsedBody: unknown): ToolDefinitionMeasurement {
  if (!parsedBody || typeof parsedBody !== 'object') return EMPTY;
  const tools = (parsedBody as { tools?: unknown }).tools;
  if (!Array.isArray(tools) || tools.length === 0) return EMPTY;

  const perServer = new Map<string, ServerDefinitionCost>();
  let nativeBytes = 0;
  let nativeToolCount = 0;
  let totalToolBytes = 0;

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const name = (tool as { name?: unknown }).name;
    let defBytes: number;
    try {
      defBytes = byteLen(JSON.stringify(tool));
    } catch {
      // Circular or otherwise unserializable entries can't reach us from a
      // JSON.parse'd body; guard anyway so a future caller with a synthetic
      // object can't throw out of the proxy's hot path.
      /* v8 ignore next 2 -- unreachable via JSON.parse'd input */
      continue;
    }
    totalToolBytes += defBytes;
    if (typeof name === 'string' && name.startsWith('mcp__')) {
      const server = serverFromToolName(name);
      const slot = perServer.get(server) ?? { defBytes: 0, toolCount: 0, toolNames: [] };
      slot.defBytes += defBytes;
      slot.toolCount += 1;
      slot.toolNames.push(name);
      perServer.set(server, slot);
    } else {
      nativeBytes += defBytes;
      nativeToolCount += 1;
    }
  }

  return { perServer, nativeBytes, nativeToolCount, totalToolBytes };
}
