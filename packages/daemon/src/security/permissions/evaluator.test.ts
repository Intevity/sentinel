import { describe, it, expect } from 'vitest';
import type { PermissionRule } from '@sentinel/shared';
import {
  compileRules,
  evaluateToolCall,
  findWholeToolDeny,
  hashCanonicalToolInput,
  ruleMatches,
  type EvaluatorSettingsView,
} from './evaluator.js';

function rule(overrides: Partial<PermissionRule>): PermissionRule {
  return {
    id: overrides.id ?? `r-${Math.random().toString(36).slice(2)}`,
    decision: overrides.decision ?? 'deny',
    tool: overrides.tool ?? 'Bash',
    pattern: overrides.pattern ?? null,
    raw: overrides.raw ?? overrides.tool ?? 'Bash',
    note: overrides.note ?? null,
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 100,
    createdAt: overrides.createdAt ?? 0,
    source: overrides.source ?? 'local',
    projectScope: overrides.projectScope ?? null,
  };
}

function settings(overrides: Partial<EvaluatorSettingsView> = {}): EvaluatorSettingsView {
  return {
    toolPermissionsEnabled: true,
    toolPermissionDefaultAction: 'allow',
    toolPermissionSkipInAutoMode: true,
    toolPermissionAutoModeActive: false,
    denyPrivateNetworkByDefault: false,
    toolPermissionResolveSymlinks: false,
    ...overrides,
  };
}

