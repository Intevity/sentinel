/**
 * Pattern detectors that map observed `tool_calls` rows to candidate
 * curated subagent routes. Pure functions keyed on a session's
 * tool-call history; the analyzer joins these against
 * `cache_ttl_events` to score savings via savings-calc.ts.
 *
 * Each heuristic returns zero or more {@link Opportunity} records.
 * Heuristics intentionally don't deduplicate across runs — that's the
 * analyzer's job, via the `optimization_events` ledger.
 */

import type { ToolCallRow } from '../db.js';

/** A pattern key string is part of the contract with
 *  `optimization_events.pattern` and the analyzer's dedup query. Don't
 *  rename without coordinating both sides. */
export type PatternKey =
  | 'short_turn_after_large_read'
  | 'repeat_read_same_file'
  | 'exploration_glob_grep'
  | 'bash_log_parse'
  | 'test_runner_noise'
  | 'diff_pre_pass';

export interface Opportunity {
  curatedId: string;
  pattern: PatternKey;
  /** Tool call IDs that drove this attribution. Stored on the
   *  optimization_events row so the dashboard can show "the Read of
   *  /var/log/system.log triggered this." */
  sourceToolCallIds: number[];
  /** Total response bytes attributed to the routing decision. */
  totalResponseBytes: number;
}

/** Floor for "large" Reads in the short-turn heuristic. ~32 KB matches
 *  Anthropic's typical Read tool result; below this the savings rarely
 *  cross the dashboard's $0.10 threshold. */
const LARGE_READ_BYTES = 32 * 1024;

/** Repeat-read threshold: same file_path read this many times in one
 *  session triggers the file-explorer recommendation. */
const REPEAT_READ_THRESHOLD = 3;

/** Exploration window: when ≥ this many Glob/Grep calls precede the
 *  first Edit/Write, recommend the repo-mapper. */
const EXPLORATION_GLOB_THRESHOLD = 5;

/** Bash log threshold: log/file-read responses ≥ this many bytes get
 *  routed to the log-analyzer. */
const LOG_PARSE_BYTES = 16 * 1024;

/** Test-runner threshold: bash commands invoking common test runners
 *  whose output exceeds this size route to the test-runner-parser. */
const TEST_NOISE_BYTES = 32 * 1024;

const TEST_RUNNER_HINTS = ['npm test', 'pnpm test', 'yarn test', 'pytest', 'go test', 'cargo test'];

export function shortTurnAfterLargeRead(rows: ToolCallRow[]): Opportunity[] {
  const out: Opportunity[] = [];
  for (const r of rows) {
    if (r.toolName !== 'Read') continue;
    if (r.responseSizeBytes === null || r.responseSizeBytes < LARGE_READ_BYTES) continue;
    if (r.wasQuotedInLaterTurn !== false) continue; // null = not yet evaluated; only fire on confirmed-not-quoted
    if (r.denied) continue;
    out.push({
      curatedId: 'file-explorer',
      pattern: 'short_turn_after_large_read',
      sourceToolCallIds: [r.id],
      totalResponseBytes: r.responseSizeBytes,
    });
  }
  return out;
}

export function repeatReadSameFile(rows: ToolCallRow[]): Opportunity[] {
  const byPath = new Map<string, ToolCallRow[]>();
  for (const r of rows) {
    if (r.toolName !== 'Read') continue;
    if (r.denied) continue;
    if (!r.filePath) continue;
    const list = byPath.get(r.filePath) ?? [];
    list.push(r);
    byPath.set(r.filePath, list);
  }
  const out: Opportunity[] = [];
  for (const list of byPath.values()) {
    if (list.length < REPEAT_READ_THRESHOLD) continue;
    out.push({
      curatedId: 'file-explorer',
      pattern: 'repeat_read_same_file',
      sourceToolCallIds: list.map((r) => r.id),
      totalResponseBytes: list.reduce((s, r) => s + (r.responseSizeBytes ?? 0), 0),
    });
  }
  return out;
}

