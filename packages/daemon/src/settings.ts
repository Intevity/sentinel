import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type {
  Settings,
  SwitchingMode,
  RoundRobinStrategy,
  SecurityEnforcementMode,
  SecurityOsNotifyThreshold,
  SecurityContextVerbosity,
  DetectorTier,
  LogLevel,
  PermissionDecision,
  ThemePreference,
  CompressionLevel,
  McpInstallScope,
  McpInstallRecord,
} from '@claude-sentinel/shared';
import { SECURITY_CONTEXT_WINDOW_CHARS, VALID_DETECTOR_TIERS } from '@claude-sentinel/shared';
import { signSettings, verifySettings } from './settings-integrity.js';

/** Default settings-file path. Tests can override via
 *  `CLAUDE_SENTINEL_TEST_SETTINGS_FILE` so they don't pick up the running
 *  user's real settings (mirrors the keychain and upstream-URL overrides
 *  delivered in Sprint 0). Resolved per-call via `currentSettingsPath()`
 *  so the env can be set after module import. Production ignores the env
 *  var; default remains `~/.claude-sentinel/settings.json`. */
export const SETTINGS_PATH = join(homedir(), '.claude-sentinel', 'settings.json');

function currentSettingsPath(): string {
  return process.env.CLAUDE_SENTINEL_TEST_SETTINGS_FILE ?? SETTINGS_PATH;
}

export const DEFAULT_SETTINGS: Settings = {
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
  overageBufferPct: 5,
  roundRobinStrategy: 'balance',
  backgroundProbeIntervalSec: 300,
  telemetryRetentionDays: 30,
  dataRetentionDays: 365,
  securityScanEnabled: true,
  securityEnforcementMode: null,
  securityScanSecrets: true,
  securityScanInjection: false,
  securityScanToolUse: true,
  securityOsNotifyThreshold: 'high',
  securityPersistSnippet: true,
  securityContextVerbosity: 'standard',
  securityEventRetentionDays: 30,
  securityApproveHoldSec: 60,
  detectorOverrides: {},
  toolPermissionsEnabled: false,
  toolPermissionDefaultAction: 'allow',
  toolPermissionSkipInAutoMode: true,
  toolPermissionAutoModeActive: false,
  denyPrivateNetworkByDefault: false,
  toolPermissionResolveSymlinks: false,
  // 4 MB chosen from request-size telemetry + scanner.bench.ts on an
  // M-series Mac (Apple Silicon). Observed Claude Code request-body
  // distribution: 100% under 2 MB across 1,500+ captured requests.
  // Sync-scan cost by body size (mean / p99 ms) from the bench:
  //   1 MB:  1.75 / 2.07
  //   2 MB:  3.47 / 3.92
  //   4 MB:  7.00 / 7.47   ← default; negligible vs. Claude RTT
  //   8 MB: 14.12 / 15.67
  //  16 MB: 28.31 / 31.53   ← slider max; still noise against RTT
  // 4 MB gives 2× headroom over observed p100 and a worst-case latency
  // adder low enough that most users won't notice sync-scan even on
  // their biggest requests. Power users can push higher (or lower)
  // from Settings → Security → Oversized request scanning.
  securityOversizedThresholdMb: 4,
  securityScanOversizedSync: false,
  securityMuteScanDeferred: false,
  securityMuteScanTruncated: false,
  securityMuteScanSkipped: false,
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
  theme: 'system',
  // Sprint 9: warn-and-forward by default; users opt into 'closed' once
  // they've decided they would rather see Claude Code fail than fall
  // through Sentinel's gates while degraded.
  daemonHealthFailMode: 'warn',
  securityWebhookUrl: null,
  securityWebhookSecret: null,
  securityWebhookSeverityFloor: 'high',
  optimizeCaptureEnabled: true,
  optimizeAutoRecommend: true,
  optimizeShowMicroOpportunities: false,
  optimizeUnits: 'tokens',
  optimizeChartView: 'realized',
  optimizeRange: 'all',
  compressionEnabled: false,
  compressionLevel: 'conservative',
  compressionMaxBodyKb: 4096,
  compressionRetrievalEnabled: false,
  compressionRetrievalInstalls: [],
  otelForwardingEnabled: false,
  otelForwardMetrics: true,
  otelForwardLogs: true,
  otelEmitSentinelMetrics: true,
  otelExporterEndpoint: null,
  otelExporterHeaderName: 'signoz-ingestion-key',
  // Empty default; `coerce()` substitutes a freshly-generated UUID v4
  // on every load when the persisted value is blank or malformed, so
  // existing installs auto-populate on next read without a migration.
  otelServiceInstanceId: '',
};

