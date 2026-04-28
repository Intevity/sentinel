/**
 * Sprint 2 anti-tamper: settings-file HMAC integrity.
 *
 * Tests cover the pure helpers in `settings-integrity.ts` plus their
 * integration with `settings.ts` (load + save round-trip, sidecar shape,
 * mode 0600 enforcement, every tamper-detection branch).
 *
 * All keychain reads/writes route through the
 * `CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE` JSON-file seam so the developer's
 * real keychain is never touched. The cache in `settings-integrity.ts` is
 * reset between tests where it matters (key rotation, fresh-install
 * scenarios) via `clearSettingsHmacKey()` /
 * `resetSettingsHmacKeyCache()`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearSettingsHmacKey,
  getOrCreateSettingsHmacKey,
  resetSettingsHmacKeyCache,
  signSettings,
  verifySettings,
} from './settings-integrity.js';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  loadSettingsWithTamper,
  saveSettings,
} from './settings.js';

let keychainPath: string;
let workDir: string;

beforeAll(() => {
  keychainPath = join(
    tmpdir(),
    `sentinel-integrity-test-keychain-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE = keychainPath;
});

afterAll(() => {
  delete process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE;
  if (existsSync(keychainPath)) rmSync(keychainPath);
  resetSettingsHmacKeyCache();
});

beforeEach(() => {
  workDir = join(
    tmpdir(),
    `sentinel-integrity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workDir, { recursive: true });
  // Fresh key per test so rotation/fresh-install tests don't leak state.
  clearSettingsHmacKey();
});

afterEach(() => {
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

describe('signSettings + verifySettings', () => {
  it('round-trips: signing then verifying the same bytes succeeds', () => {
    const bytes = '{"foo":"bar","n":1}';
    const sig = signSettings(bytes);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySettings(bytes, sig)).toBe(true);
  });

  it('rejects mutated bytes — single-byte flip is detected', () => {
    const bytes = '{"foo":"bar","n":1}';
    const sig = signSettings(bytes);
    const mutated = '{"foo":"BAR","n":1}'; // capital B
    expect(verifySettings(mutated, sig)).toBe(false);
  });

  it('rejects sig with wrong length', () => {
    const bytes = '{}';
    const sig = signSettings(bytes);
    expect(verifySettings(bytes, sig.slice(0, -2))).toBe(false);
  });

  it('rejects non-hex signature input', () => {
    expect(verifySettings('{}', 'not hex at all')).toBe(false);
  });

  it('rejects empty signature input', () => {
    expect(verifySettings('{}', '')).toBe(false);
  });

  it('verification with a different key fails (rotation)', () => {
    const bytes = '{"a":1}';
    const sig = signSettings(bytes);
    // Force key rotation: drop the current key, regenerate fresh.
    clearSettingsHmacKey();
    expect(verifySettings(bytes, sig)).toBe(false);
  });
});

describe('getOrCreateSettingsHmacKey', () => {
  it('returns the same buffer on repeated calls (in-process cache)', () => {
    const a = getOrCreateSettingsHmacKey();
    const b = getOrCreateSettingsHmacKey();
    expect(a.equals(b)).toBe(true);
  });

  it('persists the key to the test keychain file', () => {
    const key = getOrCreateSettingsHmacKey();
    // The keychain JSON layout is { service: { account: blob } }.
    const stored = JSON.parse(readFileSync(keychainPath, 'utf-8')) as Record<
      string,
      Record<string, string>
    >;
    expect(stored['Claude Sentinel-settings-hmac']?.['default']).toBe(key.toString('hex'));
  });

  it('generates exactly 32 bytes', () => {
    const key = getOrCreateSettingsHmacKey();
    expect(key.length).toBe(32);
  });

  it('after clear, generates a fresh key (different value with overwhelming probability)', () => {
    const k1 = Buffer.from(getOrCreateSettingsHmacKey());
    clearSettingsHmacKey();
    const k2 = Buffer.from(getOrCreateSettingsHmacKey());
    expect(k1.equals(k2)).toBe(false);
  });

  it('after resetSettingsHmacKeyCache (no clear), reads the persisted key from disk', () => {
    const k1 = Buffer.from(getOrCreateSettingsHmacKey());
    resetSettingsHmacKeyCache();
    const k2 = getOrCreateSettingsHmacKey();
    expect(k1.equals(k2)).toBe(true);
  });
});

describe('saveSettings + loadSettingsWithTamper integration', () => {
  it('writes both the JSON and the .sig sidecar with mode 0o600', () => {
    const path = join(workDir, 'settings.json');
    saveSettings({ ...DEFAULT_SETTINGS, autoUpdate: true }, path);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.sig`)).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(`${path}.sig`).mode & 0o777).toBe(0o600);
    }
  });

  it('loadSettingsWithTamper returns the round-tripped settings with tamperDetected=false', () => {
    const path = join(workDir, 'settings.json');
    saveSettings({ ...DEFAULT_SETTINGS, autoUpdate: true }, path);
    const result = loadSettingsWithTamper(path);
    expect(result.tamperDetected).toBe(false);
    expect(result.reason).toBe(null);
    expect(result.settings.autoUpdate).toBe(true);
  });

  it('absent file reads as fresh-install (NOT tamper)', () => {
    const path = join(workDir, 'never-written.json');
    const result = loadSettingsWithTamper(path);
    expect(result.tamperDetected).toBe(false);
    expect(result.reason).toBe(null);
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('detects sig_mismatch when the JSON is hand-corrupted', () => {
    const path = join(workDir, 'settings.json');
    saveSettings({ ...DEFAULT_SETTINGS }, path);
    // Tamper the file but leave the .sig alone.
    writeFileSync(path, '{"toolPermissionsEnabled":false}\n', 'utf-8');
    const result = loadSettingsWithTamper(path);
    expect(result.tamperDetected).toBe(true);
    expect(result.reason).toBe('sig_mismatch');
    // Critical: tampered toolPermissionsEnabled:false MUST NOT survive.
    expect(result.settings.toolPermissionsEnabled).toBe(DEFAULT_SETTINGS.toolPermissionsEnabled);
  });

  it('detects missing_sig when the sidecar is deleted', () => {
    const path = join(workDir, 'settings.json');
    saveSettings({ ...DEFAULT_SETTINGS }, path);
    unlinkSync(`${path}.sig`);
    const result = loadSettingsWithTamper(path);
    expect(result.tamperDetected).toBe(true);
    expect(result.reason).toBe('missing_sig');
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
  });

  it.skipIf(process.platform === 'win32')(
    'detects loose_mode when the file has group/other bits set',
    () => {
      const path = join(workDir, 'settings.json');
      saveSettings({ ...DEFAULT_SETTINGS, autoUpdate: true }, path);
      // Loosen: 0o644 has o+r and g+r set.
      chmodSync(path, 0o644);
      const result = loadSettingsWithTamper(path);
      expect(result.tamperDetected).toBe(true);
      expect(result.reason).toBe('loose_mode');
      // autoUpdate=true MUST NOT have been honoured because we never
      // even read the file.
      expect(result.settings.autoUpdate).toBe(DEFAULT_SETTINGS.autoUpdate);
    },
  );

  it('loadSettings (the silent fallback variant) returns DEFAULT_SETTINGS on tamper', () => {
    const path = join(workDir, 'settings.json');
    saveSettings({ ...DEFAULT_SETTINGS, autoUpdate: true }, path);
    writeFileSync(path, '{"autoUpdate":false}\n', 'utf-8'); // tamper without re-signing
    expect(loadSettings(path).autoUpdate).toBe(DEFAULT_SETTINGS.autoUpdate);
  });

  it('saving twice produces a valid pair the second time (idempotent re-sign)', () => {
    const path = join(workDir, 'settings.json');
    saveSettings({ ...DEFAULT_SETTINGS }, path);
    saveSettings({ ...DEFAULT_SETTINGS, autoUpdate: true }, path);
    const result = loadSettingsWithTamper(path);
    expect(result.tamperDetected).toBe(false);
    expect(result.settings.autoUpdate).toBe(true);
  });

  it('the .sig file content is exactly 64 lowercase hex chars', () => {
    const path = join(workDir, 'settings.json');
    saveSettings({ ...DEFAULT_SETTINGS }, path);
    const sig = readFileSync(`${path}.sig`, 'utf-8');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });
});
