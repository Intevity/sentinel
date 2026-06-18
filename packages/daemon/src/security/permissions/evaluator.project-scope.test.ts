import { describe, expect, it } from 'vitest';
import { homedir } from 'os';
import type { PermissionRule } from '@sentinel/shared';
import {
  compileRules,
  evaluateToolCall,
  findWholeToolDeny,
  ruleScopeMatchesCwd,
  ruleKey,
  type EvaluatorSettingsView,
} from './evaluator.js';

function rule(over: Partial<PermissionRule> = {}): PermissionRule {
  return {
    id: over.id ?? `r-${Math.random().toString(36).slice(2)}`,
    decision: over.decision ?? 'deny',
    tool: over.tool ?? 'Bash',
    pattern: over.pattern ?? null,
    raw: over.raw ?? `${over.tool ?? 'Bash'}${over.pattern ? `(${over.pattern})` : ''}`,
    note: over.note ?? null,
    enabled: over.enabled ?? true,
    priority: over.priority ?? 100,
    createdAt: over.createdAt ?? 0,
    source: over.source ?? 'local',
    projectScope: over.projectScope ?? null,
  };
}

const baseSettings: EvaluatorSettingsView = {
  toolPermissionsEnabled: true,
  toolPermissionDefaultAction: 'allow',
  toolPermissionSkipInAutoMode: false,
  toolPermissionAutoModeActive: false,
  denyPrivateNetworkByDefault: false,
  toolPermissionResolveSymlinks: false,
};

describe('Sprint 9 — ruleScopeMatchesCwd', () => {
  it('global rule (null scope) matches every cwd', () => {
    expect(ruleScopeMatchesCwd(null, '/Users/jeff/scratch')).toBe(true);
    expect(ruleScopeMatchesCwd(null, null)).toBe(true);
  });

  it('scoped rule with no cwd does NOT match', () => {
    expect(ruleScopeMatchesCwd('/Users/jeff/work/**', null)).toBe(false);
  });

  it('absolute scope glob matches cwds inside the tree but not outside', () => {
    expect(ruleScopeMatchesCwd('/Users/jeff/work/prod/**', '/Users/jeff/work/prod/api')).toBe(true);
    expect(ruleScopeMatchesCwd('/Users/jeff/work/prod/**', '/Users/jeff/scratch')).toBe(false);
  });

  it('home-relative ~/ scope expands to the user home directory', () => {
    expect(ruleScopeMatchesCwd('~/work/**', `${homedir()}/work/myrepo`)).toBe(true);
    expect(ruleScopeMatchesCwd('~/work/**', `${homedir()}/personal/notes`)).toBe(false);
  });

  it('exact-match scope without trailing wildcard requires the whole path', () => {
    expect(ruleScopeMatchesCwd('/Users/jeff/work/api', '/Users/jeff/work/api')).toBe(true);
    expect(ruleScopeMatchesCwd('/Users/jeff/work/api', '/Users/jeff/work/api/sub')).toBe(false);
  });

  it('exact tilde scope matches the home dir', () => {
    expect(ruleScopeMatchesCwd('~', homedir())).toBe(true);
    expect(ruleScopeMatchesCwd('~', `${homedir()}/sub`)).toBe(false);
  });

  it('// prefix is treated as an absolute path', () => {
    // `//Users/foo/**` is the explicit-absolute form — the parser
    // strips one leading slash so `/Users/foo/**` is the actual glob.
    expect(ruleScopeMatchesCwd('//Users/jeff/repo/**', '/Users/jeff/repo/api')).toBe(true);
  });

  it('empty-string scope is treated like null (global)', () => {
    expect(ruleScopeMatchesCwd('', '/anywhere')).toBe(true);
  });
});

