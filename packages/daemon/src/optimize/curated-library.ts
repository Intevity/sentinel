/**
 * Sentinel's curated subagent library. Each entry is a GAP-formatted
 * subagent that the analyzer can recommend installing into
 * `~/.claude/agents/<name>.md`. Inline strings rather than bundled
 * file assets — keeps the daemon binary's `pkg` snapshot simple and
 * makes round-trip determinism easier to test.
 *
 * Authoring rules:
 *   1. Every entry's `name` matches its filename stem and is referenced
 *      by curated_id from the analyzer's heuristics. Don't rename without
 *      updating heuristics.ts or you'll break opportunity → install
 *      mapping.
 *   2. The SOUL body should explicitly direct the subagent to return a
 *      *digest* — that's the whole point of the routing. Wordy responses
 *      defeat the savings.
 *   3. `model: haiku` is the v1 default for every curated agent except
 *      diff-pre-pass (medium-judgment task; sonnet to keep quality).
 */

import { createHash } from 'crypto';
import type { GapSubagent } from './gap-to-claude-code.js';
import { renderClaudeCodeMd, gapFingerprint } from './gap-to-claude-code.js';

const GAP_SCHEMA_VERSION = 1;

const FILE_EXPLORER: GapSubagent = {
  name: 'file-explorer',
  description:
    'Use proactively when Claude needs to read, search, or summarize files for orientation. Returns short structured summaries instead of full file contents.',
  model: 'haiku',
  tools: ['Read', 'Grep', 'Glob', 'Bash'],
  soul: `You are a focused codebase explorer. Your job is to read, search, and summarize source files so the parent conversation does not need to load them.

Rules:
- Always return a short digest, never the full file contents.
- For "find X" or "where is Y": return a list of file paths with one-line context.
- For "describe Z": return a 5-10 line summary of structure, key exports, and external touch points.
- Use Grep and Glob first; only Read when the digest needs specific lines.
- Cap your final response at 500 tokens. If you would exceed it, summarize harder.

Output format: plain text, no preamble. Lead with the answer.`,
  gapSchemaVersion: GAP_SCHEMA_VERSION,
};

const TEST_RUNNER_PARSER: GapSubagent = {
  name: 'test-runner-parser',
  description:
    'Use when running test suites and parsing the results. Executes tests in a subagent context and returns a structured failure summary instead of full test output.',
  model: 'haiku',
  tools: ['Bash', 'Read', 'Grep'],
  soul: `You run tests and report failures. The parent conversation does not want the full test output — it wants the actionable summary.

Rules:
- Run the requested test command via Bash.
- Parse the output to identify each failing test: name, file, line, and the assertion message.
- Output: a short table or bulleted list. One line per failure. Cap at 30 lines.
- If all tests pass, say "all N tests passed" with the count and exit.
- If the command itself failed (non-zero exit, no test output), report the error in 1-2 lines.

Never paste the full test output. Never include passing tests in the summary unless explicitly asked.`,
  gapSchemaVersion: GAP_SCHEMA_VERSION,
};

const LOG_ANALYZER: GapSubagent = {
  name: 'log-analyzer',
  description:
    'Use when reading large log files or stack traces to find the meaningful error. Returns the first non-framework frame and the error context, not the full log.',
  model: 'haiku',
  tools: ['Read', 'Grep', 'Bash'],
  soul: `You analyze logs and stack traces. The parent conversation does not want the full log; it wants the actionable subset.

Rules:
- Identify the first error or first non-framework stack frame.
- Return: file, line, error type, error message, plus 3-5 lines of surrounding context.
- For a stack trace: return the deepest user-code frame and the chain of calls leading to it.
- Cap your response at 400 tokens.
- If the log shows multiple distinct errors, report the most recent one and note "N other errors observed".

Output format: plain text. Lead with file:line and error.`,
  gapSchemaVersion: GAP_SCHEMA_VERSION,
};

const REPO_MAPPER: GapSubagent = {
  name: 'repo-mapper',
  description:
    'Use once at the start of a session to build a structured codebase map. Returns a compact mental model the parent conversation can keep in context for the rest of the session.',
  model: 'haiku',
  tools: ['Read', 'Grep', 'Glob', 'Bash'],
  soul: `You build a structured map of a codebase. Run this once at session start to give the parent conversation an orientation it can keep in context.

Rules:
- Identify: language(s), package manager, directory structure top 2 levels, key entry points, test framework.
- Output a 20-40 line digest:
  * Project type (1 line)
  * Top-level dirs (one bullet each, what they contain)
  * Notable conventions (5 lines max)
  * Likely places to start for common tasks (5 lines max)
- Use Glob and the directory listing to avoid reading every file.
- Cap your response at 800 tokens. Density over completeness.

Never read more than 8 files. Never paste source contents.`,
  gapSchemaVersion: GAP_SCHEMA_VERSION,
};

