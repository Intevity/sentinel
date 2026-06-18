import { describe, it, expect } from 'vitest';
import { hashOriginal, type RuleId } from './types.js';
import { isSearchOutput, extractSearchMatches, type SearchExtractOpts } from './search-rules.js';

const MODERATE: SearchExtractOpts = {
  triggerLines: 60,
  maxFiles: 30,
  maxPerFile: 20,
  headPaths: 40,
  tailPaths: 10,
};
const AGGRESSIVE: SearchExtractOpts = {
  triggerLines: 30,
  maxFiles: 12,
  maxPerFile: 6,
  headPaths: 20,
  tailPaths: 5,
};

/** Records onElide calls; returns the deterministic content-hash id, exactly as
 *  the production hook does. No mocks. */
function makeOnElide(): { fn: OnElideFn; captures: { ruleId: RuleId; elided: string }[] } {
  const captures: { ruleId: RuleId; elided: string }[] = [];
  const fn: OnElideFn = (ruleId, elided) => {
    captures.push({ ruleId, elided });
    return hashOriginal(elided);
  };
  return { fn, captures };
}
type OnElideFn = (ruleId: RuleId, elided: string) => string;

/** Builds a content-mode block of `count` hits for `path`, starting at line 1. */
function contentLines(path: string, count: number, start = 1): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(`${path}:${start + i}:match ${start + i}`);
  return out;
}

describe('isSearchOutput', () => {
  it('detects content mode (Shape A) with >=2 distinct paths', () => {
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) lines.push(`src/a.ts:${i + 1}:hit`);
    for (let i = 0; i < 6; i++) lines.push(`src/b.ts:${i + 1}:hit`);
    expect(isSearchOutput(lines.join('\n'))).toBe(true);
  });

  it('detects bare-path mode (Shape B) at >=0.95 fraction', () => {
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) lines.push(`src/components/Widget${i}.tsx`);
    expect(isSearchOutput(lines.join('\n'))).toBe(true);
  });

  it('returns false with fewer than 10 sampled non-empty lines', () => {
    const lines: string[] = [];
    for (let i = 0; i < 9; i++) lines.push(`src/a.ts:${i + 1}:hit`);
    expect(isSearchOutput(lines.join('\n'))).toBe(false);
  });

  it('returns false for content mode with only ONE distinct path', () => {
    // 12 Shape-A lines but all the same path -> distinct < 2 -> not search.
    expect(isSearchOutput(contentLines('only/one.ts', 12).join('\n'))).toBe(false);
  });

  // False-positive resistance: syslog timestamps.
  it('rejects syslog-style timestamp lines', () => {
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push(`2026-06-06T12:00:0${i % 10}: service: message ${i}`);
    }
    expect(isSearchOutput(lines.join('\n'))).toBe(false);
  });

  // False-positive resistance: YAML key:value and stack-trace-ish prose.
  it('rejects YAML key:value and stack-trace prose', () => {
    const lines = [
      'name: my-app',
      'version: 1.0.0',
      'description: a thing',
      'Error: something failed at foo.ts:10:5',
      'license: MIT',
      'author: someone',
      'main: index.js',
      'private: true',
      'type: module',
      'scripts: build',
      'keywords: none',
      'homepage: example',
    ];
    expect(isSearchOutput(lines.join('\n'))).toBe(false);
  });

  it('samples only the first 200 non-empty lines (cap break)', () => {
    // 250 bare paths: still classifies (Shape B), exercising the sampler cap.
    const paths: string[] = [];
    for (let i = 0; i < 250; i++) paths.push(`src/big/Mod${i}.ts`);
    expect(isSearchOutput(paths.join('\n'))).toBe(true);
  });

  it('rejects all-digit and timestamp-fragment bare tokens (Shape B path guard)', () => {
    // 12 lines: all bare tokens but each fails isPathLike for a distinct reason,
    // so Shape B fraction is 0 -> not search output. Covers all-digits + timestamp.
    const lines = [
      '123456', // all digits -> rejected
      '7890', // all digits
      'build-2026T12:30', // timestamp fragment T\d\d: -> rejected
      'log-2026T09:01', // timestamp fragment
      'plainword', // no sep, no dot-ext -> rejected
      'another', // no sep, no dot-ext
      'noslashhere', // no sep, no dot-ext
      'justtext', // no sep, no dot-ext
      'moretext', // no sep, no dot-ext
      'evenmore', // no sep, no dot-ext
      'lastone', // no sep, no dot-ext
      'finalbit', // no sep, no dot-ext
    ];
    expect(isSearchOutput(lines.join('\n'))).toBe(false);
  });

  it('rejects an over-length (>512 char) bare token as a path', () => {
    const longTok = 'src/' + 'a'.repeat(600) + '.ts'; // > 512 chars, has sep+ext
    const lines: string[] = [longTok];
    for (let i = 0; i < 11; i++) lines.push('plainword' + i); // non-paths
    // longTok fails the >512 guard; rest fail no-sep -> Shape B fraction 0.
    expect(isSearchOutput(lines.join('\n'))).toBe(false);
  });

  // False-positive resistance: build log just under the 0.8 Shape-A fraction.
  it('rejects a build log under the 0.8 Shape-A fraction', () => {
    // 8 Shape-A lines + 2 prose lines = 0.8 exactly is the trigger; make it 7/10 = 0.7.
    const lines: string[] = [];
    for (let i = 0; i < 7; i++) lines.push(`src/a${i}.ts:${i + 1}:hit`);
    lines.push('Compiling foo v0.1.0');
    lines.push('Finished release in 2.0s');
    lines.push('warning: unused variable');
    expect(isSearchOutput(lines.join('\n'))).toBe(false);
  });
});

