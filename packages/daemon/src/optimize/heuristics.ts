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
  | 'repeat_read_cross_session'
  | 'exploration_glob_grep'
  | 'bash_log_parse'
  | 'test_runner_noise'
  | 'diff_pre_pass'
  | 'web_fetch_oversized'
  | 'test_failure_investigation'
  | 'dep_trace_grep_read_chain'
  | 'verbose_response_formatting'
  | 'read_edit_burst'
  | 'multi_small_read_session'
  | 'bash_loop_session'
  | 'dep_trace_bash_grep_chain';

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

/** Cross-session repeat-read threshold: same file_path read this many
 *  times across distinct sessions in the analyzer's lookback window
 *  triggers the file-explorer recommendation. Higher than the per-session
 *  threshold because cross-session signal is noisier (one file naturally
 *  gets re-opened in unrelated work). */
const CROSS_SESSION_REPEAT_THRESHOLD = 5;

/** Grace period before treating a NULL `was_quoted_in_later_turn` as
 *  "not quoted". The proxy backfills this column when the *next* request
 *  in a session lands; if the session ends without a follow-up, the
 *  column stays NULL forever. We wait this long for a follow-up to
 *  arrive, then assume the read wasn't quoted. */
const WAS_QUOTED_GRACE_MS = 5 * 60_000;

/** Decide whether a read can be considered "not quoted in any later
 *  turn" for the purpose of the short-turn-after-large-read heuristic.
 *  Confirmed-not-quoted wins immediately; NULL beyond the grace window
 *  is treated as not-quoted. */
function effectivelyNotQuoted(r: ToolCallRow, nowMs: number): boolean {
  if (r.wasQuotedInLaterTurn === false) return true;
  if (r.wasQuotedInLaterTurn === null && nowMs - r.ts > WAS_QUOTED_GRACE_MS) return true;
  return false;
}

/** Exploration window: when ≥ this many Glob/Grep calls precede the
 *  first Edit/Write, recommend the repo-mapper.
 *
 *  Note: workflows that lean on Bash + Read instead of Glob/Grep (e.g.
 *  `find` / `rg` invoked from Bash) generate zero matches here by
 *  design. The repo-mapper recommendation is only relevant for
 *  exploratory sessions that use the structured Glob/Grep tools. Don't
 *  "fix" zero-fire counts by lowering this threshold without checking
 *  whether the user's traffic actually contains Glob/Grep tool calls. */
const EXPLORATION_GLOB_THRESHOLD = 5;

/** Bash log threshold: log/file-read responses ≥ this many bytes get
 *  routed to the log-analyzer. */
const LOG_PARSE_BYTES = 16 * 1024;

/** Test-runner threshold: bash commands invoking common test runners
 *  whose output exceeds this size route to the test-runner-parser.
 *  Aligned to LOG_PARSE_BYTES (16 KB) so the floor is consistent across
 *  the two Bash-output heuristics; bashLogParse explicitly excludes
 *  test runners by command-stub match, so the partition is clean. */
const TEST_NOISE_BYTES = 16 * 1024;

const TEST_RUNNER_HINTS = ['npm test', 'pnpm test', 'yarn test', 'pytest', 'go test', 'cargo test'];

/** WebFetch / WebSearch oversized response threshold. 16 KB matches the
 *  bash-log-parse floor and is well above the digest size, so net
 *  savings clear the dashboard's $0.10 floor on most fetches. */
const WEB_FETCH_LARGE_BYTES = 16 * 1024;

/** Test-failure-investigation follow-up window. After a Bash test
 *  command, this many milliseconds is the inclusive window in which
 *  Read/Grep tool calls count as "Claude is investigating the failure"
 *  rather than starting unrelated work. 60s matches typical session
 *  burst pacing of ~10s/tool. */
const TEST_FAILURE_FOLLOWUP_MS = 60_000;

/** Test-failure-investigation: minimum number of Read/Grep follow-ups
 *  inside the window before we treat the burst as an investigation
 *  pattern (vs. a generic test run). */
const TEST_FAILURE_FOLLOWUP_THRESHOLD = 3;

/** Dep-tracer: how many times the same Grep `pattern` value must repeat
 *  in one session to qualify as a refactor/rename trace. */
const DEP_TRACE_GREP_REPEAT = 3;

