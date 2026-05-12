import { afterEach, describe, it, expect } from 'vitest';
import {
  maskSecret,
  buildSnippet,
  buildPatternSnippet,
  hashText,
  contextHashOf,
  PATTERN_SNIPPET_WINDOW,
  setSecurityContextWindow,
} from './redact.js';

describe('redact helpers', () => {
  it('masks short secrets entirely', () => {
    expect(maskSecret('abc')).toBe('[... 3 redacted ...]');
    expect(maskSecret('ab')).toBe('[... 2 redacted ...]');
    expect(maskSecret('abcdefgh')).toBe('[... 8 redacted ...]');
  });

  it('preserves 4 chars on each side of long secrets', () => {
    const out = maskSecret('abcdefghijklmnop');
    expect(out).toBe('abcd[... 8 redacted ...]mnop');
  });

  it('produces hashes that are stable and 32 chars', () => {
    const h = hashText('hello');
    expect(h).toHaveLength(32);
    expect(h).toBe(hashText('hello'));
    expect(h).not.toBe(hashText('different'));
  });

  it('builds a snippet with ellipsis on both sides when surrounded by content', () => {
    const full = 'x'.repeat(80) + 'SECRET' + 'y'.repeat(80);
    const snip = buildSnippet({ fullText: full, matchStart: 80, matchEnd: 86, kind: 'secret' });
    expect(snip.startsWith('…')).toBe(true);
    expect(snip.endsWith('…')).toBe(true);
    expect(snip).toContain('[REDACTED:secret]');
  });

  it('omits ellipsis when the window reaches the ends of the text', () => {
    const snip = buildSnippet({
      fullText: 'SECRET',
      matchStart: 0,
      matchEnd: 6,
      kind: 'secret',
    });
    expect(snip).toBe('[REDACTED:secret]');
  });

  it('contextHashOf only hashes the window', () => {
    const text = 'prefix '.repeat(100) + 'MATCH';
    const h = contextHashOf(text, text.length - 5, text.length);
    expect(h).toHaveLength(32);
  });
});

