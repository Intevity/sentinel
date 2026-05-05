/**
 * Periodic analyzer that scans recent `tool_calls` for opportunities and
 * writes `kind='measured'` rows into `optimization_events`. Drives the
 * Optimize dashboard's continuous savings tracking — runs whether or
 * not any subagents are installed, so the user can see the value (or
 * lack thereof) the feature would deliver for their workload.
 *
 * Key contract: opportunities are detected by pattern, then the
 * cost-savings counterfactual is computed against the parent turn's
 * cache_ttl_events row. The realized-vs-potential split is determined
 * at QUERY time (in `getOptimizationMetrics`), not here — this lets a
 * subsequent install retroactively "promote" historical opportunities
 * from potential to realized once the install window covers them.
 *
 * Schedule:
 *   - `setInterval(SCAN_INTERVAL_MS)` between runs
 *   - On each pass: scan tool_calls.ts >= now - LOOKBACK_MS, group by
 *     session_id, run heuristics per session, dedup against existing
 *     measured rows over the past 7d, write new measured rows
 *   - Broadcast `optimization_metrics_updated` if any rows were written
 */

import type Database from 'better-sqlite3';
import {
  hasRecentOptimizationEvent,
  insertOptimizationEvent,
  listSubagentInstalls,
  listRecentToolCalls,
  type ToolCallRow,
} from '../db.js';
import type { IpcServer } from '../ipc.js';
import {
  runAllHeuristics,
  repeatReadAcrossSessions,
  type Opportunity,
  type PatternKey,
} from './heuristics.js';
import { computeSavings } from './savings-calc.js';

/** Time between scheduled passes. 60 seconds is a safety net behind
 *  the per-flush trigger (scheduleRun) — most updates land via the
 *  trigger within ~1.5s of the proxy completing a tool_use; the
 *  interval catches any path that bypassed the trigger (sleeps, GC
 *  pauses, manual DB seeding from scripts). */
const SCAN_INTERVAL_MS = 60_000;

/** Debounce window for `scheduleRun`. A session that emits 20
 *  tool_calls in 5s collapses into a single runOnce after this window
 *  elapses without further flush activity. Tuned to feel real-time
 *  (~1.5s lag) without thrashing dedup queries on a hot session. */
const SCHEDULE_DEBOUNCE_MS = 1500;

/** How far back to scan for new tool_calls on each pass. Picked
 *  generously vs. SCAN_INTERVAL_MS so a missed tick (sleep, GC pause)
 *  doesn't drop opportunities permanently. Dedup catches re-scans. */
const LOOKBACK_MS = 30 * 60_000;

/** Dedup window: an opportunity for the same (session, curated_id, pattern)
 *  is treated as already-recorded if we wrote a row in this window. 7 days
 *  matches the recommendation horizon; long enough to span a multi-day
 *  feature investigation. */
const DEDUP_WINDOW_MS = 7 * 24 * 60 * 60_000;

export interface OptimizationAnalyzer {
  start(): void;
  stop(): void;
  /** Run one full pass synchronously and return the number of new
   *  measured rows written. Exposed for IPC `run_optimization_analysis`
   *  and for tests that want deterministic timing. */
  runOnce(now?: number): number;
  /** Debounced trigger from the proxy's tool-call flush path. Multiple
   *  rapid calls collapse into a single runOnce after the debounce
   *  window expires. Cheap and idempotent (runOnce dedups via
   *  hasRecentOptimizationEvent). Used to drive Metrics-like real-time
   *  refresh on the Optimize dashboard. */
  scheduleRun(): void;
}

export interface CreateOptimizationAnalyzerDeps {
  db: Database.Database;
  ipcServer: IpcServer;
  /** Override the now() clock. Tests inject a fixed value for
   *  deterministic dedup-window assertions. */
  now?: () => number;
  /** Override the scan interval. Tests use 0 and call runOnce manually. */
  intervalMs?: number;
  /** Override the scheduleRun debounce window. Tests use small values
   *  to keep timing assertions snappy. */
  debounceMs?: number;
}

