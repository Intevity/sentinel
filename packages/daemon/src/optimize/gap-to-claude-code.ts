/**
 * GAP (GitAgent Protocol) → Claude Code subagent .md translator.
 *
 * Sentinel's curated library lives as GAP entries (yaml + soul body) so
 * we stay positioned for harness-agnostic subagent recommendations later.
 * Claude Code on disk wants a single .md file per subagent with YAML
 * frontmatter — the translator collapses GAP into that target shape
 * deterministically: stable key order, normalized line endings, no
 * trailing whitespace. Determinism matters because the rendered .md
 * content is hashed (sha256) for echo detection in the agents-sync
 * engine — non-stable output would loop the watcher.
 *
 * The minimal GAP shape we author internally:
 *
 *   {
 *     name: "file-explorer",                     // unique id; .md filename stem
 *     description: "Use proactively when …",    // when to delegate
 *     model: "haiku",                            // 'haiku' | 'sonnet' | 'opus' | 'inherit'
 *     tools: ["Read", "Grep", "Glob", "Bash"],   // allowlist; null/empty means inherit all
 *     soul: "You are a focused …"                // system prompt body
 *   }
 *
 * The translator never invokes a YAML library — the subset we emit is
 * trivial enough that hand-formatting is more reliable across Node
 * versions and avoids a dependency for one call site.
 */

import { createHash } from 'crypto';

export interface GapSubagent {
  /** Unique slug. Used as the .md filename and the frontmatter `name`. */
  name: string;
  /** "When Claude should delegate to this agent." Single line. */
  description: string;
  /** `'haiku' | 'sonnet' | 'opus' | 'inherit'`. */
  model: 'haiku' | 'sonnet' | 'opus' | 'inherit';
  /** Allowlist of Claude Code tool names. Empty means inherit-all. */
  tools: string[];
  /** System prompt body (the "SOUL"). Multi-line is fine. */
  soul: string;
  /** GAP schema version recorded in frontmatter so future loaders can
   *  detect breaking changes without re-parsing every entry. */
  gapSchemaVersion: number;
}

/** Render a single GAP entry as a Claude Code .md file. Output is byte-stable. */
export function renderClaudeCodeMd(g: GapSubagent): string {
  // Frontmatter keys in fixed order: name → description → tools → model.
  // Followed by gap_schema_version on its own line so the round-trip
  // version is recoverable from the file.
  const lines: string[] = [];
  lines.push('---');
  lines.push(`name: ${escapeYamlInline(g.name)}`);
  lines.push(`description: ${escapeYamlInline(g.description)}`);
  if (g.tools.length > 0) {
    // Comma-separated form keeps the file readable; matches Claude Code's
    // accepted shape.
    lines.push(`tools: ${g.tools.join(', ')}`);
  }
  lines.push(`model: ${g.model}`);
  lines.push(`gap_schema_version: ${g.gapSchemaVersion}`);
  lines.push('---');
  lines.push('');
  // Normalize the body: strip trailing whitespace per line, collapse
  // CRLF, ensure single trailing newline.
  const body = g.soul
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n+$/g, '');
  lines.push(body);
  lines.push('');
  return lines.join('\n');
}

/**
 * Escape a single-line YAML scalar so it survives round-trip without
 * needing a real YAML parser. Wraps in single quotes when the value
 * contains characters that would change YAML's interpretation.
 */
function escapeYamlInline(s: string): string {
  if (s === '') return "''";
  // Single quote when the string contains any of: : # & * ! | > " { } [ ] , @ %, leading/trailing whitespace, or a leading - / ?
  const needsQuotes =
    /[:#&*!|>"{}[\],@%]/.test(s) || /^[\s\-?]/.test(s) || /\s$/.test(s) || s.includes("'");
  if (!needsQuotes) return s;
  // YAML single-quote escaping: '' represents a literal '.
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Stable SHA-256 fingerprint of a GAP entry — used by the install loop to
 * detect "your installed version is stale" after a daemon upgrade. Hash
 * input is the rendered .md content so it captures every translator
 * change, not just the source GAP fields.
 */
export function gapFingerprint(g: GapSubagent): string {
  return createHash('sha256').update(renderClaudeCodeMd(g)).digest('hex');
}
