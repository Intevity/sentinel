import type { OptimizeRangePreset } from './types.js';

/**
 * Single source of truth for which date-range presets the Optimize and
 * Metrics pages offer for a given retention window.
 *
 * Each page keeps its own retention setting ({@link Settings.optimizeRetentionDays},
 * {@link Settings.metricsRetentionDays}); presets wider than the window would
 * always render partially-purged data, so the selector ladder tops out at the
 * largest preset the window fully covers. Every ladder has exactly 6 rungs
 * (plus the always-present All and Custom, which the caller appends): shorter
 * windows swap the wide rungs for finer ones (2W, 2M) so the segmented control
 * stays visually full instead of going sparse.
 *
 * Shared between the frontend (RangeSelector renders the ladder) and the
 * daemon (settings coerce snaps a persisted off-ladder preset back onto
 * the ladder) so the two can never disagree.
 */

/** A preset with a concrete window width: everything except all/custom. */
type DatedPreset = Exclude<OptimizeRangePreset, 'all' | 'custom'>;

/** Approximate width of each dated preset in days, used only to rank rungs
 *  when snapping (window/purge math stays exact elsewhere). */
const PRESET_DAYS: Record<DatedPreset, number> = {
  '1d': 1,
  '1w': 7,
  '2w': 14,
  '1m': 30,
  '2m': 60,
  '3m': 90,
  '6m': 180,
  '1y': 365,
};

/** Ladder for retention >= 1 year: exactly the historical preset set. Range
 *  presets deliberately top out at 1Y even for 2-3 year windows; All / Custom
 *  cover anything wider. */
const LADDER_1Y: readonly DatedPreset[] = ['1d', '1w', '1m', '3m', '6m', '1y'];
/** Ladder for retention in [6 months, 1 year). */
const LADDER_6M: readonly DatedPreset[] = ['1d', '1w', '2w', '1m', '3m', '6m'];
/** Ladder for retention below 6 months (the daemon clamps retention to a
 *  90-day floor, so in practice this is [3 months, 6 months)). */
const LADDER_3M: readonly DatedPreset[] = ['1d', '1w', '2w', '1m', '2m', '3m'];

/**
 * The 6 range presets a page should offer for a retention window of
 * `retentionDays`. Top rung is the largest preset fully covered by the
 * window. Defensive on unclamped input: anything below the 180-day
 * breakpoint gets the 3M ladder.
 */
export function rangeLadder(retentionDays: number): OptimizeRangePreset[] {
  return [...ladderFor(retentionDays)];
}

function ladderFor(retentionDays: number): readonly DatedPreset[] {
  if (retentionDays >= 365) return LADDER_1Y;
  if (retentionDays >= 180) return LADDER_6M;
  return LADDER_3M;
}

/**
 * Snap a persisted range preset onto the ladder for `retentionDays`.
 * `all` and `custom` are always valid. An off-ladder preset maps to the
 * widest rung that is not wider than it, which preserves intent in both
 * directions: `1y` after retention dropped to 6 months snaps DOWN to the
 * 6M top rung, and `2w` after retention grew to 1 year (whose ladder has
 * no 2W rung) snaps to the adjacent `1w` instead of ballooning to the top.
 */
export function snapRangeToLadder(
  range: OptimizeRangePreset,
  retentionDays: number,
): OptimizeRangePreset {
  if (range === 'all' || range === 'custom') return range;
  const ladder = ladderFor(retentionDays);
  if (ladder.includes(range)) return range;
  const notWider = ladder.filter((r) => PRESET_DAYS[r] <= PRESET_DAYS[range]);
  // Every ladder starts at 1d, so notWider is never empty; the fallback is
  // for type narrowing only.
  return notWider[notWider.length - 1] ?? ladder[0]!;
}
