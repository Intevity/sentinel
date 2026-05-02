import { describe, it, expect } from 'vitest';
import { renderClaudeCodeMd, gapFingerprint, type GapSubagent } from './gap-to-claude-code.js';

const SAMPLE: GapSubagent = {
  name: 'sample',
  description: 'Use when sampling.',
  model: 'haiku',
  tools: ['Read', 'Grep'],
  soul: 'You are a sample agent.\n\nFollow the rules.',
  gapSchemaVersion: 1,
};

describe('renderClaudeCodeMd', () => {
  it('emits frontmatter with stable key order', () => {
    const md = renderClaudeCodeMd(SAMPLE);
    const fmStart = md.indexOf('---\n');
    const fmEnd = md.indexOf('\n---', fmStart + 4);
    const frontmatter = md.slice(fmStart + 4, fmEnd).trim();
    expect(frontmatter).toBe(
      [
        'name: sample',
        'description: Use when sampling.',
        'tools: Read, Grep',
        'model: haiku',
        'gap_schema_version: 1',
      ].join('\n'),
    );
  });

  it('omits the tools line when tools[] is empty (inherit-all semantics)', () => {
    const md = renderClaudeCodeMd({ ...SAMPLE, tools: [] });
    expect(md).not.toMatch(/^tools:/m);
  });

  it('includes the body after frontmatter', () => {
    const md = renderClaudeCodeMd(SAMPLE);
    expect(md).toContain('You are a sample agent.\n\nFollow the rules.');
  });

  it('produces byte-stable output across calls', () => {
    expect(renderClaudeCodeMd(SAMPLE)).toBe(renderClaudeCodeMd(SAMPLE));
  });

  it('escapes special YAML characters in inline scalars', () => {
    const md = renderClaudeCodeMd({
      ...SAMPLE,
      description: 'has: a colon and # hash',
    });
    expect(md).toMatch(/description: 'has: a colon and # hash'/);
  });

  it('doubles a literal apostrophe in an escaped scalar', () => {
    const md = renderClaudeCodeMd({
      ...SAMPLE,
      description: "It's a description with apostrophes",
    });
    expect(md).toMatch(/description: 'It''s a description with apostrophes'/);
  });

  it('emits empty single-quoted scalar for empty string', () => {
    const md = renderClaudeCodeMd({ ...SAMPLE, description: '' });
    expect(md).toMatch(/description: ''/);
  });

  it('strips trailing whitespace from body lines', () => {
    const md = renderClaudeCodeMd({
      ...SAMPLE,
      soul: 'line one   \nline two\t\t\n',
    });
    expect(md).toMatch(/line one\nline two\n$/);
  });

  it('normalizes CRLF to LF in the body', () => {
    const md = renderClaudeCodeMd({ ...SAMPLE, soul: 'a\r\nb\r\nc' });
    expect(md).toContain('a\nb\nc');
    expect(md).not.toContain('\r');
  });
});

describe('gapFingerprint', () => {
  it('returns a 64-char hex string', () => {
    const fp = gapFingerprint(SAMPLE);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any GAP field changes', () => {
    const a = gapFingerprint(SAMPLE);
    const b = gapFingerprint({ ...SAMPLE, soul: 'different soul' });
    const c = gapFingerprint({ ...SAMPLE, model: 'sonnet' });
    const d = gapFingerprint({ ...SAMPLE, name: 'sample2' });
    expect(b).not.toBe(a);
    expect(c).not.toBe(a);
    expect(d).not.toBe(a);
    expect(b).not.toBe(c);
  });

  it('is stable across calls for identical input', () => {
    expect(gapFingerprint(SAMPLE)).toBe(gapFingerprint(SAMPLE));
  });
});
