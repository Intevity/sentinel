/**
 * Pure filter for the Optimize → Context tab's MCP server list. Pulled out
 * of ContextPanel.tsx so it can be unit-tested without a React renderer
 * (the app package's vitest setup only collects `*.test.ts`).
 *
 * The list mixes servers Sentinel can act on (a config entry it can bridge or
 * disable lives in ~/.claude.json, a project .mcp.json, a disable stash, or an
 * existing bridge — `insight.managed === true`) with measured-only servers
 * configured elsewhere (Claude Code plugins, remote connectors, enterprise-
 * managed settings — `managed === false`) that Sentinel cannot touch. The
 * default view hides the latter; everything else is opt-in.
 */

import type { McpContextInsight } from '@sentinel/shared';

/** Which quick-filter chips are active. Chips are an OR group: with one or
 *  more active, a server is kept when it matches ANY active chip; with none
 *  active the chips impose no constraint. */
export interface McpServerChipState {
  /** Configured at the top level (user scope) — loads in every project. */
  global: boolean;
  /** Already bridged to code execution. */
  bridged: boolean;
  /** Carries the "unused in 7 days" recommendation. */
  unused: boolean;
  /** Carries the "switch to code execution" (code-mode) recommendation. */
  recommended: boolean;
}

export interface McpServerFilterState {
  /** Matched case-insensitively against the server's display name only. */
  search: string;
  /** When true (the default), servers Sentinel can't bridge or disable
   *  (`managed === false`) are removed from the list. */
  hideUnmanaged: boolean;
  chips: McpServerChipState;
}

export interface McpServerFilterResult {
  /** Insights that survive every active constraint, original order preserved. */
  visible: McpContextInsight[];
  /** How many insights were removed SOLELY by the hide-unmanaged toggle, for
   *  the "N hidden" transparency notice. Always 0 when `hideUnmanaged` is off. */
  hiddenUnmanaged: number;
}

/** True when the server matches at least one active chip. With no chip active
 *  the group is a pass-through (returns true). */
function matchesChips(insight: McpContextInsight, chips: McpServerChipState): boolean {
  const active: boolean[] = [];
  if (chips.global) active.push(insight.global);
  if (chips.bridged) active.push(insight.bridgeStatus === 'bridged');
  if (chips.unused) active.push(insight.recommendations.some((r) => r.kind === 'unused'));
  if (chips.recommended) active.push(insight.recommendations.some((r) => r.kind === 'code-mode'));
  if (active.length === 0) return true;
  return active.some(Boolean);
}

/**
 * Apply the search box, the hide-unmanaged toggle, and the quick-filter chips
 * to the server list. Constraints are AND-combined (a server must satisfy the
 * managed rule AND the search AND the chip OR-group); `hiddenUnmanaged` counts
 * only the rows the managed toggle alone removed.
 */
export function filterMcpInsights(
  insights: McpContextInsight[],
  state: McpServerFilterState,
): McpServerFilterResult {
  const query = state.search.trim().toLowerCase();
  let hiddenUnmanaged = 0;
  const visible: McpContextInsight[] = [];

  for (const insight of insights) {
    if (state.hideUnmanaged && !insight.managed) {
      hiddenUnmanaged += 1;
      continue;
    }
    if (query !== '' && !insight.server.toLowerCase().includes(query)) continue;
    if (!matchesChips(insight, state.chips)) continue;
    visible.push(insight);
  }

  return { visible, hiddenUnmanaged };
}
