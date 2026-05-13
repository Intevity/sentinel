/**
 * Benchmark harness for the scanner's synchronous path.
 *
 * Produces per-size median ms for `scanOutbound` so we can pick the
 * `securityOversizedThresholdMb` default from evidence instead of a
 * gut guess. The sizes sweep is deliberately wide (1–16 MB) to
 * mirror the Settings slider's range. Run with:
 *
 *   npx vitest bench packages/daemon/src/security/scanner.bench.ts
 *
 * Output reports hz (ops/sec) and mean/min/max/p99 per size. Use the
 * mean as the "typical scan cost" data point when tuning the
 * default; use p99 when reasoning about worst-case latency.
 *
 * We force `securityScanOversizedSync: true` so the sync gate runs
 * regardless of body size — otherwise everything past the user's
 * threshold would defer and the benchmark would measure the empty
 * early-return path, not the detector work we care about.
 */

import { bench, describe } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { getDb } from '../db.js';
import { createSecurityScanner } from './scanner.js';
import type { Settings } from '@claude-sentinel/shared';

/** Dollar-amount of real detector work to do per run — we pad the
 *  body to the target size with a mix of plausibly-scanned content
 *  (messages array of text). Includes a single fake GitHub PAT at the
 *  end so at least one regex fires and we measure the combined
 *  parse + detector pipeline, not just `JSON.parse`. */
function buildBody(targetBytes: number): Buffer {
  const fakeSecret = 'ghp_' + 'F7K2mQ9xNp4R8tVj6LsW1Zyc3BdHYaGeMnRs';
  // Filler text shaped like conversation content. Regex-heavy
  // detectors will scan across it; picking a single char (`x`)
  // keeps the cost in the "scan every byte" branch rather than
  // matching patterns that short-circuit early.
  const header = '{"messages":[{"role":"user","content":"';
  const trailer = ` ${fakeSecret}"}]}`;
  const fillerLen = Math.max(0, targetBytes - header.length - trailer.length);
  const filler = 'x'.repeat(fillerLen);
  return Buffer.from(header + filler + trailer, 'utf-8');
}

function benchSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    launchAtLogin: true,
    switchingMode: 'off',
    alertSoundName: 'Glass',
    overageOsNotify: true,
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
    detectorOverrides: {},
    toolPermissionsEnabled: false,
    toolPermissionDefaultAction: 'allow',
    toolPermissionSkipInAutoMode: true,
    toolPermissionAutoModeActive: false,
    // Bench-specific: force sync scan regardless of body size so every
    // size in the sweep exercises the full detector path.
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
    securitySetupCompleted: false,
    tourCompleted: false,
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
    ...overrides,
  };
}

const ipcStub = () => ({ broadcast: () => undefined });

const SIZES_MB = [1, 2, 4, 8, 16] as const;

describe('scanner sync-path cost', () => {
  const dbPath = join(tmpdir(), `sentinel-bench-${Date.now()}.db`);
  const db = getDb(dbPath);
  const scanner = createSecurityScanner({
    db,
    ipcServer: ipcStub() as never,
    getSettings: () => benchSettings(),
  });

  for (const mb of SIZES_MB) {
    const body = buildBody(mb * 1024 * 1024);
    bench(`${mb} MB body — full detector set`, () => {
      scanner.scanOutbound(body, 'bench-acc');
    });
  }
  // DB handle is left open intentionally — vitest's bench runner
  // doesn't support afterAll cleanly in this shape, and the file is
  // in a tmpdir with a fresh timestamp per run so there's nothing
  // to leak beyond the process lifetime.
});
