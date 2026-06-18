import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  collapseBlankLines,
  collapseDuplicateLines,
  collapseStackTraces,
  extractLogErrors,
  truncateLog,
  type ErrorExtractOpts,
} from './text-rules.js';
import {
  tryParseJson,
  minifyJsonWhitespace,
  tabularDedup,
  sampleJsonArray,
  type SampleOpts,
} from './json-rules.js';
import { hashOriginal } from './types.js';
import { compressToolResultText } from './tiers.js';

const ESC = '\x1b';

describe('stripAnsi', () => {
  it('removes CSI color codes', () => {
    const input = `${ESC}[31mred${ESC}[0m and ${ESC}[1;32mgreen${ESC}[0m`;
    expect(stripAnsi(input)).toBe('red and green');
  });

  it('removes OSC hyperlink/title sequences', () => {
    const input = `${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`;
    expect(stripAnsi(input)).toBe('link');
  });

  it('returns the same instance when there is no escape byte', () => {
    const input = 'plain text, no escapes';
    expect(stripAnsi(input)).toBe(input);
  });

  it('is idempotent', () => {
    const input = `${ESC}[31mred${ESC}[0m\n${ESC}[2Kspinner`;
    const once = stripAnsi(input);
    expect(stripAnsi(once)).toBe(once);
    // And no ESC byte survives.
    expect(once.indexOf(ESC)).toBe(-1);
  });
});