describe('extractSearchMatches - guards & identity', () => {
  it('returns the same instance when not classifiable as search output', () => {
    const input = 'just\nsome\nprose\nlines\nhere\nthat\nare\nnot\npaths\nat all\n';
    expect(extractSearchMatches(input, MODERATE, undefined)).toBe(input);
  });

  it('returns the same instance when below the trigger line count', () => {
    // 50 content lines, 2 paths -> classifiable, but <= triggerLines (60).
    const lines = [...contentLines('src/a.ts', 25), ...contentLines('src/b.ts', 25)];
    const input = lines.join('\n');
    expect(extractSearchMatches(input, MODERATE, undefined)).toBe(input);
  });

  it('returns same instance when over trigger but fewer than 10 non-empty lines', () => {
    // triggerLines 5, 8 path lines -> over trigger, but sample (8) < 10 so we
    // cannot confidently classify; return the input untouched.
    const opts: SearchExtractOpts = {
      triggerLines: 5,
      maxFiles: 30,
      maxPerFile: 20,
      headPaths: 40,
      tailPaths: 10,
    };
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) lines.push(`src/x${i}.ts:1:hit`);
    const input = lines.join('\n');
    expect(extractSearchMatches(input, opts, undefined)).toBe(input);
  });

  it('returns same instance when over trigger and >=10 lines but not classifiable', () => {
    // 12 prose lines, over a small trigger, but neither Shape A nor Shape B.
    const opts: SearchExtractOpts = {
      triggerLines: 5,
      maxFiles: 30,
      maxPerFile: 20,
      headPaths: 40,
      tailPaths: 10,
    };
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) lines.push(`this is prose line number ${i} with words`);
    const input = lines.join('\n');
    expect(extractSearchMatches(input, opts, undefined)).toBe(input);
  });

  it('returns marker-bearing input unchanged (leading guard)', () => {
    const lines: string[] = [];
    for (let i = 0; i < 70; i++) lines.push(`src/a.ts:${i + 1}:hit`);
    lines.push('... [5 more paths elided by Sentinel] ...');
    const input = lines.join('\n');
    expect(extractSearchMatches(input, MODERATE, undefined)).toBe(input);
  });

  it('returns same instance when MODE A classifiable but no cap fires and no blanks', () => {
    // 12 single-line files: over trigger (5), under maxFiles (100) and
    // maxPerFile (100), and no blank / `--` lines -> output reconstructs the
    // input byte-for-byte, so the SAME instance must come back.
    const opts: SearchExtractOpts = {
      triggerLines: 5,
      maxFiles: 100,
      maxPerFile: 100,
      headPaths: 3,
      tailPaths: 2,
    };
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) lines.push(`src/file${i}.ts:1:hit`);
    const input = lines.join('\n');
    expect(extractSearchMatches(input, opts, undefined)).toBe(input);
  });

  it('returns same instance when MODE B classifiable but no truncation fires', () => {
    // 12 bare paths over trigger (10) but head 40 + tail 10 covers all -> middle
    // is empty -> nothing dropped -> same instance.
    const opts: SearchExtractOpts = {
      triggerLines: 10,
      maxFiles: 30,
      maxPerFile: 20,
      headPaths: 40,
      tailPaths: 10,
    };
    const lines: string[] = [];
    for (let i = 0; i < 12; i++) lines.push(`src/glob${i}.tsx`);
    const input = lines.join('\n');
    expect(extractSearchMatches(input, opts, undefined)).toBe(input);
  });
});