/** Dep-tracer: how many distinct Read calls must interleave with the
 *  repeated Greps to confirm "I am opening the matches I just found,"
 *  ruling out a simple search loop. */
const DEP_TRACE_FOLLOWUP_READS = 4;

/** Verbose-formatting threshold: a Write whose payload is at least this
 *  size, occurring after one or more substantial reads/bash outputs in
 *  the same session, suggests Claude is reformatting prior content
 *  rather than synthesizing fresh. Conservative on first ship; tune
 *  after dogfooding. */
const FORMATTING_WRITE_BYTES = 4 * 1024;
const FORMATTING_PRIOR_TOOL_BYTES = 16 * 1024;

/** Read/Edit burst: per-session counts that, when both crossed, suggest
 *  Claude is hand-applying a fan-out batch of edits one tool call at a
 *  time. Higher than diffPrePass's threshold (which catches the small-
 *  burst case and recommends a Sonnet triager) so the two heuristics
 *  cover distinct traffic shapes. */
const PATCH_BURST_READ_THRESHOLD = 10;
const PATCH_BURST_EDIT_THRESHOLD = 10;

/** bulk-reader: a session with this many distinct small Read calls
 *  spread across this many distinct file paths suggests Claude is
 *  surveying or scanning a codebase a file at a time. Distinct from
 *  file-explorer's heuristics which target single large reads or
 *  3+ reads of one file. */
const BULK_READ_THRESHOLD = 15;
const BULK_READ_AVG_BYTES_MAX = 8 * 1024;
const BULK_READ_DISTINCT_PATHS_MIN = 8;

/** bash-loop-summarizer: a session with many small Bash outputs that
 *  collectively exceed a meaningful byte total. Catches the
 *  high-frequency tiny-output pattern (git status x30, ls x40, etc.)
 *  that no other heuristic surfaces. */
const BASH_LOOP_CALL_THRESHOLD = 60;
const BASH_LOOP_TOTAL_BYTES_MIN = 50 * 1024;
const BASH_LOOP_AVG_BYTES_MAX = 2 * 1024;

/** dep-tracer (Bash flavor): Bash command stubs that look like a
 *  recursive grep or rg/ag invocation. Used by depTraceBashGrepChain
 *  for users who do code search via the Bash CLI rather than the
 *  structured Grep tool. */
const BASH_GREP_HINTS = ['grep -r', 'grep -R', 'rg ', 'rg.', 'ag '];

