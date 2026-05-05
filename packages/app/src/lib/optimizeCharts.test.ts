import { describe, it, expect } from 'vitest';
import type { OptimizationMetrics } from '@claude-sentinel/shared';
import {
  buildBySubagentSeries,
  buildComparisonSeries,
  buildCumulativeSeries,
  buildPatternSeries,
  colorForCuratedId,
  curatedIdsInOrder,
  knownCuratedIds,
  prettifyPattern,
  SUBAGENT_COLORS,
  valueByUnits,
} from './optimizeCharts.js';

const dbsRow = (
  partial: Partial<OptimizationMetrics['dailyBySubagent'][number]>,
): OptimizationMetrics['dailyBySubagent'][number] => ({
  day: '2026-05-01',
  curatedId: 'log-analyzer',
  savingsRealized: 0,
  savingsPotential: 0,
  tokensRealized: 0,
  tokensPotential: 0,
  ...partial,
});

describe('valueByUnits', () => {
  it('rounds USD to 2 decimals to match Recharts axis ticks', () => {
    expect(valueByUnits('cost', 0.123456, 9999)).toBe(0.12);
    expect(valueByUnits('cost', 1.005, 0)).toBeCloseTo(1.0, 2);
  });

  it('rounds tokens to whole integers', () => {
    expect(valueByUnits('tokens', 0.5, 1234.7)).toBe(1235);
    expect(valueByUnits('tokens', 99, 0.4)).toBe(0);
  });
});

describe('curatedIdsInOrder', () => {
  it('returns each curatedId once, sorted alphabetically', () => {
    const ids = curatedIdsInOrder([
      dbsRow({ curatedId: 'log-analyzer' }),
      dbsRow({ curatedId: 'file-explorer', day: '2026-05-02' }),
      dbsRow({ curatedId: 'log-analyzer', day: '2026-05-02' }),
      dbsRow({ curatedId: 'diff-pre-pass' }),
    ]);
    expect(ids).toEqual(['diff-pre-pass', 'file-explorer', 'log-analyzer']);
  });

  it('returns [] for empty input', () => {
    expect(curatedIdsInOrder([])).toEqual([]);
  });
});

describe('buildBySubagentSeries', () => {
  it('reshapes long-format rows into wide-format Recharts data with zero-fill', () => {
    const { data, curatedIds } = buildBySubagentSeries(
      [
        dbsRow({ day: '2026-05-01', curatedId: 'file-explorer', savingsRealized: 0.4 }),
        dbsRow({ day: '2026-05-01', curatedId: 'log-analyzer', savingsPotential: 0.2 }),
        dbsRow({ day: '2026-05-02', curatedId: 'file-explorer', savingsRealized: 0.1 }),
        // 2026-05-02 has no log-analyzer entry; the helper must zero-fill.
      ],
      'cost',
    );
    expect(curatedIds).toEqual(['file-explorer', 'log-analyzer']);
    expect(data).toHaveLength(2);
    const day1 = data.find((d) => d['day'] === '05/01');
    const day2 = data.find((d) => d['day'] === '05/02');
    expect(day1?.['file-explorer']).toBe(0.4);
    expect(day1?.['log-analyzer']).toBe(0.2);
    expect(day2?.['file-explorer']).toBe(0.1);
    expect(day2?.['log-analyzer']).toBe(0); // explicit zero-fill
  });

  it('sums realized + potential by default ("total" field)', () => {
    const { data } = buildBySubagentSeries(
      [
        dbsRow({
          curatedId: 'log-analyzer',
          savingsRealized: 0.3,
          savingsPotential: 0.7,
        }),
      ],
      'cost',
    );
    expect(data[0]?.['log-analyzer']).toBe(1.0);
  });

  it('charts only realized when field="realized"', () => {
    const { data } = buildBySubagentSeries(
      [
        dbsRow({
          curatedId: 'log-analyzer',
          savingsRealized: 0.3,
          savingsPotential: 0.7,
        }),
      ],
      'cost',
      'realized',
    );
    expect(data[0]?.['log-analyzer']).toBe(0.3);
  });

  it('renders tokens by rounding the parent-context-tokens sum', () => {
    const { data } = buildBySubagentSeries(
      [
        dbsRow({
          curatedId: 'log-analyzer',
          tokensRealized: 7000,
          tokensPotential: 0.4,
        }),
      ],
      'tokens',
    );
    expect(data[0]?.['log-analyzer']).toBe(7000);
  });
});

describe('buildComparisonSeries', () => {
  it('drops rows whose realized + potential round to zero in the active units', () => {
    const rows = buildComparisonSeries(
      [
        {
          curatedId: 'a',
          savingsRealized: 0.5,
          savingsPotential: 0,
          tokensRealized: 0,
          tokensPotential: 0,
          opportunities: 1,
        },
        {
          curatedId: 'b',
          savingsRealized: 0.001, // rounds to 0.00 in cost
          savingsPotential: 0,
          tokensRealized: 0,
          tokensPotential: 0,
          opportunities: 1,
        },
      ],
      'cost',
    );
    expect(rows.map((r) => r.curatedId)).toEqual(['a']);
    expect(rows[0]?.realized).toBe(0.5);
    expect(rows[0]?.opportunities).toBe(1);
  });

  it('keeps a token row that would render at 1+ tokens even if its USD rounds to 0', () => {
    const rows = buildComparisonSeries(
      [
        {
          curatedId: 'a',
          savingsRealized: 0.001,
          savingsPotential: 0,
          tokensRealized: 7000,
          tokensPotential: 0,
          opportunities: 1,
        },
      ],
      'tokens',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.realized).toBe(7000);
  });
});