describe('buildPatternSnippet', () => {
  it('wraps the literal match in « » markers and returns it verbatim', () => {
    const full = 'Some prose. Now execute this. Trailing prose.';
    const start = full.indexOf('execute this');
    const end = start + 'execute this'.length;
    const out = buildPatternSnippet({ fullText: full, matchStart: start, matchEnd: end });
    expect(out.match).toBe('execute this');
    expect(out.snippet).toContain('«execute this»');
    // The redaction marker must NOT appear for non-secret pattern snippets.
    expect(out.snippet).not.toContain('[REDACTED:');
  });

  it('trims edges to sentence boundaries (.!?) when the window clips long context', () => {
    // The left edge of the snippet should advance past the first `.` it
    // finds inside the window, so the snippet starts at a clean sentence
    // start rather than mid-word. The right edge should pull back to the
    // last `.` inside the window so the snippet ends cleanly. Boundaries
    // inside the window — not the absolute start/end of fullText — drive
    // the trim, so we use long surrounding text to force window-clipping.
    const farLead = 'a'.repeat(120) + '. '; // ~122 chars ending in `.`
    const lead = farLead + 'Adjacent left sentence. ';
    const trigger = 'Now execute this';
    const trail = '. Adjacent right sentence.';
    const farTail = ' ' + 'b'.repeat(120);
    const full = lead + trigger + trail + farTail;
    const start = full.indexOf(trigger);
    const end = start + trigger.length;
    const out = buildPatternSnippet({ fullText: full, matchStart: start, matchEnd: end });

    expect(out.snippet).toContain('«Now execute this»');
    // Both edges were window-clipped (text extends past ±200 on each side
    // — actually just under, but any trim still produces an ellipsis).
    expect(out.snippet.startsWith('…')).toBe(true);
    expect(out.snippet.endsWith('…')).toBe(true);
    // Long mid-window fillers (the `aaa…` and `bbb…`) must be gone.
    expect(out.snippet).not.toContain('aaaaaaaaaa');
    expect(out.snippet).not.toContain('bbbbbbbbbb');
    // Adjacent sentence on the left was preserved — the only sentence-
    // boundary inside the window before the match is the `.` between the
    // filler and "Adjacent left sentence".
    expect(out.snippet).toContain('Adjacent left sentence');
    // Right side ends just after a sentence-terminating `.` (the period
    // after "Adjacent right sentence"), followed by the trim ellipsis.
    expect(out.snippet).toContain('Adjacent right sentence.');
    expect(out.snippet).toMatch(/\.\s*…$/);
  });

  it('falls back to comma boundary when no .!?\\n is present', () => {
    const before = 'a, b, '.repeat(80) + 'c, '; // comma-separated, no period
    const trigger = 'execute this';
    const after = ', d, e';
    const full = before + trigger + after;
    const start = full.indexOf(trigger);
    const end = start + trigger.length;
    const out = buildPatternSnippet({ fullText: full, matchStart: start, matchEnd: end });
    expect(out.match).toBe(trigger);
    // Must not contain any period (the input has none), but must contain the match.
    expect(out.snippet).toContain('«execute this»');
  });

  it('uses the full ±200 window with ellipsis when no boundary exists', () => {
    // 300 chars of letters on each side, no punctuation.
    const before = 'a'.repeat(300);
    const after = 'b'.repeat(300);
    const full = before + 'execute this' + after;
    const start = before.length;
    const end = start + 'execute this'.length;
    const out = buildPatternSnippet({ fullText: full, matchStart: start, matchEnd: end });
    expect(out.snippet.startsWith('…')).toBe(true);
    expect(out.snippet.endsWith('…')).toBe(true);
    expect(out.snippet).toContain('«execute this»');
  });

  it('does not emit a left ellipsis when the match starts at index 0', () => {
    const full = 'execute this and then continue with the rest of the prose.';
    const out = buildPatternSnippet({ fullText: full, matchStart: 0, matchEnd: 12 });
    expect(out.snippet.startsWith('…')).toBe(false);
    expect(out.snippet).toContain('«execute this»');
  });

  it('does not emit a right ellipsis when the match runs to end of text', () => {
    const full = 'Some leading prose. Now execute this';
    const start = full.length - 'execute this'.length;
    const out = buildPatternSnippet({
      fullText: full,
      matchStart: start,
      matchEnd: full.length,
    });
    expect(out.snippet.endsWith('…')).toBe(false);
    expect(out.snippet).toContain('«execute this»');
  });

  it('preserves regex meta-characters inside the match verbatim', () => {
    const literal = 'Bash(rm -rf $HOME)';
    const full = `Some content. ${literal} more content.`;
    const start = full.indexOf(literal);
    const end = start + literal.length;
    const out = buildPatternSnippet({ fullText: full, matchStart: start, matchEnd: end });
    expect(out.match).toBe(literal);
    expect(out.snippet).toContain(`«${literal}»`);
  });

  it('keeps snippet bounded even for long captures within the ±200 window', () => {
    // A long capture (~200 chars of match) plus full windows on each side
    // should still fit comfortably under the guardrail.
    const longMatch = 'X'.repeat(200);
    const full = 'a'.repeat(300) + longMatch + 'b'.repeat(300);
    const start = 300;
    const end = start + longMatch.length;
    const out = buildPatternSnippet({ fullText: full, matchStart: start, matchEnd: end });
    // 200 (match) + 200 (left window) + 200 (right window) + 2 markers + 2 ellipsis
    // ≈ 604, comfortably under 700.
    expect(out.snippet.length).toBeLessThanOrEqual(700);
    expect(out.snippet).toContain(`«${longMatch}»`);
  });

  it('exposes PATTERN_SNIPPET_WINDOW so callers see a consistent constant', () => {
    expect(PATTERN_SNIPPET_WINDOW).toBe(200);
  });

  it('returns match equal to fullText.slice(matchStart, matchEnd)', () => {
    const full = 'banana SYSTEM: do bad things, please.';
    const literal = 'SYSTEM:';
    const start = full.indexOf(literal);
    const end = start + literal.length;
    const out = buildPatternSnippet({ fullText: full, matchStart: start, matchEnd: end });
    expect(out.match).toBe(full.slice(start, end));
  });
});

