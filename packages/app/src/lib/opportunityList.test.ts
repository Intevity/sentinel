import { describe, it, expect } from 'vitest';
import {
  buildListRequest,
  formatBytes,
  formatUsd,
  humanPattern,
  relativeTime,
  savingsColorClass,
} from './opportunityList.js';

describe('buildListRequest', () => {
  it("status='all' + curated='all' fetches every measured row", () => {
    const r = buildListRequest('all', 'all', 50, 0, '');
    expect(r.type).toBe('list_optimization_events');
    expect(r.kind).toBe('measured');
    expect(r.realized).toBeUndefined();
    expect(r.curatedId).toBeUndefined();
    expect(r.limit).toBe(50);
    expect(r.offset).toBe(0);
    expect(r.search).toBeUndefined();
  });

  it("status='realized' adds realized=true and kind=measured", () => {
    const r = buildListRequest('realized', 'all', 50, 0, '');
    expect(r.kind).toBe('measured');
    expect(r.realized).toBe(true);
  });

  it("status='potential' adds realized=false, kind=measured, and positiveSavingsOnly=true", () => {
    // The positiveSavingsOnly flag hides misfit-warning rows
    // ("subagent would have cost more") from the Potential view since
    // they aren't actionable opportunities.
    const r = buildListRequest('potential', 'all', 50, 0, '');
    expect(r.kind).toBe('measured');
    expect(r.realized).toBe(false);
    expect(r.positiveSavingsOnly).toBe(true);
  });

  it("status='dismissed' switches kind and drops the realized filter", () => {
    const r = buildListRequest('dismissed', 'all', 50, 0, '');
    expect(r.kind).toBe('dismissed');
    expect(r.realized).toBeUndefined();
  });

  it("status='regression' sets regressionsOnly and lets the daemon pin kind/realized", () => {
    // The daemon translates regressionsOnly into
    // (kind='measured', realized=true, savings_usd ≤ -0.005). We don't
    // re-send the kind/realized fields from the UI to keep the payload
    // unambiguous about which surface owns the threshold.
    const r = buildListRequest('regression', 'all', 50, 0, '');
    expect(r.regressionsOnly).toBe(true);
    expect(r.kind).toBeUndefined();
    expect(r.realized).toBeUndefined();
  });

  it('curated id !== "all" populates curatedId', () => {
    const r = buildListRequest('all', 'file-explorer', 100, 0, '');
    expect(r.curatedId).toBe('file-explorer');
  });

  it('curated id === "all" omits curatedId', () => {
    const r = buildListRequest('all', 'all', 100, 0, '');
    expect(r.curatedId).toBeUndefined();
  });

  it('passes through offset for server-side pagination', () => {
    const r = buildListRequest('all', 'all', 50, 100, '');
    expect(r.offset).toBe(100);
  });

  it('trims search and omits the field when empty', () => {
    expect(buildListRequest('all', 'all', 50, 0, '').search).toBeUndefined();
    expect(buildListRequest('all', 'all', 50, 0, '   ').search).toBeUndefined();
    expect(buildListRequest('all', 'all', 50, 0, '  foo ').search).toBe('foo');
  });
});

describe('humanPattern', () => {
  it('translates known pattern keys to readable labels', () => {
    expect(humanPattern('short_turn_after_large_read')).toBe('Large read, no follow-up quote');
    expect(humanPattern('repeat_read_cross_session')).toBe('Same file read across sessions');
    expect(humanPattern('diff_pre_pass')).toBe('Read+Edit cycles across multiple files');
  });

  it('falls back to the raw key for unknown patterns', () => {
    expect(humanPattern('some_new_pattern')).toBe('some_new_pattern');
  });

  it('renders an "unknown" placeholder for null', () => {
    // No em-dashes in user-facing text per project convention.
    expect(humanPattern(null)).toBe('unknown');
  });
});

describe('formatUsd', () => {
  it('formats positive amounts with two decimals', () => {
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('preserves the sign on meaningfully negative amounts', () => {
    // The dashboard shows realized=-$0.05 when a misfit subagent costs
    // more than the inline tool calls; the leading "-" is load-bearing.
    expect(formatUsd(-0.05)).toBe('-$0.05');
  });

  it('clamps near-zero values to "$0.00" without a sign', () => {
    // Avoids the misleading "-$0.00" the user saw on rows where the
    // counterfactual savings rounded to zero — sub-half-cent noise is
    // not a "negative" anything.
    expect(formatUsd(-0.001)).toBe('$0.00');
    expect(formatUsd(-0.004)).toBe('$0.00');
    expect(formatUsd(0.0001)).toBe('$0.00');
  });

  it('returns to a signed render at the half-cent boundary', () => {
    expect(formatUsd(-0.005)).toBe('-$0.01'); // toFixed rounds to .01
    expect(formatUsd(0.005)).toBe('$0.01');
  });
});

describe('savingsColorClass', () => {
  it('reads emerald for meaningful gains', () => {
    expect(savingsColorClass(0.5)).toBe('text-emerald-300');
    expect(savingsColorClass(0.005)).toBe('text-emerald-300');
  });

  it('reads red for meaningful losses', () => {
    expect(savingsColorClass(-0.5)).toBe('text-red-400');
    expect(savingsColorClass(-0.005)).toBe('text-red-400');
  });

  it('stays neutral inside the noise floor (matches formatUsd)', () => {
    expect(savingsColorClass(0)).toBe('text-foreground/70');
    expect(savingsColorClass(-0.001)).toBe('text-foreground/70');
    expect(savingsColorClass(0.004)).toBe('text-foreground/70');
  });
});

describe('formatBytes', () => {
  it('handles null with a non-em-dash placeholder', () => {
    expect(formatBytes(null)).toBe('n/a');
  });
  it('keeps small sizes in bytes', () => {
    expect(formatBytes(800)).toBe('800B');
  });
  it('renders KB for the 1KB–1MB range', () => {
    expect(formatBytes(1500)).toBe('1.5KB');
    expect(formatBytes(50_000)).toBe('48.8KB');
  });
  it('renders MB above 1MB', () => {
    expect(formatBytes(2_500_000)).toBe('2.4MB');
  });
});

describe('relativeTime', () => {
  // Event happened at t=10_000_000; the source tool calls precede it.
  const evTs = 10_000_000;
  it('renders seconds-before for sub-minute deltas', () => {
    expect(relativeTime(evTs - 30_000, evTs)).toBe('30s before');
  });
  it('renders minutes-before for minute-scale deltas', () => {
    expect(relativeTime(evTs - 5 * 60_000, evTs)).toBe('5m before');
  });
  it('renders hours-before for hour-scale deltas', () => {
    expect(relativeTime(evTs - 2 * 3600_000, evTs)).toBe('2h before');
  });
  it('renders "after event" when callTs > evTs (defensive against pruning races)', () => {
    expect(relativeTime(evTs + 1000, evTs)).toBe('after event');
  });
});
