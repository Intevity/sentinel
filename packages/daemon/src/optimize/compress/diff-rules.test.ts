import { describe, it, expect } from 'vitest';
import { isUnifiedDiff, trimUnifiedDiff, type DiffTrimOpts } from './diff-rules.js';
import { hashOriginal, type RuleId } from './types.js';
import type { OnElide } from './text-rules.js';

const MODERATE: DiffTrimOpts = { maxFiles: 20, maxHunks: 10, contextLines: 3 };
const AGGRESSIVE: DiffTrimOpts = { maxFiles: 8, maxHunks: 4, contextLines: 1 };

/** A recording OnElide closure: no mocks. Records (ruleId, elided) and returns
 *  the real content hash so markers can be verified against hashOriginal(). */
function recorder() {
  const calls: { ruleId: RuleId; elided: string }[] = [];
  const onElide: OnElide = (ruleId, elided) => {
    calls.push({ ruleId, elided });
    return hashOriginal(elided);
  };
  return { calls, onElide };
}

/** Extract the id="..." from a single marker line. */
function idOf(markerLine: string): string {
  const m = markerLine.match(/id="([0-9a-f]+)"/);
  if (!m) throw new Error(`no id in marker: ${markerLine}`);
  return m[1] ?? '';
}

// ---- Fixtures -------------------------------------------------------------

const SIMPLE_DIFF = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index 1111111..2222222 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,5 +1,5 @@',
  ' const a = 1;',
  ' const b = 2;',
  '-const c = 3;',
  '+const c = 4;',
  ' const d = 5;',
].join('\n');

describe('isUnifiedDiff', () => {
  it('accepts a diff --git with a hunk header', () => {
    expect(isUnifiedDiff(SIMPLE_DIFF)).toBe(true);
  });

  it('accepts a plain diff -u with --- followed by +++ and a hunk', () => {
    const d = ['--- old.txt', '+++ new.txt', '@@ -1 +1 @@', '-a', '+b'].join('\n');
    expect(isUnifiedDiff(d)).toBe(true);
  });

  it('rejects text with a file header but NO hunk header', () => {
    const d = ['diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x'].join('\n');
    expect(isUnifiedDiff(d)).toBe(false);
  });

  it('rejects a hunk-like line with no file header', () => {
    const d = ['@@ -1,2 +1,2 @@', ' a', '-b', '+c'].join('\n');
    expect(isUnifiedDiff(d)).toBe(false);
  });

  it('rejects --- not immediately followed by +++ (no diff --git)', () => {
    const d = ['--- a', 'middle', '+++ b', '@@ -1 +1 @@', '-x', '+y'].join('\n');
    expect(isUnifiedDiff(d)).toBe(false);
  });

  it('false-positive resistance: source code with +/- lines and the word diff', () => {
    const ts = [
      'function compute(a: number, b: number) {',
      '  const re = /^[-+]?\\d+$/;',
      '  // compute the diff between values',
      '  const delta = a - b;',
      '  return delta + 1;',
      '}',
      '-1 and +1 are sentinels',
    ].join('\n');
    expect(isUnifiedDiff(ts)).toBe(false);
  });
});

describe('trimUnifiedDiff - identity / no-op', () => {
  it('returns same instance for non-diff text', () => {
    const input = 'just some prose\nwith two lines';
    expect(trimUnifiedDiff(input, MODERATE)).toBe(input);
  });

  it('returns same instance for a single-file single-hunk diff under all caps', () => {
    expect(trimUnifiedDiff(SIMPLE_DIFF, MODERATE)).toBe(SIMPLE_DIFF);
  });

  it('returns marker-bearing input unchanged (leading guard)', () => {
    const input =
      'diff --git a/x b/x\n@@ -1,1 +1,1 @@\n-a\n... [3 hunks elided by Sentinel] ...\n+b';
    expect(trimUnifiedDiff(input, AGGRESSIVE)).toBe(input);
  });

  it('false-positive resistance: source code returns same instance', () => {
    const ts = 'const re = /^[-+]\\d+$/;\n-1\n+1\n// diff';
    expect(trimUnifiedDiff(ts, AGGRESSIVE)).toBe(ts);
  });
});