describe('extractSearchMatches - MODE A per-file cap', () => {
  it('keeps head ceil + tail floor and folds the middle (moderate)', () => {
    // One file with 50 matches; maxPerFile 20 -> keep first 10, last 10, fold 30.
    // But one file alone has only 1 distinct path -> isSearchOutput false.
    // Add a second small file to make it classifiable.
    const big = contentLines('src/big.ts', 50);
    const small = contentLines('src/small.ts', 11, 100);
    const input = [...big, ...small].join('\n');
    const { fn, captures } = makeOnElide();
    const out = extractSearchMatches(input, MODERATE, fn);

    const outLines = out.split('\n');
    // First 10 of big kept verbatim.
    expect(outLines.slice(0, 10)).toEqual(big.slice(0, 10));
    // Marker for the 30 elided middle of big.
    const middle = big.slice(10, 40); // ceil(20/2)=10 head, floor=10 tail
    const id = hashOriginal(middle.join('\n'));
    expect(outLines[10]).toBe(
      `src/big.ts: ... [30 more matches elided by Sentinel; retrieve the full output with the sentinel retrieve tool, id="${id}"] ...`,
    );
    // Last 10 of big follow.
    expect(outLines.slice(11, 21)).toEqual(big.slice(40, 50));
    // small (11 <= 20) kept verbatim.
    expect(outLines.slice(21)).toEqual(small);

    // Reversibility: the capture reconstructs the dropped bytes exactly.
    expect(captures).toHaveLength(1);
    expect(captures[0]?.ruleId).toBe('search_extract');
    expect(captures[0]?.elided).toBe(middle.join('\n'));
    expect(hashOriginal(captures[0]?.elided ?? '')).toBe(id);
  });

  it('aggressive keeps fewer per file than moderate (tier difference)', () => {
    // 65 + 5 = 70 content lines, 2 files -> over MODERATE trigger (60) and
    // AGGRESSIVE trigger (30); small file stays under both per-file caps.
    const big = contentLines('src/big.ts', 65);
    const small = contentLines('src/small.ts', 5, 200);
    const input = [...big, ...small].join('\n');
    const mod = extractSearchMatches(input, MODERATE, undefined);
    const agg = extractSearchMatches(input, AGGRESSIVE, undefined);
    // Moderate: maxPerFile 20 -> 65 > 20 fires, keeps 10+10, elides 45.
    // Aggressive: 6 -> keeps 3+3, elides 59. Aggressive output is shorter.
    expect(agg.split('\n').length).toBeLessThan(mod.split('\n').length);
    expect(agg).toContain('59 more matches elided by Sentinel');
    expect(mod).toContain('45 more matches elided by Sentinel');
  });
});

