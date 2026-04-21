import { describe, it, expect } from 'vitest';
import { parseRule, parseRawWithDecision, canonicalRaw, isValidRule } from './parser.js';

describe('parseRule — whole tool', () => {
  it.each([
    ['Bash'],
    ['Read'],
    ['Edit'],
    ['Write'],
    ['Glob'],
    ['Grep'],
    ['WebFetch'],
    ['WebSearch'],
    ['Agent'],
    ['NotebookEdit'],
    ['*'],
  ])('parses %s as whole-tool rule', (input) => {
    const r = parseRule(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.tool).toBe(input);
      expect(r.parsed.pattern).toBeNull();
      expect(r.parsed.raw).toBe(input);
    }
  });

  it('parses MCP tool names with double-underscore segments', () => {
    const r = parseRule('mcp__github__create_issue');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.tool).toBe('mcp__github__create_issue');
      expect(r.parsed.pattern).toBeNull();
    }
  });

  it('parses MCP wildcard per server', () => {
    const r = parseRule('mcp__github__*');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.tool).toBe('mcp__github__*');
      expect(r.parsed.pattern).toBeNull();
    }
  });

  it('trims outer whitespace', () => {
    const r = parseRule('  Bash  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed.tool).toBe('Bash');
  });
});

describe('parseRule — with pattern', () => {
  it('parses Bash(npm *)', () => {
    const r = parseRule('Bash(npm *)');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.tool).toBe('Bash');
      expect(r.parsed.pattern).toBe('npm *');
      expect(r.parsed.raw).toBe('Bash(npm *)');
    }
  });

  it('parses Bash(rm -rf *)', () => {
    const r = parseRule('Bash(rm -rf *)');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed.pattern).toBe('rm -rf *');
  });

  it('parses absolute Read path', () => {
    const r = parseRule('Read(//Users/jeff/secrets/**)');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.parsed.tool).toBe('Read');
      expect(r.parsed.pattern).toBe('//Users/jeff/secrets/**');
    }
  });

  it('parses project-relative path', () => {
    const r = parseRule('Edit(/src/**/*.ts)');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed.pattern).toBe('/src/**/*.ts');
  });

  it('parses home-relative path', () => {
    const r = parseRule('Read(~/Documents/*.pdf)');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed.pattern).toBe('~/Documents/*.pdf');
  });

  it('parses WebFetch domain pattern', () => {
    const r = parseRule('WebFetch(domain:example.com)');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed.pattern).toBe('domain:example.com');
  });

  it('preserves internal whitespace in Bash patterns', () => {
    const r = parseRule('Bash(ls -la)');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.parsed.pattern).toBe('ls -la');
  });

  it('round-trips raw form via canonical serialization', () => {
    const r = parseRule('  Bash(  npm test  )  ');
    expect(r.ok).toBe(true);
    // Outer whitespace stripped; inner whitespace retained verbatim.
    if (r.ok) expect(r.parsed.raw).toBe('Bash(  npm test  )');
  });
});

describe('parseRule — rejections', () => {
  it('rejects empty string', () => {
    expect(parseRule('').ok).toBe(false);
  });
  it('rejects whitespace-only string', () => {
    expect(parseRule('   ').ok).toBe(false);
  });
  it('rejects empty parentheses', () => {
    const r = parseRule('Bash()');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty parentheses/);
  });
  it('rejects unclosed parenthesis', () => {
    expect(parseRule('Bash(npm').ok).toBe(false);
  });
  it('rejects missing tool before paren', () => {
    expect(parseRule('(npm *)').ok).toBe(false);
  });
  it('rejects nested parentheses in pattern', () => {
    const r = parseRule('Bash(echo (hi))');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/nested parentheses/);
  });
  it('rejects invalid tool name with hyphens', () => {
    expect(parseRule('bad-tool').ok).toBe(false);
  });
  it('rejects an invalid tool name when the rule has a pattern', () => {
    // Hits the parenthesized-form branch where VALID_TOOL_RE fails on the
    // extracted tool — line 69-70 of parser.ts.
    const r = parseRule('bad-tool(rm *)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid tool name/);
  });
  it('rejects non-string input', () => {
    // @ts-expect-error intentional invalid input
    expect(parseRule(null).ok).toBe(false);
    // @ts-expect-error intentional invalid input
    expect(parseRule(undefined).ok).toBe(false);
  });
});

describe('parseRawWithDecision', () => {
  it('parses "allow Bash(npm *)"', () => {
    const r = parseRawWithDecision('allow Bash(npm *)');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decision).toBe('allow');
      expect(r.parsed.raw).toBe('Bash(npm *)');
    }
  });
  it('parses "deny Bash(rm -rf *)"', () => {
    const r = parseRawWithDecision('deny Bash(rm -rf *)');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.decision).toBe('deny');
      expect(r.parsed.raw).toBe('Bash(rm -rf *)');
    }
  });
  it('accepts uppercase decision token', () => {
    const r = parseRawWithDecision('DENY Bash');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision).toBe('deny');
  });
  it('rejects missing decision prefix', () => {
    const r = parseRawWithDecision('Bash(npm *)');
    expect(r.ok).toBe(false);
  });
  it('rejects decision without rule', () => {
    const r = parseRawWithDecision('allow');
    expect(r.ok).toBe(false);
  });
  it('rejects bogus decision', () => {
    const r = parseRawWithDecision('maybe Bash');
    expect(r.ok).toBe(false);
  });
  it('propagates parse errors from the inner rule', () => {
    const r = parseRawWithDecision('allow Bash(');
    expect(r.ok).toBe(false);
  });
  it('rejects non-string input', () => {
    // @ts-expect-error intentional invalid input
    expect(parseRawWithDecision(42).ok).toBe(false);
  });
});

describe('canonicalRaw', () => {
  it('returns tool alone when pattern is null', () => {
    expect(canonicalRaw('Bash', null)).toBe('Bash');
  });
  it('builds Tool(pattern) form', () => {
    expect(canonicalRaw('Bash', 'npm *')).toBe('Bash(npm *)');
  });
  it('trims tool whitespace', () => {
    expect(canonicalRaw('  Bash  ', 'npm *')).toBe('Bash(npm *)');
  });
});

describe('isValidRule', () => {
  it('returns true for valid inputs', () => {
    expect(isValidRule('Bash')).toBe(true);
    expect(isValidRule('Bash(npm *)')).toBe(true);
  });
  it('returns false for invalid inputs', () => {
    expect(isValidRule('')).toBe(false);
    expect(isValidRule('bad-tool')).toBe(false);
    expect(isValidRule('Bash(')).toBe(false);
  });
});
