/**
 * Per-tool matchers for the permission evaluator.
 *
 * Each matcher takes a parsed rule `{ tool, pattern }` and a tool_use
 * `{ name, input }` and returns `true` iff the tool call should be
 * considered a match for that rule.
 *
 * Whole-tool matching (rule pattern is `null`) is handled generically at the
 * top level; matchers here are only called when a specifier is present.
 *
 * Supported tool families:
 *   - Bash               — shell-aware command matching with wrapper stripping
 *   - Read/Edit/Write/…  — path globs (absolute, home-relative, glob-suffix)
 *   - WebFetch/WebSearch — domain: prefix + URL globs
 *   - mcp__*             — handled at the tool-name level, not here
 *   - fallback           — glob against JSON.stringify(toolInput)
 */

import { homedir } from 'os';
import { posix as posixPath } from 'path';

// ─── Glob → regex ────────────────────────────────────────────────────────────

export interface GlobOptions {
  /** When true, `*` and `?` do NOT cross `/` boundaries. `**` still does.
   *  Used for path matching. */
  pathMode: boolean;
}

/**
 * Convert a simple glob pattern to an anchored regex. Supports:
 *   **  — any number of any characters (including `/` in pathMode)
 *   *   — any characters except `/` in pathMode, or anything otherwise
 *   ?   — a single non-`/` character in pathMode, or any char otherwise
 *   \   — escape the next character literally
 *
 * Other regex metacharacters are escaped to be literal.
 */
export function globToRegex(pattern: string, opts: GlobOptions = { pathMode: false }): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\' && i + 1 < pattern.length) {
      // Backslash escapes the next char to be matched literally. The
      // historical implementation prepended an extra `\\` here which
      // turned `\[` into "literal-backslash-then-bracket" (and made
      // bracket char classes leak through). Just regex-escape the
      // following character — that already produces `\[`, `\.`, `\*` etc.
      out += escapeRegex(pattern[++i]!);
      continue;
    }
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += opts.pathMode ? '[^/]*' : '.*';
      }
      continue;
    }
    if (ch === '?') {
      out += opts.pathMode ? '[^/]' : '.';
      continue;
    }
    out += escapeRegex(ch);
  }
  return new RegExp('^' + out + '$');
}

function escapeRegex(s: string): string {
  // Includes `*` and `?` so the `\X` literal-escape branch in
  // `globToRegex` produces the right output for glob meta chars too —
  // the meta-handling branches above run before the fallthrough that
  // also calls escapeRegex, so adding them here can't double-escape.
  return s.replace(/[.+^${}()|[\]\\*?]/g, '\\$&');
}

// ─── Bash ────────────────────────────────────────────────────────────────────

/** Process wrappers whose leading argv is stripped before matching so
 *  `timeout 30 npm test` matches `Bash(npm test)` etc. Extend with care —
 *  each addition lowers rule precision.
 *  `eval` and `exec` are included because both pass their argv through
 *  to be executed as a real command, so `eval rm -rf /` should match the
 *  same rule a bare `rm -rf /` would. */
const WRAPPER_COMMANDS = new Set(['time', 'nohup', 'eval', 'exec']);

/** Wrappers that take a single numeric / named argument before the real
 *  command. Greedy — we strip `cmd ARG` as a pair. */
const WRAPPER_WITH_ARG = new Set(['timeout', 'nice', 'stdbuf']);

/** Shells whose `-c "..."` payload is itself a command to match. */
const SHELLS_WITH_DASH_C = new Set(['sh', 'bash', 'zsh', 'dash']);

/** Tokenize a shell command into argv-style segments. Honors single and
 *  double quotes. Pipelines and logical separators are NOT split here —
 *  see `splitPipeline` for that. */