/** RFC 7230 token: `tchar = ALPHA / DIGIT / "!" / "#" / "$" / "%" / "&" /
 *  "'" / "*" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~"`. Used to
 *  validate the OTEL exporter auth-header name. */
const HTTP_HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/** Hosts considered loopback. Plain `http://` is accepted only for these
 *  so a misconfigured production setup can't quietly leak the ingestion
 *  key in plaintext. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Strict UUID v4 shape (lowercase hex, version nibble = 4, variant
 *  high-bits = 10xx i.e. one of 8/9/a/b). Anything else is treated as
 *  invalid and replaced via `randomUUID()` on the next load. Avoids a
 *  loose-match drift where `'aaaa-…'` would slip through. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Build a fresh `Settings` object with every field at its default value
 *  AND a freshly-generated `otelServiceInstanceId` (DEFAULT_SETTINGS'
 *  empty-string sentinel exists only so coerce can detect a missing
 *  persisted value). Used everywhere a "no file / tampered file" branch
 *  needs a Settings to return — keeps the instance-id auto-population
 *  invariant in one place rather than per-callsite. */
function freshDefaults(): Settings {
  return { ...DEFAULT_SETTINGS, otelServiceInstanceId: randomUUID() };
}

const VALID_MODES: readonly SwitchingMode[] = ['off', 'round-robin'];
const VALID_RR_STRATEGIES: readonly RoundRobinStrategy[] = ['balance', 'earliest-reset'];
const VALID_ENFORCEMENT_MODES: readonly SecurityEnforcementMode[] = [
  'observe',
  'block_high',
  'block_medium_high',
];
const VALID_NOTIFY_THRESHOLDS: readonly SecurityOsNotifyThreshold[] = [
  'off',
  'high',
  'medium',
  'low',
];
const VALID_CONTEXT_VERBOSITIES: readonly SecurityContextVerbosity[] = [
  'compact',
  'standard',
  'verbose',
];
const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const VALID_PERMISSION_DECISIONS: readonly PermissionDecision[] = ['allow', 'deny'];
const VALID_HEALTH_FAIL_MODES: readonly Settings['daemonHealthFailMode'][] = [
  'closed',
  'open',
  'warn',
];
const VALID_WEBHOOK_FLOORS: readonly Settings['securityWebhookSeverityFloor'][] = [
  'low',
  'medium',
  'high',
];
const VALID_THEMES: readonly ThemePreference[] = ['light', 'dark', 'system'];
const VALID_COMPRESSION_LEVELS: readonly CompressionLevel[] = [
  'conservative',
  'moderate',
  'aggressive',
];
const VALID_MCP_SCOPES: readonly McpInstallScope[] = ['user', 'local', 'project'];

/** Coerce an arbitrary value into a clean McpInstallRecord[], dropping any
 *  malformed entries. `user`-scope records carry a null directory; `local`
 *  and `project` require a non-empty directory string. */
function coerceMcpInstalls(raw: unknown): McpInstallRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: McpInstallRecord[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const scope = e['scope'];
    if (typeof scope !== 'string' || !VALID_MCP_SCOPES.includes(scope as McpInstallScope)) continue;
    const directory = e['directory'];
    const installedAt = e['installedAt'];
    if (typeof installedAt !== 'number' || !Number.isFinite(installedAt)) continue;
    if (scope === 'user') {
      out.push({ scope: 'user', directory: null, installedAt });
    } else if (typeof directory === 'string' && directory.length > 0) {
      out.push({ scope: scope as McpInstallScope, directory, installedAt });
    }
  }
  return out;
}

/**
 * Coerce an arbitrary value into a valid Settings object, falling back to
 * defaults for any field that is missing or invalid. Never throws — malformed
 * files are treated as a fresh install.
 */