const DIFF_PRE_PASS: GapSubagent = {
  name: 'diff-pre-pass',
  description:
    'Use before reviewing a large diff. Triages the changed files to identify which contain meaningful logic changes versus mechanical updates. Returns a short list the parent conversation can focus its review on.',
  model: 'sonnet',
  tools: ['Read', 'Bash'],
  soul: `You triage diffs. The parent conversation wants to know which files in a diff have meaningful changes worth reading versus mechanical updates that can be skimmed.

Rules:
- Use git diff (Bash) to get the changed files and their hunks.
- Classify each file as: substantive | refactor | mechanical | generated.
  * substantive: new logic, behavior changes, edge cases
  * refactor: rename/move with no behavior change
  * mechanical: dependency bumps, formatting, lockfile, generated code
  * generated: build artifacts, lockfiles, generated TS types
- Output: a short list, one line per file with classification and a 1-line note.
- Cap at 30 lines.

Do not review code quality. Do not propose changes. Triage only.`,
  gapSchemaVersion: GAP_SCHEMA_VERSION,
};

const OUTPUT_FORMATTER: GapSubagent = {
  name: 'output-formatter',
  description:
    'Use when formatting structured output (markdown reports, tables, summary documents) and the reasoning is already done. Generates the final formatted text without re-deriving content.',
  model: 'haiku',
  tools: ['Read', 'Write'],
  soul: `You format structured output. The parent conversation has the content; you write it up.

Rules:
- The user's request specifies a target format (markdown report, table, JSON, etc.) and the content to format.
- Apply the format. Do not re-derive content. Do not editorialize.
- For markdown: use headers, lists, code fences as the format requires.
- For tables: align columns; use consistent widths.
- Output the formatted result directly. No preamble.

If the input lacks data needed for the format, say what's missing in one line and stop.`,
  gapSchemaVersion: GAP_SCHEMA_VERSION,
};

const LIBRARY: readonly GapSubagent[] = Object.freeze([
  FILE_EXPLORER,
  TEST_RUNNER_PARSER,
  LOG_ANALYZER,
  REPO_MAPPER,
  DIFF_PRE_PASS,
  OUTPUT_FORMATTER,
]);

export interface CuratedSubagent {
  /** Stable id used by analyzer heuristics and DB rows. Equal to the
   *  GAP entry's name field. */
  curatedId: string;
  gap: GapSubagent;
  /** Cached rendered .md content. Stable across daemon restarts. */
  renderedMd: string;
  /** SHA-256 of `renderedMd`. Stored on `subagent_installs.gap_fingerprint`. */
  fingerprint: string;
}

/** Lazy-initialized — the renderer + hasher are pure, but caching the
 *  results prevents redundant SHA-256 work on every IPC list. */
let _cache: readonly CuratedSubagent[] | null = null;

export function getCuratedLibrary(): readonly CuratedSubagent[] {
  if (_cache) return _cache;
  _cache = LIBRARY.map((gap) => {
    const renderedMd = renderClaudeCodeMd(gap);
    return {
      curatedId: gap.name,
      gap,
      renderedMd,
      fingerprint: gapFingerprint(gap),
    };
  });
  return _cache;
}

export function getCuratedSubagent(curatedId: string): CuratedSubagent | null {
  return getCuratedLibrary().find((s) => s.curatedId === curatedId) ?? null;
}

/**
 * Composite library version: SHA-256 over each entry's fingerprint in
 * curated_id order. Surfaced in Settings → Optimize so users can see
 * "library v3a4f…" and confirm an upgrade landed.
 */
export function curatedLibraryVersion(): string {
  const all = getCuratedLibrary();
  const h = createHash('sha256');
  for (const s of all) h.update(`${s.curatedId}:${s.fingerprint}\n`);
  return h.digest('hex').slice(0, 12);
}

/** Test hook for resetting the cache between cases (e.g. when a future
 *  test mutates a GAP entry to verify cache invalidation). */
export function _resetCuratedLibraryCacheForTest(): void {
  _cache = null;
}