export function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < cmd.length) {
        cur += cmd[++i];
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Split a command string into segments separated by `|`, `||`, `&&`, or `;`.
 *  Quoted sections are preserved (we don't split inside quotes). */
export function splitPipeline(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      else if (ch === '\\' && i + 1 < cmd.length) cur += cmd[++i];
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '|' || ch === '&' || ch === ';') {
      const next = cmd[i + 1];
      if ((ch === '|' && next === '|') || (ch === '&' && next === '&')) i++;
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Strip leading wrappers (sudo, timeout N, env K=V …) to reveal the real
 *  command. Returns the rewritten command string. Runs iteratively so chained
 *  wrappers (`sudo timeout 5 nohup npm test`) all peel off. */
export function stripWrappers(cmd: string): string {
  let tokens = tokenize(cmd);
  let changed = true;
  while (changed && tokens.length > 0) {
    changed = false;
    const head = tokens[0]!;
    if (head === 'sudo') {
      tokens = tokens.slice(1);
      changed = true;
      continue;
    }
    if (/^[A-Z_][A-Z0-9_]*=/.test(head)) {
      // `env` style inline variable assignments — shell accepts K=V at the
      // head of a command without the literal `env`.
      tokens = tokens.slice(1);
      changed = true;
      continue;
    }
    if (head === 'env') {
      // `env K=V [K=V ...] cmd` — skip the env word and every K=V that follows.
      let j = 1;
      while (j < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[j]!)) j++;
      tokens = tokens.slice(j);
      changed = true;
      continue;
    }
    if (WRAPPER_COMMANDS.has(head)) {
      tokens = tokens.slice(1);
      changed = true;
      continue;
    }
    if (WRAPPER_WITH_ARG.has(head) && tokens.length >= 2) {
      // These wrappers take optional flags (-k, -n …) and one or more
      // numeric / pure-value args before the real command. Skip through
      // any sequence of those.
      let j = 1;
      while (j < tokens.length) {
        const tok = tokens[j]!;
        if (tok.startsWith('-')) {
          j++;
          continue;
        }
        if (/^[0-9]+(?:[smhd]|\.[0-9]+)?$/.test(tok)) {
          j++;
          continue;
        }
        break;
      }
      if (j >= tokens.length) break; // nothing left — give up
      tokens = tokens.slice(j);
      changed = true;
      continue;
    }
    if (head === 'xargs') {
      // Best-effort: skip every xargs flag (starts with `-`) then fall through.
      let j = 1;
      while (j < tokens.length && tokens[j]!.startsWith('-')) {
        if (tokens[j] === '-I' || tokens[j] === '-n') j++; // arg-taking flags
        j++;
      }
      tokens = tokens.slice(j);
      changed = true;
      continue;
    }
  }
  return tokens.join(' ');
}

/** True when `flag` looks like a shell `-c`-style flag bundle. Accepts
 *  the bare `-c` plus combinations like `-lc` (login + command),
 *  `-ec` (errexit + command), `-Ec`, etc. — all of which still treat
 *  the next argv as a script body. Long-form `--command` is also
 *  accepted for completeness. */
function isShellCommandFlag(flag: string): boolean {
  if (flag === '-c' || flag === '--command') return true;
  if (!flag.startsWith('-') || flag.startsWith('--')) return false;
  // Short-flag bundle (e.g. `-lc`, `-eEuc`); look for `c` among the chars.
  return flag.slice(1).includes('c');
}

/** Find every `$(...)` and backtick-subshell inside `cmd` and return the
 *  inner command text. Honors single-quote regions (which suppress
 *  expansion in real shells). Nested `$(...)` is supported with a depth
 *  counter; backtick nesting is not (real shells require backslash-escaping
 *  inner backticks, which we treat as a literal close).
 *
 *  Used by `expandBashCommand` so a rule like `Bash(rm:*)` catches
 *  `echo $(rm -rf /)`. Exported so unit tests can assert the extraction
 *  shape directly. */
export function extractSubshells(cmd: string): string[] {
  const out: string[] = [];
  let i = 0;
  let quote: '"' | "'" | null = null;
  while (i < cmd.length) {
    const ch = cmd[i]!;
    if (quote) {
      // Single quotes suppress every expansion, including command
      // substitution. Stay inside until the closing quote.
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // Double quotes still permit `$(...)` expansion in real shells
      // — only single quotes suppress it. Track the active quote so
      // single-quoted runs are skipped wholesale.
      if (ch === "'") quote = ch;
      i++;
      continue;
    }
    if (ch === '$' && cmd[i + 1] === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < cmd.length && depth > 0) {
        const cj = cmd[j]!;
        if (cj === '(') depth++;
        else if (cj === ')') depth--;
        if (depth === 0) break;
        j++;
      }
      if (depth === 0) {
        const inner = cmd.slice(i + 2, j).trim();
        if (inner) out.push(inner);
        i = j + 1;
        continue;
      }
      // Unmatched `$(` — bail; treat the rest of the string as opaque.
      break;
    }
    if (ch === '`') {
      const j = cmd.indexOf('`', i + 1);
      if (j > i) {
        const inner = cmd.slice(i + 1, j).trim();
        if (inner) out.push(inner);
        i = j + 1;
        continue;
      }
      // Unbalanced backtick — bail.
      break;
    }
    i++;
  }
  return out;
}

/** Find heredoc bodies inside `cmd`. Bash heredoc syntax is
 *  `<<DELIM` or `<<-DELIM`, with optional quoting around DELIM. The
 *  body runs from the next line up to a line equal to DELIM. We treat
 *  the body lines as additional command-segment candidates because a
 *  heredoc fed to `bash` (or `sh -c "$(cat)"` patterns) effectively
 *  executes those lines.
 *
 *  Returns the body text per heredoc (each as one segment, which the
 *  caller can further pipeline-split). */
export function extractHeredocs(cmd: string): string[] {
  const out: string[] = [];
  // Multi-line, non-greedy match. Delimiter capture group permits
  // optional surrounding quotes (`<<'EOF'` and `<<"EOF"` both behave
  // the same for our purposes — quotes suppress expansion of the body
  // but not whether commands inside would run).
  const re = /<<-?\s*['"]?(\w+)['"]?\r?\n([\s\S]*?)\r?\n\1\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const body = m[2]?.trim();
    if (body) out.push(body);
  }
  return out;
}

/**
 * Expand `-c` shells so a rule can match the inner command directly. A
 * `sh -c "npm test && npm lint"` call becomes two logical segments —
 * `npm test` and `npm lint` — alongside the outer `sh` so rules can target
 * either layer. Also expands command substitutions (`$(...)`,
 * backticks) and heredoc bodies — each of those is itself an inner
 * command that real shells execute.
 */
export function expandBashCommand(cmd: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  const enqueue = (c: string): void => {
    const trimmed = c.trim();
    if (!trimmed) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    results.push(trimmed);
    const tokens = tokenize(stripWrappers(trimmed));
    if (
      tokens.length >= 3 &&
      SHELLS_WITH_DASH_C.has(tokens[0]!) &&
      isShellCommandFlag(tokens[1]!)
    ) {
      const inner = tokens.slice(2).join(' ');
      for (const seg of splitPipeline(inner)) enqueue(seg);
    }
    // Subshell substitutions and heredocs inside this segment also
    // become candidates. Each one feeds back through enqueue so its own
    // `-c` / nested-substitution layers expand recursively.
    for (const inner of extractSubshells(trimmed)) {
      for (const seg of splitPipeline(inner)) enqueue(seg);
    }
    for (const inner of extractHeredocs(trimmed)) {
      for (const seg of splitPipeline(inner)) enqueue(seg);
    }
  };
  for (const seg of splitPipeline(cmd)) enqueue(seg);
  return results;
}

/** Build a regex from a Bash pattern, applying the word-boundary rule where a
 *  literal space precedes a trailing `*`. A pattern ending in ` *` matches
 *  the prefix followed by exactly one space and any tail. A pattern ending in
 *  `*` with no preceding space is a plain prefix match. */
function bashPatternToRegex(pattern: string): RegExp {
  // Accept both `npm *` and `npm:*` as equivalent (Claude Code documents
  // the colon form as a shorthand for `space + *`).
  const normalized = pattern.replace(/:(?=\*)/g, ' ');
  return globToRegex(normalized, { pathMode: false });
}

/**
 * Match a Bash tool_use against a Bash rule pattern. Returns true when any
 * of: the full command, the stripped-of-wrappers command, or any segment of
 * a pipeline / `sh -c` expansion matches the regex.
 */
export function matchBash(pattern: string, command: string): boolean {
  if (!command) return false;
  const regex = bashPatternToRegex(pattern);
  const candidates = new Set<string>();
  candidates.add(command);
  candidates.add(stripWrappers(command));
  for (const seg of expandBashCommand(command)) {
    candidates.add(seg);
    candidates.add(stripWrappers(seg));
  }
  for (const c of candidates) {
    if (regex.test(c)) return true;
  }
  return false;
}

// ─── Paths (Read / Edit / Write / Glob / Grep / NotebookEdit) ─────────────────

const PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'NotebookEdit', 'MultiEdit']);

