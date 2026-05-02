# Optimize feature — deferred work

The v1 Optimize tab shipped May 2026 with full capture, the curated library, agents-sync engine, install/uninstall flow, and a working dashboard surface. The pieces below are intentionally deferred — the IPC handlers return empty/zeroed shapes today so the UI renders cleanly. Pick this back up when the user is ready to turn recommendations on.

## What's in v1

- **Capture**: `tool-call-extractor.ts` parses tool_use blocks from SSE responses into `tool_calls` (file paths and sizes only, never raw content). Wired into `proxy.ts` behind `optimizeCaptureEnabled` (default true). Settings → Optimize houses the kill switch and the inline disclosure.
- **Install loop**: `agents-sync.ts` writes/removes `~/.claude/agents/<name>.md` atomically, watches the directory, soft-deletes orphans. `install_curated_subagent` / `uninstall_subagent` IPC handlers wired end-to-end with broadcasts.
- **Curated library**: six GAP-format subagents inline in `curated-library.ts`. `gap-to-claude-code.ts` translates GAP → Claude Code `.md` deterministically.
- **Pure-function building blocks**: `heuristics.ts` (six pattern detectors) and `savings-calc.ts` (cache-aware counterfactual). Both fully unit-tested but not yet wired into a runtime path.
- **Dashboard**: `OptimizeDashboard.tsx` renders the curated library, installed subagents, and a 7-day savings totals header.

## What's NOT in v1 (this doc's scope)

### 1. Periodic analyzer

Heuristics + savings-calc exist as pure functions; nothing calls them on a schedule. The plan was a `setInterval(5 * 60_000)` loop plus a per-session "idle for 2 min → analyze" trigger.

**To wire up**:

- Create `packages/daemon/src/optimize/optimization-analyzer.ts`. Shape:

  ```ts
  export interface OptimizationAnalyzer {
    start(): void;
    stop(): void;
    runOnce(): Promise<void>;
    getOpportunities(): Opportunity[]; // in-memory cache for fast IPC reads
  }
  ```

- `runOnce()` should:
  1. Query `tool_calls` rows from the past N minutes (start with last 30 min).
  2. Group by `session_id`.
  3. For each session, call `runAllHeuristics(rows)` from `heuristics.ts`.
  4. Join each opportunity with the session's `cache_ttl_events` rows by `request_id` to assemble `CacheTurnState` per parent turn.
  5. Call `computeSavings()` from `savings-calc.ts`.
  6. Dedup against `optimization_events` over the past 7 days using `(account_id, session_id, curated_id, pattern)`. (The `hasRecentOptimizationEvent` helper was removed during v1 cleanup — re-add it from git history; the SQL is in the v1 commit.)
  7. Insert one `kind='recommended'` row per surviving opportunity.
  8. Broadcast `optimization_opportunity_found` (need to add to `ipc-messages.ts`).

- Wire `start()` into `index.ts` daemon startup after `permissionsEnforcer` and `cacheTtlCtx`. Stop on shutdown.

- Replace the stubbed `case 'get_optimization_opportunities'` in `index.ts` with `analyzer.getOpportunities()`.

- Replace the stubbed `case 'get_optimization_metrics'` with a real DB rollup over `optimization_events` filtered by the `days` arg.

- Replace the stubbed `case 'run_optimization_analysis'` with `analyzer.runOnce()` so the dashboard's manual-refresh button actually does something.

**Settings gate**: the analyzer should respect `settings.optimizeAutoRecommend` — when off, `runOnce()` should still write `kind='measured'` rows but skip the broadcast (so the savings dashboard keeps updating without nudging the user).

### 2. Recommendations UI

`OptimizeDashboard.tsx` has the curated library list and installed list but no "Recommended for you" section. Once the analyzer ships:

- Add an `OpportunityList` component above the curated library.
- Each card: pattern description ("3 large reads of `/var/log/system.log` were never re-quoted"), curated subagent it would route to, estimated savings.
- Accept button → `install_curated_subagent`. Dismiss button → `dismiss_optimization`.
- Listen for `optimization_opportunity_found` broadcasts to refetch.

### 3. Cleanup of removed helpers

During the v1 coverage push, three DB helpers were deleted because they had no callers yet:

- `backfillToolCallAttribution(db, toolCallId, inputTokens, cachedTokens)` — used by the analyzer to write per-call attribution back to `tool_calls`.
- `deleteToolCallsBefore(db, tsMs)` — retention sweep, called from the same daily purge that handles `usage_events`.
- `listOptimizationEvents(db, opts)` — used by the dashboard for the daily savings chart.
- `hasRecentOptimizationEvent(db, args)` — used by the analyzer's dedup pass.
- `setSubagentInstallOptedOut(db, name, optedOut)` — used by the per-curated opt-out UI.

When the analyzer + recommendations UI lands, restore these from the v1 commit (or just re-author; they're small).

### 4. Telemetry retention for `tool_calls`

`tool_calls` rows accumulate without bound today. The retention sweep that prunes `usage_events` (via `purgeTelemetryOlderThan` in `db.ts`) should also prune `tool_calls` using the same `telemetryRetentionDays` setting. One-line addition to the existing sweep.

### 5. Curated library updates

Curated subagents are shipped in the daemon binary today; updating them requires a daemon update. v1 stores `gap_fingerprint` on every install row, so a future "update available" prompt can compare the installed fingerprint against `getCuratedLibrary()[curatedId].fingerprint` and offer a one-click reinstall. UI surface: a yellow dot next to the row in the installed list.

### 6. Eval methodology

The plan called out the need for a held-out eval: "% token reduction at <Y% quality regression." Before we surface savings numbers prominently in marketing or the README, run an eval over a representative session corpus. The savings-calc is approximate (proportional split, byte-to-token ratio of 3.5); the eval should ground the numbers against actual replay through the routed subagent.

## Order to land

1. Restore the deleted DB helpers (Section 3) — small, no behavior change.
2. Wire the analyzer (Section 1).
3. Add the recommendations UI (Section 2).
4. Add `tool_calls` to the retention sweep (Section 4).
5. Add the "library update available" surface (Section 5) — quality-of-life.
6. Run the eval (Section 6) before any external positioning around savings %.

## Files most relevant

- `packages/daemon/src/optimize/heuristics.ts` — opportunity detectors (already shipped).
- `packages/daemon/src/optimize/savings-calc.ts` — cost math (already shipped).
- `packages/daemon/src/db.ts` — `tool_calls` / `optimization_events` / `subagent_installs` schema + helpers.
- `packages/daemon/src/index.ts` — search for `list_installed_subagents` to find the current Optimize handler block; new analyzer wiring goes near `claudeSyncEngine` startup.
- `packages/app/src/components/OptimizeDashboard.tsx` — dashboard scaffold; the recommendations list slots in here.
- `documentation/SECURITY_PLAN.md` — pattern reference for how this kind of multi-sprint plan is structured.