describe('extractSearchMatches - MODE A file cap', () => {
  it('keeps the heaviest maxFiles and folds dropped runs into one marker each', () => {
    // 4 files; aggressive maxFiles would be 12 (too high). Use a custom opts to
    // force a file cap of 2 with low per-file so per-file never fires.
    const opts: SearchExtractOpts = {
      triggerLines: 5,
      maxFiles: 2,
      maxPerFile: 100,
      headPaths: 3,
      tailPaths: 2,
    };
    // Sizes: a=2, b=5 (heaviest), c=1, d=4 -> keep b(5) and d(4). a and c are
    // each their own contiguous dropped run (b and d sit between/after them).
    // Order: a(2), b(5 keep), c(1 drop), d(4 keep)
    const a = contentLines('f/a.ts', 2, 1);
    const b = contentLines('f/b.ts', 5, 10);
    const c = contentLines('f/c.ts', 1, 20);
    const d = contentLines('f/d.ts', 4, 30);
    const input = [...a, ...b, ...c, ...d].join('\n');
    // isSearchOutput needs >=10 sampled non-empty lines: total = 12. Good.
    const { fn, captures } = makeOnElide();
    const out = extractSearchMatches(input, opts, fn);
    const outLines = out.split('\n');

    // a is dropped (run of 1 file, 2 matches) -> first line is its marker.
    const idA = hashOriginal(a.join('\n'));
    expect(outLines[0]).toBe(
      `... [1 more files with 2 matches elided by Sentinel; retrieve the full output with the sentinel retrieve tool, id="${idA}"] ...`,
    );
    // Then b verbatim (5 lines).
    expect(outLines.slice(1, 6)).toEqual(b);
    // Then c dropped (run of 1 file, 1 match) -> marker.
    const idC = hashOriginal(c.join('\n'));
    expect(outLines[6]).toBe(
      `... [1 more files with 1 matches elided by Sentinel; retrieve the full output with the sentinel retrieve tool, id="${idC}"] ...`,
    );
    // Then d verbatim (4 lines).
    expect(outLines.slice(7, 11)).toEqual(d);
    expect(outLines).toHaveLength(11);

    // Two captures, byte-exact.
    expect(captures.map((c2) => c2.elided)).toEqual([a.join('\n'), c.join('\n')]);
  });

  it('breaks file-cap weight ties by first-seen order', () => {
    const opts: SearchExtractOpts = {
      triggerLines: 5,
      maxFiles: 2,
      maxPerFile: 100,
      headPaths: 3,
      tailPaths: 2,
    };
    // Three files tied at weight 3 (a,b,c) + one at 1 (d). Heaviest 2 by weight,
    // ties broken first-seen -> keep a and b; c (tied but later) and d dropped.
    const a = contentLines('f/a.ts', 3, 1);
    const b = contentLines('f/b.ts', 3, 10);
    const c = contentLines('f/c.ts', 3, 20);
    const d = contentLines('f/d.ts', 1, 30);
    const input = [...a, ...b, ...c, ...d].join('\n');
    const out = extractSearchMatches(input, opts, undefined);
    const outLines = out.split('\n');
    // a and b kept verbatim (6 lines), then c+d are ONE contiguous dropped run.
    expect(outLines.slice(0, 6)).toEqual([...a, ...b]);
    expect(outLines[6]).toContain('2 more files with 4 matches elided by Sentinel');
    expect(outLines).toHaveLength(7);
  });

  it('folds a contiguous multi-file dropped run into a single marker', () => {
    const opts: SearchExtractOpts = {
      triggerLines: 5,
      maxFiles: 1,
      maxPerFile: 100,
      headPaths: 3,
      tailPaths: 2,
    };
    // keep heaviest=1 file. Make first file heaviest so the rest form one run.
    const keep = contentLines('f/keep.ts', 6, 1);
    const x = contentLines('f/x.ts', 2, 10);
    const y = contentLines('f/y.ts', 3, 20);
    const input = [...keep, ...x, ...y].join('\n');
    const { fn, captures } = makeOnElide();
    const out = extractSearchMatches(input, opts, fn);
    const outLines = out.split('\n');
    expect(outLines.slice(0, 6)).toEqual(keep);
    // x and y are ONE contiguous dropped run: 2 files, 5 matches.
    const elided = [...x, ...y].join('\n');
    const id = hashOriginal(elided);
    expect(outLines[6]).toBe(
      `... [2 more files with 5 matches elided by Sentinel; retrieve the full output with the sentinel retrieve tool, id="${id}"] ...`,
    );
    expect(outLines).toHaveLength(7);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.elided).toBe(elided);
  });
});

