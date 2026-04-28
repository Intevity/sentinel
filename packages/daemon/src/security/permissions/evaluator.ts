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
import { createHash } from 'crypto';
import {
  matchBash,
  matchPath,
  matchWeb,
  matchMcpTool,
  matchFallback,
  isPathTool,
  isWebTool,
  isLinkLocalOrMetadata,
  pickHost,
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
  /** When true, RFC-1918 ranges are added to the synthetic
   *  network-egress default-deny set (link-local IPs, cloud-metadata
   *  FQDNs, and localhost are always denied regardless). */
  denyPrivateNetworkByDefault: boolean;
  /** When true, path-tool inputs are run through `fs.realpathSync`
   *  before matching, so a deny rule for the canonical path catches
   *  symlink-redirected reads/writes. Adds a stat per rule check;
   *  off by default. */
  toolPermissionResolveSymlinks: boolean;
}

/** Stable id used by the synthetic network-egress default-deny.
 *  Exported so audit / pending consumers can recognize a system-emitted
 *  block versus a user rule. */
export const SYNTHETIC_NETWORK_EGRESS_DENY_ID = '__sentinel/network-egress-default-deny__';

/** Stably sorted view of rules, grouped by decision tier so hot-path
 *  evaluation doesn't re-sort on every tool call. */
export interface CompiledRuleSet {
  denies: PermissionRule[];
  allows: PermissionRule[];
}

/** Build a compiled rule set from raw rows. Stable sort by
 *  (priority ASC, createdAt ASC). Disabled rules are dropped.
 *
 *  'ask' rules are placed in the `denies` tier — their external
 *  behaviour (block + prompt) is a superset of a plain 'deny'. The
 *  evaluator preserves the rule's original `decision` on the result
 *  so callers can distinguish: the SSE interceptor promotes 'ask'
 *  matches to the pending flow even when the global hold setting
 *  is off, matching Claude Code's own `permissions.ask` semantics. */
export function compileRules(rules: PermissionRule[]): CompiledRuleSet {
  const sorted = rules
    .filter((r) => r.enabled)
    .slice()
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  return {
    denies: sorted.filter((r) => r.decision === 'deny' || r.decision === 'ask'),
    allows: sorted.filter((r) => r.decision === 'allow'),
  };
}

/** True iff `rule` matches the tool call. Handles both whole-tool rules
 *  (pattern === null) and specifier rules. Exported for unit tests. */
export function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  toolInput: unknown,
  opts?: { resolveSymlinks?: boolean },
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
    return matchPath(rule.pattern, toolInput, opts);
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
 * Canonical SHA-256 of a tool-call's input. Keys are sorted recursively
 * so whitespace / ordering differences don't produce divergent hashes
 * for semantically-identical inputs. Used as the bypass lookup key
 * (together with `rule.id`) and stored on the bypass row.
 *
 * Exported so the enforcer can compute the same hash at insertion
 * time and the evaluator can compute it at check time without
 * duplicating the canonicalisation logic.
 */
export function hashCanonicalToolInput(toolName: string, toolInput: unknown): string {
  // Prefix with toolName so a bypass for `Bash("rm -rf *")` can't
  // accidentally collide with `Write` input that happens to stringify
  // to the same bytes after canonicalisation.
  const canonical = `${toolName}|${canonicalStringify(toolInput)}`;
  return createHash('sha256').update(canonical).digest('hex');
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return `${JSON.stringify(k)}:${canonicalStringify(v)}`;
  });
  return `{${parts.join(',')}}`;
}

/** Optional callbacks the evaluator consults when set. Kept separate
 *  from `EvaluatorSettingsView` because settings are pure data from
 *  the Settings object; these are live side-effect hooks owned by
 *  the enforcer. Both are optional so call sites that don't care
 *  about the bypass pathway (unit tests, one-off evaluations) can
 *  pass undefined without adding a stub. */
export interface EvaluatorHooks {
  /** Synchronous check against the permission_bypass table. When it
   *  returns true for a matched deny rule, the evaluator flips the
   *  decision to 'allow' with `matchedRule` still set so the caller
   *  can log the bypass separately if desired. */
  isBypassed?: (ruleId: string, inputHash: string) => boolean;
}

/**
 * Evaluate a tool call. Returns allow/deny decision plus the matched rule (if any).
 *
 * Short-circuits:
 *   1. feature disabled → allow (the caller doesn't even install the proxy hook)
 *   2. auto-mode skip toggled on AND auto-mode active → allow
 *   3. deny tier → first matching deny rule wins, BUT if an opt-in bypass
 *      matches the (rule, input) pair, the decision flips to 'allow'
 *   4. allow tier → first matching allow rule wins
 *   5. fallback → settings.toolPermissionDefaultAction
 */
export function evaluateToolCall(
  toolName: string,
  toolInput: unknown,
  compiled: CompiledRuleSet,
  settings: EvaluatorSettingsView,
  hooks?: EvaluatorHooks,
): EvaluationResult {
  if (!settings.toolPermissionsEnabled) {
    return { decision: 'allow', matchedRule: null, reason: 'tool permissions disabled' };
  }
  if (settings.toolPermissionSkipInAutoMode && settings.toolPermissionAutoModeActive) {
    return { decision: 'allow', matchedRule: null, reason: 'auto mode — enforcement skipped' };
  }
  const matchOpts = { resolveSymlinks: settings.toolPermissionResolveSymlinks };
  for (const rule of compiled.denies) {
    if (ruleMatches(rule, toolName, toolInput, matchOpts)) {
      // Per-rule input bypass short-circuit. Computed lazily — a user
      // without any bypass rows pays zero hash cost on every deny
      // match. `hooks?.isBypassed` is the gate; only hash when it's
      // present.
      if (hooks?.isBypassed) {
        const inputHash = hashCanonicalToolInput(toolName, toolInput);
        if (hooks.isBypassed(rule.id, inputHash)) {
          return {
            decision: 'allow',
            matchedRule: rule,
            reason: `bypassed by per-input allowlist for ${rule.raw}`,
          };
        }
      }
      return { decision: 'deny', matchedRule: rule, reason: `denied by ${rule.raw}` };
    }
  }
  for (const rule of compiled.allows) {
    if (ruleMatches(rule, toolName, toolInput, matchOpts)) {
      return { decision: 'allow', matchedRule: rule, reason: `allowed by ${rule.raw}` };
    }
  }
  // Synthetic network-egress default-deny. Sits between the user's
  // allow tier (so an explicit `WebFetch(domain:internal-api.local)`
  // allow can override) and the default-action fallback (so it
  // applies even in default-allow mode, which is the whole point).
  if (isWebTool(toolName)) {
    const host = pickHost(toolInput);
    if (host) {
      const ne = isLinkLocalOrMetadata(host, settings.denyPrivateNetworkByDefault);
      if (ne.match) {
        const synthetic: PermissionRule = {
          id: SYNTHETIC_NETWORK_EGRESS_DENY_ID,
          decision: 'deny',
          tool: toolName,
          pattern: `domain:${host}`,
          raw: `${SYNTHETIC_NETWORK_EGRESS_DENY_ID}(${host})`,
          note: `Default-deny: ${ne.category}`,
          enabled: true,
          priority: 0,
          createdAt: 0,
          source: 'local',
        };
        return {
          decision: 'deny',
          matchedRule: synthetic,
          reason: `denied by network-egress default (${ne.category})`,
        };
      }
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
