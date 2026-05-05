/**
 * Pure helpers for the Optimize tab's OpportunityList component. Pulled
 * out of the .tsx so they can be unit-tested without a React renderer
 * (the app package's vitest setup only collects `*.test.ts`).
 */

import type { ListOptimizationEventsMessage } from '@claude-sentinel/shared';

export type StatusFilter = 'all' | 'realized' | 'regression' | 'potential' | 'dismissed';

/**
 * Build the IPC request payload for `list_optimization_events` from the
 * UI's filter state. Keeps the resolution rules in one place so the
 * component and its tests agree on what each chip actually fetches.
 *
 *   - 'all'        → all measured rows (default kind=measured)
 *   - 'realized'   → measured AND realized=true
 *   - 'regression' → measured AND realized=true AND savings_usd ≤ -0.005
 *                    (the daemon enforces the threshold; matches the
 *                    UI's regression pill so chip and pill agree)
 *   - 'potential'  → measured AND realized=false
 *   - 'dismissed'  → kind=dismissed
 *
 * `search` is sent verbatim; the daemon LIKEs against curated_id,
 * pattern, and session_id (case-insensitive).
 */
export function buildListRequest(
  status: StatusFilter,
  curatedId: string,
  limit: number,
  offset: number,
  search: string,
): ListOptimizationEventsMessage {
  const req: ListOptimizationEventsMessage = {
    type: 'list_optimization_events',
    limit,
    offset,
  };
  if (status === 'realized') {
    req.kind = 'measured';
    req.realized = true;
  } else if (status === 'regression') {
    // The daemon's regressionsOnly flag pins kind+realized AND adds the
    // savings threshold. Don't also pass realized/kind here — the
    // daemon would intersect them, which is fine, but explicit is
    // cleaner and matches the test expectations.
    req.regressionsOnly = true;
  } else if (status === 'potential') {
    req.kind = 'measured';
    req.realized = false;
    // Hide misfit-warning rows ("subagent would have cost more").
    // They still appear under 'all' for users who want to audit.
    req.positiveSavingsOnly = true;
  } else if (status === 'dismissed') {
    req.kind = 'dismissed';
  } else {
    req.kind = 'measured';
  }
  if (curatedId !== 'all') req.curatedId = curatedId;
  const trimmed = search.trim();
  if (trimmed.length > 0) req.search = trimmed;
  return req;
}

/** Human-readable label for an `optimization_events.pattern` value.
 *  Falls back to the raw key so a new pattern shipped before this map is
 *  updated still renders something legible. */
export function humanPattern(pattern: string | null): string {
  if (pattern === null) return 'unknown';
  const map: Record<string, string> = {
    short_turn_after_large_read: 'Large read, no follow-up quote',
    repeat_read_same_file: 'Same file read repeatedly (one session)',
    repeat_read_cross_session: 'Same file read across sessions',
    exploration_glob_grep: 'Many Glob/Grep before any edit',
    bash_log_parse: 'Large log/text parsed inline',
    test_runner_noise: 'Test runner output dumped inline',
    diff_pre_pass: 'Read+Edit cycles across multiple files',
  };
  return map[pattern] ?? pattern;
}

/** Display threshold below which a savings number is treated as zero
 *  (no sign). Two-decimal rounding turns values like -0.001 into the
 *  misleading "-$0.00" — clamping anything under half-a-cent collapses
 *  that noise to a clean "$0.00". */
const SAVINGS_NOISE_FLOOR = 0.005;

export function formatUsd(n: number): string {
  if (Math.abs(n) < SAVINGS_NOISE_FLOOR) return '$0.00';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

/**
 * Tailwind class for a savings amount. Mirrors the dashboard header's
 * three-state convention so a negative realized number reads as a
 * regression, not as a generic "savings line item":
 *   - meaningfully positive → emerald (it worked)
 *   - meaningfully negative → red (the install made things worse)
 *   - within the noise floor → neutral
 *
 * Same noise floor as `formatUsd` so the color and the displayed number
 * agree: nothing should ever read as red while showing "$0.00".
 */
export function savingsColorClass(n: number): string {
  if (n >= SAVINGS_NOISE_FLOOR) return 'text-emerald-300';
  if (n <= -SAVINGS_NOISE_FLOOR) return 'text-red-400';
  return 'text-white/70';
}

export function formatBytes(n: number | null): string {
  if (n === null) return 'n/a';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** Relative-time label for a tool-call timestamp vs the event timestamp.
 *  Tool calls always precede the event that summarises them; if a row
 *  comes back with callTs > evTs we render "after event" rather than
 *  silently producing a negative number. */
export function relativeTime(callTs: number, evTs: number): string {
  const delta = evTs - callTs;
  if (delta < 0) return 'after event';
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}s before`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m before`;
  const hr = Math.floor(min / 60);
  return `${hr}h before`;
}