describe('collapseBlankLines', () => {
  it('collapses 3+ blank lines to a single empty line', () => {
    expect(collapseBlankLines('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('normalizes whitespace-only lines to empty', () => {
    expect(collapseBlankLines('a\n   \n\t\nb')).toBe('a\n\nb');
  });

  it('leaves a single blank line untouched in shape', () => {
    expect(collapseBlankLines('a\n\nb')).toBe('a\n\nb');
  });

  it('is idempotent', () => {
    const input = 'x\n\n\n\n\ny\n\n\nz';
    const once = collapseBlankLines(input);
    expect(collapseBlankLines(once)).toBe(once);
  });

  it('returns empty string unchanged', () => {
    expect(collapseBlankLines('')).toBe('');
  });
});

describe('collapseDuplicateLines', () => {
  it('collapses runs of identical adjacent lines to one', () => {
    expect(collapseDuplicateLines('loading\nloading\nloading\ndone')).toBe('loading\ndone');
  });

  it('keeps non-adjacent duplicates', () => {
    expect(collapseDuplicateLines('a\nb\na')).toBe('a\nb\na');
  });

  it('is idempotent', () => {
    const input = 'p\np\np\nq\nq\nr';
    const once = collapseDuplicateLines(input);
    expect(collapseDuplicateLines(once)).toBe(once);
  });

  it('returns empty string unchanged', () => {
    expect(collapseDuplicateLines('')).toBe('');
  });
});

describe('collapseStackTraces', () => {
  const frames = (n: number): string =>
    Array.from({ length: n }, (_, i) => `    at fn${i} (file.js:${i}:1)`).join('\n');

  it('collapses a long run keeping head and tail frames', () => {
    const input = `Error: boom\n${frames(40)}\nafter`;
    const out = collapseStackTraces(input, 8);
    const lines = out.split('\n');
    // header + 8 head + 1 marker + 8 tail + trailing line = 19
    expect(lines[0]).toBe('Error: boom');
    expect(out).toContain('[24 stack frames elided by Sentinel]');
    expect(lines[lines.length - 1]).toBe('after');
    expect(lines).toHaveLength(19);
  });

  it('leaves short stack runs untouched (returns same string)', () => {
    const input = `Error\n${frames(5)}`;
    expect(collapseStackTraces(input, 8)).toBe(input);
  });

  it('is idempotent (marker is not a frame line, so no re-trigger)', () => {
    const input = `Error\n${frames(60)}`;
    const once = collapseStackTraces(input, 8);
    expect(collapseStackTraces(once, 8)).toBe(once);
  });

  it('returns input when keep < 1', () => {
    const input = `Error\n${frames(60)}`;
    expect(collapseStackTraces(input, 0)).toBe(input);
  });
});

describe('truncateLog', () => {
  const opts = { triggerLines: 300, headLines: 120, tailLines: 120 };
  const bigLog = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');

  it('keeps head + tail with an elision marker when over the trigger', () => {
    const out = truncateLog(bigLog, opts);
    const lines = out.split('\n');
    expect(lines).toHaveLength(120 + 1 + 120);
    expect(lines[0]).toBe('line 0');
    expect(lines[lines.length - 1]).toBe('line 499');
    expect(out).toContain('[260 lines elided by Sentinel]');
  });

  it('leaves output under the trigger untouched', () => {
    const small = Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n');
    expect(truncateLog(small, opts)).toBe(small);
  });

  it('is idempotent: a once-truncated result never re-triggers', () => {
    const once = truncateLog(bigLog, opts);
    expect(once.split('\n').length).toBeLessThanOrEqual(opts.triggerLines);
    expect(truncateLog(once, opts)).toBe(once);
  });
});

describe('extractLogErrors', () => {
  const opts: ErrorExtractOpts = {
    triggerLines: 80,
    headLines: 3,
    tailLines: 3,
    contextLines: 1,
    minRun: 4,
  };
  // A pytest-style run: header, a long passing run, a failure with detail,
  // another passing run, and a summary.
  const pytestLog = (): string =>
    [
      '============================= test session starts ==============================',
      'platform linux -- Python 3.11.4',
      'collected 250 items',
      ...Array.from({ length: 120 }, (_, i) => `tests/test_a.py::test_${i} PASSED`),
      'tests/test_a.py::test_boom FAILED',
      'E   AssertionError: expected 1 but got 2',
      ...Array.from({ length: 120 }, (_, i) => `tests/test_b.py::test_${i} PASSED`),
      '=========================== 1 failed, 240 passed in 3.21s ======================',
    ].join('\n');

  it('keeps the error lines and head/tail, eliding long passing runs', () => {
    const out = extractLogErrors(pytestLog(), opts);
    expect(out).toContain('elided by Sentinel');
    expect(out).toContain('test_boom FAILED');
    expect(out).toContain('AssertionError: expected 1 but got 2');
    expect(out).toContain('test session starts');
    expect(out).toContain('1 failed, 240 passed');
    // Far smaller than the ~245-line original.
    expect(out.split('\n').length).toBeLessThan(40);
  });

  it('embeds a retrieval id under reversible mode and omits it otherwise', () => {
    const ids: string[] = [];
    const withId = extractLogErrors(pytestLog(), opts, (_rule, elided) => {
      const id = `hash-${ids.length}`;
      ids.push(elided);
      return id;
    });
    expect(withId).toContain('id="hash-0"');
    // The captured run is real passing-test output.
    expect(ids[0]).toContain('PASSED');
    const withoutId = extractLogErrors(pytestLog(), opts);
    expect(withoutId).not.toContain('id=');
  });

  it('returns the input unchanged when no build/test framework is detected', () => {
    const prose = Array.from({ length: 200 }, (_, i) => `paragraph line number ${i}`).join('\n');
    expect(extractLogErrors(prose, opts)).toBe(prose);
  });

  it('returns the input unchanged when under the line trigger', () => {
    const short = ['=== test session starts ===', 'collected 2 items', 'x PASSED', 'y PASSED'].join(
      '\n',
    );
    expect(extractLogErrors(short, opts)).toBe(short);
  });

  it('returns the input unchanged when no run reaches minRun', () => {
    // Framework detected and over-trigger, but minRun is huge so nothing elides.
    const out = extractLogErrors(pytestLog(), { ...opts, minRun: 10_000 });
    expect(out).toBe(pytestLog());
  });

  it('does not re-process text that already carries an elision marker', () => {
    const marked = `=== test session starts ===\n${Array.from({ length: 90 }, () => 'noise').join('\n')}\n... [12 lines elided by Sentinel] ...\ndone`;
    expect(extractLogErrors(marked, opts)).toBe(marked);
  });

  it('is idempotent', () => {
    const once = extractLogErrors(pytestLog(), opts);
    expect(extractLogErrors(once, opts)).toBe(once);
  });

  it('keeps short gaps verbatim while eliding long runs', () => {
    const o: ErrorExtractOpts = {
      triggerLines: 10,
      headLines: 1,
      tailLines: 1,
      contextLines: 0,
      minRun: 4,
    };
    const lines = [
      '=== test session starts ===',
      'error one',
      'gap-a',
      'gap-b', // 2-line gap (< minRun) -> kept verbatim
      'error two',
      'noise0',
      'noise1',
      'noise2',
      'noise3',
      'noise4', // 5-line run (>= minRun) -> elided
      'summary line',
    ];
    const out = extractLogErrors(lines.join('\n'), o);
    expect(out).toContain('gap-a');
    expect(out).toContain('gap-b');
    expect(out).toContain('elided by Sentinel');
    expect(out).not.toContain('noise2');
  });

  it('is deterministic', () => {
    expect(extractLogErrors(pytestLog(), opts)).toBe(extractLogErrors(pytestLog(), opts));
  });
});

describe('tryParseJson', () => {
  it('parses objects and arrays', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(tryParseJson('  [1,2]')).toEqual({ ok: true, value: [1, 2] });
  });

  it('fast-rejects non-object/array starts without parsing', () => {
    expect(tryParseJson('"a string"')).toEqual({ ok: false });
    expect(tryParseJson('42')).toEqual({ ok: false });
    expect(tryParseJson('')).toEqual({ ok: false });
  });

  it('rejects malformed JSON that starts with a brace', () => {
    expect(tryParseJson('{not json')).toEqual({ ok: false });
  });
});

describe('minifyJsonWhitespace', () => {
  it('removes insignificant whitespace', () => {
    expect(minifyJsonWhitespace('{\n  "a": 1,\n  "b": [1, 2]\n}')).toBe('{"a":1,"b":[1,2]}');
  });

  it('preserves whitespace inside string values', () => {
    expect(minifyJsonWhitespace('{ "msg": "a  b\\tc" }')).toBe('{"msg":"a  b\\tc"}');
  });

  it('preserves number representation exactly (no parse round-trip)', () => {
    // A parse/re-stringify would turn 1.0 into 1 and lose big-int precision.
    expect(minifyJsonWhitespace('{ "x": 1.0, "big": 12345678901234567890 }')).toBe(
      '{"x":1.0,"big":12345678901234567890}',
    );
  });

  it('returns input unchanged when not valid JSON', () => {
    expect(minifyJsonWhitespace('not json {')).toBe('not json {');
  });

  it('handles escaped quotes inside strings', () => {
    expect(minifyJsonWhitespace('{ "q": "she said \\"hi\\"" }')).toBe('{"q":"she said \\"hi\\""}');
  });

  it('is idempotent', () => {
    const once = minifyJsonWhitespace('{ "a": [ 1, 2, 3 ] }');
    expect(minifyJsonWhitespace(once)).toBe(once);
  });
});

describe('tabularDedup', () => {
  const rows = (n: number): unknown[] =>
    Array.from({ length: n }, (_, i) => ({ id: i, name: `n${i}`, active: true }));

  it('folds a homogeneous array of objects into columns/rows', () => {
    const value = rows(5);
    const out = tabularDedup(JSON.stringify(value), value);
    const parsed = JSON.parse(out) as { _sentinelTable: { columns: string[]; rows: unknown[][] } };
    expect(parsed._sentinelTable.columns).toEqual(['id', 'name', 'active']);
    expect(parsed._sentinelTable.rows).toHaveLength(5);
    expect(parsed._sentinelTable.rows[0]).toEqual([0, 'n0', true]);
  });

  it('preserves all values losslessly', () => {
    const value = rows(6);
    const out = tabularDedup(JSON.stringify(value), value);
    const parsed = JSON.parse(out) as { _sentinelTable: { columns: string[]; rows: unknown[][] } };
    // Reconstruct and compare.
    const reconstructed = parsed._sentinelTable.rows.map((r) =>
      Object.fromEntries(parsed._sentinelTable.columns.map((c, i) => [c, r[i]])),
    );
    expect(reconstructed).toEqual(value);
  });

  it('does not fold arrays below the row threshold', () => {
    const value = rows(4);
    const text = JSON.stringify(value);
    expect(tabularDedup(text, value)).toBe(text);
  });

  it('does not fold heterogeneous arrays', () => {
    const value = [{ a: 1 }, { a: 1, b: 2 }, { a: 1 }, { a: 1 }, { a: 1 }];
    const text = JSON.stringify(value);
    expect(tabularDedup(text, value)).toBe(text);
  });

  it('does not fold arrays of non-objects', () => {
    const value = [1, 2, 3, 4, 5];
    const text = JSON.stringify(value);
    expect(tabularDedup(text, value)).toBe(text);
  });

  it('does not fold objects with no keys', () => {
    const value = [{}, {}, {}, {}, {}];
    const text = JSON.stringify(value);
    expect(tabularDedup(text, value)).toBe(text);
  });

  it('does not fold objects with the same key count but different keys', () => {
    const value = [{ a: 1 }, { b: 1 }, { a: 1 }, { a: 1 }, { a: 1 }];
    const text = JSON.stringify(value);
    expect(tabularDedup(text, value)).toBe(text);
  });

  it('is idempotent: a folded object is not an array, so it never re-folds', () => {
    const value = rows(8);
    const once = tabularDedup(JSON.stringify(value), value);
    const reparsed = tryParseJson(once);
    expect(reparsed.ok).toBe(true);
    expect(tabularDedup(once, reparsed.value)).toBe(once);
  });

  it('expands a uniform depth-1 nested object into dotted columns in place', () => {
    const value = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      addr: { city: `c${i}`, zip: i * 10 },
      ok: true,
    }));
    const out = tabularDedup(JSON.stringify(value), value);
    const parsed = JSON.parse(out) as { _sentinelTable: { columns: string[]; rows: unknown[][] } };
    // Dotted columns sit at the parent's position, sub-keys in row-0 order.
    expect(parsed._sentinelTable.columns).toEqual(['id', 'addr.city', 'addr.zip', 'ok']);
    expect(parsed._sentinelTable.rows[0]).toEqual([0, 'c0', 0, true]);
    expect(parsed._sentinelTable.rows[4]).toEqual([4, 'c4', 40, true]);
  });

  it('reconstructs the original nested objects from dotted columns losslessly', () => {
    const value = Array.from({ length: 6 }, (_, i) => ({
      id: i,
      addr: { city: `c${i}`, zip: i * 10 },
    }));
    const out = tabularDedup(JSON.stringify(value), value);
    const parsed = JSON.parse(out) as { _sentinelTable: { columns: string[]; rows: unknown[][] } };
    const reconstructed = parsed._sentinelTable.rows.map((r) => {
      const obj: Record<string, unknown> = {};
      parsed._sentinelTable.columns.forEach((c, i) => {
        const dot = c.indexOf('.');
        if (dot === -1) {
          obj[c] = r[i];
        } else {
          const parent = c.slice(0, dot);
          const sub = c.slice(dot + 1);
          const nested = (obj[parent] as Record<string, unknown>) ?? {};
          nested[sub] = r[i];
          obj[parent] = nested;
        }
      });
      return obj;
    });
    expect(reconstructed).toEqual(value);
  });

  it('does not expand a nested key when one row is missing a sub-key', () => {
    const value = [
      { id: 0, addr: { city: 'a', zip: 1 } },
      { id: 1, addr: { city: 'b', zip: 2 } },
      { id: 2, addr: { city: 'c' } }, // missing zip => non-uniform sub-signature
      { id: 3, addr: { city: 'd', zip: 4 } },
      { id: 4, addr: { city: 'e', zip: 5 } },
    ];
    const out = tabularDedup(JSON.stringify(value), value);
    const parsed = JSON.parse(out) as { _sentinelTable: { columns: string[]; rows: unknown[][] } };
    // addr stays a single column carrying the verbatim nested object.
    expect(parsed._sentinelTable.columns).toEqual(['id', 'addr']);
    expect(parsed._sentinelTable.rows[2]).toEqual([2, { city: 'c' }]);
  });

  it('does not expand a key whose dotted name collides with another top-level key', () => {
    const value = Array.from({ length: 5 }, (_, i) => ({
      meta: { region: `r${i}` },
      'meta.region': i,
    }));
    const out = tabularDedup(JSON.stringify(value), value);
    const parsed = JSON.parse(out) as { _sentinelTable: { columns: string[]; rows: unknown[][] } };
    // meta would produce 'meta.region', colliding with the literal top-level
    // key 'meta.region', so meta is kept whole.
    expect(parsed._sentinelTable.columns).toEqual(['meta', 'meta.region']);
    expect(parsed._sentinelTable.rows[0]).toEqual([{ region: 'r0' }, 0]);
  });

  it('mixes flat and dotted columns and keeps nested array values as cells', () => {
    const value = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      dims: { w: i, h: i + 1 },
      tags: ['a', 'b'],
    }));
    const out = tabularDedup(JSON.stringify(value), value);
    const parsed = JSON.parse(out) as { _sentinelTable: { columns: string[]; rows: unknown[][] } };
    // dims expands (uniform object); tags stays a single column (array, not a
    // plain object) with the array verbatim as the cell value (depth 1).
    expect(parsed._sentinelTable.columns).toEqual(['id', 'dims.w', 'dims.h', 'tags']);
    expect(parsed._sentinelTable.rows[2]).toEqual([2, 2, 3, ['a', 'b']]);
  });

  it('keeps a nested-array-valued sub-column verbatim (depth 1 only)', () => {
    const value = Array.from({ length: 5 }, (_, i) => ({
      box: { label: `b${i}`, points: [i, i + 1] },
    }));
    const out = tabularDedup(JSON.stringify(value), value);
    const parsed = JSON.parse(out) as { _sentinelTable: { columns: string[]; rows: unknown[][] } };
    expect(parsed._sentinelTable.columns).toEqual(['box.label', 'box.points']);
    // points is an array sub-value: used as-is, not recursively flattened.
    expect(parsed._sentinelTable.rows[3]).toEqual(['b3', [3, 4]]);
  });
});

