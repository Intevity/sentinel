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

import type { PermissionDecision, PermissionRule } from '@sentinel/shared';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { posix as posixPath } from 'path';
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
  globToRegex,
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

/** Sprint 9: canonical key for a rule's identity in approval-grant /
 *  approval-event tables. Two rules with the same `tool|pattern` pair
 *  represent the same enforcement target even if their decision was
 *  edited (deny → ask, ask → allow). Pattern is normalized to '*' when
 *  null so a whole-tool rule has a stable string key. Exported so the
 *  enforcer and tests share one definition. */
export function ruleKey(rule: { tool: string; pattern: string | null }): string {
  return `${rule.tool}|${rule.pattern ?? '*'}`;
}

/** Sprint 9: returns true when the rule's project_scope glob matches
 *  the request's working directory (or when the rule is global). When
 *  the request has no extractable cwd, scoped rules are skipped — the
 *  user's intent of "rule applies in /work/prod/**" cannot be
 *  satisfied without knowing where the agent is running. Path
 *  expansion mirrors `matchers.matchPath`: `~` expands to the user's
 *  home directory; on macOS we lower-case both sides because APFS is
 *  case-insensitive by default. */
export function ruleScopeMatchesCwd(scope: string | null, cwd: string | null): boolean {
  if (scope === null || scope === '') return true;
  if (cwd === null) return false;
  let pattern = scope;
  if (pattern.startsWith('//')) pattern = pattern.slice(1);
  else if (pattern === '~') pattern = homedir();
  else if (pattern.startsWith('~/')) pattern = homedir() + pattern.slice(1);
  let target = posixPath.normalize(cwd);
  if (process.platform === 'darwin') {
    pattern = pattern.toLowerCase();
    target = target.toLowerCase();
  }
  return globToRegex(pattern, { pathMode: true }).test(target);
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

/** Sprint 10: stable content hash over the fields `compileRules` reads.
 *  When two rule arrays have the same hash, `compileRules` must produce
 *  identical output — allowing the enforcer to keep its cached compiled
 *  set across `invalidate()` calls when the underlying rows didn't
 *  actually change (e.g., a settings save that triggered invalidate but
 *  left rules untouched, or a no-op upsert from claude-sync). */
export function compileRulesContentHash(rules: PermissionRule[]): string {
  const sorted = rules
    .filter((r) => r.enabled)
    .slice()
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  const h = createHash('sha256');
  for (const r of sorted) {
    h.update(
      `${r.id}\0${r.decision}\0${r.tool}\0${r.pattern ?? '\x01'}\0${r.priority}\0${r.createdAt}\0${r.projectScope ?? '\x01'}\n`,
    );
  }
  return h.digest('hex');
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

/**
 * Sentinel `input_hash` value used to mark a bypass as rule-wide: any
 * input matching the bypass's `rule_id` is allowed, not just one
 * specific canonicalised input. Stored in `permission_bypass.input_hash`
 * exactly like a real hash — the value is a single byte (`'*'`) so it
 * can never collide with a real SHA-256 hex digest (which is 64 hex
 * characters). The evaluator consults this row first when a deny rule
 * matches, short-circuiting the canonical-hash check.
 *
 * Picked when the user clicks "Always" in the approval banner. The
 * legacy per-input bypass shape is still supported — it just isn't
 * what the UI writes by default any more.
 */
export const WILDCARD_INPUT_HASH = '*';

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
 *
 * Sprint 9: when `cwd` is provided, rules with a non-null
 * `projectScope` are skipped unless their scope glob matches the cwd.
 * `null`/undefined cwd disables the scope check (the request had no
 * extractable working directory) — scoped rules are conservatively
 * skipped, matching the user's intent of "fire only when in this
 * project tree".
 */
export function evaluateToolCall(
  toolName: string,
  toolInput: unknown,
  compiled: CompiledRuleSet,
  settings: EvaluatorSettingsView,
  hooks?: EvaluatorHooks,
  cwd: string | null = null,
): EvaluationResult {
  if (!settings.toolPermissionsEnabled) {
    return { decision: 'allow', matchedRule: null, reason: 'tool permissions disabled' };
  }
  if (settings.toolPermissionSkipInAutoMode && settings.toolPermissionAutoModeActive) {
    return { decision: 'allow', matchedRule: null, reason: 'auto mode — enforcement skipped' };
  }
  const matchOpts = { resolveSymlinks: settings.toolPermissionResolveSymlinks };
  for (const rule of compiled.denies) {
    if (!ruleScopeMatchesCwd(rule.projectScope, cwd)) continue;
    if (ruleMatches(rule, toolName, toolInput, matchOpts)) {
      // Bypass short-circuits. Checked in order:
      //   1. Rule-wide wildcard ("Always" approval — any matching input).
      //   2. Per-input canonical hash (legacy "exact input" approvals
      //      and tests that pin the older behaviour).
      // Both are gated on `hooks?.isBypassed` so callers that don't
      // care about bypass (unit tests, one-off evaluations) pay zero
      // DB cost. The wildcard check runs first because it short-circuits
      // without the SHA-256 hash; on a user who's ticked "Always" we
      // want the cheaper lookup.
      if (hooks?.isBypassed) {
        if (hooks.isBypassed(rule.id, WILDCARD_INPUT_HASH)) {
          return {
            decision: 'allow',
            matchedRule: rule,
            reason: `bypassed by rule-wide approval for ${rule.raw}`,
          };
        }
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
    if (!ruleScopeMatchesCwd(rule.projectScope, cwd)) continue;
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
          projectScope: null,
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
 *  NOT consider sub-command rules (those need response-level evaluation).
 *
 *  Sprint 9: scoped whole-tool rules are skipped when their scope does not
 *  match the request's cwd (or when cwd is unknown). */
export function findWholeToolDeny(
  toolName: string,
  compiled: CompiledRuleSet,
  settings: EvaluatorSettingsView,
  cwd: string | null = null,
): PermissionRule | null {
  if (!settings.toolPermissionsEnabled) return null;
  if (settings.toolPermissionSkipInAutoMode && settings.toolPermissionAutoModeActive) return null;
  for (const rule of compiled.denies) {
    if (rule.pattern !== null) continue;
    if (!toolNameMatches(rule.tool, toolName)) continue;
    if (!ruleScopeMatchesCwd(rule.projectScope, cwd)) continue;
    return rule;
  }
  return null;
}