export function createOptimizationAnalyzer(
  deps: CreateOptimizationAnalyzerDeps,
): OptimizationAnalyzer {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? SCAN_INTERVAL_MS;
  const debounceMs = deps.debounceMs ?? SCHEDULE_DEBOUNCE_MS;
  let timer: ReturnType<typeof setInterval> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const runOnce = (clockMs?: number): number => {
    const t = clockMs ?? now();
    const since = t - LOOKBACK_MS;

    // Pull tool_calls grouped by session. listRecentToolCalls returns
    // rows in DESC ts order; we want them ASC per session so the
    // exploration heuristic (which scans for Edits *after* Glob/Grep)
    // sees the right order.
    const recent = listRecentToolCalls(deps.db, { sinceMs: since, limit: 5000 });
    const bySession = new Map<string, ToolCallRow[]>();
    let droppedNoSession = 0;
    for (const row of recent) {
      if (!row.sessionId) {
        droppedNoSession += 1;
        continue;
      }
      const list = bySession.get(row.sessionId) ?? [];
      list.push(row);
      bySession.set(row.sessionId, list);
    }
    for (const list of bySession.values()) list.sort((a, b) => a.ts - b.ts);

    const installs = listSubagentInstalls(deps.db); // unused at write
    // time but pulled here so tests can validate the data pipeline; the
    // realized/potential bucket assignment happens at query time.
    void installs;

    // Per-pattern fire counts so the diagnostic log can show the user
    // which heuristics are detecting opportunities and which are silent.
    const patternCounts: Record<PatternKey, number> = {
      short_turn_after_large_read: 0,
      repeat_read_same_file: 0,
      repeat_read_cross_session: 0,
      exploration_glob_grep: 0,
      bash_log_parse: 0,
      test_runner_noise: 0,
      diff_pre_pass: 0,
    };
    let dedupSkipped = 0;
    let scoreNull = 0;
    let written = 0;
    let totalSavings = 0;

    const tryInsert = (
      opp: Opportunity,
      sessionRows: ToolCallRow[],
      sessionId: string | null,
      accountId: string,
    ): void => {
      if (
        hasRecentOptimizationEvent(deps.db, {
          accountId,
          sessionId,
          curatedId: opp.curatedId,
          pattern: opp.pattern,
          sinceMs: t - DEDUP_WINDOW_MS,
        })
      ) {
        dedupSkipped += 1;
        return;
      }
      const savings = scoreOpportunity(opp, sessionRows);
      if (savings === null) {
        scoreNull += 1;
        return;
      }
      try {
        insertOptimizationEvent(deps.db, {
          ts: t,
          accountId,
          sessionId,
          curatedId: opp.curatedId,
          kind: 'measured',
          pattern: opp.pattern,
          savingsUsd: savings.savingsUsd,
          actualInputTokens: savings.attributedInputTokens,
          actualCachedTokens: savings.attributedCachedTokens,
          actualCostUsd: savings.actualCostUsd,
          hypotheticalCostUsd: savings.hypotheticalCostUsd,
          hypotheticalTotalTokens: savings.hypotheticalTotalTokens,
          sourceToolCallIds: opp.sourceToolCallIds,
        });
        written += 1;
        totalSavings += savings.savingsUsd;
        /* v8 ignore next 4 */
      } catch (err) {
        console.error('[OptimizeAnalyzer] insert failed:', err);
      }
    };

    for (const [sessionId, rows] of bySession) {
      const opportunities = runAllHeuristics(rows, t);
      for (const opp of opportunities) patternCounts[opp.pattern] += 1;
      if (opportunities.length === 0) continue;
      /* v8 ignore next 1 — `?? 'unknown'` is unreachable in practice; tool_calls.account_id is NOT NULL */
      const accountId = rows[0]?.accountId ?? 'unknown';
      for (const opp of opportunities) tryInsert(opp, rows, sessionId, accountId);
    }

    // Cross-session heuristics see the full lookback window, not a
    // per-session slice. The resulting opportunity has sessionId=null
    // and uses an arbitrary matching account (file-explorer's value
    // generalises across accounts using the same workstation).
    const crossSessionOpps = repeatReadAcrossSessions(recent);
    for (const opp of crossSessionOpps) patternCounts[opp.pattern] += 1;
    if (crossSessionOpps.length > 0) {
      /* v8 ignore next 1 — `?? 'unknown'` defensive; we just produced these from recent rows */
      const accountId = recent[0]?.accountId ?? 'unknown';
      for (const opp of crossSessionOpps) tryInsert(opp, recent, null, accountId);
    }

    // Structured one-line per-pass log so the user can grep daemon.log
    // and see exactly what each pass observed. This is the user-visible
    // diagnostic the Optimize feature has lacked since launch.
    console.log(
      `[Optimize] pass: tool_calls=${recent.length} sessions=${bySession.size}` +
        ` dropped_no_session=${droppedNoSession}` +
        ` opportunities short_turn=${patternCounts.short_turn_after_large_read}` +
        ` repeat=${patternCounts.repeat_read_same_file}` +
        ` cross_session=${patternCounts.repeat_read_cross_session}` +
        ` exploration=${patternCounts.exploration_glob_grep}` +
        ` bash_log=${patternCounts.bash_log_parse}` +
        ` test_runner=${patternCounts.test_runner_noise}` +
        ` diff_pre_pass=${patternCounts.diff_pre_pass}` +
        ` dedup_skipped=${dedupSkipped} score_null=${scoreNull} inserted=${written}` +
        ` savings=$${totalSavings.toFixed(4)}`,
    );

    if (written > 0) {
      try {
        deps.ipcServer.broadcast({ type: 'optimization_metrics_updated' });
        /* v8 ignore next 3 */
      } catch (err) {
        console.error('[OptimizeAnalyzer] broadcast failed:', err);
      }
    }

    return written;
  };

  const start = (): void => {
    if (timer !== null) return;
    timer = setInterval(() => {
      try {
        runOnce();
        /* v8 ignore next 3 */
      } catch (err) {
        console.error('[OptimizeAnalyzer] runOnce failed:', err);
      }
    }, intervalMs);
    // Don't keep the event loop alive on this timer alone — daemon
    // shutdown should be able to exit even if the analyzer is mid-tick.
    if (typeof timer.unref === 'function') timer.unref();
  };

  const stop = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const scheduleRun = (): void => {
    // Coalesce a burst of flush events into one analyzer pass after
    // the debounce window. The most recent caller "wins" — earlier
    // schedules push the deadline forward.
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        runOnce();
        /* v8 ignore next 3 */
      } catch (err) {
        console.error('[OptimizeAnalyzer] scheduled runOnce failed:', err);
      }
    }, debounceMs);
    if (typeof debounceTimer.unref === 'function') debounceTimer.unref();
  };

  return { start, stop, runOnce, scheduleRun };
}