describe('extractSearchMatches - MODE A grouping behavior', () => {
  it('drops blank and -- separators, groups context (-) lines and continuations with their file', () => {
    const opts: SearchExtractOpts = {
      triggerLines: 5,
      maxFiles: 100,
      maxPerFile: 100,
      headPaths: 3,
      tailPaths: 2,
    };
    const input = [
      'src/a.ts:10:function foo() {',
      'src/a.ts:11-  return 1;', // rg context line (Shape A with '-' separator)
      'continuation line not matching', // rides with a.ts
      '--', // rg group separator -> dropped
      '', // blank -> dropped
      'src/b.ts:20:bar',
      'src/c.ts:30:baz',
      'src/d.ts:40:qux',
      'src/e.ts:50:quux',
      'src/f.ts:60:corge',
      'src/g.ts:70:grault',
      'src/h.ts:80:garply',
    ].join('\n');
    // 12 non-empty lines; Shape A matches 10 (all path:line lines incl. the
    // context '-' line) -> 10/12 = 0.83 >= 0.8 classify. Nothing dropped by
    // caps, but blank and -- are removed, so output differs from input.
    const out = extractSearchMatches(input, opts, undefined);
    const outLines = out.split('\n');
    expect(outLines).toEqual([
      'src/a.ts:10:function foo() {',
      'src/a.ts:11-  return 1;',
      'continuation line not matching',
      'src/b.ts:20:bar',
      'src/c.ts:30:baz',
      'src/d.ts:40:qux',
      'src/e.ts:50:quux',
      'src/f.ts:60:corge',
      'src/g.ts:70:grault',
      'src/h.ts:80:garply',
    ]);
  });

  it('preserves a preamble block at the top, untouched', () => {
    const opts: SearchExtractOpts = {
      triggerLines: 5,
      maxFiles: 1,
      maxPerFile: 100,
      headPaths: 3,
      tailPaths: 2,
    };
    const input = [
      'Searching 1,234 files...', // preamble (no path seen yet)
      'src/keep.ts:1:a',
      'src/keep.ts:2:b',
      'src/keep.ts:3:c',
      'src/drop.ts:1:x',
      'src/drop.ts:2:y',
      'src/drop.ts:3:z',
      'src/drop.ts:4:w',
      'src/drop.ts:5:v',
      'src/drop.ts:6:u',
    ].join('\n');
    const { fn } = makeOnElide();
    const out = extractSearchMatches(input, opts, fn);
    const outLines = out.split('\n');
    // Preamble first, untouched.
    expect(outLines[0]).toBe('Searching 1,234 files...');
    // keep.ts (3 lines) heaviest? drop.ts has 6 -> drop.ts is heaviest, kept.
    // So keep.ts (lighter) is dropped. Marker then drop.ts verbatim.
    expect(outLines[1]).toContain('1 more files with 3 matches elided by Sentinel');
    expect(outLines.slice(2)).toEqual([
      'src/drop.ts:1:x',
      'src/drop.ts:2:y',
      'src/drop.ts:3:z',
      'src/drop.ts:4:w',
      'src/drop.ts:5:v',
      'src/drop.ts:6:u',
    ]);
  });
});

