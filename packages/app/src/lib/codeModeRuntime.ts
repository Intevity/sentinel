/**
 * Formatting for the Context tab's per-server runtime line.
 *
 * Extracted from ContextPanel because the app's vitest run only collects
 * `*.test.ts` — panel logic is tested by living in `lib/`.
 */

import type { CodeModeServerRuntime } from '@sentinel/shared';

/** Compact duration: the largest two units that carry information. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return h > 0 && m % 60 > 0 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 > 0 ? `${d}d ${h % 24}h` : `${d}d`;
}

export interface RuntimeSummary {
  /** One-line description of the live connection(s), or null when there is
   *  nothing running to describe. */
  line: string | null;
  /** More processes alive than connections tracked — something leaked, and
   *  saying so is the whole reason this surface exists. */
  leaked: boolean;
  /** Why the server currently has no connection. Only set when there is no
   *  live client, so a healthy server never shows a stale failure. */
  error: string | null;
}

const EMPTY: RuntimeSummary = { line: null, leaked: false, error: null };

/**
 * Describe a bridged server's live state.
 *
 * `undefined` means the daemon has never needed this server — the bridge
 * connects lazily, so that is "idle", not "broken", and says nothing.
 */
export function summarizeServerRuntime(
  entry: CodeModeServerRuntime | undefined,
  now: number = Date.now(),
): RuntimeSummary {
  if (!entry) return EMPTY;
  const clients = entry.clients;
  if (clients.length === 0) {
    return { line: null, leaked: entry.liveProcesses > 0, error: entry.lastError };
  }
  const parts: string[] = [];
  if (clients.length > 1) parts.push(`${clients.length} connections`);
  const oldest = Math.min(...clients.map((c) => c.connectedAt));
  parts.push(`up ${formatDuration(now - oldest)}`);
  // One pid is worth naming so it can be matched against `ps`; several would
  // be noise, and the count already says there are several.
  if (clients.length === 1 && clients[0]?.pid != null) parts.push(`pid ${clients[0].pid}`);
  const tools = clients[0]?.toolCount;
  if (clients.length === 1 && tools != null) parts.push(`${tools} tools`);
  const lastCallAt = clients
    .map((c) => c.lastCallAt)
    .filter((t): t is number => t != null)
    .sort((a, b) => b - a)[0];
  if (lastCallAt != null) parts.push(`last call ${formatDuration(now - lastCallAt)} ago`);
  return {
    line: parts.join(' · '),
    leaked: entry.liveProcesses > clients.length,
    error: null,
  };
}