function coerce(raw: unknown): Settings {
  const next = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return next;
  const obj = raw as Record<string, unknown>;

  if (typeof obj['launchAtLogin'] === 'boolean') {
    next.launchAtLogin = obj['launchAtLogin'];
  }
  if (
    typeof obj['switchingMode'] === 'string' &&
    VALID_MODES.includes(obj['switchingMode'] as SwitchingMode)
  ) {
    next.switchingMode = obj['switchingMode'] as SwitchingMode;
  }
  if (obj['alertSoundName'] === null || typeof obj['alertSoundName'] === 'string') {
    next.alertSoundName = obj['alertSoundName'] as string | null;
  }
  if (typeof obj['overageOsNotify'] === 'boolean') {
    next.overageOsNotify = obj['overageOsNotify'];
  }
  if (typeof obj['autoUpdate'] === 'boolean') {
    next.autoUpdate = obj['autoUpdate'];
  }
  if (obj['alternateApiUrl'] === null) {
    next.alternateApiUrl = null;
  } else if (typeof obj['alternateApiUrl'] === 'string') {
    const trimmed = (obj['alternateApiUrl'] as string).trim();
    if (trimmed === '') {
      next.alternateApiUrl = null;
    } else {
      try {
        const u = new URL(trimmed);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          next.alternateApiUrl = u.origin;
        }
      } catch {
        // Malformed URL; keep default (null). Matches securityWebhookUrl pattern.
      }
    }
  }
  if (Array.isArray(obj['poolExcludedIds'])) {
    next.poolExcludedIds = obj['poolExcludedIds'].filter((v): v is string => typeof v === 'string');
  }
  if (typeof obj['reauthIncognitoDefault'] === 'boolean') {
    next.reauthIncognitoDefault = obj['reauthIncognitoDefault'];
  }
  if (Array.isArray(obj['overageEnabledIds'])) {
    next.overageEnabledIds = obj['overageEnabledIds'].filter(
      (v): v is string => typeof v === 'string',
    );
  }
  if (
    obj['budgetWeeklyUsdByAccount'] &&
    typeof obj['budgetWeeklyUsdByAccount'] === 'object' &&
    !Array.isArray(obj['budgetWeeklyUsdByAccount'])
  ) {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(
      obj['budgetWeeklyUsdByAccount'] as Record<string, unknown>,
    )) {
      if (typeof k !== 'string' || !k) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
      out[k] = Math.min(v, 100_000);
    }
    next.budgetWeeklyUsdByAccount = out;
  }
  if (obj['budgetWeeklyUsdGlobal'] === null) {
    next.budgetWeeklyUsdGlobal = null;
  } else if (
    typeof obj['budgetWeeklyUsdGlobal'] === 'number' &&
    Number.isFinite(obj['budgetWeeklyUsdGlobal']) &&
    (obj['budgetWeeklyUsdGlobal'] as number) >= 0
  ) {
    next.budgetWeeklyUsdGlobal = Math.min(obj['budgetWeeklyUsdGlobal'] as number, 100_000);
  }
  if (
    typeof obj['overageBufferPct'] === 'number' &&
    Number.isFinite(obj['overageBufferPct']) &&
    (obj['overageBufferPct'] as number) >= 0 &&
    (obj['overageBufferPct'] as number) <= 50
  ) {
    next.overageBufferPct = Math.floor(obj['overageBufferPct'] as number);
  }
  if (
    typeof obj['roundRobinStrategy'] === 'string' &&
    VALID_RR_STRATEGIES.includes(obj['roundRobinStrategy'] as RoundRobinStrategy)
  ) {
    next.roundRobinStrategy = obj['roundRobinStrategy'] as RoundRobinStrategy;
  }
  if (typeof obj['backgroundProbeIntervalSec'] === 'number') {
    const n = Math.floor(obj['backgroundProbeIntervalSec']);
    if (n >= 60 && n <= 3600) next.backgroundProbeIntervalSec = n;
  }
  if (typeof obj['telemetryRetentionDays'] === 'number') {
    const n = Math.floor(obj['telemetryRetentionDays']);
    if (n >= 1 && n <= 365) next.telemetryRetentionDays = n;
  }
  if (typeof obj['dataRetentionDays'] === 'number') {
    const n = Math.floor(obj['dataRetentionDays']);
    if (n >= 1 && n <= 3650) next.dataRetentionDays = n;
  } else if (typeof obj['telemetryRetentionDays'] === 'number') {
    // Back-compat seed: upgrading users whose file predates the unified
    // analytics-retention knob inherit their old telemetry value once. After
    // the next save the file carries `dataRetentionDays` and this never fires.
    next.dataRetentionDays = next.telemetryRetentionDays;
  }
  if (typeof obj['securityScanEnabled'] === 'boolean') {
    next.securityScanEnabled = obj['securityScanEnabled'];
  }
  if (
    obj['securityEnforcementMode'] === null ||
    (typeof obj['securityEnforcementMode'] === 'string' &&
      VALID_ENFORCEMENT_MODES.includes(obj['securityEnforcementMode'] as SecurityEnforcementMode))
  ) {
    next.securityEnforcementMode = obj['securityEnforcementMode'] as SecurityEnforcementMode | null;
  }
  if (typeof obj['securityScanSecrets'] === 'boolean') {
    next.securityScanSecrets = obj['securityScanSecrets'];
  }
  if (typeof obj['securityScanInjection'] === 'boolean') {
    next.securityScanInjection = obj['securityScanInjection'];
  }
  if (typeof obj['securityScanToolUse'] === 'boolean') {
    next.securityScanToolUse = obj['securityScanToolUse'];
  }
  if (
    typeof obj['securityOsNotifyThreshold'] === 'string' &&
    VALID_NOTIFY_THRESHOLDS.includes(obj['securityOsNotifyThreshold'] as SecurityOsNotifyThreshold)
  ) {
    next.securityOsNotifyThreshold = obj['securityOsNotifyThreshold'] as SecurityOsNotifyThreshold;
  }
  if (typeof obj['securityPersistSnippet'] === 'boolean') {
    next.securityPersistSnippet = obj['securityPersistSnippet'];
  }
  if (
    typeof obj['securityContextVerbosity'] === 'string' &&
    VALID_CONTEXT_VERBOSITIES.includes(obj['securityContextVerbosity'] as SecurityContextVerbosity)
  ) {
    next.securityContextVerbosity = obj['securityContextVerbosity'] as SecurityContextVerbosity;
  }
  if (typeof obj['securityEventRetentionDays'] === 'number') {
    const n = Math.floor(obj['securityEventRetentionDays']);
    // Sprint 8 raised the cap from 365 → 3650 (10y) for compliance use cases
    // that demand long-horizon audit retention. Default stays 30; the value
    // is purely a user-configurable cap on retention sweep cutoffs.
    if (n >= 1 && n <= 3650) next.securityEventRetentionDays = n;
  }
  if (typeof obj['securityApproveHoldSec'] === 'number') {
    const n = Math.floor(obj['securityApproveHoldSec']);
    if (n >= 10 && n <= 300) next.securityApproveHoldSec = n;
  }
  if (
    obj['detectorOverrides'] &&
    typeof obj['detectorOverrides'] === 'object' &&
    !Array.isArray(obj['detectorOverrides'])
  ) {
    // Replace-semantics: each `updateSettings` patch fully specifies the
    // override map. To re-promote a detector back to `'active'`, send
    // an object without its key (or with the value `'active'`). The
    // outer `{...current, ...patch}` merge in `updateSettings` already
    // overwrites the whole field when present in the patch, so all that
    // matters here is shape-validating each value.
    const out: Record<string, DetectorTier> = {};
    for (const [k, v] of Object.entries(obj['detectorOverrides'] as Record<string, unknown>)) {
      if (typeof k !== 'string' || !k) continue;
      if (typeof v !== 'string') continue;
      if (!VALID_DETECTOR_TIERS.includes(v as DetectorTier)) continue;
      out[k] = v as DetectorTier;
    }
    next.detectorOverrides = out;
  }
  if (typeof obj['toolPermissionsEnabled'] === 'boolean') {
    next.toolPermissionsEnabled = obj['toolPermissionsEnabled'];
  }
  if (
    typeof obj['toolPermissionDefaultAction'] === 'string' &&
    VALID_PERMISSION_DECISIONS.includes(obj['toolPermissionDefaultAction'] as PermissionDecision)
  ) {
    next.toolPermissionDefaultAction = obj['toolPermissionDefaultAction'] as PermissionDecision;
  }
  if (typeof obj['toolPermissionSkipInAutoMode'] === 'boolean') {
    next.toolPermissionSkipInAutoMode = obj['toolPermissionSkipInAutoMode'];
  }
  if (typeof obj['toolPermissionAutoModeActive'] === 'boolean') {
    next.toolPermissionAutoModeActive = obj['toolPermissionAutoModeActive'];
  }
  if (typeof obj['denyPrivateNetworkByDefault'] === 'boolean') {
    next.denyPrivateNetworkByDefault = obj['denyPrivateNetworkByDefault'];
  }
  if (typeof obj['toolPermissionResolveSymlinks'] === 'boolean') {
    next.toolPermissionResolveSymlinks = obj['toolPermissionResolveSymlinks'];
  }
  if (typeof obj['securityOversizedThresholdMb'] === 'number') {
    // Clamp 1–16 MB. Values outside the range fall back to the
    // existing setting rather than reverting to the default — avoids
    // silently wiping a user's choice on a partial update payload.
    const n = Math.floor(obj['securityOversizedThresholdMb']);
    if (n >= 1 && n <= 16) next.securityOversizedThresholdMb = n;
  }
  if (typeof obj['securityScanOversizedSync'] === 'boolean') {
    next.securityScanOversizedSync = obj['securityScanOversizedSync'];
  }
  if (typeof obj['securityMuteScanDeferred'] === 'boolean') {
    next.securityMuteScanDeferred = obj['securityMuteScanDeferred'];
  }
  if (typeof obj['securityMuteScanTruncated'] === 'boolean') {
    next.securityMuteScanTruncated = obj['securityMuteScanTruncated'];
  }
  if (typeof obj['securityMuteScanSkipped'] === 'boolean') {
    next.securityMuteScanSkipped = obj['securityMuteScanSkipped'];
  }
  if (obj['lastScanBenchmark'] === null) {
    next.lastScanBenchmark = null;
  } else if (obj['lastScanBenchmark'] && typeof obj['lastScanBenchmark'] === 'object') {
    // Shape-check the incoming benchmark. Reject anything with the
    // wrong schema outright — the field is user-invisible, so silently
    // ignoring a bad payload is safer than throwing.
    const bench = obj['lastScanBenchmark'] as Record<string, unknown>;
    const results = Array.isArray(bench['results']) ? bench['results'] : null;
    const recommendedMb =
      typeof bench['recommendedMb'] === 'number' ? Math.floor(bench['recommendedMb']) : null;
    const ranAt = typeof bench['ranAt'] === 'number' ? bench['ranAt'] : null;
    const platform = typeof bench['platform'] === 'string' ? bench['platform'] : null;
    if (
      results !== null &&
      recommendedMb !== null &&
      recommendedMb >= 1 &&
      recommendedMb <= 16 &&
      ranAt !== null &&
      platform !== null &&
      results.every(
        (r) =>
          r &&
          typeof r === 'object' &&
          typeof (r as Record<string, unknown>)['sizeMb'] === 'number' &&
          typeof (r as Record<string, unknown>)['meanMs'] === 'number' &&
          typeof (r as Record<string, unknown>)['p99Ms'] === 'number',
      )
    ) {
      next.lastScanBenchmark = {
        ranAt,
        platform,
        recommendedMb,
        results: results.map((r) => {
          const row = r as Record<string, unknown>;
          return {
            sizeMb: Math.floor(row['sizeMb'] as number),
            meanMs: row['meanMs'] as number,
            p99Ms: row['p99Ms'] as number,
          };
        }),
      };
    }
  }
  if (typeof obj['claudeCodeSyncEnabled'] === 'boolean') {
    next.claudeCodeSyncEnabled = obj['claudeCodeSyncEnabled'];
  }
  if (typeof obj['securityIncidentReplay'] === 'boolean') {
    next.securityIncidentReplay = obj['securityIncidentReplay'];
  }
  if (
    typeof obj['logLevel'] === 'string' &&
    VALID_LOG_LEVELS.includes(obj['logLevel'] as LogLevel)
  ) {
    next.logLevel = obj['logLevel'] as LogLevel;
  }
  if (typeof obj['requestLoggingEnabled'] === 'boolean') {
    next.requestLoggingEnabled = obj['requestLoggingEnabled'];
  }
  if (typeof obj['requestLogRetentionDays'] === 'number') {
    const n = Math.floor(obj['requestLogRetentionDays']);
    if (n >= 1 && n <= 90) next.requestLogRetentionDays = n;
  }
  if (typeof obj['requestLogMaxBodyKb'] === 'number') {
    const n = Math.floor(obj['requestLogMaxBodyKb']);
    if (n >= 1 && n <= 5000) next.requestLogMaxBodyKb = n;
  }
  if (typeof obj['requestLogCaptureResponse'] === 'boolean') {
    next.requestLogCaptureResponse = obj['requestLogCaptureResponse'];
  }
  if (typeof obj['requestLogRedactAuthHeaders'] === 'boolean') {
    next.requestLogRedactAuthHeaders = obj['requestLogRedactAuthHeaders'];
  }
  if (typeof obj['cacheTtlForceOneHour'] === 'boolean') {
    next.cacheTtlForceOneHour = obj['cacheTtlForceOneHour'];
  }
  if (typeof obj['securitySetupCompleted'] === 'boolean') {
    next.securitySetupCompleted = obj['securitySetupCompleted'];
  }
  if (typeof obj['tourCompleted'] === 'boolean') {
    next.tourCompleted = obj['tourCompleted'];
  }
  if (typeof obj['theme'] === 'string' && VALID_THEMES.includes(obj['theme'] as ThemePreference)) {
    next.theme = obj['theme'] as ThemePreference;
  }
  if (
    typeof obj['daemonHealthFailMode'] === 'string' &&
    VALID_HEALTH_FAIL_MODES.includes(
      obj['daemonHealthFailMode'] as Settings['daemonHealthFailMode'],
    )
  ) {
    next.daemonHealthFailMode = obj['daemonHealthFailMode'] as Settings['daemonHealthFailMode'];
  }
  if (obj['securityWebhookUrl'] === null) {
    next.securityWebhookUrl = null;
  } else if (typeof obj['securityWebhookUrl'] === 'string') {
    // Drop anything that doesn't parse as http(s). An empty string also
    // means "off" — easier for the UI to roundtrip than null.
    const candidate = obj['securityWebhookUrl'] as string;
    if (candidate.trim() === '') {
      next.securityWebhookUrl = null;
    } else {
      try {
        const u = new URL(candidate);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          next.securityWebhookUrl = candidate;
        }
      } catch {
        // Malformed URL; leave the previous value (default null) intact
        // rather than throwing on a partial update payload.
      }
    }
  }
  if (obj['securityWebhookSecret'] === null) {
    next.securityWebhookSecret = null;
  } else if (typeof obj['securityWebhookSecret'] === 'string') {
    const candidate = obj['securityWebhookSecret'] as string;
    next.securityWebhookSecret = candidate === '' ? null : candidate;
  }
  if (
    typeof obj['securityWebhookSeverityFloor'] === 'string' &&
    VALID_WEBHOOK_FLOORS.includes(
      obj['securityWebhookSeverityFloor'] as Settings['securityWebhookSeverityFloor'],
    )
  ) {
    next.securityWebhookSeverityFloor = obj[
      'securityWebhookSeverityFloor'
    ] as Settings['securityWebhookSeverityFloor'];
  }
  if (typeof obj['optimizeCaptureEnabled'] === 'boolean') {
    next.optimizeCaptureEnabled = obj['optimizeCaptureEnabled'];
  }
  if (typeof obj['optimizeAutoRecommend'] === 'boolean') {
    next.optimizeAutoRecommend = obj['optimizeAutoRecommend'];
  }
  if (typeof obj['optimizeShowMicroOpportunities'] === 'boolean') {
    next.optimizeShowMicroOpportunities = obj['optimizeShowMicroOpportunities'];
  }
  if (obj['optimizeUnits'] === 'tokens' || obj['optimizeUnits'] === 'cost') {
    next.optimizeUnits = obj['optimizeUnits'];
  }
  if (
    typeof obj['optimizeChartView'] === 'string' &&
    isOptimizeChartView(obj['optimizeChartView'])
  ) {
    next.optimizeChartView = obj['optimizeChartView'];
  }
  if (typeof obj['optimizeRange'] === 'string' && isOptimizeRange(obj['optimizeRange'])) {
    next.optimizeRange = obj['optimizeRange'];
  }
  if (typeof obj['compressionEnabled'] === 'boolean') {
    next.compressionEnabled = obj['compressionEnabled'];
  }
  if (
    typeof obj['compressionLevel'] === 'string' &&
    VALID_COMPRESSION_LEVELS.includes(obj['compressionLevel'] as CompressionLevel)
  ) {
    next.compressionLevel = obj['compressionLevel'] as CompressionLevel;
  }
  if (
    typeof obj['compressionMaxBodyKb'] === 'number' &&
    Number.isFinite(obj['compressionMaxBodyKb'])
  ) {
    const n = Math.floor(obj['compressionMaxBodyKb'] as number);
    if (n >= 16 && n <= 16384) next.compressionMaxBodyKb = n;
  }
  if (typeof obj['compressionRetrievalEnabled'] === 'boolean') {
    next.compressionRetrievalEnabled = obj['compressionRetrievalEnabled'];
  }
  if (obj['compressionRetrievalInstalls'] !== undefined) {
    next.compressionRetrievalInstalls = coerceMcpInstalls(obj['compressionRetrievalInstalls']);
  }
  if (typeof obj['otelForwardingEnabled'] === 'boolean') {
    next.otelForwardingEnabled = obj['otelForwardingEnabled'];
  }
  if (typeof obj['otelForwardMetrics'] === 'boolean') {
    next.otelForwardMetrics = obj['otelForwardMetrics'];
  }
  if (typeof obj['otelForwardLogs'] === 'boolean') {
    next.otelForwardLogs = obj['otelForwardLogs'];
  }
  if (typeof obj['otelEmitSentinelMetrics'] === 'boolean') {
    next.otelEmitSentinelMetrics = obj['otelEmitSentinelMetrics'];
  }
  if (obj['otelExporterEndpoint'] === null) {
    next.otelExporterEndpoint = null;
  } else if (typeof obj['otelExporterEndpoint'] === 'string') {
    const trimmed = (obj['otelExporterEndpoint'] as string).trim();
    if (trimmed === '') {
      next.otelExporterEndpoint = null;
    } else {
      try {
        const u = new URL(trimmed);
        const host = u.hostname.toLowerCase();
        const accept =
          u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK_HOSTS.has(host));
        if (accept) {
          // Strip trailing slashes; preserve port + base path so SigNoz-style
          // `https://ingest.us2.signoz.cloud:443` and vendor-specific base
          // paths both round-trip.
          next.otelExporterEndpoint = trimmed.replace(/\/+$/, '');
        }
        // else: silently drop. Keeps the previous default of null on a
        // partial update payload that includes a rejected URL.
      } catch {
        // Malformed URL; leave the default (null) intact.
      }
    }
  }
  if (typeof obj['otelExporterHeaderName'] === 'string') {
    const candidate = (obj['otelExporterHeaderName'] as string).trim();
    if (candidate === '') {
      next.otelExporterHeaderName = DEFAULT_SETTINGS.otelExporterHeaderName;
    } else if (HTTP_HEADER_NAME_RE.test(candidate)) {
      next.otelExporterHeaderName = candidate;
    }
    // Invalid characters: silently drop, keep default.
  }
  // Service-instance-id auto-population: accept a valid persisted UUID
  // verbatim, otherwise mint a fresh one. The `next` object will be
  // saved on the next `saveSettings()` call, so a freshly-minted id
  // gets persisted lazily without a dedicated first-run hook.
  if (
    typeof obj['otelServiceInstanceId'] === 'string' &&
    UUID_V4_RE.test(obj['otelServiceInstanceId'] as string)
  ) {
    next.otelServiceInstanceId = obj['otelServiceInstanceId'] as string;
  } else {
    next.otelServiceInstanceId = randomUUID();
  }
  return next;
}