describe('extractSearchMatches - MODE B bare paths', () => {
  it('keeps head + tail and folds the middle (moderate head/tail exactness)', () => {
    const paths: string[] = [];
    for (let i = 0; i < 100; i++) paths.push(`src/components/Widget${i}.tsx`);
    const input = paths.join('\n');
    const { fn, captures } = makeOnElide();
    const out = extractSearchMatches(input, MODERATE, fn);
    const outLines = out.split('\n');
    // head 40, marker, tail 10 = 51 lines.
    expect(outLines).toHaveLength(51);
    expect(outLines.slice(0, 40)).toEqual(paths.slice(0, 40));
    const middle = paths.slice(40, 90);
    const id = hashOriginal(middle.join('\n'));
    expect(outLines[40]).toBe(
      `... [50 more paths elided by Sentinel; retrieve the full output with the sentinel retrieve tool, id="${id}"] ...`,
    );
    expect(outLines.slice(41)).toEqual(paths.slice(90));
    expect(captures).toHaveLength(1);
    expect(captures[0]?.elided).toBe(middle.join('\n'));
  });

  it('aggressive head/tail differs from moderate', () => {
    const paths: string[] = [];
    for (let i = 0; i < 100; i++) paths.push(`src/x${i}.js`);
    const input = paths.join('\n');
    const agg = extractSearchMatches(input, AGGRESSIVE, undefined);
    const aggLines = agg.split('\n');
    // head 20 + marker + tail 5 = 26.
    expect(aggLines).toHaveLength(26);
    expect(aggLines.slice(0, 20)).toEqual(paths.slice(0, 20));
    expect(aggLines[20]).toContain('75 more paths elided by Sentinel');
    expect(aggLines.slice(21)).toEqual(paths.slice(95));
  });
});

describe('extractSearchMatches - thresholds, determinism, idempotency', () => {
  it('at-trigger does NOT fire; one-over fires (Shape B boundary)', () => {
    const opts: SearchExtractOpts = {
      triggerLines: 30,
      maxFiles: 12,
      maxPerFile: 6,
      headPaths: 20,
      tailPaths: 5,
    };
    const at: string[] = [];
    for (let i = 0; i < 30; i++) at.push(`src/p${i}.ts`);
    const atInput = at.join('\n');
    expect(extractSearchMatches(atInput, opts, undefined)).toBe(atInput);

    const over: string[] = [];
    for (let i = 0; i < 31; i++) over.push(`src/p${i}.ts`);
    const overInput = over.join('\n');
    expect(extractSearchMatches(overInput, opts, undefined)).not.toBe(overInput);
  });

  it('is deterministic: two runs produce identical strings', () => {
    const paths: string[] = [];
    for (let i = 0; i < 80; i++) paths.push(`src/m${i}.ts`);
    const input = paths.join('\n');
    const { fn: f1 } = makeOnElide();
    const { fn: f2 } = makeOnElide();
    expect(extractSearchMatches(input, MODERATE, f1)).toBe(
      extractSearchMatches(input, MODERATE, f2),
    );
  });

  it('is idempotent in MODE B: second pass returns identical content', () => {
    const paths: string[] = [];
    for (let i = 0; i < 80; i++) paths.push(`src/n${i}.ts`);
    const input = paths.join('\n');
    const { fn } = makeOnElide();
    const once = extractSearchMatches(input, MODERATE, fn);
    const twice = extractSearchMatches(once, MODERATE, fn);
    expect(twice).toBe(once);
  });

  it('is idempotent in MODE A: second pass returns identical content', () => {
    const big = contentLines('src/big.ts', 60);
    const small = contentLines('src/small.ts', 12, 200);
    const input = [...big, ...small].join('\n');
    const { fn } = makeOnElide();
    const once = extractSearchMatches(input, MODERATE, fn);
    const twice = extractSearchMatches(once, MODERATE, fn);
    expect(twice).toBe(once);
  });

  it('non-CCR marker still reads the literal elided phrase', () => {
    const paths: string[] = [];
    for (let i = 0; i < 80; i++) paths.push(`src/q${i}.ts`);
    const out = extractSearchMatches(paths.join('\n'), MODERATE, undefined);
    expect(out).toContain('more paths elided by Sentinel] ...');
    // No retrieval hint when onElide is undefined.
    expect(out).not.toContain('retrieve the full output');
  });
});
