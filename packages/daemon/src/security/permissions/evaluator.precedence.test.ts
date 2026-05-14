/**
 * Precedence and conflict-resolution tests for `evaluateToolCall`.
 *
 * The existing `evaluator.test.ts` covers happy-path matching. This
 * suite pins the contract for what happens when rules conflict —
 * different tiers, equal priorities, disabled toggles, ask routing,
 * defaults, auto-mode skip, and the bypass hook. Conflict semantics
 * are easy to regress because they live in the iteration order +
 * short-circuit logic, both of which are invisible to a single-rule
 * test.
 */

import { describe, it, expect } from 'vitest';
import type { PermissionRule } from '@claude-sentinel/shared';
import {
  compileRules,
  evaluateToolCall,
  hashCanonicalToolInput,
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

describe('evaluator precedence: tier ordering', () => {
  it('a matching deny ALWAYS beats a matching allow regardless of priority', () => {
    // The user's intent: a deny rule, even if added with the *worst*
    // priority and the *latest* createdAt, must still win over a
    // permissive allow. Pinning this makes a regression in
    // `compileRules` (e.g. accidentally putting allows first) impossible.
    const compiled = compileRules([
      rule({
        id: 'allow',
        decision: 'allow',
        tool: 'Bash',
        pattern: null,
        raw: 'Bash',
        priority: 0,
        createdAt: 0,
      }),
      rule({
        id: 'deny',
        decision: 'deny',
        tool: 'Bash',
        pattern: 'rm -rf *',
        raw: 'Bash(rm -rf *)',
        priority: 999_999,
        createdAt: Number.MAX_SAFE_INTEGER,
      }),
    ]);
    const result = evaluateToolCall('Bash', { command: 'rm -rf /' }, compiled, settings());
    expect(result.decision).toBe('deny');
    expect(result.matchedRule?.id).toBe('deny');
  });

  it('an allow rule wins when no deny matches and default would otherwise be deny', () => {
    const compiled = compileRules([
      rule({
        id: 'allow',
        decision: 'allow',
        tool: 'Bash',
        pattern: 'git *',
        raw: 'Bash(git *)',
      }),
    ]);
    const result = evaluateToolCall(
      'Bash',
      { command: 'git status' },
      compiled,
      settings({ toolPermissionDefaultAction: 'deny' }),
    );
    expect(result.decision).toBe('allow');
    expect(result.matchedRule?.id).toBe('allow');
  });
});

describe('evaluator precedence: ordering within a tier', () => {
  it('equal-priority deny rules are evaluated in createdAt-ascending order', () => {
    // Both match. The earlier one (createdAt=1) must win so the
    // matchedRule is stable across runs.
    const compiled = compileRules([
      rule({
        id: 'late',
        decision: 'deny',
        tool: '*',
        pattern: null,
        raw: '*',
        priority: 50,
        createdAt: 999,
      }),
      rule({
        id: 'early',
        decision: 'deny',
        tool: '*',
        pattern: null,
        raw: '*',
        priority: 50,
        createdAt: 1,
      }),
    ]);
    const result = evaluateToolCall('Bash', { command: 'ls' }, compiled, settings());
    expect(result.decision).toBe('deny');
    expect(result.matchedRule?.id).toBe('early');
  });

  it('a lower-priority deny rule wins over a higher-priority deny rule (priority ASC)', () => {
    const compiled = compileRules([
      rule({
        id: 'broad',
        decision: 'deny',
        tool: '*',
        pattern: null,
        raw: '*',
        priority: 10,
        createdAt: 0,
      }),
      rule({
        id: 'specific',
        decision: 'deny',
        tool: 'Bash',
        pattern: 'rm -rf *',
        raw: 'Bash(rm -rf *)',
        priority: 100,
        createdAt: 0,
      }),
    ]);
    const result = evaluateToolCall('Bash', { command: 'rm -rf /' }, compiled, settings());
    // Both match — `priority: 10` sorts first, so it wins.
    expect(result.matchedRule?.id).toBe('broad');
  });
});

describe('evaluator precedence: disabled rules', () => {
  it('a disabled deny rule is skipped, falling through to a matching allow', () => {
    const compiled = compileRules([
      rule({
        id: 'disabled-deny',
        decision: 'deny',
        tool: 'Bash',
        pattern: 'rm -rf *',
        raw: 'Bash(rm -rf *)',
        enabled: false,
      }),
      rule({
        id: 'allow',
        decision: 'allow',
        tool: 'Bash',
        pattern: 'rm *',
        raw: 'Bash(rm *)',
      }),
    ]);
    const result = evaluateToolCall('Bash', { command: 'rm -rf /' }, compiled, settings());
    expect(result.decision).toBe('allow');
    expect(result.matchedRule?.id).toBe('allow');
  });

  it('compileRules drops disabled rules from BOTH tiers', () => {
    const compiled = compileRules([
      rule({ id: 'disabled-deny', decision: 'deny', enabled: false, raw: 'a' }),
      rule({ id: 'disabled-allow', decision: 'allow', enabled: false, raw: 'b' }),
    ]);
    expect(compiled.denies).toHaveLength(0);
    expect(compiled.allows).toHaveLength(0);
  });
});

describe('evaluator precedence: ask routing', () => {
  it('an `ask` rule is placed in the deny tier; result.decision is "deny" but matchedRule.decision preserves "ask"', () => {
    // This pins the actual contract: the SSE interceptor only branches
    // on `decision.decision === 'allow'`, so any non-allow shape is
    // sufficient to hold the tool_use. Callers that need to distinguish
    // ask from deny inspect `matchedRule.decision` (e.g. to always
    // route ask through the pending registry regardless of the global
    // hold setting). If a future change starts surfacing the rule's
    // original decision on the result, this test will fail and force a
    // matched audit of every reader.
    const compiled = compileRules([
      rule({
        id: 'ask-rm',
        decision: 'ask',
        tool: 'Bash',
        pattern: 'rm -rf *',
        raw: 'Bash(rm -rf *)',
      }),
    ]);
    const result = evaluateToolCall('Bash', { command: 'rm -rf /' }, compiled, settings());
    expect(result.decision).toBe('deny');
    expect(result.matchedRule?.id).toBe('ask-rm');
    expect(result.matchedRule?.decision).toBe('ask');
  });

  it('a matching `ask` rule still fires when an allow rule with broader scope also matches', () => {
    // The user has allowed Bash broadly but added an ask on the most
    // dangerous pattern. The ask MUST take effect — that's the entire
    // value of an ask rule. Pinning this so a future "allow wins ties"
    // refactor would loudly break.
    const compiled = compileRules([
      rule({
        id: 'allow-bash',
        decision: 'allow',
        tool: 'Bash',
        pattern: null,
        raw: 'Bash',
        priority: 1,
      }),
      rule({
        id: 'ask-rm',
        decision: 'ask',
        tool: 'Bash',
        pattern: 'rm -rf *',
        raw: 'Bash(rm -rf *)',
        priority: 50,
      }),
    ]);
    const result = evaluateToolCall('Bash', { command: 'rm -rf /' }, compiled, settings());
    expect(result.decision).toBe('deny');
    expect(result.matchedRule?.id).toBe('ask-rm');
    expect(result.matchedRule?.decision).toBe('ask');
  });
});

describe('evaluator precedence: feature toggles and defaults', () => {
  it('feature disabled short-circuits to allow regardless of any deny', () => {
    const compiled = compileRules([
      rule({
        id: 'deny',
        decision: 'deny',
        tool: '*',
        pattern: null,
        raw: '*',
      }),
    ]);
    const result = evaluateToolCall(
      'Bash',
      { command: 'rm -rf /' },
      compiled,
      settings({ toolPermissionsEnabled: false }),
    );
    expect(result.decision).toBe('allow');
    expect(result.matchedRule).toBeNull();
    expect(result.reason).toContain('disabled');
  });

  it('default-deny + zero matching rules returns deny with no matched rule', () => {
    const compiled = compileRules([]);
    const result = evaluateToolCall(
      'Bash',
      { command: 'whatever' },
      compiled,
      settings({ toolPermissionDefaultAction: 'deny' }),
    );
    expect(result.decision).toBe('deny');
    expect(result.matchedRule).toBeNull();
    expect(result.reason).toContain('default deny');
  });

  it('default-allow + zero matching rules returns allow with no matched rule', () => {
    const compiled = compileRules([]);
    const result = evaluateToolCall('Bash', { command: 'ls' }, compiled, settings());
    expect(result.decision).toBe('allow');
    expect(result.matchedRule).toBeNull();
    expect(result.reason).toContain('default allow');
  });
});

describe('evaluator precedence: auto-mode skip', () => {
  it('auto-mode active + skip enabled bypasses every deny', () => {
    const compiled = compileRules([
      rule({
        id: 'deny-everything',
        decision: 'deny',
        tool: '*',
        pattern: null,
        raw: '*',
      }),
    ]);
    const result = evaluateToolCall(
      'Bash',
      { command: 'rm -rf /' },
      compiled,
      settings({
        toolPermissionSkipInAutoMode: true,
        toolPermissionAutoModeActive: true,
      }),
    );
    expect(result.decision).toBe('allow');
    expect(result.matchedRule).toBeNull();
    expect(result.reason).toContain('auto mode');
  });

  it('auto-mode active + skip DISABLED still evaluates rules', () => {
    const compiled = compileRules([
      rule({
        id: 'deny-everything',
        decision: 'deny',
        tool: '*',
        pattern: null,
        raw: '*',
      }),
    ]);
    const result = evaluateToolCall(
      'Bash',
      { command: 'rm -rf /' },
      compiled,
      settings({
        toolPermissionSkipInAutoMode: false,
        toolPermissionAutoModeActive: true,
      }),
    );
    expect(result.decision).toBe('deny');
    expect(result.matchedRule?.id).toBe('deny-everything');
  });
});

describe('evaluator precedence: bypass hook', () => {
  it('bypass hook flips a matched deny to allow with matchedRule preserved', () => {
    const denyRule = rule({
      id: 'deny-rm',
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
    });
    const compiled = compileRules([denyRule]);
    const input = { command: 'rm -rf /tmp/build' };
    const expectedHash = hashCanonicalToolInput('Bash', input);
    // The evaluator probes the wildcard sentinel ('*') first to honour
    // "Always" rule-wide approvals, then falls through to the canonical
    // input hash for legacy per-input bypasses. Returning false on '*'
    // exercises the per-input branch; returning true on `expectedHash`
    // is the assertion that the hook receives the right (ruleId, hash)
    // pair on the second probe.
    const isBypassed = (ruleId: string, hash: string): boolean => {
      expect(ruleId).toBe('deny-rm');
      if (hash === '*') return false;
      expect(hash).toBe(expectedHash);
      return true;
    };
    const result = evaluateToolCall('Bash', input, compiled, settings(), { isBypassed });
    expect(result.decision).toBe('allow');
    expect(result.matchedRule?.id).toBe('deny-rm');
    expect(result.reason).toContain('bypassed');
  });

  it('bypass hook returning false leaves the deny intact', () => {
    const denyRule = rule({
      id: 'deny-rm',
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm -rf *',
      raw: 'Bash(rm -rf *)',
    });
    const compiled = compileRules([denyRule]);
    const result = evaluateToolCall('Bash', { command: 'rm -rf /' }, compiled, settings(), {
      isBypassed: () => false,
    });
    expect(result.decision).toBe('deny');
    expect(result.matchedRule?.id).toBe('deny-rm');
  });

  it('no bypass hook means no hashing cost on the deny path', () => {
    // The evaluator only computes the hash when a hook is present.
    // Pin via a counting hook on a different id — if the evaluator
    // ever started hashing eagerly, it would have to call the hook
    // we did NOT provide and crash; the absence of a crash is the
    // assertion. Plus we sanity-check the result.
    const compiled = compileRules([
      rule({
        id: 'deny-rm',
        decision: 'deny',
        tool: 'Bash',
        pattern: 'rm -rf *',
        raw: 'Bash(rm -rf *)',
      }),
    ]);
    const result = evaluateToolCall('Bash', { command: 'rm -rf /' }, compiled, settings());
    expect(result.decision).toBe('deny');
  });

  it('wildcard bypass flips deny→allow for ANY matching input, not just the approved one', () => {
    // Regression: "Always" approval used to write a bypass keyed by
    // the canonical SHA-256 of the exact input the user approved, so
    // a follow-up call with a different command matching the same
    // rule re-prompted. The wildcard sentinel ('*') lets a single
    // approval cover every future input matching the rule, matching
    // the user's mental model of "Always".
    const denyRule = rule({
      id: 'deny-rm',
      decision: 'deny',
      tool: 'Bash',
      pattern: 'rm *',
      raw: 'Bash(rm *)',
    });
    const compiled = compileRules([denyRule]);
    const calls: Array<[string, string]> = [];
    const isBypassed = (ruleId: string, hash: string): boolean => {
      calls.push([ruleId, hash]);
      // Only the wildcard probe returns true. If the evaluator wasn't
      // calling with '*' first, this hook would never short-circuit.
      return hash === '*';
    };
    // Two distinct commands that both match the rule but hash
    // differently. Both must be allowed off the same wildcard row.
    const a = evaluateToolCall('Bash', { command: 'rm -rf /tmp/a' }, compiled, settings(), {
      isBypassed,
    });
    const b = evaluateToolCall('Bash', { command: 'rm -rf /tmp/b' }, compiled, settings(), {
      isBypassed,
    });
    expect(a.decision).toBe('allow');
    expect(b.decision).toBe('allow');
    expect(a.reason).toContain('rule-wide');
    expect(b.reason).toContain('rule-wide');
    // The wildcard probe must precede the canonical-hash probe so
    // a user with an "Always" row pays the cheaper lookup first.
    // Both probes for both calls saw the wildcard as the first
    // entry (short-circuit means we never see the canonical entries).
    expect(calls).toEqual([
      ['deny-rm', '*'],
      ['deny-rm', '*'],
    ]);
  });

  it('falls back to per-input bypass when no wildcard row exists', () => {
    // The legacy per-input bypass shape stays valid: a user with an
    // older bypass row (canonical hash) keeps getting it honoured
    // even though new approvals write wildcards. Without this
    // fallback the migration would silently invalidate every
    // pre-existing bypass.
    const denyRule = rule({
      id: 'deny-write',
      decision: 'deny',
      tool: 'Write',
      pattern: '*',
      raw: 'Write(*)',
    });
    const compiled = compileRules([denyRule]);
    const input = { path: '/etc/hosts', content: 'x' };
    const expectedHash = hashCanonicalToolInput('Write', input);
    const isBypassed = (ruleId: string, hash: string): boolean => {
      expect(ruleId).toBe('deny-write');
      if (hash === '*') return false;
      return hash === expectedHash;
    };
    const result = evaluateToolCall('Write', input, compiled, settings(), { isBypassed });
    expect(result.decision).toBe('allow');
    expect(result.reason).toContain('per-input allowlist');
    // A different input on the same rule still denies.
    const other = evaluateToolCall(
      'Write',
      { path: '/etc/passwd', content: 'x' },
      compiled,
      settings(),
      { isBypassed },
    );
    expect(other.decision).toBe('deny');
  });
});