describe('trimUnifiedDiff - lockfile hunks (rule a)', () => {
  const lock = [
    'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
    'index aaa..bbb 100644',
    '--- a/pnpm-lock.yaml',
    '+++ b/pnpm-lock.yaml',
    '@@ -1,3 +1,3 @@',
    ' lockfileVersion: 9',
    '-  foo: 1.0.0',
    '+  foo: 1.0.1',
    '@@ -10,2 +10,2 @@',
    '-  bar: 2.0.0',
    '+  bar: 2.0.1',
  ].join('\n');

  it('keeps headers, collapses all hunks to one marker, captures exact bytes', () => {
    const { calls, onElide } = recorder();
    const out = trimUnifiedDiff(lock, MODERATE, onElide);
    const lines = out.split('\n');
    // The four header lines survive byte-identical.
    expect(lines.slice(0, 4)).toEqual([
      'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
      'index aaa..bbb 100644',
      '--- a/pnpm-lock.yaml',
      '+++ b/pnpm-lock.yaml',
    ]);
    // One marker replaces both hunks.
    expect(lines[4]).toContain('[2 hunks elided by Sentinel');
    expect(lines.length).toBe(5);
    // Capture reconstructs exactly the two dropped hunks.
    const expectedDropped = [
      '@@ -1,3 +1,3 @@',
      ' lockfileVersion: 9',
      '-  foo: 1.0.0',
      '+  foo: 1.0.1',
      '@@ -10,2 +10,2 @@',
      '-  bar: 2.0.0',
      '+  bar: 2.0.1',
    ].join('\n');
    expect(calls.length).toBe(1);
    expect(calls[0]?.elided).toBe(expectedDropped);
    expect(idOf(lines[4] ?? '')).toBe(hashOriginal(expectedDropped));
  });

  it('detects go.sum via diff --git path', () => {
    const d = ['diff --git a/go.sum b/go.sum', '@@ -1,1 +1,1 @@', '-x v1.0.0', '+x v1.0.1'].join(
      '\n',
    );
    const out = trimUnifiedDiff(d, MODERATE);
    expect(out).toContain('[1 hunks elided by Sentinel] ...');
    expect(out.split('\n')[0]).toBe('diff --git a/go.sum b/go.sum');
  });

  it('detects lockfile via --- / +++ path when no diff --git present', () => {
    const d = ['--- a/yarn.lock', '+++ b/yarn.lock', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n');
    const out = trimUnifiedDiff(d, MODERATE);
    expect(out).toContain('[1 hunks elided by Sentinel] ...');
    expect(out.split('\n').slice(0, 2)).toEqual(['--- a/yarn.lock', '+++ b/yarn.lock']);
  });
});

describe('trimUnifiedDiff - whitespace-only hunks (rule b)', () => {
  const d = [
    'diff --git a/x.ts b/x.ts',
    '@@ -1,2 +1,2 @@',
    '-  ',
    '+    ',
    '@@ -10,3 +10,3 @@',
    ' keep me',
    '-real change',
    '+real change!',
  ].join('\n');

  it('collapses only the whitespace-only hunk, keeps the real one', () => {
    const { calls, onElide } = recorder();
    const out = trimUnifiedDiff(d, MODERATE, onElide);
    const lines = out.split('\n');
    expect(lines[0]).toBe('diff --git a/x.ts b/x.ts');
    expect(lines[1]).toContain('[1 whitespace-only hunks elided by Sentinel');
    // The real hunk survives byte-identical.
    expect(lines.slice(2)).toEqual([
      '@@ -10,3 +10,3 @@',
      ' keep me',
      '-real change',
      '+real change!',
    ]);
    const expectedDropped = ['@@ -1,2 +1,2 @@', '-  ', '+    '].join('\n');
    expect(calls.length).toBe(1);
    expect(calls[0]?.elided).toBe(expectedDropped);
    expect(idOf(lines[1] ?? '')).toBe(hashOriginal(expectedDropped));
  });

  it('does NOT treat a hunk with a non-blank change as whitespace-only', () => {
    const real = ['diff --git a/y.ts b/y.ts', '@@ -1,2 +1,2 @@', '-  x', '+  '].join('\n');
    // Only one side blank -> not whitespace-only; single hunk under caps -> no-op.
    expect(trimUnifiedDiff(real, MODERATE)).toBe(real);
  });
});

describe('trimUnifiedDiff - file cap (rule c)', () => {
  // Build N files each with a distinct churn so ranking is deterministic.
  function fileBlock(name: string, churn: number): string {
    const body: string[] = [`diff --git a/${name} b/${name}`, '@@ -1,1 +1,1 @@'];
    for (let i = 0; i < churn; i++) {
      body.push(`-old${i}`);
      body.push(`+new${i}`);
    }
    return body.join('\n');
  }

  it('aggressive: keeps heaviest maxFiles, contiguous run -> one marker, exact capture', () => {
    // 10 files, churns 1..10 by position. maxFiles=8 -> drop the 2 lightest
    // (files 0 and 1, churn 1 and 2). They are contiguous -> one marker.
    const files: string[] = [];
    for (let i = 0; i < 10; i++) files.push(fileBlock(`f${i}.ts`, i + 1));
    const text = files.join('\n');
    const { calls, onElide } = recorder();
    const out = trimUnifiedDiff(text, AGGRESSIVE, onElide);
    const lines = out.split('\n');
    // First line is the contiguous-drop marker for files 0 and 1.
    expect(lines[0]).toContain('[2 files (2 hunks) elided by Sentinel');
    // Files 2..9 follow, in original order, with f2 first.
    expect(lines[1]).toBe('diff --git a/f2.ts b/f2.ts');
    expect(out).toContain('diff --git a/f9.ts b/f9.ts');
    expect(out).not.toContain('diff --git a/f0.ts');
    expect(out).not.toContain('diff --git a/f1.ts');
    // Exactly one elide call; capture reconstructs files 0 and 1 verbatim.
    const expectedDropped = [fileBlock('f0.ts', 1), fileBlock('f1.ts', 2)].join('\n');
    expect(calls.length).toBe(1);
    expect(calls[0]?.elided).toBe(expectedDropped);
    expect(idOf(lines[0] ?? '')).toBe(hashOriginal(expectedDropped));
  });

  it('non-contiguous drops produce two markers', () => {
    // 10 files; make files 0 and 9 the lightest so drops are non-contiguous.
    const churns = [1, 5, 6, 7, 8, 9, 10, 11, 12, 2];
    const files: string[] = [];
    for (let i = 0; i < 10; i++) files.push(fileBlock(`g${i}.ts`, churns[i] ?? 1));
    const text = files.join('\n');
    const out = trimUnifiedDiff(text, AGGRESSIVE);
    const markers = out.split('\n').filter((l) => l.includes('files (') && l.includes('elided'));
    // Two separate contiguous runs (file 0 alone, file 9 alone) -> two markers.
    expect(markers.length).toBe(2);
    expect(markers[0]).toContain('[1 files (1 hunks) elided by Sentinel');
    expect(markers[1]).toContain('[1 files (1 hunks) elided by Sentinel');
    expect(out).not.toContain('diff --git a/g0.ts');
    expect(out).not.toContain('diff --git a/g9.ts');
  });

  it('file count exactly at maxFiles does not fire', () => {
    const files: string[] = [];
    for (let i = 0; i < 8; i++) files.push(fileBlock(`h${i}.ts`, i + 1));
    const text = files.join('\n');
    expect(trimUnifiedDiff(text, AGGRESSIVE)).toBe(text);
  });
});

describe('trimUnifiedDiff - hunk cap (rule d)', () => {
  function hunk(startLine: number, churn: number): string[] {
    const out = [`@@ -${startLine},2 +${startLine},2 @@`];
    for (let i = 0; i < churn; i++) {
      out.push(`-o${i}`);
      out.push(`+n${i}`);
    }
    return out;
  }

  it('aggressive: keeps first, last, and largest-churn middle; one marker per run', () => {
    // 6 hunks, churns: [1, 5, 2, 9, 3, 1]. maxHunks=4 -> keep first(0) + last(5)
    // + 2 largest middle: idx3(churn9), idx1(churn5). Dropped: idx2, idx4 (each
    // isolated -> two markers).
    const churns = [1, 5, 2, 9, 3, 1];
    const lines: string[] = ['diff --git a/m.ts b/m.ts'];
    let ln = 1;
    for (const c of churns) {
      lines.push(...hunk(ln, c));
      ln += 10;
    }
    const text = lines.join('\n');
    const { calls, onElide } = recorder();
    const out = trimUnifiedDiff(text, AGGRESSIVE, onElide);
    // Kept hunk headers: idx0 (@@ -1), idx1 (@@ -11), idx3 (@@ -31), idx5 (@@ -51).
    expect(out).toContain('@@ -1,2 +1,2 @@');
    expect(out).toContain('@@ -11,2 +11,2 @@');
    expect(out).toContain('@@ -31,2 +31,2 @@');
    expect(out).toContain('@@ -51,2 +51,2 @@');
    // Dropped hunk headers gone.
    expect(out).not.toContain('@@ -21,2 +21,2 @@'); // idx2
    expect(out).not.toContain('@@ -41,2 +41,2 @@'); // idx4
    // Two contiguous-drop markers (idx2 alone, idx4 alone).
    const markers = out.split('\n').filter((l) => /\[\d+ hunks elided by Sentinel/.test(l));
    expect(markers.length).toBe(2);
    expect(calls.length).toBe(2);
    // First marker captures idx2 exactly.
    expect(calls[0]?.elided).toBe(hunk(21, 2).join('\n'));
    // Second marker captures idx4 exactly.
    expect(calls[1]?.elided).toBe(hunk(41, 3).join('\n'));
  });

  it('contiguous dropped hunks fold into one marker', () => {
    // maxHunks=4 over 6 hunks all churn 1 -> keep first,last + 2 largest middle
    // (ties broken by earliest: idx1, idx2). Dropped idx3, idx4 contiguous.
    const lines: string[] = ['diff --git a/c.ts b/c.ts'];
    let ln = 1;
    for (let i = 0; i < 6; i++) {
      lines.push(...hunk(ln, 1));
      ln += 10;
    }
    const text = lines.join('\n');
    const out = trimUnifiedDiff(text, AGGRESSIVE);
    const markers = out.split('\n').filter((l) => /\[\d+ hunks elided by Sentinel/.test(l));
    expect(markers.length).toBe(1);
    expect(markers[0]).toContain('[2 hunks elided by Sentinel');
  });

  it('ranks middle hunks by TOTAL body-line count, not just +/- churn', () => {
    // idx1: 1 change (2 body lines) but 8 context lines => 10 body lines.
    // idx2: 3 changes (6 body lines), 0 context => 6 body lines.
    // maxHunks=3 (one middle slot). By body-line-count, idx1 (10) wins over
    // idx2 (6). A churn-only ranking would WRONGLY pick idx2 (churn 3 > 1).
    const fat = ['@@ -11,9 +11,9 @@'];
    for (let i = 0; i < 8; i++) fat.push(` ctx${i}`);
    fat.push('-only');
    fat.push('+only!');
    const compact = ['@@ -31,3 +31,3 @@', '-a', '+a!', '-b', '+b!', '-c', '+c!'];
    const text = [
      'diff --git a/rank.ts b/rank.ts',
      ...hunk(1, 1), // idx0 first (always kept)
      ...fat, // idx1
      ...compact, // idx2
      ...hunk(51, 1), // idx3 last (always kept)
    ].join('\n');
    const out = trimUnifiedDiff(text, { maxFiles: 20, maxHunks: 3, contextLines: 3 });
    // idx1 (fat, more body lines) kept; idx2 (compact) dropped.
    expect(out).toContain('@@ -11,9 +11,9 @@');
    expect(out).not.toContain('@@ -31,3 +31,3 @@');
  });

  it('hunk count exactly at maxHunks does not fire', () => {
    const lines: string[] = ['diff --git a/e.ts b/e.ts'];
    let ln = 1;
    for (let i = 0; i < 4; i++) {
      lines.push(...hunk(ln, 1));
      ln += 10;
    }
    const text = lines.join('\n');
    expect(trimUnifiedDiff(text, AGGRESSIVE)).toBe(text);
  });
});

describe('trimUnifiedDiff - context trim (rule e)', () => {
  // A hunk with a long leading context run (6 lines) and a long trailing run.
  function ctxDiff(lead: number, trail: number): string {
    const out = ['diff --git a/ctx.ts b/ctx.ts', '@@ -1,99 +1,99 @@'];
    for (let i = 0; i < lead; i++) out.push(` ctxL${i}`);
    out.push('-changed');
    out.push('+changed!');
    for (let i = 0; i < trail; i++) out.push(` ctxT${i}`);
    return out.join('\n');
  }

  it('aggressive (contextLines=1): trims leading and trailing when >=4 dropped', () => {
    const text = ctxDiff(6, 6); // lead drop = 6-1 = 5 >=4; trail drop = 5 >=4.
    const { calls, onElide } = recorder();
    const out = trimUnifiedDiff(text, AGGRESSIVE, onElide);
    const lines = out.split('\n');
    expect(lines[0]).toBe('diff --git a/ctx.ts b/ctx.ts');
    // @@ header is NEVER rewritten (stale counts accepted).
    expect(lines[1]).toBe('@@ -1,99 +1,99 @@');
    // Leading: one marker for 5 dropped, then 1 kept context (ctxL5, adjacent).
    expect(lines[2]).toContain('[5 context lines elided by Sentinel');
    expect(lines[3]).toBe(' ctxL5');
    expect(lines[4]).toBe('-changed');
    expect(lines[5]).toBe('+changed!');
    // Trailing: 1 kept context (ctxT0), then marker for 5 dropped.
    expect(lines[6]).toBe(' ctxT0');
    expect(lines[7]).toContain('[5 context lines elided by Sentinel');
    expect(lines.length).toBe(8);
    // Two capture calls; leading captures ctxL0..ctxL4, trailing ctxT1..ctxT5.
    expect(calls.length).toBe(2);
    expect(calls[0]?.elided).toBe([0, 1, 2, 3, 4].map((i) => ` ctxL${i}`).join('\n'));
    expect(calls[1]?.elided).toBe([1, 2, 3, 4, 5].map((i) => ` ctxT${i}`).join('\n'));
    expect(idOf(lines[2] ?? '')).toBe(hashOriginal(calls[0]?.elided ?? ''));
    expect(idOf(lines[7] ?? '')).toBe(hashOriginal(calls[1]?.elided ?? ''));
  });

  it('does NOT fire when the run is too short (<4 would be dropped)', () => {
    // contextLines=1, lead run of 4 -> drop 3 (<4) -> no trim; trail 4 -> drop 3.
    const text = ctxDiff(4, 4);
    expect(trimUnifiedDiff(text, AGGRESSIVE)).toBe(text);
  });

  it('moderate (contextLines=3) keeps more context than aggressive', () => {
    const text = ctxDiff(8, 0); // lead run 8.
    const mod = trimUnifiedDiff(text, MODERATE); // drop 8-3=5 >=4 -> trim, keep 3.
    const agg = trimUnifiedDiff(text, AGGRESSIVE); // drop 8-1=7 -> trim, keep 1.
    const modLines = mod.split('\n');
    const aggLines = agg.split('\n');
    // Moderate keeps ctxL5,6,7 (3 lines); aggressive keeps only ctxL7 (1 line).
    expect(modLines).toContain(' ctxL5');
    expect(modLines).toContain(' ctxL7');
    expect(aggLines).not.toContain(' ctxL5');
    expect(aggLines).toContain(' ctxL7');
    expect(mod).not.toBe(agg);
  });

  it('leaves a context-only hunk (no +/- lines) untouched', () => {
    // A @@ hunk whose body is all context lines: trimHunkContext finds no
    // change (first === -1) and returns the body unchanged. Single hunk under
    // caps -> overall identity.
    const text = [
      'diff --git a/ctxonly.ts b/ctxonly.ts',
      '@@ -1,6 +1,6 @@',
      ' a',
      ' b',
      ' c',
      ' d',
      ' e',
      ' f',
    ].join('\n');
    expect(trimUnifiedDiff(text, AGGRESSIVE)).toBe(text);
  });

  it('does not touch interior context between two changes', () => {
    const text = [
      'diff --git a/i.ts b/i.ts',
      '@@ -1,99 +1,99 @@',
      '-a',
      '+a!',
      ' interior0',
      ' interior1',
      ' interior2',
      ' interior3',
      ' interior4',
      '-b',
      '+b!',
    ].join('\n');
    // No leading/trailing context runs (changes at both ends) -> no-op identity.
    expect(trimUnifiedDiff(text, AGGRESSIVE)).toBe(text);
  });
});

describe('trimUnifiedDiff - preamble & special lines', () => {
  it('preserves git show preamble before the first file', () => {
    const text = [
      'commit abc123',
      'Author: Jane <jane@example.com>',
      '',
      '    a commit message',
      '',
      'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
    ].join('\n');
    const out = trimUnifiedDiff(text, MODERATE);
    const lines = out.split('\n');
    expect(lines.slice(0, 5)).toEqual([
      'commit abc123',
      'Author: Jane <jane@example.com>',
      '',
      '    a commit message',
      '',
    ]);
    expect(out).toContain('[1 hunks elided by Sentinel');
  });

  it('preserves old mode / new mode lines byte-identical (headroom-bug guard)', () => {
    // Force a transformation (lockfile) so the file is re-rendered, and assert
    // the mode lines survive byte-for-byte.
    const text = [
      'diff --git a/go.sum b/go.sum',
      'old mode 100755',
      'new mode 100644',
      'index 1..2',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+y',
    ].join('\n');
    const out = trimUnifiedDiff(text, MODERATE);
    const lines = out.split('\n');
    expect(lines).toContain('old mode 100755');
    expect(lines).toContain('new mode 100644');
    expect(lines).toContain('index 1..2');
  });

  it('preserves "\\ No newline at end of file" markers in kept hunks', () => {
    const text = [
      'diff --git a/n.ts b/n.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ].join('\n');
    // Single hunk under caps, no long context -> identity.
    expect(trimUnifiedDiff(text, MODERATE)).toBe(text);
    expect(text).toContain('\\ No newline at end of file');
  });
});

describe('trimUnifiedDiff - parser edge cases', () => {
  it('handles a diff -u with no diff --git and a --- / +++ file header', () => {
    // Force the cap to drop a file via the --- / +++ parse path. Two files,
    // maxFiles=1 -> the lighter one is elided through the --- /+++ branch.
    const text = [
      '--- a/one.txt',
      '+++ b/one.txt',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      '--- a/two.txt',
      '+++ b/two.txt',
      '@@ -1,1 +1,1 @@',
      '-c',
      '+d',
      '-e',
      '+f',
    ].join('\n');
    const out = trimUnifiedDiff(text, { maxFiles: 1, maxHunks: 10, contextLines: 3 });
    // two.txt (churn 4) is heavier than one.txt (churn 2) -> one.txt dropped.
    expect(out).toContain('[1 files (1 hunks) elided by Sentinel');
    expect(out).toContain('--- a/two.txt');
    expect(out).not.toContain('--- a/one.txt');
  });

  it('attaches a hunk that appears before any file header to a synthesized file', () => {
    // A diff-of-a-diff: the hunk BODY contains literal --- / +++ lines, which
    // makes isUnifiedDiff true, but the OUTER stream starts with a bare @@.
    const text = [
      '@@ -1,4 +1,4 @@',
      ' context',
      '--- a/inner.txt',
      '+++ b/inner.txt',
      '-removed',
      '+added',
    ].join('\n');
    // isUnifiedDiff true (the --- /+++ pair in the body); single synthesized
    // file, single hunk, no long context -> identity (nothing dropped).
    expect(isUnifiedDiff(text)).toBe(true);
    expect(trimUnifiedDiff(text, AGGRESSIVE)).toBe(text);
  });

  it('skips a file that has header lines but zero hunks (pure rename)', () => {
    // A rename-only file (no hunks) sits among files with hunks; the file cap
    // must not crash on the zero-hunk file and must keep it byte-identical.
    const renameOnly = [
      'diff --git a/old-name.ts b/new-name.ts',
      'similarity index 100%',
      'rename from old-name.ts',
      'rename to new-name.ts',
    ].join('\n');
    const lock = ['diff --git a/poetry.lock b/poetry.lock', '@@ -1,1 +1,1 @@', '-a', '+b'].join(
      '\n',
    );
    const text = [renameOnly, lock].join('\n');
    const out = trimUnifiedDiff(text, MODERATE);
    // Rename header survives verbatim; lockfile hunk is collapsed.
    expect(out).toContain('rename from old-name.ts');
    expect(out).toContain('rename to new-name.ts');
    expect(out).toContain('[1 hunks elided by Sentinel');
  });

  it('does not elide a hunk header with a non-lockfile path (lockfile false branch)', () => {
    // Exercises isLockfile returning false on both the diff --git and ---/+++
    // operands: a normal file with two hunks stays under the moderate caps.
    const text = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
    ].join('\n');
    expect(trimUnifiedDiff(text, MODERATE)).toBe(text);
  });
});

describe('trimUnifiedDiff - determinism, idempotency, reversibility', () => {
  // A diff that exercises every pass: lockfile, whitespace hunk, file cap,
  // hunk cap, context trim.
  function bigDiff(): string {
    const blocks: string[] = [];
    // Lockfile file.
    blocks.push(['diff --git a/Cargo.lock b/Cargo.lock', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n'));
    // 9 normal files to trip the file cap (aggressive maxFiles=8 over 1+9=10).
    for (let i = 0; i < 9; i++) {
      blocks.push(
        [
          `diff --git a/file${i}.ts b/file${i}.ts`,
          '@@ -1,99 +1,99 @@',
          ` c0`,
          ` c1`,
          ` c2`,
          ` c3`,
          ` c4`,
          `-x${i}`,
          `+y${i}`,
        ].join('\n'),
      );
    }
    return blocks.join('\n');
  }

  it('is deterministic across two runs', () => {
    const text = bigDiff();
    const a = trimUnifiedDiff(text, AGGRESSIVE);
    const b = trimUnifiedDiff(text, AGGRESSIVE);
    expect(a).toBe(b);
    expect(a).not.toBe(text);
  });

  it('is idempotent: second pass returns content unchanged', () => {
    const text = bigDiff();
    const once = trimUnifiedDiff(text, AGGRESSIVE);
    const twice = trimUnifiedDiff(once, AGGRESSIVE);
    expect(twice).toBe(once);
  });

  it('every marker id reconstructs its exact dropped bytes', () => {
    const { calls, onElide } = recorder();
    const out = trimUnifiedDiff(bigDiff(), AGGRESSIVE, onElide);
    // Build a hash -> original map from the recorder.
    const byId = new Map<string, string>();
    for (const c of calls) byId.set(hashOriginal(c.elided), c.elided);
    // Every id embedded in a marker must resolve to recorded bytes.
    const markerLines = out.split('\n').filter((l) => l.includes('elided by Sentinel'));
    expect(markerLines.length).toBeGreaterThan(0);
    for (const ml of markerLines) {
      const id = idOf(ml);
      expect(byId.has(id)).toBe(true);
      // And the recorded bytes hash back to the same id (round-trip).
      expect(hashOriginal(byId.get(id) ?? '')).toBe(id);
    }
  });

  it('without onElide the marker still carries the literal phrase and no hint', () => {
    const lock = ['diff --git a/Gemfile.lock b/Gemfile.lock', '@@ -1,1 +1,1 @@', '-a', '+b'].join(
      '\n',
    );
    const out = trimUnifiedDiff(lock, MODERATE);
    const marker = out.split('\n').find((l) => l.includes('elided by Sentinel'));
    expect(marker).toBe('... [1 hunks elided by Sentinel] ...');
    expect(marker).not.toContain('id=');
  });
});