const VALID_CHART_VIEWS: readonly Settings['optimizeChartView'][] = [
  'realized',
  'bySubagent',
  'comparison',
  'cumulative',
  'byPattern',
  'compression',
];

function isOptimizeChartView(v: string): v is Settings['optimizeChartView'] {
  return (VALID_CHART_VIEWS as readonly string[]).includes(v);
}

const VALID_OPTIMIZE_RANGES: readonly Settings['optimizeRange'][] = [
  '1d',
  '1w',
  '1m',
  '3m',
  '1y',
  'all',
  'custom',
];

function isOptimizeRange(v: string): v is Settings['optimizeRange'] {
  return (VALID_OPTIMIZE_RANGES as readonly string[]).includes(v);
}

/** Resolved snippet-window size (chars per side) for the current
 *  Settings. Returns 0 when persistence is off so the scanner can
 *  treat "off" and "zero-size" as one path. */
export function resolveSecurityContextWindow(s: Settings): number {
  if (!s.securityPersistSnippet) return 0;
  return SECURITY_CONTEXT_WINDOW_CHARS[s.securityContextVerbosity];
}

/** Why a `loadSettingsWithTamper` call returned defaults instead of the
 *  on-disk value. `null` means the file was loaded cleanly (or simply
 *  absent — first-run is not tampering). */