export function shortTurnAfterLargeRead(rows: ToolCallRow[], nowMs: number): Opportunity[] {
  const out: Opportunity[] = [];
  for (const r of rows) {
    if (r.toolName !== 'Read') continue;
    if (r.responseSizeBytes === null || r.responseSizeBytes < LARGE_READ_BYTES) continue;
    if (!effectivelyNotQuoted(r, nowMs)) continue;
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
    // file_path on Bash holds the command stub captured by the
    // extractor's `command` probe (see tool-call-extractor.ts:204).
    // We match common test runner hints.
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
 * web-fetcher: any WebFetch / WebSearch call whose response exceeds
 * WEB_FETCH_LARGE_BYTES is a candidate. Each oversized fetch is its own
 * opportunity, mirroring the per-call shape of shortTurnAfterLargeRead;
 * the analyzer's 7-day (account, session, curated, pattern) dedup keeps
 * repeated fetches in one session from spamming.
 */
export function webFetchOversized(rows: ToolCallRow[]): Opportunity[] {
  const out: Opportunity[] = [];
  for (const r of rows) {
    if (r.toolName !== 'WebFetch' && r.toolName !== 'WebSearch') continue;
    if (r.denied) continue;
    if (r.responseSizeBytes === null || r.responseSizeBytes < WEB_FETCH_LARGE_BYTES) continue;
    out.push({
      curatedId: 'web-fetcher',
      pattern: 'web_fetch_oversized',
      sourceToolCallIds: [r.id],
      totalResponseBytes: r.responseSizeBytes,
    });
  }
  return out;
}

/**
 * test-failure-investigator: a Bash test-runner invocation followed
 * within TEST_FAILURE_FOLLOWUP_MS by ≥ TEST_FAILURE_FOLLOWUP_THRESHOLD
 * Read/Grep calls. Distinct from `testRunnerNoise` (which only cares
 * about the runner's output size) — this signal is "Claude is *acting*
 * on the output, not just reading it." Both heuristics can fire on the
 * same Bash row; they recommend different subagents and are dedup'd
 * separately by the analyzer's (curated_id, pattern) key.
 *
 * The proxy doesn't capture Bash exit codes, so failure-vs-success is
 * inferred from the follow-up burst rather than a status code.
 */
export function testFailureInvestigation(rows: ToolCallRow[]): Opportunity[] {
  const out: Opportunity[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (r.toolName !== 'Bash') continue;
    if (r.denied) continue;
    const command = r.filePath ?? '';
    if (!TEST_RUNNER_HINTS.some((h) => command.includes(h))) continue;
    const followups: ToolCallRow[] = [];
    for (let j = i + 1; j < rows.length; j++) {
      const next = rows[j];
      if (!next) continue;
      if (next.ts - r.ts > TEST_FAILURE_FOLLOWUP_MS) break;
      if (next.denied) continue;
      if (next.toolName === 'Read' || next.toolName === 'Grep') followups.push(next);
    }
    if (followups.length < TEST_FAILURE_FOLLOWUP_THRESHOLD) continue;
    out.push({
      curatedId: 'test-failure-investigator',
      pattern: 'test_failure_investigation',
      sourceToolCallIds: [r.id, ...followups.map((f) => f.id)],
      totalResponseBytes:
        (r.responseSizeBytes ?? 0) + followups.reduce((s, f) => s + (f.responseSizeBytes ?? 0), 0),
    });
  }
  return out;
}

/**
 * dep-tracer: same Grep `pattern` repeated DEP_TRACE_GREP_REPEAT+ times
 * within one session, with at least DEP_TRACE_FOLLOWUP_READS distinct
 * Read calls interleaved. The "interleaved" rule rules out a pure
 * search loop and pins the signal to "I greped, opened the matches,
 * greped again" — refactor/rename intent.
 *
 * file_path on a Grep row holds the `pattern` value (extractor probe
 * order), so grouping by filePath is grouping by the searched symbol.
 */
export function depTraceGrepReadChain(rows: ToolCallRow[]): Opportunity[] {
  const grepsByPattern = new Map<string, ToolCallRow[]>();
  for (const r of rows) {
    if (r.toolName !== 'Grep') continue;
    if (r.denied) continue;
    if (!r.filePath) continue;
    const list = grepsByPattern.get(r.filePath) ?? [];
    list.push(r);
    grepsByPattern.set(r.filePath, list);
  }
  const out: Opportunity[] = [];
  for (const [, greps] of grepsByPattern) {
    if (greps.length < DEP_TRACE_GREP_REPEAT) continue;
    const firstGrepTs = greps[0]?.ts ?? 0;
    const lastGrepTs = greps[greps.length - 1]?.ts ?? 0;
    const interleavedReads = rows.filter(
      (r) =>
        r.toolName === 'Read' &&
        !r.denied &&
        r.ts >= firstGrepTs &&
        r.ts <= lastGrepTs &&
        r.filePath !== null,
    );
    const distinctPaths = new Set(interleavedReads.map((r) => r.filePath));
    if (distinctPaths.size < DEP_TRACE_FOLLOWUP_READS) continue;
    out.push({
      curatedId: 'dep-tracer',
      pattern: 'dep_trace_grep_read_chain',
      sourceToolCallIds: [...greps.map((g) => g.id), ...interleavedReads.map((r) => r.id)],
      totalResponseBytes:
        greps.reduce((s, g) => s + (g.responseSizeBytes ?? 0), 0) +
        interleavedReads.reduce((s, r) => s + (r.responseSizeBytes ?? 0), 0),
    });
  }
  return out;
}

/**
 * verbose-formatting (output-formatter): a Write of FORMATTING_WRITE_BYTES+
 * occurring after one or more prior tool outputs whose combined response
 * size is FORMATTING_PRIOR_TOOL_BYTES+. Heuristic for "Claude has the
 * content, now it's writing the formatted version." The signal is weak
 * v1; tune thresholds after dogfooding. If zero fires after 7 days, drop
 * output-formatter from the curated library entirely.
 */
export function verboseResponseFormatting(rows: ToolCallRow[]): Opportunity[] {
  const out: Opportunity[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (r.toolName !== 'Write') continue;
    if (r.denied) continue;
    if (r.inputSizeBytes < FORMATTING_WRITE_BYTES) continue;
    const priorBytes = rows
      .slice(0, i)
      .filter(
        (p) =>
          !p.denied &&
          (p.toolName === 'Read' || p.toolName === 'Bash') &&
          p.responseSizeBytes !== null,
      )
      .reduce((s, p) => s + (p.responseSizeBytes ?? 0), 0);
    if (priorBytes < FORMATTING_PRIOR_TOOL_BYTES) continue;
    out.push({
      curatedId: 'output-formatter',
      pattern: 'verbose_response_formatting',
      sourceToolCallIds: [r.id],
      totalResponseBytes: r.inputSizeBytes,
    });
  }
  return out;
}

/**
 * patch-applier: heavy Read/Edit traffic across multiple files in one
 * session. Fires when reads ≥ PATCH_BURST_READ_THRESHOLD AND
 * (Edit + MultiEdit + Write) ≥ PATCH_BURST_EDIT_THRESHOLD AND the set
 * of distinct edited paths has cardinality ≥ 2. The 2-distinct-paths
 * floor distinguishes the burst pattern from "iterate on one file"
 * sessions (which diffPrePass already covers at lower volume).
 *
 * Returns at most one opportunity per session.
 */
export function readEditBurst(rows: ToolCallRow[]): Opportunity[] {
  const reads = rows.filter((r) => r.toolName === 'Read' && !r.denied);
  if (reads.length < PATCH_BURST_READ_THRESHOLD) return [];
  const edits = rows.filter(
    (r) =>
      (r.toolName === 'Edit' || r.toolName === 'MultiEdit' || r.toolName === 'Write') && !r.denied,
  );
  if (edits.length < PATCH_BURST_EDIT_THRESHOLD) return [];
  const distinctPaths = new Set(
    edits.map((r) => r.filePath).filter((p): p is string => p !== null),
  );
  if (distinctPaths.size < 2) return [];
  const all = [...reads, ...edits];
  return [
    {
      curatedId: 'patch-applier',
      pattern: 'read_edit_burst',
      sourceToolCallIds: all.map((r) => r.id),
      totalResponseBytes: all.reduce((s, r) => s + (r.responseSizeBytes ?? 0), 0),
    },
  ];
}

/**
 * bulk-reader: many small Reads across distinct paths in one session.
 * Targets the dominant cost shape that isn't a single big Read (handled
 * by file-explorer's short_turn heuristic) or a same-file repeat
 * (repeat_read_same_file): a survey-style pass where the session reads
 * 15+ small files spread across 8+ distinct paths. Returns at most one
 * opportunity per session.
 */
export function multiSmallReadSession(rows: ToolCallRow[]): Opportunity[] {
  const reads = rows.filter((r) => r.toolName === 'Read' && !r.denied);
  if (reads.length < BULK_READ_THRESHOLD) return [];
  const totalBytes = reads.reduce((s, r) => s + (r.responseSizeBytes ?? 0), 0);
  const avgBytes = totalBytes / reads.length;
  if (avgBytes > BULK_READ_AVG_BYTES_MAX) return [];
  const distinctPaths = new Set(
    reads.map((r) => r.filePath).filter((p): p is string => p !== null),
  );
  if (distinctPaths.size < BULK_READ_DISTINCT_PATHS_MIN) return [];
  return [
    {
      curatedId: 'bulk-reader',
      pattern: 'multi_small_read_session',
      sourceToolCallIds: reads.map((r) => r.id),
      totalResponseBytes: totalBytes,
    },
  ];
}

/**
 * bash-loop-summarizer: many tiny Bash calls in one session whose
 * cumulative output is meaningful. Distinct from log-analyzer (single
 * large Bash) and test-runner-parser (test runner output). Returns at
 * most one opportunity per session.
 */
export function bashLoopSession(rows: ToolCallRow[]): Opportunity[] {
  const bashes = rows.filter((r) => r.toolName === 'Bash' && !r.denied);
  if (bashes.length < BASH_LOOP_CALL_THRESHOLD) return [];
  const totalBytes = bashes.reduce((s, r) => s + (r.responseSizeBytes ?? 0), 0);
  if (totalBytes < BASH_LOOP_TOTAL_BYTES_MIN) return [];
  const avgBytes = totalBytes / bashes.length;
  if (avgBytes >= BASH_LOOP_AVG_BYTES_MAX) return [];
  return [
    {
      curatedId: 'bash-loop-summarizer',
      pattern: 'bash_loop_session',
      sourceToolCallIds: bashes.map((r) => r.id),
      totalResponseBytes: totalBytes,
    },
  ];
}

/**
 * dep-tracer (Bash flavor): a Bash row whose command stub matches a
 * recursive grep or rg/ag invocation, followed within
 * TEST_FAILURE_FOLLOWUP_MS by ≥ DEP_TRACE_FOLLOWUP_READS distinct Read
 * file paths. The original depTraceGrepReadChain only matches the
 * structured Grep tool; this companion catches users whose refactor
 * traffic goes through the Bash CLI.
 */
export function depTraceBashGrepChain(rows: ToolCallRow[]): Opportunity[] {
  const out: Opportunity[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (r.toolName !== 'Bash') continue;
    if (r.denied) continue;
    const command = r.filePath ?? '';
    if (!BASH_GREP_HINTS.some((h) => command.includes(h))) continue;
    const followups: ToolCallRow[] = [];
    for (let j = i + 1; j < rows.length; j++) {
      const next = rows[j];
      if (!next) continue;
      if (next.ts - r.ts > TEST_FAILURE_FOLLOWUP_MS) break;
      if (next.denied) continue;
      if (next.toolName === 'Read' && next.filePath !== null) followups.push(next);
    }
    const distinctPaths = new Set(followups.map((f) => f.filePath));
    if (distinctPaths.size < DEP_TRACE_FOLLOWUP_READS) continue;
    out.push({
      curatedId: 'dep-tracer',
      pattern: 'dep_trace_bash_grep_chain',
      sourceToolCallIds: [r.id, ...followups.map((f) => f.id)],
      totalResponseBytes:
        (r.responseSizeBytes ?? 0) + followups.reduce((s, f) => s + (f.responseSizeBytes ?? 0), 0),
    });
  }
  return out;
}

/**
 * Cross-session repeat-read: detects when the same file is read
 * `CROSS_SESSION_REPEAT_THRESHOLD` or more times across at least two
 * distinct sessions. The per-session `repeatReadSameFile` heuristic
 * misses this case — re-reading the same file across sessions is
 * exactly what `file-explorer` was designed to absorb (load the file
 * into the subagent's context once, summarise into the parent), so the
 * cross-session signal is the dominant indicator of file-explorer's
 * value for users with mostly-short sessions. Returns at most one
 * opportunity per file path.
 */
export function repeatReadAcrossSessions(rows: ToolCallRow[]): Opportunity[] {
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
    if (list.length < CROSS_SESSION_REPEAT_THRESHOLD) continue;
    const sessions = new Set(list.map((r) => r.sessionId).filter((s): s is string => s !== null));
    if (sessions.size < 2) continue;
    out.push({
      curatedId: 'file-explorer',
      pattern: 'repeat_read_cross_session',
      sourceToolCallIds: list.map((r) => r.id),
      totalResponseBytes: list.reduce((s, r) => s + (r.responseSizeBytes ?? 0), 0),
    });
  }
  return out;
}

/**
 * Run every heuristic against a session's tool calls and return the
 * combined opportunity list. Order matters for the analyzer's first-
 * win dedup: large-read fires before repeat-read so a single big read
 * doesn't trigger a "you read the same file twice" recommendation.
 *
 * `nowMs` is threaded in so the grace-period predicate in
 * `shortTurnAfterLargeRead` is testable without mocking the clock.
 *
 * Note: `repeatReadAcrossSessions` is intentionally NOT included here.
 * It's invoked once at the analyzer level over the full lookback
 * window, not once per session.
 */
export function runAllHeuristics(rows: ToolCallRow[], nowMs: number): Opportunity[] {
  return [
    ...shortTurnAfterLargeRead(rows, nowMs),
    ...repeatReadSameFile(rows),
    ...explorationGlobGrepWithoutEdit(rows),
    ...bashLogParse(rows),
    ...testRunnerNoise(rows),
    ...diffPrePass(rows),
    ...webFetchOversized(rows),
    ...testFailureInvestigation(rows),
    ...depTraceGrepReadChain(rows),
    ...verboseResponseFormatting(rows),
    ...readEditBurst(rows),
    ...multiSmallReadSession(rows),
    ...bashLoopSession(rows),
    ...depTraceBashGrepChain(rows),
  ];
}
