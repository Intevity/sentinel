/**
 * Evaluate a proposed tool call against the user's permission rule set.
 *
 * Evaluation order mirrors Claude Code's native semantics: all enabled
 * deny rules are checked first; any match → deny. Otherwise all enabled
 * allow rules are checked; any match → allow. No match → caller's
 * `defaultAction`.
 *
 * Within each tier, rules are evaluated by (priority ASC, createdAt ASC).
 *
 * This module is pure — no I/O, no timing, no globals. The daemon owns the
 * cache of compiled rules and invalidates it on mutation.
 */

import type { PermissionDecision, PermissionRule } from '@claude-sentinel/shared';
import {
  matchBash,
  matchPath,
  matchWeb,
  matchMcpTool,
  matchFallback,
  isPathTool,
  isWebTool,
} from './matchers.js';

export interface EvaluationResult {
  decision: PermissionDecision;
  /** The rule that produced the decision, or null when falling through to
   *  `defaultAction`. */
  matchedRule: PermissionRule | null;
  /** Short human-readable reason. Stable enough to display to the user. */
  reason: string;
}

export interface EvaluatorSettingsView {
  toolPermissionsEnabled: boolean;
  toolPermissionDefaultAction: PermissionDecision;
  toolPermissionSkipInAutoMode: boolean;
  toolPermissionAutoModeActive: boolean;
}

/** Stably sorted view of rules, grouped by decision tier so hot-path
 *  evaluation doesn't re-sort on every tool call. */
export interface CompiledRuleSet {
  denies: PermissionRule[];
  allows: PermissionRule[];
}

/** Build a compiled rule set from raw rows. Stable sort by
 *  (priority ASC, createdAt ASC). Disabled rules are dropped. */
export function compileRules(rules: PermissionRule[]): CompiledRuleSet {
  const sorted = rules
    .filter((r) => r.enabled)
    .slice()
    .sort(
      (a, b) => a.priority - b.priority || a.createdAt - b.createdAt,
    );
  return {
    denies: sorted.filter((r) => r.decision === 'deny'),
    allows: sorted.filter((r) => r.decision === 'allow'),
  };
}

/** True iff `rule` matches the tool call. Handles both whole-tool rules
 *  (pattern === null) and specifier rules. Exported for unit tests. */
export function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  toolInput: unknown,
): boolean {
  // Tool-name gate. A rule targeting 'Bash' does not match a 'Read' tool_use.
  // '*' matches any tool. MCP wildcard rules are handled here.
  if (!toolNameMatches(rule.tool, toolName)) return false;

  // Whole-tool rule — matched by the name alone.
  if (rule.pattern === null) return true;

  // Specifier-based matching. Dispatch by tool family.
  if (toolName === 'Bash') {
    const command = pickBashCommand(toolInput);
    return matchBash(rule.pattern, command);
  }
  if (isPathTool(toolName)) {
    return matchPath(rule.pattern, toolInput);
  }
  if (isWebTool(toolName)) {
    return matchWeb(rule.pattern, toolInput);
  }
  return matchFallback(rule.pattern, toolInput);
}

function toolNameMatches(ruleTool: string, toolName: string): boolean {
  if (ruleTool === '*') return true;
  if (ruleTool === toolName) return true;
  if (ruleTool.startsWith('mcp__')) return matchMcpTool(ruleTool, toolName);
  return false;
}

function pickBashCommand(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const v = (input as Record<string, unknown>)['command'];
  return typeof v === 'string' ? v : '';
}

/**
 * Evaluate a tool call. Returns allow/deny decision plus the matched rule (if any).
 *
 * Short-circuits:
 *   1. feature disabled → allow (the caller doesn't even install the proxy hook)
 *   2. auto-mode skip toggled on AND auto-mode active → allow
 *   3. deny tier → first matching deny rule wins
 *   4. allow tier → first matching allow rule wins
 *   5. fallback → settings.toolPermissionDefaultAction
 */
export function evaluateToolCall(
  toolName: string,
  toolInput: unknown,
  compiled: CompiledRuleSet,
  settings: EvaluatorSettingsView,
): EvaluationResult {
  if (!settings.toolPermissionsEnabled) {
    return { decision: 'allow', matchedRule: null, reason: 'tool permissions disabled' };
  }
  if (settings.toolPermissionSkipInAutoMode && settings.toolPermissionAutoModeActive) {
    return { decision: 'allow', matchedRule: null, reason: 'auto mode — enforcement skipped' };
  }
  for (const rule of compiled.denies) {
    if (ruleMatches(rule, toolName, toolInput)) {
      return { decision: 'deny', matchedRule: rule, reason: `denied by ${rule.raw}` };
    }
  }
  for (const rule of compiled.allows) {
    if (ruleMatches(rule, toolName, toolInput)) {
      return { decision: 'allow', matchedRule: rule, reason: `allowed by ${rule.raw}` };
    }
  }
  return {
    decision: settings.toolPermissionDefaultAction,
    matchedRule: null,
    reason:
      settings.toolPermissionDefaultAction === 'deny'
        ? 'no matching rule — default deny'
        : 'no matching rule — default allow',
  };
}

/** Whole-tool deny lookup used by the request-level tool stripper. Returns the
 *  matching rule when the tool name is outright denied with no pattern. Does
 *  NOT consider sub-command rules (those need response-level evaluation). */
export function findWholeToolDeny(
  toolName: string,
  compiled: CompiledRuleSet,
  settings: EvaluatorSettingsView,
): PermissionRule | null {
  if (!settings.toolPermissionsEnabled) return null;
  if (settings.toolPermissionSkipInAutoMode && settings.toolPermissionAutoModeActive) return null;
  for (const rule of compiled.denies) {
    if (rule.pattern !== null) continue;
    if (!toolNameMatches(rule.tool, toolName)) continue;
    return rule;
  }
  return null;
}
