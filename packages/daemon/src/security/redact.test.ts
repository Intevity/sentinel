import { describe, it, expect } from 'vitest';
import { maskSecret, buildSnippet, hashText, contextHashOf } from './redact.js';

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
