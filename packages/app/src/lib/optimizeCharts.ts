/**
 * Pure data-transformation helpers for the Optimize dashboard's chart
 * variants. Kept here (not inside the chart components) so the data
 * shaping is unit-testable without rendering React. Each helper returns
 * the exact row shape Recharts expects.
 *
 * Charts honor the existing `optimizeUnits` toggle — when `units` is
 * 'cost' the value is USD rounded to 2 decimals; when 'tokens' it's
 * the integer parent-context-token savings.
 */
import type { OptimizationMetrics } from '@sentinel/shared';
import { DIGEST_TOKENS_BY_CURATED_ID } from '@sentinel/shared';
import type { SavingsUnits } from './optimizeUnits.js';

/** Pick the value of a (savingsUsd, tokens) pair according to `units`.
 *  Cost is rounded to 2 decimals so Recharts axis ticks stay clean;
 *  tokens are rounded to integers (tokens are always whole-number-ish). */
export function valueByUnits(units: SavingsUnits, savingsUsd: number, tokens: number): number {
  return units === 'cost' ? Number(savingsUsd.toFixed(2)) : Math.round(tokens);
}

/** Stable ordered list of curated subagent IDs that appear in
 *  `dailyBySubagent`. Sorted alphabetically so the legend, the stack
 *  order, and the color assignments all line up across renders.
 *  Returning the ids in a deterministic order also stops Recharts from
 *  re-keying bars when the daily data shifts. */
export function curatedIdsInOrder(
  dailyBySubagent: OptimizationMetrics['dailyBySubagent'],
): string[] {
  const set = new Set<string>();
  for (const r of dailyBySubagent) set.add(r.curatedId);
  return [...set].sort();
}

/** Reshape `dailyBySubagent` (long format: one row per (day, curatedId))
 *  into Recharts' wide format: `{ day, [curatedIdA]: 1.23, [curatedIdB]: 0.5 }`.
 *  Days with no events for a given subagent get an explicit 0 so the
 *  stacked bar renders the zero-baseline cleanly instead of dropping the
 *  bar segment. The shortDay label drops the year so the axis stays
 *  legible at narrow widths.
 *
 *  By default sums realized + potential per (day, subagent), since the
 *  realized/potential split already has its own dedicated chart. Pass
 *  `field: 'realized'` to chart only realized contributions. */
export function buildBySubagentSeries(
  dailyBySubagent: OptimizationMetrics['dailyBySubagent'],
  units: SavingsUnits,
  field: 'total' | 'realized' = 'total',
): {
  data: Array<Record<string, string | number>>;
  curatedIds: string[];
} {
  const curatedIds = curatedIdsInOrder(dailyBySubagent);
  const byDay = new Map<string, Record<string, string | number>>();
  for (const r of dailyBySubagent) {
    const day = r.day.slice(5).replace('-', '/');
    let row = byDay.get(day);
    if (!row) {
      row = { day };
      for (const id of curatedIds) row[id] = 0;
      byDay.set(day, row);
    }
    const usd = field === 'realized' ? r.savingsRealized : r.savingsRealized + r.savingsPotential;
    const tokens = field === 'realized' ? r.tokensRealized : r.tokensRealized + r.tokensPotential;
    row[r.curatedId] = (row[r.curatedId] as number) + valueByUnits(units, usd, tokens);
  }
  // Round once after summing to keep cumulative floating-point error
  // out of the rendered axis (otherwise stacked bars can drift by a
  // hundredth of a cent).
  const data = [...byDay.values()].map((row) => {
    const out: Record<string, string | number> = { day: String(row['day'] ?? '') };
    for (const id of curatedIds) {
      const v = (row[id] ?? 0) as number;
      out[id] = units === 'cost' ? Number(v.toFixed(2)) : Math.round(v);
    }
    return out;
  });
  return { data, curatedIds };
}

/** Build a horizontal-comparison data array from `bySubagent`. Drops
 *  rows where realized + potential rounds to zero in the active units —
 *  they'd render as invisible bars and just add noise to the legend. */
export function buildComparisonSeries(
  bySubagent: OptimizationMetrics['bySubagent'],
  units: SavingsUnits,
): Array<{ curatedId: string; realized: number; potential: number; opportunities: number }> {
  return bySubagent
    .map((s) => ({
      curatedId: s.curatedId,
      realized: valueByUnits(units, s.savingsRealized, s.tokensRealized),
      potential: valueByUnits(units, s.savingsPotential, s.tokensPotential),
      opportunities: s.opportunities,
    }))
    .filter((r) => r.realized !== 0 || r.potential !== 0);
}

