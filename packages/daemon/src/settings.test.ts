import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { loadSettings, saveSettings, updateSettings, DEFAULT_SETTINGS } from './settings.js';

function tempSettingsPath(): string {
  const dir = join(tmpdir(), `sentinel-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'settings.json');
}

describe('settings', () => {
  let path: string;

  beforeEach(() => { path = tempSettingsPath(); });
  afterEach(() => {
    const dir = join(path, '..');
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  describe('loadSettings', () => {
    it('returns defaults when the file does not exist', () => {
      expect(loadSettings(path)).toEqual(DEFAULT_SETTINGS);
    });

    it('returns defaults when the file is unparseable', () => {
      writeFileSync(path, 'not json at all', 'utf-8');
      expect(loadSettings(path)).toEqual(DEFAULT_SETTINGS);
    });

    it('returns defaults when the file contains a non-object', () => {
      writeFileSync(path, '"a string"', 'utf-8');
      expect(loadSettings(path)).toEqual(DEFAULT_SETTINGS);
    });

    it('preserves valid fields and backfills invalid ones with defaults', () => {
      writeFileSync(path, JSON.stringify({
        launchAtLogin: false,
        switchingMode: 'bogus-mode',
      }), 'utf-8');
      const got = loadSettings(path);
      expect(got.launchAtLogin).toBe(false);
      expect(got.switchingMode).toBe(DEFAULT_SETTINGS.switchingMode);
    });

    it('accepts both valid switchingMode values', () => {
      for (const mode of ['off', 'round-robin'] as const) {
        writeFileSync(path, JSON.stringify({ ...DEFAULT_SETTINGS, switchingMode: mode }), 'utf-8');
        expect(loadSettings(path).switchingMode).toBe(mode);
      }
    });

    it('rejects the retired "auto-switch" mode, falling back to default', () => {
      writeFileSync(path, JSON.stringify({ switchingMode: 'auto-switch' }), 'utf-8');
      expect(loadSettings(path).switchingMode).toBe(DEFAULT_SETTINGS.switchingMode);
    });

    it('defaults roundRobinStrategy to "balance"', () => {
      expect(loadSettings(path).roundRobinStrategy).toBe('balance');
    });

    it('accepts both valid roundRobinStrategy values', () => {
      for (const strategy of ['balance', 'earliest-reset'] as const) {
        writeFileSync(path, JSON.stringify({ ...DEFAULT_SETTINGS, roundRobinStrategy: strategy }), 'utf-8');
        expect(loadSettings(path).roundRobinStrategy).toBe(strategy);
      }
    });

    it('falls back to default roundRobinStrategy when the value is garbage', () => {
      writeFileSync(path, JSON.stringify({ roundRobinStrategy: 'other' }), 'utf-8');
      expect(loadSettings(path).roundRobinStrategy).toBe(DEFAULT_SETTINGS.roundRobinStrategy);
      writeFileSync(path, JSON.stringify({ roundRobinStrategy: 42 }), 'utf-8');
      expect(loadSettings(path).roundRobinStrategy).toBe(DEFAULT_SETTINGS.roundRobinStrategy);
    });

    it('accepts all valid logLevel values', () => {
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        writeFileSync(path, JSON.stringify({ ...DEFAULT_SETTINGS, logLevel: level }), 'utf-8');
        expect(loadSettings(path).logLevel).toBe(level);
      }
    });

    it('falls back to default logLevel when the value is garbage', () => {
      writeFileSync(path, JSON.stringify({ logLevel: 'verbose' }), 'utf-8');
      expect(loadSettings(path).logLevel).toBe(DEFAULT_SETTINGS.logLevel);
    });

    it('falls back to default logLevel when the value is not a string', () => {
      writeFileSync(path, JSON.stringify({ logLevel: 42 }), 'utf-8');
      expect(loadSettings(path).logLevel).toBe(DEFAULT_SETTINGS.logLevel);
    });

    it('defaults overageOsNotify to true when the file is missing', () => {
      expect(loadSettings(path).overageOsNotify).toBe(true);
    });

    it('round-trips overageOsNotify=false and rejects non-boolean input', () => {
      writeFileSync(path, JSON.stringify({ overageOsNotify: false }), 'utf-8');
      expect(loadSettings(path).overageOsNotify).toBe(false);
      writeFileSync(path, JSON.stringify({ overageOsNotify: 'nope' }), 'utf-8');
      expect(loadSettings(path).overageOsNotify).toBe(DEFAULT_SETTINGS.overageOsNotify);
    });

    it('accepts a boolean autoUpdate and ignores non-boolean values', () => {
      writeFileSync(path, JSON.stringify({ autoUpdate: true }), 'utf-8');
      expect(loadSettings(path).autoUpdate).toBe(true);
      writeFileSync(path, JSON.stringify({ autoUpdate: 'yes' }), 'utf-8');
      expect(loadSettings(path).autoUpdate).toBe(DEFAULT_SETTINGS.autoUpdate);
    });

    it('defaults autoUpdate to false when the file is missing', () => {
      expect(loadSettings(path).autoUpdate).toBe(false);
    });

    it('defaults overageEnabledIds to an empty array', () => {
      expect(loadSettings(path).overageEnabledIds).toEqual([]);
    });

    it('filters non-string entries out of overageEnabledIds', () => {
      writeFileSync(path, JSON.stringify({ overageEnabledIds: ['acc-1', 5, null, 'acc-2', {}] }), 'utf-8');
      expect(loadSettings(path).overageEnabledIds).toEqual(['acc-1', 'acc-2']);
    });

    it('ignores a non-array overageEnabledIds value', () => {
      writeFileSync(path, JSON.stringify({ overageEnabledIds: 'acc-1' }), 'utf-8');
      expect(loadSettings(path).overageEnabledIds).toEqual(DEFAULT_SETTINGS.overageEnabledIds);
    });

    it('defaults budgetWeeklyUsdByAccount to an empty map', () => {
      expect(loadSettings(path).budgetWeeklyUsdByAccount).toEqual({});
    });

    it('accepts a valid budgetWeeklyUsdByAccount and drops invalid entries', () => {
      writeFileSync(path, JSON.stringify({
        budgetWeeklyUsdByAccount: {
          'acc-a': 10,
          'acc-b': -3,             // negative — dropped
          'acc-c': 'not-a-number', // non-number — dropped
          'acc-d': Number.POSITIVE_INFINITY, // non-finite — dropped
          '':      7,               // empty key — dropped
          'acc-e': 250_000,         // clamped to 100_000
        },
      }), 'utf-8');
      expect(loadSettings(path).budgetWeeklyUsdByAccount).toEqual({
        'acc-a': 10,
        'acc-e': 100_000,
      });
    });

    it('ignores a non-object budgetWeeklyUsdByAccount value', () => {
      writeFileSync(path, JSON.stringify({ budgetWeeklyUsdByAccount: [1, 2] }), 'utf-8');
      expect(loadSettings(path).budgetWeeklyUsdByAccount).toEqual({});
    });

    it('defaults budgetWeeklyUsdGlobal to null', () => {
      expect(loadSettings(path).budgetWeeklyUsdGlobal).toBe(null);
    });

    it('accepts a valid budgetWeeklyUsdGlobal and clamps above 100000', () => {
      writeFileSync(path, JSON.stringify({ budgetWeeklyUsdGlobal: 42 }), 'utf-8');
      expect(loadSettings(path).budgetWeeklyUsdGlobal).toBe(42);
      writeFileSync(path, JSON.stringify({ budgetWeeklyUsdGlobal: 250_000 }), 'utf-8');
      expect(loadSettings(path).budgetWeeklyUsdGlobal).toBe(100_000);
      writeFileSync(path, JSON.stringify({ budgetWeeklyUsdGlobal: null }), 'utf-8');
      expect(loadSettings(path).budgetWeeklyUsdGlobal).toBe(null);
    });

    it('rejects an invalid budgetWeeklyUsdGlobal (negative, NaN, string)', () => {
      writeFileSync(path, JSON.stringify({ budgetWeeklyUsdGlobal: -1 }), 'utf-8');
      expect(loadSettings(path).budgetWeeklyUsdGlobal).toBe(DEFAULT_SETTINGS.budgetWeeklyUsdGlobal);
      writeFileSync(path, JSON.stringify({ budgetWeeklyUsdGlobal: 'fifty' }), 'utf-8');
      expect(loadSettings(path).budgetWeeklyUsdGlobal).toBe(DEFAULT_SETTINGS.budgetWeeklyUsdGlobal);
    });

    it('defaults overageBufferPct to 5', () => {
      expect(loadSettings(path).overageBufferPct).toBe(5);
    });

    it('accepts overageBufferPct in [0, 50] and floors fractionals', () => {
      writeFileSync(path, JSON.stringify({ overageBufferPct: 0 }), 'utf-8');
      expect(loadSettings(path).overageBufferPct).toBe(0);
      writeFileSync(path, JSON.stringify({ overageBufferPct: 25 }), 'utf-8');
      expect(loadSettings(path).overageBufferPct).toBe(25);
      writeFileSync(path, JSON.stringify({ overageBufferPct: 50 }), 'utf-8');
      expect(loadSettings(path).overageBufferPct).toBe(50);
      writeFileSync(path, JSON.stringify({ overageBufferPct: 12.7 }), 'utf-8');
      expect(loadSettings(path).overageBufferPct).toBe(12);
    });

    it('rejects overageBufferPct outside [0, 50] or non-numeric', () => {
      for (const bad of [-1, 51, 100, NaN, 'twenty', null, {}]) {
        writeFileSync(path, JSON.stringify({ overageBufferPct: bad }), 'utf-8');
        expect(loadSettings(path).overageBufferPct).toBe(DEFAULT_SETTINGS.overageBufferPct);
      }
    });

    it('accepts telemetryRetentionDays in [1, 365] and clamps the rest to default', () => {
      writeFileSync(path, JSON.stringify({ telemetryRetentionDays: 60 }), 'utf-8');
      expect(loadSettings(path).telemetryRetentionDays).toBe(60);
      writeFileSync(path, JSON.stringify({ telemetryRetentionDays: 0 }), 'utf-8');
      expect(loadSettings(path).telemetryRetentionDays).toBe(DEFAULT_SETTINGS.telemetryRetentionDays);
      writeFileSync(path, JSON.stringify({ telemetryRetentionDays: 500 }), 'utf-8');
      expect(loadSettings(path).telemetryRetentionDays).toBe(DEFAULT_SETTINGS.telemetryRetentionDays);
      writeFileSync(path, JSON.stringify({ telemetryRetentionDays: 'month' }), 'utf-8');
      expect(loadSettings(path).telemetryRetentionDays).toBe(DEFAULT_SETTINGS.telemetryRetentionDays);
    });

    it('defaults securitySetupCompleted and tourCompleted to false', () => {
      writeFileSync(path, JSON.stringify({}), 'utf-8');
      const loaded = loadSettings(path);
      expect(loaded.securitySetupCompleted).toBe(false);
      expect(loaded.tourCompleted).toBe(false);
    });

    it('round-trips securitySetupCompleted/tourCompleted and rejects non-boolean input', () => {
      writeFileSync(path, JSON.stringify({ securitySetupCompleted: true, tourCompleted: true }), 'utf-8');
      const loaded = loadSettings(path);
      expect(loaded.securitySetupCompleted).toBe(true);
      expect(loaded.tourCompleted).toBe(true);

      writeFileSync(path, JSON.stringify({ securitySetupCompleted: 'yes', tourCompleted: 1 }), 'utf-8');
      const bad = loadSettings(path);
      expect(bad.securitySetupCompleted).toBe(DEFAULT_SETTINGS.securitySetupCompleted);
      expect(bad.tourCompleted).toBe(DEFAULT_SETTINGS.tourCompleted);
    });
  });

  describe('saveSettings', () => {
    it('writes valid JSON that loadSettings can read back', () => {
      const wanted = {
        ...DEFAULT_SETTINGS,
        launchAtLogin: false,
        switchingMode: 'round-robin' as const,
        alertSoundName: 'Glass',
        autoUpdate: true,
        poolExcludedIds: [],
      };
      saveSettings(wanted, path);
      expect(existsSync(path)).toBe(true);
      expect(loadSettings(path)).toEqual(wanted);
    });

    it('creates the parent directory if needed', () => {
      const nested = join(tmpdir(), `sentinel-nested-${Date.now()}`, 'sub', 'settings.json');
      try {
        saveSettings(DEFAULT_SETTINGS, nested);
        expect(existsSync(nested)).toBe(true);
      } finally {
        rmSync(join(nested, '..', '..'), { recursive: true, force: true });
      }
    });

    it('writes human-readable JSON with a trailing newline', () => {
      saveSettings(DEFAULT_SETTINGS, path);
      const contents = readFileSync(path, 'utf-8');
      expect(contents.endsWith('\n')).toBe(true);
      expect(contents).toContain('"launchAtLogin"');
    });
  });

  describe('updateSettings', () => {
    it('merges a partial into the current settings', () => {
      saveSettings(DEFAULT_SETTINGS, path);
      const got = updateSettings({ launchAtLogin: false }, path);
      expect(got.launchAtLogin).toBe(false);
      expect(got.switchingMode).toBe(DEFAULT_SETTINGS.switchingMode);
    });

    it('starts from defaults when no file exists', () => {
      const got = updateSettings({ switchingMode: 'round-robin' }, path);
      expect(got.switchingMode).toBe('round-robin');
      expect(got.launchAtLogin).toBe(DEFAULT_SETTINGS.launchAtLogin);
    });

    it('rejects invalid values in the patch (coerce keeps prior state)', () => {
      saveSettings(DEFAULT_SETTINGS, path);
      const got = updateSettings({ switchingMode: 'nonsense' as unknown as 'off' }, path);
      expect(got.switchingMode).toBe(DEFAULT_SETTINGS.switchingMode);
    });

    it('persists across calls', () => {
      updateSettings({ launchAtLogin: false }, path);
      updateSettings({ switchingMode: 'round-robin' }, path);
      const got = loadSettings(path);
      expect(got.launchAtLogin).toBe(false);
      expect(got.switchingMode).toBe('round-robin');
    });

    it('round-trips the autoUpdate toggle', () => {
      const on = updateSettings({ autoUpdate: true }, path);
      expect(on.autoUpdate).toBe(true);
      expect(loadSettings(path).autoUpdate).toBe(true);
      const off = updateSettings({ autoUpdate: false }, path);
      expect(off.autoUpdate).toBe(false);
    });
  });
});
