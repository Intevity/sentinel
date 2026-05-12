/**
 * Production-callable scanner microbenchmark.
 *
 * The `scanner.bench.ts` vitest-bench file is great for developer
 * timing on a local machine, but we want end users to be able to
 * measure their own hardware from the Settings UI — so the
 * user-visible button triggers this module, which runs the same
 * synthetic sweep inside the daemon process.
 *
 * Design notes:
 *   - Body shape mirrors scanner.bench.ts exactly (JSON wrapper with
 *     x-padded content plus a fake GitHub PAT) so scan cost is
 *     dominated by the real detector pipeline, not JSON.parse alone.
 *   - A throwaway scanner runs on a fresh in-memory SQLite DB with a
 *     no-op IPC stub — no state leaks into the real daemon's DB,
 *     no broadcasts fire during the bench.
 *   - `securityScanOversizedSync: true` in the bench settings forces
 *     the synchronous path at every size; mute flags prevent any
 *     synthetic events from landing anywhere.
 *   - Each size runs until we hit at least `MIN_SAMPLES` iterations
 *     OR `MAX_DURATION_MS` has elapsed. Sub-millisecond per-call cost
 *     is measured via `process.hrtime.bigint()` nanosecond precision.
 *   - Recommendation logic: pick the largest size whose p99 ≤
 *     `BUDGET_MS`. If no size qualifies (extreme slow hardware),
 *     fall back to 1 MB so the user gets *some* sync coverage.
 */

import Database from 'better-sqlite3';
import { platform as osPlatform, arch as osArch } from 'os';
import type {
  Settings,
  SecurityBenchmarkResult,
  ScanBenchmarkSample,
} from '@claude-sentinel/shared';
import { SCHEMA } from '../db.js';
import { createSecurityScanner } from './scanner.js';

/** Sizes to measure, in MB. Mirrors the Settings slider range so the
 *  recommendation maps directly to a valid threshold. */
const SIZES_MB = [1, 2, 4, 8, 16] as const;

/** Per-size floor — always run this many iterations even if it's
 *  quicker than MAX_DURATION_MS. Keeps p99 calculations honest on
 *  very fast hardware. */
const MIN_SAMPLES = 20;

/** Per-size ceiling — stop collecting samples after this long even
 *  if MIN_SAMPLES hasn't been hit yet. Total bench time is bounded
 *  by `SIZES_MB.length * MAX_DURATION_MS` = ~2.5 s worst case on
 *  hardware where every size blows the budget. */
const MAX_DURATION_MS = 500;

/** Recommendation budget — the largest size whose p99 falls under
 *  this wins. 50 ms is < 2% overhead on a typical Claude RTT, which
 *  reads as "invisible" latency. Chosen over 20 ms (too tight for
 *  older Intel Macs) and 100 ms (starts feeling sluggish on 16 MB
 *  payloads on some hardware). */
const BUDGET_MS = 50;

/** Build a synthetic body of approximately `targetBytes` bytes. The
 *  body parses as a /v1/messages request with one user-content
 *  message whose text is x-padded to the target size, followed by a
 *  fake GitHub PAT so at least one secret-detector regex fires. */
function buildBody(targetBytes: number): Buffer {
  const fakeSecret = 'ghp_' + 'F7K2mQ9xNp4R8tVj6LsW1Zyc3BdHYaGeMnRs';
  const header = '{"messages":[{"role":"user","content":"';
  const trailer = ` ${fakeSecret}"}]}`;
  const fillerLen = Math.max(0, targetBytes - header.length - trailer.length);
  const filler = 'x'.repeat(fillerLen);
  return Buffer.from(header + filler + trailer, 'utf-8');
}

/** Fixed settings used by the bench. Forces sync scan at every size,
 *  mutes all synthetic telemetry, disables the pending-block hold
 *  path (we want pure scanner cost, not UI-latency modelling). */
