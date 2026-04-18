import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { Settings, SwitchingMode } from '@claude-sentinel/shared';

export const SETTINGS_PATH = join(homedir(), '.claude-sentinel', 'settings.json');

export const DEFAULT_SETTINGS: Settings = {
  launchAtLogin: true,
  switchingMode: 'off',
  autoSwitchThresholdPct: 90,
  alertSoundName: 'Glass',
  autoUpdate: false,
  poolExcludedIds: [],
};

const VALID_MODES: readonly SwitchingMode[] = ['off', 'auto-switch', 'round-robin'];

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
  if (typeof obj['autoSwitchThresholdPct'] === 'number') {
    const n = Math.floor(obj['autoSwitchThresholdPct']);
    if (n >= 1 && n <= 99) next.autoSwitchThresholdPct = n;
  }
  if (obj['alertSoundName'] === null || typeof obj['alertSoundName'] === 'string') {
    next.alertSoundName = obj['alertSoundName'] as string | null;
  }
  if (typeof obj['autoUpdate'] === 'boolean') {
    next.autoUpdate = obj['autoUpdate'];
  }
  if (Array.isArray(obj['poolExcludedIds'])) {
    next.poolExcludedIds = obj['poolExcludedIds'].filter(
      (v): v is string => typeof v === 'string',
    );
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