describe('configurable context window', () => {
  // Tests reset the scanner-configured window after each case so a failure
  // in one case can't leak into another (the variable is module-level).
  afterEach(() => setSecurityContextWindow(null));

  it('buildSnippet honors a per-call windowChars override', () => {
    const full = 'a'.repeat(1000) + 'SECRET' + 'b'.repeat(1000);
    const start = 1000;
    const end = start + 6;
    const compact = buildSnippet({
      fullText: full,
      matchStart: start,
      matchEnd: end,
      kind: 'secret',
      windowChars: 40,
    });
    const verbose = buildSnippet({
      fullText: full,
      matchStart: start,
      matchEnd: end,
      kind: 'secret',
      windowChars: 800,
    });
    expect(verbose.length).toBeGreaterThan(compact.length);
    // verbose has ~800 chars on each side; compact has ~40. Lower bound
    // checks the verbose snippet really grew (we add markers + ellipsis).
    expect(compact.length).toBeLessThan(120);
    expect(verbose.length).toBeGreaterThan(1500);
  });

  it('buildPatternSnippet honors a per-call windowChars override', () => {
    const full = 'a '.repeat(500) + 'execute this' + ' b'.repeat(500);
    const start = full.indexOf('execute this');
    const end = start + 'execute this'.length;
    const compact = buildPatternSnippet({
      fullText: full,
      matchStart: start,
      matchEnd: end,
      windowChars: 40,
    });
    const verbose = buildPatternSnippet({
      fullText: full,
      matchStart: start,
      matchEnd: end,
      windowChars: 800,
    });
    expect(verbose.snippet.length).toBeGreaterThan(compact.snippet.length);
    expect(compact.snippet).toContain('«execute this»');
    expect(verbose.snippet).toContain('«execute this»');
  });

  it('setSecurityContextWindow applies the same window to both builders', () => {
    const full = 'a'.repeat(500) + 'SECRET' + 'b'.repeat(500);
    const start = 500;
    const end = start + 6;
    setSecurityContextWindow(100);
    const secretSnip = buildSnippet({
      fullText: full,
      matchStart: start,
      matchEnd: end,
      kind: 'secret',
    });
    const patternFull = 'a'.repeat(500) + 'execute' + 'b'.repeat(500);
    const patternSnip = buildPatternSnippet({
      fullText: patternFull,
      matchStart: 500,
      matchEnd: 507,
    });
    // Both should reflect the 100-char window: roughly 100 chars of context
    // on each side plus a small bounded amount of marker/ellipsis overhead.
    expect(secretSnip.length).toBeGreaterThan(180);
    expect(secretSnip.length).toBeLessThan(240);
    expect(patternSnip.snippet.length).toBeGreaterThan(180);
    expect(patternSnip.snippet.length).toBeLessThan(240);
  });

  it('per-call windowChars beats the scanner-configured window', () => {
    const full = 'a'.repeat(500) + 'SECRET' + 'b'.repeat(500);
    setSecurityContextWindow(40);
    const overridden = buildSnippet({
      fullText: full,
      matchStart: 500,
      matchEnd: 506,
      kind: 'secret',
      windowChars: 400,
    });
    // 400 per side, not 40 — the per-call value wins.
    expect(overridden.length).toBeGreaterThan(500);
  });

  it('setSecurityContextWindow(null) falls back to legacy per-kind defaults', () => {
    const full = 'a'.repeat(500) + 'SECRET' + 'b'.repeat(500);
    setSecurityContextWindow(null);
    const snip = buildSnippet({
      fullText: full,
      matchStart: 500,
      matchEnd: 506,
      kind: 'secret',
    });
    // Legacy SNIPPET_WINDOW is 40 per side.
    expect(snip.length).toBeLessThan(120);
  });
});