export function explorationGlobGrepWithoutEdit(rows: ToolCallRow[]): Opportunity[] {
  // Find the index of the first edit/write. If there is none AND we
  // see ≥ EXPLORATION_GLOB_THRESHOLD Glob/Grep calls before it (or
  // ever), recommend repo-mapper.
  const firstEditIdx = rows.findIndex(
    (r) => r.toolName === 'Edit' || r.toolName === 'Write' || r.toolName === 'MultiEdit',
  );
  const ceiling = firstEditIdx === -1 ? rows.length : firstEditIdx;
  const explorations = rows
    .slice(0, ceiling)
    .filter((r) => (r.toolName === 'Glob' || r.toolName === 'Grep') && !r.denied);
  if (explorations.length < EXPLORATION_GLOB_THRESHOLD) return [];
  return [
    {
      curatedId: 'repo-mapper',
      pattern: 'exploration_glob_grep',
      sourceToolCallIds: explorations.map((r) => r.id),
      totalResponseBytes: explorations.reduce((s, r) => s + (r.responseSizeBytes ?? 0), 0),
    },
  ];
}

export function bashLogParse(rows: ToolCallRow[]): Opportunity[] {
  const out: Opportunity[] = [];
  for (const r of rows) {
    if (r.toolName !== 'Bash') continue;
    if (r.denied) continue;
    if (r.responseSizeBytes === null || r.responseSizeBytes < LOG_PARSE_BYTES) continue;
    // Skip if it looks like a test runner (handled by testRunnerNoise).
    if (r.filePath && TEST_RUNNER_HINTS.some((h) => r.filePath?.includes(h))) continue;
    out.push({
      curatedId: 'log-analyzer',
      pattern: 'bash_log_parse',
      sourceToolCallIds: [r.id],
      totalResponseBytes: r.responseSizeBytes,
    });
  }
  return out;
}

export function testRunnerNoise(rows: ToolCallRow[]): Opportunity[] {
  const out: Opportunity[] = [];
  for (const r of rows) {
    if (r.toolName !== 'Bash') continue;
    if (r.denied) continue;
    if (r.responseSizeBytes === null || r.responseSizeBytes < TEST_NOISE_BYTES) continue;
    // file_path on Bash is the input command stub captured by the
    // extractor (Bash uses `command` field, but the extractor maps any
    // `command`-shaped string into file_path for indexing). We match
    // common test runner hints.
    const command = r.filePath ?? '';
    if (!TEST_RUNNER_HINTS.some((h) => command.includes(h))) continue;
    out.push({
      curatedId: 'test-runner-parser',
      pattern: 'test_runner_noise',
      sourceToolCallIds: [r.id],
      totalResponseBytes: r.responseSizeBytes,
    });
  }
  return out;
}

export function diffPrePass(rows: ToolCallRow[]): Opportunity[] {
  // Look for repeated Read+Edit cycles on the same file (≥ 2 Read+Edit
  // pairs across distinct files in one session). Returns at most one
  // diff-pre-pass opportunity per session.
  const editPaths = new Set(
    rows
      .filter((r) => (r.toolName === 'Edit' || r.toolName === 'Write') && !r.denied)
      .map((r) => r.filePath)
      .filter((p): p is string => p !== null),
  );
  if (editPaths.size < 2) return [];
  const reads = rows.filter(
    (r) => r.toolName === 'Read' && !r.denied && r.filePath !== null && editPaths.has(r.filePath),
  );
  if (reads.length < 2) return [];
  return [
    {
      curatedId: 'diff-pre-pass',
      pattern: 'diff_pre_pass',
      sourceToolCallIds: reads.map((r) => r.id),
      totalResponseBytes: reads.reduce((s, r) => s + (r.responseSizeBytes ?? 0), 0),
    },
  ];
}

/**
 * Run every heuristic against a session's tool calls and return the
 * combined opportunity list. Order matters for the analyzer's first-
 * win dedup: large-read fires before repeat-read so a single big read
 * doesn't trigger a "you read the same file twice" recommendation.
 */
export function runAllHeuristics(rows: ToolCallRow[]): Opportunity[] {
  return [
    ...shortTurnAfterLargeRead(rows),
    ...repeatReadSameFile(rows),
    ...explorationGlobGrepWithoutEdit(rows),
    ...bashLogParse(rows),
    ...testRunnerNoise(rows),
    ...diffPrePass(rows),
  ];
}