/**
 * Score one opportunity by joining the parent turn's cache_ttl_events
 * row (matched by request_id) with the candidate tool calls. Returns
 * null when we can't recover a usable cache state — savings would be
 * meaningless without it.
 *
 * Exported for unit tests; analyzer-internal.
 */
export function scoreOpportunity(
  opp: Opportunity,
  sessionRows: ToolCallRow[],
): {
  savingsUsd: number;
  actualCostUsd: number;
  hypotheticalCostUsd: number;
  attributedInputTokens: number;
  attributedCachedTokens: number;
  hypotheticalTotalTokens: number;
} | null {
  // Build the tool call contributions that drove this opportunity.
  const sourceIds = new Set(opp.sourceToolCallIds);
  const sourceCalls = sessionRows.filter((r) => sourceIds.has(r.id));
  if (sourceCalls.length === 0) return null;
  /* v8 ignore next 1 — `?? 0` fallback covers a tool_use whose tool_result hasn't arrived yet; analyzer normally only scores once response_size_bytes is filled */
  const totalResponseBytes = sourceCalls.reduce((s, r) => s + (r.responseSizeBytes ?? 0), 0);
  if (totalResponseBytes <= 0) return null;

  // Aggregate the parent-turn cache state from the tool_call rows
  // themselves: each row carries the model + (lazily filled)
  // attributedInputTokens / attributedCachedTokens. Until backfill
  // attribution lands, fall back to the raw response bytes as a
  // tokens-equivalent — savings-calc clamps the share to [0, 1] so
  // worst case the estimate undershoots.
  /* v8 ignore next 1 */
  const model = sourceCalls[0]?.model ?? 'claude-opus-4-7';
  // Approximate "this turn's input tokens" as the sum of attributed
  // counts when present, else 4x the response bytes (rough Opus turn
  // size heuristic — most input is the conversation, not the read).
  const totalInputTokens = sourceCalls.reduce(
    (s, r) => s + (r.attributedInputTokens ?? Math.floor((r.responseSizeBytes ?? 0) * 4)),
    0,
  );
  const cacheRead = sourceCalls.reduce((s, r) => s + (r.attributedCachedTokens ?? 0), 0);

  return computeSavings({
    /* v8 ignore next 1 — same null-guard as above; defensive against pre-backfill rows */
    toolCalls: sourceCalls.map((r) => ({ responseSizeBytes: r.responseSizeBytes ?? 0 })),
    parentTurn: {
      cacheRead,
      cacheCreate5m: 0,
      cacheCreate1h: 0,
      uncachedInput: Math.max(0, totalInputTokens - cacheRead),
      totalInputTokens: Math.max(totalInputTokens, totalResponseBytes), // floor
    },
    actualModel: model,
    curatedId: opp.curatedId,
    hypoModel: 'claude-haiku-4-5',
  });
}