/** Build a cumulative running-total series from `daily`. Returns three
 *  numeric fields per day: realized (alone), potential (alone), and
 *  total (realized + potential — the optimistic "if I'd installed
 *  everything") so the chart can layer them. Days are emitted in the
 *  daemon's already-sorted order. */
export function buildCumulativeSeries(
  daily: OptimizationMetrics['daily'],
  units: SavingsUnits,
): Array<{ day: string; realized: number; potential: number; total: number }> {
  let realized = 0;
  let potential = 0;
  return daily.map((d) => {
    realized += valueByUnits(units, d.savingsRealized, d.tokensRealized);
    potential += valueByUnits(units, d.savingsPotential, d.tokensPotential);
    const r = units === 'cost' ? Number(realized.toFixed(2)) : Math.round(realized);
    const p = units === 'cost' ? Number(potential.toFixed(2)) : Math.round(potential);
    return {
      day: d.day.slice(5).replace('-', '/'),
      realized: r,
      potential: p,
      total:
        units === 'cost'
          ? Number((realized + potential).toFixed(2))
          : Math.round(realized + potential),
    };
  });
}

/** Build a horizontal-bar series for the "by pattern" chart, ranking
 *  patterns by opportunity count desc. Caps at the top N so the chart
 *  height stays bounded; remainder rolls into "other" only when there
 *  are more than `cap + 1` rows (avoid creating an "other" with one
 *  entry, which is just a renamed last row). */
export function buildPatternSeries(
  byPattern: OptimizationMetrics['byPattern'],
  cap = 8,
): Array<{
  pattern: string;
  label: string;
  opportunities: number;
  savingsUsd: number;
  tokens: number;
}> {
  const sorted = [...byPattern].sort((a, b) => b.opportunities - a.opportunities);
  const head = sorted.slice(0, cap);
  const tail = sorted.slice(cap);
  const result = head.map((p) => ({
    pattern: p.pattern,
    label: prettifyPattern(p.pattern),
    opportunities: p.opportunities,
    savingsUsd: p.savingsRealized + p.savingsPotential,
    tokens: p.tokensRealized + p.tokensPotential,
  }));
  if (tail.length > 1) {
    result.push({
      pattern: '__other__',
      label: `Other (${tail.length})`,
      opportunities: tail.reduce((s, p) => s + p.opportunities, 0),
      savingsUsd: tail.reduce((s, p) => s + p.savingsRealized + p.savingsPotential, 0),
      tokens: tail.reduce((s, p) => s + p.tokensRealized + p.tokensPotential, 0),
    });
  } else if (tail.length === 1) {
    const p = tail[0];
    if (p) {
      result.push({
        pattern: p.pattern,
        label: prettifyPattern(p.pattern),
        opportunities: p.opportunities,
        savingsUsd: p.savingsRealized + p.savingsPotential,
        tokens: p.tokensRealized + p.tokensPotential,
      });
    }
  }
  return result;
}

/** Snake_case heuristic id → human-readable label.
 *  e.g. `short_turn_after_large_read` → `Short turn after large read`. */
export function prettifyPattern(pattern: string): string {
  if (pattern === '__none__') return 'Unclassified';
  if (!pattern) return 'Unclassified';
  const words = pattern.split('_');
  if (words.length === 0) return pattern;
  const first = words[0] ?? '';
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(' ');
}

/** Stable, deterministic color per curated subagent. Hand-mapped where
 *  possible (matches the existing realized/potential palette so the eye
 *  doesn't have to recalibrate). Unknown ids fall through to a slate
 *  fallback — they still render, they just don't get a brand color. */
export const SUBAGENT_COLORS: Readonly<Record<string, string>> = {
  'log-analyzer': '#34d399', // emerald
  'file-explorer': '#60a5fa', // sky
  'repo-mapper': '#a78bfa', // violet
  'diff-pre-pass': '#f472b6', // pink
  'output-formatter': '#fbbf24', // amber
  'web-fetcher': '#22d3ee', // cyan
  'test-runner-parser': '#fb923c', // orange
  'test-failure-investigator': '#f87171', // red
  'dep-tracer': '#c084fc', // purple
  'patch-applier': '#4ade80', // green
  'bulk-reader': '#facc15', // yellow
  'bash-loop-summarizer': '#94a3b8', // slate
};
const FALLBACK_COLOR = '#64748b';

export function colorForCuratedId(curatedId: string): string {
  return SUBAGENT_COLORS[curatedId] ?? FALLBACK_COLOR;
}

/** Sanity check: every digest-ed curated id should have a color so a
 *  fresh user with the full default install doesn't see fallback grey
 *  for a known subagent. Used by the helper test suite. */
export function knownCuratedIds(): readonly string[] {
  return Object.keys(DIGEST_TOKENS_BY_CURATED_ID);
}