export type SettingsTamperReason = 'loose_mode' | 'missing_sig' | 'sig_mismatch';

export interface LoadSettingsResult {
  settings: Settings;
  tamperDetected: boolean;
  reason: SettingsTamperReason | null;
  /** Absolute path of the settings.json that was checked. Useful for the
   *  IPC broadcast payload and for log lines. */
  path: string;
}

/** Path of the HMAC sidecar derived from a settings.json path. */
function sigPath(p: string): string {
  return `${p}.sig`;
}

/**
 * Read settings from disk and report whether the integrity check passed.
 * The boot path uses this so it can broadcast `settings_tamper_detected`;
 * everything else goes through the simpler `loadSettings()` which silently
 * falls back to defaults on any tamper signal.
 *
 * Tamper detection rules:
 *   - File mode has any group/other bits set → `loose_mode`.
 *   - Sidecar `.sig` is missing while `.json` exists → `missing_sig`.
 *   - HMAC verification fails → `sig_mismatch`.
 *
 * A genuinely-fresh install (neither file present) is NOT tamper. The
 * caller should run `saveSettings(...)` once, which establishes both
 * files together.
 */
export function loadSettingsWithTamper(path?: string): LoadSettingsResult {
  const p = path ?? currentSettingsPath();
  const empty: LoadSettingsResult = {
    settings: freshDefaults(),
    tamperDetected: false,
    reason: null,
    path: p,
  };
  if (!existsSync(p)) return empty;

  // Mode check first — a loose-permissions file could have been written
  // by something other than the daemon, so don't trust its contents even
  // if the sig somehow verifies.
  if (process.platform !== 'win32') {
    try {
      const mode = statSync(p).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        console.warn(
          `[Settings] Insecure file mode ${mode.toString(8)} on ${p} — falling back to defaults`,
        );
        return {
          settings: freshDefaults(),
          tamperDetected: true,
          reason: 'loose_mode',
          path: p,
        };
      }
    } catch {
      /* v8 ignore next 2 */
      // statSync racing a concurrent rename — fall through to the read attempt.
    }
  }

  let bytes: string;
  try {
    bytes = readFileSync(p, 'utf-8');
  } catch {
    return empty;
  }

  // Sidecar check. `.sig` absent on a `.json` that exists is suspicious:
  // saveSettings() writes both atomically, so the only ways to land here
  // are hand-deletion of the sidecar or a previous-version daemon (pre-
  // Sprint 2) that didn't sign at all. Treat both as tamper — the user
  // sees the banner, sets the desired settings via UI, and saveSettings
  // writes a fresh signed pair.
  const sp = sigPath(p);
  if (!existsSync(sp)) {
    console.warn(`[Settings] Missing signature file ${sp} — falling back to defaults`);
    return {
      settings: freshDefaults(),
      tamperDetected: true,
      reason: 'missing_sig',
      path: p,
    };
  }
  let expectedSig: string;
  try {
    expectedSig = readFileSync(sp, 'utf-8').trim();
  } catch {
    /* v8 ignore next 2 */
    return {
      settings: freshDefaults(),
      tamperDetected: true,
      reason: 'missing_sig',
      path: p,
    };
  }

  if (!verifySettings(bytes, expectedSig)) {
    console.error(`[Settings] HMAC mismatch on ${p} — falling back to defaults`);
    return {
      settings: freshDefaults(),
      tamperDetected: true,
      reason: 'sig_mismatch',
      path: p,
    };
  }

  try {
    return {
      settings: coerce(JSON.parse(bytes)),
      tamperDetected: false,
      reason: null,
      path: p,
    };
  } catch {
    // Coerce already swallows malformed JSON, but the JSON.parse can
    // throw — fall back silently.
    /* v8 ignore next */
    return empty;
  }
}

