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
        autoSwitchThresholdPct: 200,
      }), 'utf-8');
      const got = loadSettings(path);
      expect(got.launchAtLogin).toBe(false);
      expect(got.switchingMode).toBe(DEFAULT_SETTINGS.switchingMode);
      expect(got.autoSwitchThresholdPct).toBe(DEFAULT_SETTINGS.autoSwitchThresholdPct);
    });

    it('accepts all three valid switchingMode values', () => {
      for (const mode of ['off', 'auto-switch', 'round-robin'] as const) {
        writeFileSync(path, JSON.stringify({ ...DEFAULT_SETTINGS, switchingMode: mode }), 'utf-8');
        expect(loadSettings(path).switchingMode).toBe(mode);
      }
    });

    it('clamps autoSwitchThresholdPct outside [1,99] back to default', () => {
      writeFileSync(path, JSON.stringify({ autoSwitchThresholdPct: 0 }), 'utf-8');
      expect(loadSettings(path).autoSwitchThresholdPct).toBe(DEFAULT_SETTINGS.autoSwitchThresholdPct);
      writeFileSync(path, JSON.stringify({ autoSwitchThresholdPct: 100 }), 'utf-8');
      expect(loadSettings(path).autoSwitchThresholdPct).toBe(DEFAULT_SETTINGS.autoSwitchThresholdPct);
    });

    it('floors fractional thresholds', () => {
      writeFileSync(path, JSON.stringify({ autoSwitchThresholdPct: 75.7 }), 'utf-8');
      expect(loadSettings(path).autoSwitchThresholdPct).toBe(75);
    });
  });

  describe('saveSettings', () => {
    it('writes valid JSON that loadSettings can read back', () => {
      const wanted = { launchAtLogin: false, switchingMode: 'auto-switch' as const, autoSwitchThresholdPct: 75, alertSoundName: 'Glass' };
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
      updateSettings({ autoSwitchThresholdPct: 70 }, path);
      const got = loadSettings(path);
      expect(got.launchAtLogin).toBe(false);
      expect(got.autoSwitchThresholdPct).toBe(70);
    });
  });
});