export function isPathTool(name: string): boolean {
  return PATH_TOOLS.has(name);
}

function pickPath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  for (const key of ['file_path', 'path', 'notebook_path', 'pattern']) {
    const v = obj[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function normalizePatternToAbsolute(pattern: string): string {
  if (pattern.startsWith('//')) return pattern.slice(1);
  if (pattern.startsWith('~/')) return homedir() + pattern.slice(1);
  if (pattern === '~') return homedir();
  return pattern;
}

/** Collapse `..` segments in an absolute POSIX path. Returns the input
 *  unchanged for non-absolute paths (the basename matcher handles those).
 *  Symlinks are NOT resolved — that would require a stat call on every
 *  rule check, which is too slow for the hot path; document the limit
 *  rather than fix it. */
function normalizePathForMatch(raw: string): string {
  if (!raw.startsWith('/')) return raw;
  const collapsed = posixPath.normalize(raw);
  // posix.normalize leaves a trailing slash on directory-style inputs;
  // preserve only the trailing slash that was on the original.
  if (raw.endsWith('/') && !collapsed.endsWith('/')) return collapsed + '/';
  return collapsed;
}

/** Match a path tool_use against a path rule pattern.
 *  - `//abs/**`   : absolute path glob
 *  - `~/**`       : home-relative glob
 *  - `/x/**`      : treated as an absolute path for v1 (no project-root)
 *  - `x`          : glob matched against the basename OR anywhere in the path
 *
 *  The path is normalized through `posixPath.normalize` before matching
 *  so traversal via `..` segments cannot escape an `**` boundary
 *  (`/safe/../etc/passwd` matches `Read(//etc/**)`).
 */
export function matchPath(pattern: string, input: unknown): boolean {
  const raw = pickPath(input);
  if (!raw) return false;
  const normalizedRaw = normalizePathForMatch(raw);
  const normalizedPattern = normalizePatternToAbsolute(pattern);
  const regex = globToRegex(normalizedPattern, { pathMode: true });
  if (regex.test(normalizedRaw)) return true;
  // For bare patterns without an anchoring slash, also try matching against
  // the basename so `*.env` works without the user remembering to prefix **.
  if (!normalizedPattern.startsWith('/')) {
    const base = normalizedRaw.split('/').pop() ?? normalizedRaw;
    if (regex.test(base)) return true;
  }
  return false;
}

// ─── WebFetch / WebSearch ────────────────────────────────────────────────────

const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);

export function isWebTool(name: string): boolean {
  return WEB_TOOLS.has(name);
}

function pickUrl(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  for (const key of ['url', 'query']) {
    const v = obj[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function matchWeb(pattern: string, input: unknown): boolean {
  const url = pickUrl(input);
  if (!url) return false;
  if (pattern.startsWith('domain:')) {
    const needle = pattern.slice('domain:'.length).toLowerCase();
    const host = extractDomain(url);
    if (!host) return false;
    if (host === needle) return true;
    if (host.endsWith('.' + needle)) return true;
    return false;
  }
  return globToRegex(pattern, { pathMode: false }).test(url);
}

// ─── MCP ─────────────────────────────────────────────────────────────────────

/** MCP tools follow the `mcp__<server>__<toolname>` naming convention. A rule
 *  can target a whole server via `mcp__<server>__*` or a specific tool. */
export function matchMcpTool(ruleTool: string, toolName: string): boolean {
  if (!ruleTool.startsWith('mcp__')) return false;
  if (ruleTool === toolName) return true;
  if (ruleTool.endsWith('__*')) {
    const prefix = ruleTool.slice(0, -1); // 'mcp__srv__'
    return toolName.startsWith(prefix);
  }
  return false;
}

// ─── Fallback matcher ─────────────────────────────────────────────────────────

/** Glob-match the JSON-serialized tool input. Used for tools we don't have a
 *  dedicated matcher for (custom tools, experimental APIs). */
export function matchFallback(pattern: string, input: unknown): boolean {
  const serialized = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  return globToRegex(pattern, { pathMode: false }).test(serialized);
}
