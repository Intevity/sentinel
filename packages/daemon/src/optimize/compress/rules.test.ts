import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  collapseBlankLines,
  collapseDuplicateLines,
  collapseStackTraces,
  truncateLog,
} from './text-rules.js';
import { tryParseJson, minifyJsonWhitespace, tabularDedup } from './json-rules.js';
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
    expect(out).toContain('[24 stack frames elided by Claude Sentinel]');
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
    expect(out).toContain('[260 lines elided by Claude Sentinel]');
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
    const log = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const r = compressToolResultText(log, 'moderate');
    expect(r.text).toContain('lines elided by Claude Sentinel');
    expect(r.perRule.log_truncate?.hits).toBe(1);
    expect((r.perRule.log_truncate?.bytesSaved ?? 0) > 0).toBe(true);
  });

  it('aggressive folds homogeneous JSON arrays; moderate does not', () => {
    const value = Array.from({ length: 10 }, (_, i) => ({ id: i, label: `row-${i}` }));
    const text = JSON.stringify(value, null, 2);
    const agg = compressToolResultText(text, 'aggressive');
    expect(agg.text).toContain('_sentinelTable');
    expect(agg.perRule.json_tabular?.hits).toBe(1);

    const mod = compressToolResultText(text, 'moderate');
    expect(mod.text).not.toContain('_sentinelTable');
    // moderate still minifies the JSON whitespace.
    expect(mod.perRule.json_minify?.hits).toBe(1);
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
