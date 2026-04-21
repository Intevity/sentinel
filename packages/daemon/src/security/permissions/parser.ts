/**
 * Parse and canonicalize Claude Code-style permission rule strings.
 *
 * Supported forms:
 *   Bash                     → { tool: 'Bash', pattern: null }
 *   Bash(npm *)              → { tool: 'Bash', pattern: 'npm *' }
 *   Read(//Users/jeff/**)    → { tool: 'Read', pattern: '//Users/jeff/**' }
 *   WebFetch(domain:ex.com)  → { tool: 'WebFetch', pattern: 'domain:ex.com' }
 *   mcp__github__create_iss  → { tool: 'mcp__github__create_iss', pattern: null }
 *   mcp__github__*           → { tool: 'mcp__github__*', pattern: null }
 *   *                        → { tool: '*', pattern: null }
 *
 * Parentheses are required to carry any pattern; missing parens means
 * whole-tool match. Empty or unbalanced inputs are rejected so the UI can
 * surface a validation error before the rule is saved.
 *
 * The parser also accepts a "raw with decision prefix" form used by the
 * editor's raw mode: `allow Bash(npm *)` / `deny Bash(rm -rf *)`. See
 * `parseRawWithDecision` for that variant.
 */

import type { PermissionDecision } from '@claude-sentinel/shared';

export interface ParsedRule {
  tool: string;
  pattern: string | null;
  /** Canonical serialized form — always `tool` or `tool(pattern)` regardless
   *  of incidental whitespace in the input. Stored in the DB's `raw` column. */
  raw: string;
}

export interface ParseError {
  ok: false;
  error: string;
}

export interface ParseOk {
  ok: true;
  parsed: ParsedRule;
}

export type ParseResult = ParseOk | ParseError;

const VALID_TOOL_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:__[A-Za-z0-9_*]+)*\*?$|^\*$/;

function fail(message: string): ParseError {
  return { ok: false, error: message };
}

/**
 * Parse a single rule string. Whitespace around the tool name and pattern is
 * trimmed; internal whitespace in Bash patterns is preserved verbatim (it's
 * significant for `ls *` vs `ls*`).
 */
export function parseRule(input: string): ParseResult {
  if (typeof input !== 'string') return fail('rule must be a string');
  const trimmed = input.trim();
  if (!trimmed) return fail('rule is empty');

  const parenIdx = trimmed.indexOf('(');
  if (parenIdx === -1) {
    return parseWholeTool(trimmed);
  }
  if (!trimmed.endsWith(')')) {
    return fail('rule has opening "(" but no matching ")" at the end');
  }
  const tool = trimmed.slice(0, parenIdx).trim();
  if (!tool) return fail('rule is missing a tool name before "("');
  if (!VALID_TOOL_RE.test(tool)) {
    return fail(`invalid tool name: ${JSON.stringify(tool)}`);
  }
  const pattern = trimmed.slice(parenIdx + 1, -1);
  if (!pattern) {
    return fail('rule has empty parentheses — omit them for a whole-tool match');
  }
  if (pattern.includes('(') || pattern.includes(')')) {
    return fail('rule pattern contains nested parentheses');
  }
  return {
    ok: true,
    parsed: { tool, pattern, raw: `${tool}(${pattern})` },
  };
}

function parseWholeTool(trimmed: string): ParseResult {
  if (!VALID_TOOL_RE.test(trimmed)) {
    return fail(`invalid tool name: ${JSON.stringify(trimmed)}`);
  }
  return {
    ok: true,
    parsed: { tool: trimmed, pattern: null, raw: trimmed },
  };
}

/**
 * Parse the editor's raw-mode input which carries a decision prefix:
 *   allow Bash(npm *)
 *   deny  WebFetch
 *
 * The decision word and the rule are separated by one or more spaces. Any
 * surplus whitespace is tolerated.
 */
export function parseRawWithDecision(
  input: string,
): { ok: true; decision: PermissionDecision; parsed: ParsedRule } | { ok: false; error: string } {
  if (typeof input !== 'string') return { ok: false, error: 'input must be a string' };
  const trimmed = input.trim();
  const match = /^(allow|deny)\s+(.+)$/i.exec(trimmed);
  if (!match) {
    return { ok: false, error: 'expected "allow <rule>" or "deny <rule>"' };
  }
  const decisionToken = match[1];
  const rest = match[2];
  if (!decisionToken || !rest) {
    return { ok: false, error: 'expected "allow <rule>" or "deny <rule>"' };
  }
  const decision = decisionToken.toLowerCase() as PermissionDecision;
  const parsed = parseRule(rest);
  if (!parsed.ok) return parsed;
  return { ok: true, decision, parsed: parsed.parsed };
}

/** Build the canonical raw form from a split `tool` + `pattern` pair. Used by
 *  the form-mode UI to keep the DB's `raw` column in sync. */
export function canonicalRaw(tool: string, pattern: string | null): string {
  const t = tool.trim();
  if (!pattern) return t;
  return `${t}(${pattern})`;
}

/** UI helper: true iff the string parses as a complete rule. */
export function isValidRule(raw: string): boolean {
  return parseRule(raw).ok;
}