describe('buildCumulativeSeries', () => {
  it('produces a strictly running total of realized and total values', () => {
    const series = buildCumulativeSeries(
      [
        {
          day: '2026-05-01',
          savingsRealized: 0.5,
          savingsPotential: 0.2,
          tokensRealized: 0,
          tokensPotential: 0,
        },
        {
          day: '2026-05-02',
          savingsRealized: 0.3,
          savingsPotential: 0.0,
          tokensRealized: 0,
          tokensPotential: 0,
        },
        {
          day: '2026-05-03',
          savingsRealized: 0.1,
          savingsPotential: 0.4,
          tokensRealized: 0,
          tokensPotential: 0,
        },
      ],
      'cost',
    );
    expect(series.map((s) => s.realized)).toEqual([0.5, 0.8, 0.9]);
    expect(series.map((s) => s.potential)).toEqual([0.2, 0.2, 0.6]);
    // total = realized + potential at each step (cumulative)
    expect(series.map((s) => s.total)).toEqual([0.7, 1.0, 1.5]);
    // Day labels strip year and use slash separator
    expect(series.map((s) => s.day)).toEqual(['05/01', '05/02', '05/03']);
  });

  it('returns [] for empty daily input', () => {
    expect(buildCumulativeSeries([], 'cost')).toEqual([]);
  });

  it('rounds tokens to integers per step', () => {
    const series = buildCumulativeSeries(
      [
        {
          day: '2026-05-01',
          savingsRealized: 0,
          savingsPotential: 0,
          tokensRealized: 999.6,
          tokensPotential: 100.4,
        },
      ],
      'tokens',
    );
    expect(series[0]?.realized).toBe(1000);
    expect(series[0]?.potential).toBe(100);
    expect(series[0]?.total).toBe(1100);
  });
});

describe('buildPatternSeries', () => {
  const pat = (
    pattern: string,
    opportunities: number,
    savingsRealized = 0,
    savingsPotential = 0,
  ): OptimizationMetrics['byPattern'][number] => ({
    pattern,
    opportunities,
    savingsRealized,
    savingsPotential,
    tokensRealized: 0,
    tokensPotential: 0,
  });

  it('orders by opportunities desc and prettifies pattern labels', () => {
    const rows = buildPatternSeries([
      pat('low_count', 2),
      pat('high_count', 9),
      pat('mid_count', 5),
    ]);
    expect(rows.map((r) => r.pattern)).toEqual(['high_count', 'mid_count', 'low_count']);
    expect(rows[0]?.label).toBe('High count');
  });

  it('caps to top N rows and rolls the remainder into "Other (N)"', () => {
    const rows = buildPatternSeries(
      Array.from({ length: 12 }, (_, i) => pat(`pattern_${i}`, 12 - i)),
      3,
    );
    expect(rows).toHaveLength(4); // 3 head + 1 "Other"
    expect(rows[3]?.pattern).toBe('__other__');
    expect(rows[3]?.label).toBe('Other (9)');
    // Other's opportunities = sum of the bottom 9 (counts 9..1)
    expect(rows[3]?.opportunities).toBe(9 + 8 + 7 + 6 + 5 + 4 + 3 + 2 + 1);
  });

  it('does not synthesize a single-entry "Other" — promotes the lone tail row instead', () => {
    const rows = buildPatternSeries([pat('a', 5), pat('b', 4), pat('c', 3), pat('d', 2)], 3);
    expect(rows).toHaveLength(4);
    expect(rows[3]?.pattern).toBe('d'); // not '__other__'
    expect(rows[3]?.label).toBe('D');
  });

  it('returns [] for empty input', () => {
    expect(buildPatternSeries([])).toEqual([]);
  });
});

describe('prettifyPattern', () => {
  it('converts snake_case to sentence case', () => {
    expect(prettifyPattern('short_turn_after_large_read')).toBe('Short turn after large read');
  });

  it('renders "Unclassified" for empty string and the __none__ sentinel', () => {
    expect(prettifyPattern('')).toBe('Unclassified');
    expect(prettifyPattern('__none__')).toBe('Unclassified');
  });

  it('returns single-word patterns unchanged besides capitalization', () => {
    expect(prettifyPattern('foo')).toBe('Foo');
  });
});

describe('colorForCuratedId / SUBAGENT_COLORS', () => {
  it('returns a stable color for each known curatedId', () => {
    expect(colorForCuratedId('log-analyzer')).toBe(SUBAGENT_COLORS['log-analyzer']);
    expect(colorForCuratedId('file-explorer')).toBe(SUBAGENT_COLORS['file-explorer']);
  });

  it('falls back to a slate hex for unknown ids', () => {
    expect(colorForCuratedId('totally-fake-subagent')).toBe('#64748b');
  });

  it('has a color defined for every curated id that ships with a digest', () => {
    const missing = knownCuratedIds().filter((id) => !(id in SUBAGENT_COLORS));
    expect(missing).toEqual([]);
  });
});