describe('compileRules', () => {
  it('separates denies and allows', () => {
    const rules = [
      rule({ decision: 'allow', tool: 'Bash', raw: 'Bash' }),
      rule({ decision: 'deny', tool: 'WebFetch', raw: 'WebFetch' }),
    ];
    const compiled = compileRules(rules);
    expect(compiled.denies).toHaveLength(1);
    expect(compiled.allows).toHaveLength(1);
  });
  it('drops disabled rules', () => {
    const rules = [rule({ enabled: false })];
    expect(compileRules(rules).denies).toHaveLength(0);
  });
  it('sorts by priority ASC then createdAt ASC', () => {
    const rules = [
      rule({ id: 'a', decision: 'deny', priority: 20, createdAt: 1, raw: 'a' }),
      rule({ id: 'b', decision: 'deny', priority: 10, createdAt: 1, raw: 'b' }),
      rule({ id: 'c', decision: 'deny', priority: 10, createdAt: 0, raw: 'c' }),
    ];
    const compiled = compileRules(rules);
    expect(compiled.denies.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('ruleMatches — whole tool', () => {
  it('matches exact tool name', () => {
    expect(ruleMatches(rule({ tool: 'Bash' }), 'Bash', { command: 'ls' })).toBe(true);
  });
  it('does not match different tool', () => {
    expect(ruleMatches(rule({ tool: 'Bash' }), 'Read', { file_path: '/a' })).toBe(false);
  });
  it('* tool matches any tool', () => {
    expect(ruleMatches(rule({ tool: '*' }), 'Bash', { command: 'ls' })).toBe(true);
    expect(ruleMatches(rule({ tool: '*' }), 'WebFetch', { url: 'https://a.com' })).toBe(true);
  });
  it('mcp wildcard matches per-server tools', () => {
    expect(ruleMatches(rule({ tool: 'mcp__github__*' }), 'mcp__github__create_issue', {})).toBe(
      true,
    );
    expect(ruleMatches(rule({ tool: 'mcp__github__*' }), 'mcp__gitlab__create_issue', {})).toBe(
      false,
    );
  });
});

describe('ruleMatches — Bash patterns', () => {
  it('matches Bash(npm *)', () => {
    expect(
      ruleMatches(rule({ tool: 'Bash', pattern: 'npm *', raw: 'Bash(npm *)' }), 'Bash', {
        command: 'npm install',
      }),
    ).toBe(true);
  });
  it('does not match different tool via Bash pattern', () => {
    expect(ruleMatches(rule({ tool: 'Bash', pattern: 'npm *' }), 'Read', { file_path: '/a' })).toBe(
      false,
    );
  });
  it('matches through timeout wrapper', () => {
    expect(
      ruleMatches(rule({ tool: 'Bash', pattern: 'rm -rf *' }), 'Bash', {
        command: 'timeout 30 rm -rf /tmp/foo',
      }),
    ).toBe(true);
  });
});

describe('ruleMatches — path patterns', () => {
  it('matches Read absolute path glob', () => {
    expect(
      ruleMatches(rule({ tool: 'Read', pattern: '//etc/**' }), 'Read', {
        file_path: '/etc/passwd',
      }),
    ).toBe(true);
  });
  it('respects tool-name gate for paths', () => {
    expect(
      ruleMatches(rule({ tool: 'Read', pattern: '//etc/**' }), 'Edit', {
        file_path: '/etc/passwd',
      }),
    ).toBe(false);
  });
});

describe('ruleMatches — WebFetch domain', () => {
  it('matches domain:', () => {
    expect(
      ruleMatches(rule({ tool: 'WebFetch', pattern: 'domain:example.com' }), 'WebFetch', {
        url: 'https://example.com',
      }),
    ).toBe(true);
  });
});

describe('ruleMatches — opts.resolveSymlinks threading', () => {
  // Smoke-test that opts is forwarded to matchPath. The behavior of
  // realpath is exercised end-to-end in matchers.symlink.test.ts; here
  // we just pin that ruleMatches accepts the opts arg without changing
  // the no-opts behavior.
  it('returns true with resolveSymlinks=false for a literal-path match', () => {
    expect(
      ruleMatches(
        rule({ tool: 'Read', pattern: '//etc/**' }),
        'Read',
        { file_path: '/etc/passwd' },
        { resolveSymlinks: false },
      ),
    ).toBe(true);
  });

  it('forwards opts to matchPath (smoke test — non-existent path falls back gracefully)', () => {
    // realpathSync throws ENOENT for a non-existent path; the matcher
    // catches and falls back to the un-resolved input. Pin that the
    // forwarding works (no exception escapes ruleMatches) and that
    // the literal pattern still matches the literal input.
    expect(
      ruleMatches(
        rule({ tool: 'Read', pattern: '//tmp/cs-evaluator-no-such-file/**' }),
        'Read',
        { file_path: '/tmp/cs-evaluator-no-such-file/x' },
        { resolveSymlinks: true },
      ),
    ).toBe(true);
  });
});

describe('evaluateToolCall — short circuits', () => {
  it('allows when feature disabled', () => {
    const r = evaluateToolCall(
      'Bash',
      { command: 'rm -rf /' },
      compileRules([rule({ decision: 'deny', pattern: 'rm -rf *', tool: 'Bash' })]),
      settings({ toolPermissionsEnabled: false }),
    );
    expect(r.decision).toBe('allow');
    expect(r.matchedRule).toBeNull();
  });

  it('allows when auto-mode active and skip enabled', () => {
    const r = evaluateToolCall(
      'Bash',
      { command: 'rm -rf /' },
      compileRules([rule({ decision: 'deny', pattern: 'rm -rf *', tool: 'Bash' })]),
      settings({ toolPermissionAutoModeActive: true, toolPermissionSkipInAutoMode: true }),
    );
    expect(r.decision).toBe('allow');
    expect(r.reason).toMatch(/auto mode/);
  });

  it('does NOT skip when auto-mode active but skip disabled', () => {
    const r = evaluateToolCall(
      'Bash',
      { command: 'rm -rf /' },
      compileRules([
        rule({ decision: 'deny', pattern: 'rm -rf *', tool: 'Bash', raw: 'Bash(rm -rf *)' }),
      ]),
      settings({ toolPermissionAutoModeActive: true, toolPermissionSkipInAutoMode: false }),
    );
    expect(r.decision).toBe('deny');
  });
});

describe('evaluateToolCall — deny > allow ordering', () => {
  it('deny wins even when allow also matches', () => {
    const compiled = compileRules([
      rule({ id: 'a', decision: 'allow', tool: 'Bash', pattern: '*', raw: 'Bash(*)' }),
      rule({ id: 'd', decision: 'deny', tool: 'Bash', pattern: 'rm *', raw: 'Bash(rm *)' }),
    ]);
    const r = evaluateToolCall('Bash', { command: 'rm -rf /' }, compiled, settings());
    expect(r.decision).toBe('deny');
    expect(r.matchedRule?.id).toBe('d');
  });

  it('first-matching deny in priority order wins', () => {
    const compiled = compileRules([
      rule({
        id: 'd1',
        decision: 'deny',
        tool: 'Bash',
        pattern: 'rm *',
        raw: 'Bash(rm *)',
        priority: 20,
      }),
      rule({
        id: 'd2',
        decision: 'deny',
        tool: 'Bash',
        pattern: 'rm -rf *',
        raw: 'Bash(rm -rf *)',
        priority: 10,
      }),
    ]);
    const r = evaluateToolCall('Bash', { command: 'rm -rf /' }, compiled, settings());
    expect(r.matchedRule?.id).toBe('d2');
  });

  it('allow wins when no deny matches', () => {
    const compiled = compileRules([
      rule({ id: 'a', decision: 'allow', tool: 'Bash', pattern: 'npm *', raw: 'Bash(npm *)' }),
      rule({ id: 'd', decision: 'deny', tool: 'Bash', pattern: 'rm *', raw: 'Bash(rm *)' }),
    ]);
    const r = evaluateToolCall('Bash', { command: 'npm test' }, compiled, settings());
    expect(r.decision).toBe('allow');
    expect(r.matchedRule?.id).toBe('a');
  });
});

describe('evaluateToolCall — default action fallback', () => {
  it('falls back to default allow when no rule matches', () => {
    const compiled = compileRules([rule({ decision: 'deny', tool: 'WebFetch' })]);
    const r = evaluateToolCall(
      'Bash',
      { command: 'ls' },
      compiled,
      settings({ toolPermissionDefaultAction: 'allow' }),
    );
    expect(r.decision).toBe('allow');
    expect(r.matchedRule).toBeNull();
  });
  it('falls back to default deny when no rule matches', () => {
    const compiled = compileRules([]);
    const r = evaluateToolCall(
      'Bash',
      { command: 'ls' },
      compiled,
      settings({ toolPermissionDefaultAction: 'deny' }),
    );
    expect(r.decision).toBe('deny');
    expect(r.matchedRule).toBeNull();
  });
});

describe('evaluateToolCall — per-rule input bypass', () => {
  it('flips a matched deny to allow when isBypassed returns true', () => {
    const compiled = compileRules([
      rule({ id: 'd', decision: 'deny', tool: 'Bash', pattern: 'rm *', raw: 'Bash(rm *)' }),
    ]);
    let checkedRuleId: string | null = null;
    const r = evaluateToolCall('Bash', { command: 'rm -rf /tmp/x' }, compiled, settings(), {
      isBypassed: (ruleId) => {
        checkedRuleId = ruleId;
        return true;
      },
    });
    expect(r.decision).toBe('allow');
    expect(r.matchedRule?.id).toBe('d');
    expect(r.reason).toMatch(/bypassed/);
    expect(checkedRuleId).toBe('d');
  });

  it('still denies when isBypassed returns false', () => {
    const compiled = compileRules([
      rule({ id: 'd', decision: 'deny', tool: 'Bash', pattern: 'rm *', raw: 'Bash(rm *)' }),
    ]);
    const r = evaluateToolCall('Bash', { command: 'rm -rf /tmp/x' }, compiled, settings(), {
      isBypassed: () => false,
    });
    expect(r.decision).toBe('deny');
  });

  it('hashes identical inputs to the same digest regardless of key order', () => {
    // Two tool inputs that differ only in key order must hash identically
    // so a per-input bypass registered with one ordering still catches the
    // other. The evaluator now consults the wildcard sentinel ('*') first
    // and falls back to the canonical hash, so we filter wildcard entries
    // out of `seen` before comparing.
    const compiled = compileRules([
      rule({ id: 'd', decision: 'deny', tool: 'Write', pattern: '*', raw: 'Write(*)' }),
    ]);
    const seen: string[] = [];
    const hook = {
      isBypassed: (_: string, h: string) => {
        seen.push(h);
        return false;
      },
    };
    evaluateToolCall('Write', { path: '/tmp/a', content: 'x' }, compiled, settings(), hook);
    evaluateToolCall('Write', { content: 'x', path: '/tmp/a' }, compiled, settings(), hook);
    const canonical = seen.filter((h) => h !== '*');
    expect(canonical).toHaveLength(2);
    expect(canonical[0]).toBe(canonical[1]);
  });

  it('skips the hash + bypass check entirely when no hook is provided', () => {
    const compiled = compileRules([
      rule({ id: 'd', decision: 'deny', tool: 'Bash', pattern: 'rm *', raw: 'Bash(rm *)' }),
    ]);
    // Undefined hooks object — no hashCanonicalToolInput call at all.
    const r = evaluateToolCall('Bash', { command: 'rm -rf /' }, compiled, settings());
    expect(r.decision).toBe('deny');
  });
});

describe('findWholeToolDeny', () => {
  it('finds whole-tool deny rule', () => {
    const compiled = compileRules([
      rule({ id: 'd', decision: 'deny', tool: 'WebFetch', pattern: null, raw: 'WebFetch' }),
    ]);
    expect(findWholeToolDeny('WebFetch', compiled, settings())?.id).toBe('d');
  });
  it('skips pattern-based deny rules (not whole-tool)', () => {
    const compiled = compileRules([
      rule({ decision: 'deny', tool: 'Bash', pattern: 'rm *', raw: 'Bash(rm *)' }),
    ]);
    expect(findWholeToolDeny('Bash', compiled, settings())).toBeNull();
  });
  it('matches * whole-tool deny against any tool', () => {
    const compiled = compileRules([rule({ decision: 'deny', tool: '*', pattern: null, raw: '*' })]);
    expect(findWholeToolDeny('WebFetch', compiled, settings())).not.toBeNull();
    expect(findWholeToolDeny('Bash', compiled, settings())).not.toBeNull();
  });
  it('respects feature disabled', () => {
    const compiled = compileRules([
      rule({ decision: 'deny', tool: 'WebFetch', pattern: null, raw: 'WebFetch' }),
    ]);
    expect(
      findWholeToolDeny('WebFetch', compiled, settings({ toolPermissionsEnabled: false })),
    ).toBeNull();
  });
  it('respects auto-mode skip', () => {
    const compiled = compileRules([
      rule({ decision: 'deny', tool: 'WebFetch', pattern: null, raw: 'WebFetch' }),
    ]);
    expect(
      findWholeToolDeny('WebFetch', compiled, settings({ toolPermissionAutoModeActive: true })),
    ).toBeNull();
  });
});

describe('evaluateToolCall — comprehensive scenarios', () => {
  it('typical policy: deny rm -rf, allow everything else', () => {
    const compiled = compileRules([
      rule({ decision: 'deny', tool: 'Bash', pattern: 'rm -rf *', raw: 'Bash(rm -rf *)' }),
    ]);
    const s = settings({ toolPermissionDefaultAction: 'allow' });
    expect(evaluateToolCall('Bash', { command: 'npm test' }, compiled, s).decision).toBe('allow');
    expect(evaluateToolCall('Bash', { command: 'rm -rf /tmp' }, compiled, s).decision).toBe('deny');
  });
  it('default-deny policy: allow only npm and git', () => {
    const compiled = compileRules([
      rule({ decision: 'allow', tool: 'Bash', pattern: 'npm *', raw: 'Bash(npm *)' }),
      rule({ decision: 'allow', tool: 'Bash', pattern: 'git *', raw: 'Bash(git *)' }),
      rule({ decision: 'allow', tool: 'Read', pattern: null, raw: 'Read' }),
    ]);
    const s = settings({ toolPermissionDefaultAction: 'deny' });
    expect(evaluateToolCall('Bash', { command: 'npm test' }, compiled, s).decision).toBe('allow');
    expect(evaluateToolCall('Bash', { command: 'git status' }, compiled, s).decision).toBe('allow');
    expect(evaluateToolCall('Bash', { command: 'rm -rf /' }, compiled, s).decision).toBe('deny');
    expect(evaluateToolCall('WebFetch', { url: 'https://a.com' }, compiled, s).decision).toBe(
      'deny',
    );
    expect(evaluateToolCall('Read', { file_path: '/a/b' }, compiled, s).decision).toBe('allow');
  });
  it('deny WebFetch entirely (whole-tool)', () => {
    const compiled = compileRules([
      rule({ decision: 'deny', tool: 'WebFetch', pattern: null, raw: 'WebFetch' }),
    ]);
    const r = evaluateToolCall('WebFetch', { url: 'https://example.com' }, compiled, settings());
    expect(r.decision).toBe('deny');
  });
  it('deny Read of .env files', () => {
    const compiled = compileRules([
      rule({ decision: 'deny', tool: 'Read', pattern: '*.env', raw: 'Read(*.env)' }),
    ]);
    expect(
      evaluateToolCall('Read', { file_path: '/Users/jeff/app/.env' }, compiled, settings())
        .decision,
    ).toBe('deny');
    expect(
      evaluateToolCall('Read', { file_path: '/Users/jeff/app/README.md' }, compiled, settings())
        .decision,
    ).toBe('allow');
  });
  it('mcp server-level deny blocks all its tools', () => {
    const compiled = compileRules([
      rule({ decision: 'deny', tool: 'mcp__github__*', pattern: null, raw: 'mcp__github__*' }),
    ]);
    expect(evaluateToolCall('mcp__github__create_issue', {}, compiled, settings()).decision).toBe(
      'deny',
    );
    expect(evaluateToolCall('mcp__github__search_code', {}, compiled, settings()).decision).toBe(
      'deny',
    );
    expect(evaluateToolCall('mcp__gitlab__create_issue', {}, compiled, settings()).decision).toBe(
      'allow',
    );
  });
});

describe('ruleMatches — fallback matcher + hashCanonicalToolInput', () => {
  it('falls back to JSON-pattern match for custom (non-bash/path/web) tools', () => {
    // Tool name 'Task' is neither Bash, path, web, nor MCP — ruleMatches
    // dispatches to matchFallback, which greps the serialized input.
    const r = rule({
      decision: 'deny',
      tool: 'Task',
      pattern: '*dangerous*',
      raw: 'Task(*dangerous*)',
    });
    expect(ruleMatches(r, 'Task', { description: 'run something dangerous' })).toBe(true);
    expect(ruleMatches(r, 'Task', { description: 'harmless help' })).toBe(false);
  });

  it('hashCanonicalToolInput handles arrays at any nesting depth deterministically', () => {
    const a = hashCanonicalToolInput('Bash', { a: [1, 2, { nested: [3, 4] }] });
    const b = hashCanonicalToolInput('Bash', { a: [1, 2, { nested: [3, 4] }] });
    expect(a).toBe(b);
    // And the array-nesting branch differentiates from a non-array value.
    const c = hashCanonicalToolInput('Bash', { a: [1, 2, { nested: 'str' }] });
    expect(a).not.toBe(c);
  });
});