describe('sampleJsonArray', () => {
  const opts: SampleOpts = { minRows: 30, headN: 3, tailN: 3, sigma: 2 };
  const sample = (
    value: unknown,
    o: SampleOpts = opts,
    onElide?: Parameters<typeof sampleJsonArray>[3],
  ) => sampleJsonArray(JSON.stringify(value), value, o, onElide);

  it('keeps head/tail and drops the uniform middle of a large array', () => {
    const value = Array.from({ length: 60 }, (_, i) => ({ id: i, name: `item-${i}` }));
    const out = JSON.parse(sample(value)) as {
      _sentinelSample: { kept: Array<{ id: number }>; droppedCount: number; note: string };
    };
    expect(out._sentinelSample.droppedCount).toBe(54);
    expect(out._sentinelSample.kept.map((k) => k.id)).toEqual([0, 1, 2, 57, 58, 59]);
    expect(out._sentinelSample.note).toContain('54 of 60 items elided by Sentinel');
  });

  it('always keeps error-like items wherever they sit', () => {
    const value = Array.from({ length: 40 }, (_, i) =>
      i === 20 ? { id: i, status: 'connection error' } : { id: i, status: 'ok' },
    );
    const out = JSON.parse(sample(value)) as {
      _sentinelSample: { kept: Array<{ id: number; status: string }> };
    };
    expect(
      out._sentinelSample.kept.some((k) => k.id === 20 && k.status === 'connection error'),
    ).toBe(true);
  });

  it('keeps error-like string items and items with an error-ish key', () => {
    const strs = Array.from({ length: 40 }, (_, i) => (i === 10 ? 'fatal: disk gone' : `row ${i}`));
    const a = JSON.parse(sample(strs)) as { _sentinelSample: { kept: string[] } };
    expect(a._sentinelSample.kept).toContain('fatal: disk gone');

    const objs = Array.from({ length: 40 }, (_, i) =>
      i === 17 ? { id: i, errors: 3 } : { id: i, ok: true },
    );
    const b = JSON.parse(sample(objs)) as {
      _sentinelSample: { kept: Array<Record<string, unknown>> };
    };
    expect(b._sentinelSample.kept.some((k) => k['errors'] === 3)).toBe(true);
  });

  it('keeps a numeric outlier item in an object array', () => {
    const value = Array.from({ length: 30 }, (_, i) => ({ v: i === 15 ? 100_000 : 1 }));
    const out = JSON.parse(sample(value)) as { _sentinelSample: { kept: Array<{ v: number }> } };
    expect(out._sentinelSample.kept.some((k) => k.v === 100_000)).toBe(true);
  });

  it('keeps a numeric outlier in a primitive number array', () => {
    const value = [...Array(15).fill(1), 9999, ...Array(14).fill(1)];
    const out = JSON.parse(sample(value)) as { _sentinelSample: { kept: number[] } };
    expect(out._sentinelSample.kept).toContain(9999);
  });

  it('flags nothing when a numeric field has zero variance', () => {
    // All ids identical => std 0 => no outliers; only head/tail dropped the rest.
    const value = Array.from({ length: 40 }, () => ({ id: 7 }));
    const out = JSON.parse(sample(value)) as { _sentinelSample: { kept: unknown[] } };
    // head 3 + tail 3, nothing extra flagged.
    expect(out._sentinelSample.kept).toHaveLength(6);
  });

  it('leaves arrays below minRows untouched', () => {
    const value = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    expect(sample(value)).toBe(JSON.stringify(value));
  });

  it('returns the input when every item qualifies to keep', () => {
    const value = Array.from({ length: 30 }, (_, i) => ({ msg: `error ${i}` }));
    expect(sample(value)).toBe(JSON.stringify(value));
  });

  it('is reversible: the capture restores the exact original array', () => {
    const value = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const captures: Array<{ rule: string; original: string }> = [];
    const out = sample(value, opts, (rule, original) => {
      captures.push({ rule, original });
      return 'cap-1';
    });
    const parsed = JSON.parse(out) as { _sentinelSample: { note: string } };
    expect(parsed._sentinelSample.note).toContain('id="cap-1"');
    expect(captures[0]?.rule).toBe('json_sample');
    // The captured original parses back to the exact input array.
    expect(JSON.parse(captures[0]!.original)).toEqual(value);
  });

  it('omits the retrieval id when reversible mode is off', () => {
    const value = Array.from({ length: 40 }, (_, i) => ({ id: i }));
    expect(sample(value)).not.toContain('id=');
  });

  it('summarizes dropped numeric fields with exact hand-computed stats', () => {
    // 30 objects with a numeric field `v`. head 3 + tail 3 kept, 24 dropped.
    // Use values that exercise even-count median and 4-decimal rounding.
    const all = [
      0, // kept (head)
      1, // kept (head)
      2, // kept (head)
      ...Array.from({ length: 24 }, (_, i) => i + 3), // dropped: 3..26
      27, // kept (tail)
      28, // kept (tail)
      29, // kept (tail)
    ];
    const value = all.map((v) => ({ v }));
    const o: SampleOpts = { minRows: 30, headN: 3, tailN: 3, sigma: 100 };
    const out = JSON.parse(sample(value, o)) as {
      _sentinelSample: {
        droppedCount: number;
        stats: Record<
          string,
          { count: number; min: number; max: number; mean: number; median: number; stdev: number }
        >;
      };
    };
    expect(out._sentinelSample.droppedCount).toBe(24);
    const dropped = Array.from({ length: 24 }, (_, i) => i + 3); // 3..26
    const count = dropped.length; // 24
    const sum = dropped.reduce((a, b) => a + b, 0); // 3+..+26 = 348
    const mean = sum / count; // 14.5
    const variance = dropped.reduce((a, b) => a + (b - mean) ** 2, 0) / count;
    const stdev = Math.round(Math.sqrt(variance) * 1e4) / 1e4; // population stdev, round4
    // Even count => mean of the two middle elements: (14 + 15) / 2 = 14.5
    const median = (dropped[11]! + dropped[12]!) / 2;
    expect(out._sentinelSample.stats['v']).toEqual({
      count: 24,
      min: 3,
      max: 26,
      mean: 14.5,
      median: 14.5,
      stdev,
    });
    expect(median).toBe(14.5);
  });

  it('rounds mean/median/stdev to exactly 4 decimals', () => {
    // Three dropped values 1,2,2 => mean 1.6666..., stdev 0.4714..., both
    // truncated by round4 to a 4-decimal value (visible rounding).
    const value = [
      { x: 9 }, // kept head
      { x: 9 }, // kept head
      { x: 9 }, // kept head
      { x: 1 }, // dropped
      { x: 2 }, // dropped
      { x: 2 }, // dropped
      { x: 9 }, // kept tail
      { x: 9 }, // kept tail
      { x: 9 }, // kept tail
    ];
    const o: SampleOpts = { minRows: 9, headN: 3, tailN: 3, sigma: 100 };
    const out = JSON.parse(sample(value, o)) as {
      _sentinelSample: { stats: Record<string, { mean: number; median: number; stdev: number }> };
    };
    // mean = 5/3 = 1.66666... => round4 1.6667
    expect(out._sentinelSample.stats['x']?.mean).toBe(1.6667);
    // odd count median = middle of sorted [1,2,2] = 2
    expect(out._sentinelSample.stats['x']?.median).toBe(2);
    // population stdev of [1,2,2]: variance = ((1-5/3)^2+2*(2-5/3)^2)/3 = 0.2222...
    // sqrt = 0.4714045... => round4 0.4714
    expect(out._sentinelSample.stats['x']?.stdev).toBe(0.4714);
  });

  it('summarizes a dropped scalar-number array under the empty-string field', () => {
    // 30 numbers; head 3 + tail 3 kept, 24 dropped (all value 5 => stdev 0).
    const value = [10, 11, 12, ...Array(24).fill(5), 13, 14, 15];
    const o: SampleOpts = { minRows: 30, headN: 3, tailN: 3, sigma: 100 };
    const out = JSON.parse(sample(value, o)) as {
      _sentinelSample: {
        stats: Record<
          string,
          { count: number; min: number; max: number; mean: number; stdev: number }
        >;
      };
    };
    expect(out._sentinelSample.stats['']).toEqual({
      count: 24,
      min: 5,
      max: 5,
      mean: 5,
      median: 5,
      stdev: 0,
    });
  });

  it('omits the stats key entirely for an all-string dropped population', () => {
    const value = Array.from({ length: 40 }, (_, i) => `row ${i}`);
    const serialized = sample(value);
    // No numeric fields among dropped items => no stats key at all.
    expect(serialized).not.toContain('"stats"');
    const out = JSON.parse(serialized) as { _sentinelSample: Record<string, unknown> };
    expect('stats' in out._sentinelSample).toBe(false);
  });

  it('orders stats last in the _sentinelSample key order', () => {
    const value = Array.from({ length: 40 }, (_, i) => ({ id: i }));
    const out = JSON.parse(sample(value)) as { _sentinelSample: Record<string, unknown> };
    expect(Object.keys(out._sentinelSample)).toEqual(['kept', 'droppedCount', 'note', 'stats']);
  });

  it('produces identical output across two runs (determinism)', () => {
    const value = Array.from({ length: 50 }, (_, i) => ({ id: i, score: (i * 7) % 13 }));
    expect(sample(value)).toBe(sample(value));
  });

  it('is idempotent: sampling its own (object) output returns it unchanged', () => {
    const value = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const once = sample(value);
    const reparsed = tryParseJson(once);
    expect(reparsed.ok).toBe(true);
    expect(sampleJsonArray(once, reparsed.value, opts)).toBe(once);
  });

  it('embeds the hashOriginal id of the exact dropped-source text in the marker', () => {
    const value = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    const source = JSON.stringify(value);
    const captures: Array<{ rule: string; original: string }> = [];
    const out = sampleJsonArray(source, value, opts, (rule, original) => {
      captures.push({ rule, original });
      return hashOriginal(original);
    });
    const parsed = JSON.parse(out) as { _sentinelSample: { note: string } };
    const expectedId = hashOriginal(source);
    expect(parsed._sentinelSample.note).toContain(`id="${expectedId}"`);
    expect(captures[0]?.original).toBe(source);
    // The recorded capture reconstructs the original array byte-for-byte.
    expect(captures[0]!.original).toBe(source);
    expect(JSON.parse(captures[0]!.original)).toEqual(value);
  });

  it('does not fire when the array length equals minRows minus one (boundary)', () => {
    const value = Array.from({ length: 29 }, (_, i) => ({ id: i }));
    const o: SampleOpts = { minRows: 30, headN: 3, tailN: 3, sigma: 2 };
    // 29 < 30 => below trigger, returned unchanged (same instance).
    const text = JSON.stringify(value);
    expect(sampleJsonArray(text, value, o)).toBe(text);
  });

  it('fires when the array length is exactly minRows (one over the boundary)', () => {
    const value = Array.from({ length: 30 }, (_, i) => ({ id: i }));
    const o: SampleOpts = { minRows: 30, headN: 3, tailN: 3, sigma: 100 };
    const out = JSON.parse(sample(value, o)) as { _sentinelSample: { droppedCount: number } };
    expect(out._sentinelSample.droppedCount).toBe(24);
  });
});

