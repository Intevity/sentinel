import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type {
  Settings,
  SwitchingMode,
  RoundRobinStrategy,
  SecurityEnforcementMode,
  SecurityOsNotifyThreshold,
  LogLevel,
  PermissionDecision,
} from '@claude-sentinel/shared';

export const SETTINGS_PATH = join(homedir(), '.claude-sentinel', 'settings.json');

export const DEFAULT_SETTINGS: Settings = {
  launchAtLogin: true,
  switchingMode: 'off',
  alertSoundName: 'Glass',
  overageOsNotify: true,
  autoUpdate: false,
  poolExcludedIds: [],
  overageEnabledIds: [],
  budgetWeeklyUsdByAccount: {},
  budgetWeeklyUsdGlobal: null,
  overageBufferPct: 5,
  roundRobinStrategy: 'balance',
  backgroundProbeIntervalSec: 300,
  telemetryRetentionDays: 30,
  securityScanEnabled: true,
  securityEnforcementMode: null,
  securityScanSecrets: true,
  securityScanInjection: false,
  securityScanToolUse: true,
  securityOsNotifyThreshold: 'high',
  securityPersistSnippet: true,
  securityEventRetentionDays: 30,
  securityBlockHoldEnabled: true,
  securityApproveHoldSec: 60,
  toolPermissionsEnabled: false,
  toolPermissionDefaultAction: 'allow',
  toolPermissionSkipInAutoMode: true,
  toolPermissionAutoModeActive: false,
  logLevel: 'info',
  securitySetupCompleted: false,
  tourCompleted: false,
};

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
const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const VALID_PERMISSION_DECISIONS: readonly PermissionDecision[] = ['allow', 'deny'];

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
  if (typeof obj['switchingMode'] === 'string' && VALID_MODES.includes(obj['switchingMode'] as SwitchingMode)) {
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
  if (Array.isArray(obj['poolExcludedIds'])) {
    next.poolExcludedIds = obj['poolExcludedIds'].filter(
      (v): v is string => typeof v === 'string',
    );
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
    for (const [k, v] of Object.entries(obj['budgetWeeklyUsdByAccount'] as Record<string, unknown>)) {
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
  if (typeof obj['securityEventRetentionDays'] === 'number') {
    const n = Math.floor(obj['securityEventRetentionDays']);
    if (n >= 1 && n <= 365) next.securityEventRetentionDays = n;
  }
  if (typeof obj['securityBlockHoldEnabled'] === 'boolean') {
    next.securityBlockHoldEnabled = obj['securityBlockHoldEnabled'];
  }
  if (typeof obj['securityApproveHoldSec'] === 'number') {
    const n = Math.floor(obj['securityApproveHoldSec']);
    if (n >= 10 && n <= 300) next.securityApproveHoldSec = n;
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
  if (
    typeof obj['logLevel'] === 'string' &&
    VALID_LOG_LEVELS.includes(obj['logLevel'] as LogLevel)
  ) {
    next.logLevel = obj['logLevel'] as LogLevel;
  }
  if (typeof obj['securitySetupCompleted'] === 'boolean') {
    next.securitySetupCompleted = obj['securitySetupCompleted'];
  }
  if (typeof obj['tourCompleted'] === 'boolean') {
    next.tourCompleted = obj['tourCompleted'];
  }
  return next;
}

/**
 * Read settings from disk. Creates no file — returns DEFAULT_SETTINGS when
 * the file is absent so the caller can detect a first run.
 */
export function loadSettings(path: string = SETTINGS_PATH): Settings {
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  try {
    const contents = readFileSync(path, 'utf-8');
    return coerce(JSON.parse(contents));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persist a full Settings object atomically (write + rename). Creates the
 * parent directory if needed.
 */
export function saveSettings(settings: Settings, path: string = SETTINGS_PATH): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  // Atomic rename on POSIX; fall back to a direct write on Windows if rename fails.
  try {
    renameSync(tmp, path);
  } catch {
    /* v8 ignore next 1 */
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }
}

/**
 * Merge a partial update into the current settings and persist the result.
 * Returns the new full Settings object. Invalid fields are silently dropped
 * by coerce() so callers can round-trip user-supplied JSON safely.
 */
export function updateSettings(patch: Partial<Settings>, path: string = SETTINGS_PATH): Settings {
  const current = loadSettings(path);
  const merged = coerce({ ...current, ...patch });
  saveSettings(merged, path);
  return merged;
}