/**
 * Read settings from disk. Creates no file — returns DEFAULT_SETTINGS when
 * the file is absent so the caller can detect a first run, and also when
 * the integrity check fails (silent fallback). Use `loadSettingsWithTamper`
 * for the boot path that needs to surface tamper to the UI.
 */
export function loadSettings(path?: string): Settings {
  return loadSettingsWithTamper(path).settings;
}

/**
 * Persist a full Settings object atomically (write + rename). Creates the
 * parent directory if needed.
 *
 * Sprint 2: the parent dir is chmod 0o700, the settings file is chmod
 * 0o600, and a sidecar `.sig` (HMAC-SHA256, hex) is written next to it
 * — also 0o600. Both files are written before fsync-equivalent return so
 * a subsequent `loadSettings` on the same boot can verify.
 */
export function saveSettings(settings: Settings, path?: string): void {
  const p = path ?? currentSettingsPath();
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Tighten directory perms idempotently — protects against an attacker
  // who set o+w between writes.
  if (process.platform !== 'win32') {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* v8 ignore next */
      // non-fatal
    }
  }

  const bytes = JSON.stringify(settings, null, 2) + '\n';
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, bytes, 'utf-8');
  try {
    renameSync(tmp, p);
  } catch {
    /* v8 ignore next */
    writeFileSync(p, bytes, 'utf-8');
  }
  if (process.platform !== 'win32') {
    try {
      chmodSync(p, 0o600);
    } catch {
      /* v8 ignore next */
      // non-fatal
    }
  }

  // Sign and persist the sidecar. Order matters: write+rename+chmod the
  // .json first so a reader who races us either sees the old pair or the
  // new pair, never the new .json with the old .sig.
  const sig = signSettings(bytes);
  const sp = sigPath(p);
  const sigTmp = `${sp}.tmp`;
  writeFileSync(sigTmp, sig, 'utf-8');
  try {
    renameSync(sigTmp, sp);
  } catch {
    /* v8 ignore next */
    writeFileSync(sp, sig, 'utf-8');
  }
  if (process.platform !== 'win32') {
    try {
      chmodSync(sp, 0o600);
    } catch {
      /* v8 ignore next */
      // non-fatal
    }
  }
}

/**
 * Remove the settings file and its sidecar. Used by the uninstall / reset
 * flow; not called during normal operation. No-ops on missing files.
 */
export function deleteSettingsFiles(path?: string): void {
  const p = path ?? currentSettingsPath();
  for (const target of [p, sigPath(p)]) {
    try {
      if (existsSync(target)) unlinkSync(target);
    } catch {
      /* v8 ignore next 2 */
      // ignore
    }
  }
}

/**
 * Merge a partial update into the current settings and persist the result.
 * Returns the new full Settings object. Invalid fields are silently dropped
 * by coerce() so callers can round-trip user-supplied JSON safely.
 */
export function updateSettings(patch: Partial<Settings>, path?: string): Settings {
  const p = path ?? currentSettingsPath();
  const current = loadSettings(p);
  const merged = coerce({ ...current, ...patch });
  saveSettings(merged, p);
  return merged;
}