describe('compressToolResultText (tiers)', () => {
  it('conservative strips ANSI and minifies JSON but does not truncate', () => {
    const log = `${ESC}[32mok${ESC}[0m\n${'x\n'.repeat(1000)}`;
    const r = compressToolResultText(log, 'conservative');
    expect(r.text).not.toContain(ESC);
    expect(r.perRule.ansi_strip?.hits).toBe(1);
    // No truncation marker at conservative.
    expect(r.text).not.toContain('lines elided');
  });

  it('conservative leaves clean prose unchanged (no rules fire)', () => {
    const r = compressToolResultText('a tidy single line of output', 'conservative');
    expect(r.text).toBe('a tidy single line of output');
    expect(Object.keys(r.perRule)).toHaveLength(0);
  });

  it('moderate truncates very long logs', () => {
    // Template-DISTINCT lines (adjacent words differ), so the near-duplicate
    // fold cannot pre-empt and the tier-level truncate is what fires.
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];
    const log = Array.from({ length: 500 }, (_, i) => `${words[i % words.length]} step ${i}`).join(
      '\n',
    );
    const r = compressToolResultText(log, 'moderate');
    expect(r.text).toContain('lines elided by Sentinel');
    expect(r.perRule.log_truncate?.hits).toBe(1);
    expect((r.perRule.log_truncate?.bytesSaved ?? 0) > 0).toBe(true);
  });

  it('moderate folds near-duplicate log lines (template-identical runs)', () => {
    // Same template every line ("req <N> served in <N>ms"): the near-dup fold
    // collapses the run to first line + one marker, pre-empting truncate.
    const log = Array.from({ length: 500 }, (_, i) => `req ${i} served in ${i % 90}ms`).join('\n');
    const r = compressToolResultText(log, 'moderate');
    expect(r.perRule.log_near_dup_fold?.hits).toBe(1);
    expect(r.perRule.log_truncate).toBeUndefined();
    const lines = r.text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('req 0 served in 0ms');
    expect(lines[1]).toContain('[499 similar lines elided by Sentinel');
  });

  it('extracts errors from framework logs at moderate/aggressive, not conservative', () => {
    // Distinct test NAMES per line (like real pytest output), so adjacent
    // templates differ and the near-duplicate fold leaves the log to the
    // error-extract rule.
    const words = ['login', 'search', 'cache', 'parse', 'render', 'stream', 'merge'];
    const log = [
      '============================= test session starts ==============================',
      'collected 300 items',
      ...Array.from(
        { length: 250 },
        (_, i) => `tests/test_a.py::test_${words[i % words.length]}_case${i} PASSED`,
      ),
      'tests/test_a.py::test_boom FAILED',
      'E   RuntimeError: kaboom',
      '=========================== 1 failed, 299 passed ===========================',
    ].join('\n');

    const agg = compressToolResultText(log, 'aggressive');
    expect(agg.perRule.log_error_extract?.hits).toBe(1);
    expect(agg.text).toContain('test_boom FAILED');
    expect(agg.text).toContain('RuntimeError: kaboom');

    // Conservative never elides.
    const cons = compressToolResultText(log, 'conservative');
    expect(cons.perRule.log_error_extract).toBeUndefined();
    expect(cons.text).toContain('test_login_case0 PASSED');
  });

  it('moderate and aggressive both fold homogeneous JSON arrays; conservative does not', () => {
    const value = Array.from({ length: 10 }, (_, i) => ({ id: i, label: `row-${i}` }));
    const text = JSON.stringify(value, null, 2);
    const agg = compressToolResultText(text, 'aggressive');
    expect(agg.text).toContain('_sentinelTable');
    expect(agg.perRule.json_tabular?.hits).toBe(1);

    // The fold is lossless, so it runs at moderate too (re-gated for parity
    // with content-type compressors; see tiers.ts).
    const mod = compressToolResultText(text, 'moderate');
    expect(mod.text).toContain('_sentinelTable');
    expect(mod.perRule.json_tabular?.hits).toBe(1);

    const cons = compressToolResultText(text, 'conservative');
    expect(cons.text).not.toContain('_sentinelTable');
    // conservative still minifies the JSON whitespace.
    expect(cons.perRule.json_minify?.hits).toBe(1);
  });

  it('aggressive samples a large array (sampling wins over the tabular fold)', () => {
    const value = Array.from({ length: 60 }, (_, i) => ({ id: i, name: `row-${i}` }));
    const text = JSON.stringify(value, null, 2);
    const agg = compressToolResultText(text, 'aggressive');
    expect(agg.perRule.json_sample?.hits).toBe(1);
    expect(agg.text).toContain('_sentinelSample');
    // Homogeneous, but sampling pre-empts the lossless tabular fold.
    expect(agg.text).not.toContain('_sentinelTable');
    expect(agg.perRule.json_tabular).toBeUndefined();

    // Moderate's gentle threshold (minRows 120) leaves a 60-item array to the
    // lossless tabular fold instead.
    const mod = compressToolResultText(text, 'moderate');
    expect(mod.text).not.toContain('_sentinelSample');
    expect(mod.perRule.json_sample).toBeUndefined();
    expect(mod.text).toContain('_sentinelTable');
    expect(mod.perRule.json_tabular?.hits).toBe(1);
  });

  it('moderate samples a genuinely large array with gentle thresholds', () => {
    const value = Array.from({ length: 130 }, (_, i) => ({ id: i, ms: 10 + (i % 7) }));
    const text = JSON.stringify(value, null, 2);
    const mod = compressToolResultText(text, 'moderate');
    expect(mod.perRule.json_sample?.hits).toBe(1);
    const parsed = JSON.parse(mod.text) as {
      _sentinelSample: { kept: Array<{ id: number }>; droppedCount: number };
    };
    // headN 8 + tailN 8 boundary items survive (no errors; sigma-3 outliers
    // cannot flag in this uniform data).
    expect(parsed._sentinelSample.kept).toHaveLength(16);
    expect(parsed._sentinelSample.kept[0]?.id).toBe(0);
    expect(parsed._sentinelSample.kept[7]?.id).toBe(7);
    expect(parsed._sentinelSample.kept[8]?.id).toBe(122);
    expect(parsed._sentinelSample.kept[15]?.id).toBe(129);
    expect(parsed._sentinelSample.droppedCount).toBe(114);
  });

  it('routes a unified diff to diff_trim and skips the generic log chain', () => {
    // 6 hunks (> aggressive maxHunks 4) whose bodies contain `at ` and `error`
    // lookalikes that the log rules would mangle if they ran.
    const hunks = Array.from({ length: 6 }, (_, h) =>
      [
        `@@ -${h * 10 + 1},4 +${h * 10 + 1},4 @@`,
        ' const ctx = 1;',
        `-  at oldHandler(${h});`,
        `+  at newHandler(${h});`,
        ' // error: handled below',
      ].join('\n'),
    );
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      ...hunks,
    ].join('\n');
    const r = compressToolResultText(diff, 'aggressive');
    expect(r.perRule.diff_trim?.hits).toBe(1);
    expect(r.text).toContain('hunks elided by Sentinel');
    // Routed: none of the generic log rules fired on the diff body.
    expect(r.perRule.log_error_extract).toBeUndefined();
    expect(r.perRule.stack_trace_collapse).toBeUndefined();
    expect(r.perRule.log_near_dup_fold).toBeUndefined();
  });

  it('routes ripgrep output to search_extract and skips the generic log chain', () => {
    const lines: string[] = [];
    for (let f = 0; f < 20; f++) {
      for (let m = 0; m < 8; m++) {
        lines.push(`src/dir${f}/file${f}.ts:${10 + m}:  const error${m} = handle(${f});`);
      }
    }
    const r = compressToolResultText(lines.join('\n'), 'aggressive');
    expect(r.perRule.search_extract?.hits).toBe(1);
    expect(r.text).toContain('more files with');
    expect(r.perRule.log_error_extract).toBeUndefined();
    expect(r.perRule.log_near_dup_fold).toBeUndefined();
  });

  it('routes HTML to html_extract and falls through to the generic chain', () => {
    const cards = Array.from(
      { length: 40 },
      (_, i) => `<div class="card"><p>Widget ${i} costs &#36;${i}.99</p></div>`,
    ).join('\n');
    const html = `<!DOCTYPE html>\n<html><head><style>.card{color:red}</style></head><body>\n${cards}\n</body></html>`;
    const r = compressToolResultText(html, 'moderate');
    expect(r.perRule.html_extract?.hits).toBe(1);
    expect(r.text).toContain('bytes of HTML markup elided by Sentinel');
    expect(r.text).toContain('Widget 0 costs $0.99');
    expect(r.text).not.toContain('<div');
    expect(r.text).not.toContain('color:red');
  });

  it('conservative routes nothing: diffs, search output, and HTML ride through verbatim', () => {
    const diff = ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b'].join('\n');
    const rd = compressToolResultText(diff, 'conservative');
    expect(rd.text).toBe(diff);
    expect(rd.perRule.diff_trim).toBeUndefined();

    const search = Array.from({ length: 80 }, (_, i) => `src/a${i}.ts:${i + 1}:hit`).join('\n');
    const rs = compressToolResultText(search, 'conservative');
    expect(rs.text).toBe(search);
    expect(rs.perRule.search_extract).toBeUndefined();

    const html = '<!DOCTYPE html><html><body><p>hello</p></body></html>';
    const rh = compressToolResultText(html, 'conservative');
    expect(rh.text).toBe(html);
    expect(rh.perRule.html_extract).toBeUndefined();
  });

  it('aggressive falls back to the tabular fold for arrays below the sample threshold', () => {
    const value = Array.from({ length: 12 }, (_, i) => ({ id: i, label: `r${i}` }));
    const agg = compressToolResultText(JSON.stringify(value), 'aggressive');
    expect(agg.text).not.toContain('_sentinelSample');
    expect(agg.text).toContain('_sentinelTable');
    expect(agg.perRule.json_tabular?.hits).toBe(1);
  });

  it('is idempotent at aggressive on a sampled (large) array', () => {
    const text = JSON.stringify(Array.from({ length: 60 }, (_, i) => ({ id: i, name: `n${i}` })));
    const once = compressToolResultText(text, 'aggressive').text;
    const twice = compressToolResultText(once, 'aggressive').text;
    expect(twice).toBe(once);
  });

  it('aggressive on a JSON object (not an array) minifies but does not fold', () => {
    const text = JSON.stringify({ status: 'ok', items: [1, 2, 3] }, null, 2);
    const r = compressToolResultText(text, 'aggressive');
    expect(r.text).not.toContain('_sentinelTable');
    expect(r.perRule.json_tabular).toBeUndefined();
    expect(r.perRule.json_minify?.hits).toBe(1);
  });

  it.each(['conservative', 'moderate', 'aggressive'] as const)(
    'is idempotent at the %s tier on a mixed adversarial payload',
    (level) => {
      const payload = [
        `${ESC}[31mERROR${ESC}[0m`,
        ...Array.from({ length: 60 }, (_, i) => `    at fn${i} (file.js:${i}:1)`),
        '',
        '',
        '',
        ...Array.from({ length: 400 }, (_, i) => `progress ${i}`),
        'tail-line',
        'tail-line',
        'tail-line',
      ].join('\n');
      const once = compressToolResultText(payload, level).text;
      const twice = compressToolResultText(once, level).text;
      expect(twice).toBe(once);
    },
  );

  it.each(['conservative', 'moderate', 'aggressive'] as const)(
    'is idempotent at the %s tier on a JSON array payload',
    (level) => {
      const value = Array.from({ length: 12 }, (_, i) => ({ id: i, name: `n${i}`, ok: true }));
      const text = JSON.stringify(value, null, 2);
      const once = compressToolResultText(text, level).text;
      const twice = compressToolResultText(once, level).text;
      expect(twice).toBe(once);
    },
  );

  it('is deterministic: same input yields identical output and rule stats', () => {
    const log = `${ESC}[33mwarn${ESC}[0m\n${Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n')}`;
    const a = compressToolResultText(log, 'aggressive');
    const b = compressToolResultText(log, 'aggressive');
    expect(a.text).toBe(b.text);
    expect(a.perRule).toEqual(b.perRule);
  });
});