function benchSettings(): Settings {
  return {
    launchAtLogin: false,
    switchingMode: 'off',
    alertSoundName: null,
    overageOsNotify: false,
    autoUpdate: false,
    alternateApiUrl: null,
    poolExcludedIds: [],
    reauthIncognitoDefault: true,
    overageEnabledIds: [],
    budgetWeeklyUsdByAccount: {},
    budgetWeeklyUsdGlobal: null,
    overageBufferPct: 10,
    roundRobinStrategy: 'balance',
    backgroundProbeIntervalSec: 300,
    telemetryRetentionDays: 30,
    securityScanEnabled: true,
    securityEnforcementMode: 'observe',
    securityScanSecrets: true,
    securityScanInjection: true,
    securityScanToolUse: true,
    securityOsNotifyThreshold: 'high',
    securityPersistSnippet: false,
    securityContextVerbosity: 'standard',
    securityEventRetentionDays: 30,
    securityApproveHoldSec: 60,
    toolPermissionsEnabled: false,
    toolPermissionDefaultAction: 'allow',
    toolPermissionSkipInAutoMode: true,
    toolPermissionAutoModeActive: false,
    securityOversizedThresholdMb: 1,
    securityScanOversizedSync: true,
    securityMuteScanDeferred: true,
    securityMuteScanTruncated: true,
    securityMuteScanSkipped: true,
    lastScanBenchmark: null,
    claudeCodeSyncEnabled: false,
    securityIncidentReplay: false,
    logLevel: 'info',
    requestLoggingEnabled: false,
    requestLogRetentionDays: 7,
    requestLogMaxBodyKb: 256,
    requestLogCaptureResponse: true,
    requestLogRedactAuthHeaders: true,
    cacheTtlForceOneHour: false,
    securitySetupCompleted: true,
    tourCompleted: true,
    denyPrivateNetworkByDefault: false,
    toolPermissionResolveSymlinks: false,
    daemonHealthFailMode: 'warn',
    securityWebhookUrl: null,
    securityWebhookSecret: null,
    securityWebhookSeverityFloor: 'high',
    optimizeCaptureEnabled: true,
    optimizeAutoRecommend: true,
    optimizeShowMicroOpportunities: false,
    optimizeUnits: 'tokens',
    otelForwardingEnabled: false,
    otelForwardMetrics: true,
    otelForwardLogs: true,
    otelEmitSentinelMetrics: true,
    otelExporterEndpoint: null,
    otelExporterHeaderName: 'signoz-ingestion-key',
    otelServiceInstanceId: '00000000-0000-4000-8000-000000000000',
    optimizeChartView: 'realized',
  };
}

/** Statistical p99 from a sorted ms array. We use nearest-rank rather
 *  than interpolation — N is small (20-ish samples), interpolation
 *  would overstate precision and add a second failure mode
 *  (empty-array guard). */
function p99(sortedMs: number[]): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.ceil(sortedMs.length * 0.99) - 1);
  return sortedMs[Math.max(0, idx)]!;
}

/** Arithmetic mean of an ms array. Returns 0 on empty input. */
function mean(ms: number[]): number {
  if (ms.length === 0) return 0;
  let sum = 0;
  for (const x of ms) sum += x;
  return sum / ms.length;
}

/** Pick the largest size whose p99 fits under `budgetMs`. Walks
 *  descending so the first hit wins. Falls back to the smallest size
 *  (1 MB) if even that blows the budget — better to sync-scan
 *  something than fall through to the defer path for everything. */
export function pickRecommendedMb(
  results: ScanBenchmarkSample[],
  budgetMs: number = BUDGET_MS,
): number {
  // Sort descending so the first match is the largest qualifying size.
  const desc = [...results].sort((a, b) => b.sizeMb - a.sizeMb);
  for (const r of desc) {
    if (r.p99Ms <= budgetMs) return r.sizeMb;
  }
  // Nothing qualified — recommend the smallest size.
  return Math.min(...results.map((r) => r.sizeMb));
}

/**
 * Run the microbenchmark and return per-size timings plus a
 * recommendation. Synchronous — the caller is expected to fire this
 * off in a way that doesn't block the IPC socket (see the
 * `run_scan_benchmark` handler in index.ts for the plumbing).
 */
export function runScanBenchmark(): SecurityBenchmarkResult {
  // Throwaway DB — the in-memory constructor avoids any disk I/O.
  // The schema is applied explicitly since we're bypassing the
  // `getDb()` singleton that would usually do it for us.
  const db = new Database(':memory:');
  db.exec(SCHEMA);

  const ipc = { broadcast: () => undefined };
  const scanner = createSecurityScanner({
    db,
    ipcServer: ipc as never,
    getSettings: benchSettings,
  });

  const results: ScanBenchmarkSample[] = [];
  for (const mb of SIZES_MB) {
    const body = buildBody(mb * 1024 * 1024);
    const samplesMs: number[] = [];
    const start = process.hrtime.bigint();
    while (true) {
      const t0 = process.hrtime.bigint();
      scanner.scanOutbound(body, 'bench-acc');
      const t1 = process.hrtime.bigint();
      // nanoseconds → milliseconds as a float
      samplesMs.push(Number(t1 - t0) / 1_000_000);
      const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      if (samplesMs.length >= MIN_SAMPLES && elapsedMs >= MAX_DURATION_MS) break;
      // Safety cap — if one sample takes longer than MAX_DURATION_MS,
      // bail early to keep the whole bench bounded.
      if (elapsedMs >= MAX_DURATION_MS * 4) break;
    }
    const sortedMs = [...samplesMs].sort((a, b) => a - b);
    results.push({
      sizeMb: mb,
      meanMs: mean(samplesMs),
      p99Ms: p99(sortedMs),
    });
  }

  // Don't close the DB explicitly: the scanner's telemetry may fire
  // via setImmediate after our final scanOutbound returns, and
  // running those writes against a closed handle produces a noisy
  // "database is not open" stack trace even though the test itself
  // passes. The in-memory handle gets reaped by GC once the scanner
  // closure drops out of scope, which is fine for a one-shot call.

  const recommendedMb = pickRecommendedMb(results);
  return {
    ranAt: Date.now(),
    platform: `${osPlatform()}-${osArch()}`,
    results,
    recommendedMb,
  };
}