describe('Sprint 9 — evaluateToolCall scoped rule short-circuit', () => {
  const compiled = compileRules([
    rule({
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm *',
      projectScope: '/Users/jeff/work/prod/**',
    }),
  ]);

  it('skips a scoped deny when cwd is outside the scope', () => {
    const r = evaluateToolCall(
      'Bash',
      { command: 'rm something.txt' },
      compiled,
      baseSettings,
      undefined,
      '/Users/jeff/scratch',
    );
    expect(r.decision).toBe('allow');
    expect(r.matchedRule).toBe(null);
  });

  it('fires a scoped deny when cwd is inside the scope', () => {
    const r = evaluateToolCall(
      'Bash',
      { command: 'rm something.txt' },
      compiled,
      baseSettings,
      undefined,
      '/Users/jeff/work/prod/api',
    );
    expect(r.decision).toBe('deny');
    expect(r.matchedRule?.raw).toBe('Bash(rm *)');
  });

  it('skips a scoped deny when the cwd is unknown (null)', () => {
    const r = evaluateToolCall(
      'Bash',
      { command: 'rm anything' },
      compiled,
      baseSettings,
      undefined,
      null,
    );
    expect(r.decision).toBe('allow');
  });

  it('skips a scoped allow when cwd is outside; default-deny then takes over', () => {
    const c = compileRules([
      rule({
        decision: 'allow',
        tool: 'Bash',
        pattern: 'ls *',
        projectScope: '/Users/jeff/work/**',
      }),
    ]);
    const r = evaluateToolCall(
      'Bash',
      { command: 'ls -la' },
      c,
      { ...baseSettings, toolPermissionDefaultAction: 'deny' },
      undefined,
      '/Users/jeff/scratch',
    );
    expect(r.decision).toBe('deny');
    expect(r.matchedRule).toBe(null);
  });

  it('fires a scoped allow when cwd matches', () => {
    const c = compileRules([
      rule({
        decision: 'allow',
        tool: 'Bash',
        pattern: 'ls *',
        projectScope: '/Users/jeff/work/**',
      }),
    ]);
    const r = evaluateToolCall(
      'Bash',
      { command: 'ls -la' },
      c,
      { ...baseSettings, toolPermissionDefaultAction: 'deny' },
      undefined,
      '/Users/jeff/work/api',
    );
    expect(r.decision).toBe('allow');
    expect(r.matchedRule?.raw).toBe('Bash(ls *)');
  });

  it('a global (null-scope) deny still fires regardless of cwd', () => {
    const c = compileRules([rule({ decision: 'deny', tool: 'Bash', pattern: 'rm *' })]);
    const r = evaluateToolCall(
      'Bash',
      { command: 'rm anything' },
      c,
      baseSettings,
      undefined,
      '/Users/jeff/scratch',
    );
    expect(r.decision).toBe('deny');
  });
});

describe('Sprint 9 — findWholeToolDeny honors scope', () => {
  it('skips a scoped whole-tool deny when cwd is outside', () => {
    const compiled = compileRules([
      rule({ decision: 'deny', tool: 'Bash', pattern: null, projectScope: '/work/**' }),
    ]);
    const hit = findWholeToolDeny('Bash', compiled, baseSettings, '/Users/jeff/scratch');
    expect(hit).toBe(null);
  });

  it('fires a scoped whole-tool deny when cwd matches', () => {
    const compiled = compileRules([
      rule({ decision: 'deny', tool: 'Bash', pattern: null, projectScope: '/work/**' }),
    ]);
    const hit = findWholeToolDeny('Bash', compiled, baseSettings, '/work/prod');
    expect(hit?.tool).toBe('Bash');
    expect(hit?.pattern).toBe(null);
  });
});

describe('Sprint 9 — ruleKey', () => {
  it('returns a stable key per (tool, pattern) pair', () => {
    expect(ruleKey({ tool: 'Bash', pattern: 'rm *' })).toBe('Bash|rm *');
    // Whole-tool rules collapse pattern null to '*' so the key is stable.
    expect(ruleKey({ tool: 'Read', pattern: null })).toBe('Read|*');
  });
});
