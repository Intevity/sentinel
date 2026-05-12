import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import {
  loadSettings,
  saveSettings,
  updateSettings,
  resolveSecurityContextWindow,
  DEFAULT_SETTINGS,
} from './settings.js';
import { signSettings, resetSettingsHmacKeyCache } from './settings-integrity.js';

function tempSettingsPath(): string {
  const dir = join(
    tmpdir(),
    `sentinel-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return join(dir, 'settings.json');
}

/** Write `contents` to `path` AND a valid `.sig` next to it, using the
 *  installation HMAC key. Most tests in this file want to seed a specific
 *  raw JSON shape (valid Settings, malformed JSON, partial fields) and
 *  then call `loadSettings` — they need the sidecar to be valid so the
 *  HMAC check doesn't redirect them to DEFAULT_SETTINGS.
 *
 *  Mirrors `saveSettings`'s 0o600 chmod so the loose-mode check in
 *  `loadSettingsWithTamper` doesn't trip on the umask-default 0o644
 *  modes that `writeFileSync` produces.
 *
 *  Accepts (and ignores) a trailing encoding arg so it can be a drop-in
 *  for `writeFileSync(p, contents, 'utf-8')` call sites. */
function writeRawWithSig(p: string, contents: string, _encoding?: BufferEncoding): void {
  writeFileSync(p, contents, 'utf-8');
  writeFileSync(`${p}.sig`, signSettings(contents), 'utf-8');
  if (process.platform !== 'win32') {
    chmodSync(p, 0o600);
    chmodSync(`${p}.sig`, 0o600);
  }
}

let keychainTmp: string;

describe('settings', () => {
  let path: string;

  beforeAll(() => {
    // Route HMAC key reads/writes to a temp JSON file instead of the OS
    // keychain so test runs don't pollute the developer's real keychain.
    // One keychain file shared across the whole suite — the in-process
    // cache then sees the same key on every test.
    keychainTmp = join(
      tmpdir(),
      `sentinel-settings-test-keychain-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE = keychainTmp;
    resetSettingsHmacKeyCache();
  });

  afterAll(() => {
    delete process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE;
    if (existsSync(keychainTmp)) rmSync(keychainTmp);
    resetSettingsHmacKeyCache();
  });

  beforeEach(() => {
    path = tempSettingsPath();
  });
  afterEach(() => {
    const dir = join(path, '..');
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  describe('loadSettings', () => {
    // The otelServiceInstanceId default is auto-generated on every load when
    // the persisted value is missing or invalid, so it's deliberately
    // non-deterministic. Substitute the loaded value into the expected
    // shape before equality-checking the rest.
    const expectDefaultsWithGeneratedId = (loaded: ReturnType<typeof loadSettings>): void => {
      expect(loaded).toEqual({
        ...DEFAULT_SETTINGS,
        otelServiceInstanceId: loaded.otelServiceInstanceId,
      });
    };

    it('returns defaults when the file does not exist', () => {
      expectDefaultsWithGeneratedId(loadSettings(path));
    });

    it('returns defaults when the file is unparseable', () => {
      writeRawWithSig(path, 'not json at all', 'utf-8');
      expectDefaultsWithGeneratedId(loadSettings(path));
    });

    it('returns defaults when the file contains a non-object', () => {
      writeRawWithSig(path, '"a string"', 'utf-8');
      expectDefaultsWithGeneratedId(loadSettings(path));
    });

    it('preserves valid fields and backfills invalid ones with defaults', () => {
      writeRawWithSig(
        path,
        JSON.stringify({
          launchAtLogin: false,
          switchingMode: 'bogus-mode',
        }),
      );
      const got = loadSettings(path);
      expect(got.launchAtLogin).toBe(false);
      expect(got.switchingMode).toBe(DEFAULT_SETTINGS.switchingMode);
    });

    it('accepts both valid switchingMode values', () => {
      for (const mode of ['off', 'round-robin'] as const) {
        writeRawWithSig(
          path,
          JSON.stringify({ ...DEFAULT_SETTINGS, switchingMode: mode }),
          'utf-8',
        );
        expect(loadSettings(path).switchingMode).toBe(mode);
      }
    });

    it('rejects the retired "auto-switch" mode, falling back to default', () => {
      writeRawWithSig(path, JSON.stringify({ switchingMode: 'auto-switch' }), 'utf-8');
      expect(loadSettings(path).switchingMode).toBe(DEFAULT_SETTINGS.switchingMode);
    });

    it('defaults roundRobinStrategy to "balance"', () => {
      expect(loadSettings(path).roundRobinStrategy).toBe('balance');
    });

    it('accepts both valid roundRobinStrategy values', () => {
      for (const strategy of ['balance', 'earliest-reset'] as const) {
        writeRawWithSig(
          path,
          JSON.stringify({ ...DEFAULT_SETTINGS, roundRobinStrategy: strategy }),
        );
        expect(loadSettings(path).roundRobinStrategy).toBe(strategy);
      }
    });

    it('falls back to default roundRobinStrategy when the value is garbage', () => {
      writeRawWithSig(path, JSON.stringify({ roundRobinStrategy: 'other' }), 'utf-8');
      expect(loadSettings(path).roundRobinStrategy).toBe(DEFAULT_SETTINGS.roundRobinStrategy);
      writeRawWithSig(path, JSON.stringify({ roundRobinStrategy: 42 }), 'utf-8');
      expect(loadSettings(path).roundRobinStrategy).toBe(DEFAULT_SETTINGS.roundRobinStrategy);
    });

    it('accepts all valid logLevel values', () => {
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        writeRawWithSig(path, JSON.stringify({ ...DEFAULT_SETTINGS, logLevel: level }), 'utf-8');
        expect(loadSettings(path).logLevel).toBe(level);
      }
    });

    it('falls back to default logLevel when the value is garbage', () => {
      writeRawWithSig(path, JSON.stringify({ logLevel: 'verbose' }), 'utf-8');
      expect(loadSettings(path).logLevel).toBe(DEFAULT_SETTINGS.logLevel);
    });

    it('falls back to default logLevel when the value is not a string', () => {
      writeRawWithSig(path, JSON.stringify({ logLevel: 42 }), 'utf-8');
      expect(loadSettings(path).logLevel).toBe(DEFAULT_SETTINGS.logLevel);
    });

    it('defaults overageOsNotify to true when the file is missing', () => {
      expect(loadSettings(path).overageOsNotify).toBe(true);
    });

    it('round-trips overageOsNotify=false and rejects non-boolean input', () => {
      writeRawWithSig(path, JSON.stringify({ overageOsNotify: false }), 'utf-8');
      expect(loadSettings(path).overageOsNotify).toBe(false);
      writeRawWithSig(path, JSON.stringify({ overageOsNotify: 'nope' }), 'utf-8');
      expect(loadSettings(path).overageOsNotify).toBe(DEFAULT_SETTINGS.overageOsNotify);
    });

    it('accepts a boolean autoUpdate and ignores non-boolean values', () => {
      writeRawWithSig(path, JSON.stringify({ autoUpdate: true }), 'utf-8');
      expect(loadSettings(path).autoUpdate).toBe(true);
      writeRawWithSig(path, JSON.stringify({ autoUpdate: 'yes' }), 'utf-8');
      expect(loadSettings(path).autoUpdate).toBe(DEFAULT_SETTINGS.autoUpdate);
    });

    it('defaults autoUpdate to false when the file is missing', () => {
      expect(loadSettings(path).autoUpdate).toBe(false);
    });

    it('defaults overageEnabledIds to an empty array', () => {
      expect(loadSettings(path).overageEnabledIds).toEqual([]);
    });

    it('filters non-string entries out of overageEnabledIds', () => {
      writeRawWithSig(path, JSON.stringify({ overageEnabledIds: ['acc-1', 5, null, 'acc-2', {}] }));
      expect(loadSettings(path).overageEnabledIds).toEqual(['acc-1', 'acc-2']);
    });

    it('ignores a non-array overageEnabledIds value', () => {
      writeRawWithSig(path, JSON.stringify({ overageEnabledIds: 'acc-1' }), 'utf-8');
      expect(loadSettings(path).overageEnabledIds).toEqual(DEFAULT_SETTINGS.overageEnabledIds);
    });

    it('defaults budgetWeeklyUsdByAccount to an empty map', () => {
      expect(loadSettings(path).budgetWeeklyUsdByAccount).toEqual({});
    });

    it('accepts a valid budgetWeeklyUsdByAccount and drops invalid entries', () => {
      writeRawWithSig(
        path,
        JSON.stringify({
          budgetWeeklyUsdByAccount: {
            'acc-a': 10,
            'acc-b': -3, // negative — dropped
            'acc-c': 'not-a-number', // non-number — dropped
            'acc-d': Number.POSITIVE_INFINITY, // non-finite — dropped
            '': 7, // empty key — dropped
            'acc-e': 250_000, // clamped to 100_000
          },
        }),
      );
      expect(loadSettings(path).budgetWeeklyUsdByAccount).toEqual({
        'acc-a': 10,
        'acc-e': 100_000,
      });
    });

    it('ignores a non-object budgetWeeklyUsdByAccount value', () => {
      writeRawWithSig(path, JSON.stringify({ budgetWeeklyUsdByAccount: [1, 2] }), 'utf-8');
      expect(loadSettings(path).budgetWeeklyUsdByAccount).toEqual({});
    });

    it('defaults budgetWeeklyUsdGlobal to null', () => {
      expect(loadSettings(path).budgetWeeklyUsdGlobal).toBe(null);
    });

    it('accepts a valid budgetWeeklyUsdGlobal and clamps above 100000', () => {
      writeRawWithSig(path, JSON.stringify({ budgetWeeklyUsdGlobal: 42 }), 'utf-8');
      expect(loadSettings(path).budgetWeeklyUsdGlobal).toBe(42);
      writeRawWithSig(path, JSON.stringify({ budgetWeeklyUsdGlobal: 250_000 }), 'utf-8');
      expect(loadSettings(path).budgetWeeklyUsdGlobal).toBe(100_000);
      writeRawWithSig(path, JSON.stringify({ budgetWeeklyUsdGlobal: null }), 'utf-8');
      expect(loadSettings(path).budgetWeeklyUsdGlobal).toBe(null);
    });

    it('rejects an invalid budgetWeeklyUsdGlobal (negative, NaN, string)', () => {
      writeRawWithSig(path, JSON.stringify({ budgetWeeklyUsdGlobal: -1 }), 'utf-8');
      expect(loadSettings(path).budgetWeeklyUsdGlobal).toBe(DEFAULT_SETTINGS.budgetWeeklyUsdGlobal);
      writeRawWithSig(path, JSON.stringify({ budgetWeeklyUsdGlobal: 'fifty' }), 'utf-8');
      expect(loadSettings(path).budgetWeeklyUsdGlobal).toBe(DEFAULT_SETTINGS.budgetWeeklyUsdGlobal);
    });

    it('defaults overageBufferPct to 5', () => {
      expect(loadSettings(path).overageBufferPct).toBe(5);
    });

    it('accepts overageBufferPct in [0, 50] and floors fractionals', () => {
      writeRawWithSig(path, JSON.stringify({ overageBufferPct: 0 }), 'utf-8');
      expect(loadSettings(path).overageBufferPct).toBe(0);
      writeRawWithSig(path, JSON.stringify({ overageBufferPct: 25 }), 'utf-8');
      expect(loadSettings(path).overageBufferPct).toBe(25);
      writeRawWithSig(path, JSON.stringify({ overageBufferPct: 50 }), 'utf-8');
      expect(loadSettings(path).overageBufferPct).toBe(50);
      writeRawWithSig(path, JSON.stringify({ overageBufferPct: 12.7 }), 'utf-8');
      expect(loadSettings(path).overageBufferPct).toBe(12);
    });

    it('rejects overageBufferPct outside [0, 50] or non-numeric', () => {
      for (const bad of [-1, 51, 100, NaN, 'twenty', null, {}]) {
        writeRawWithSig(path, JSON.stringify({ overageBufferPct: bad }), 'utf-8');
        expect(loadSettings(path).overageBufferPct).toBe(DEFAULT_SETTINGS.overageBufferPct);
      }
    });

    it('accepts telemetryRetentionDays in [1, 365] and clamps the rest to default', () => {
      writeRawWithSig(path, JSON.stringify({ telemetryRetentionDays: 60 }), 'utf-8');
      expect(loadSettings(path).telemetryRetentionDays).toBe(60);
      writeRawWithSig(path, JSON.stringify({ telemetryRetentionDays: 0 }), 'utf-8');
      expect(loadSettings(path).telemetryRetentionDays).toBe(
        DEFAULT_SETTINGS.telemetryRetentionDays,
      );
      writeRawWithSig(path, JSON.stringify({ telemetryRetentionDays: 500 }), 'utf-8');
      expect(loadSettings(path).telemetryRetentionDays).toBe(
        DEFAULT_SETTINGS.telemetryRetentionDays,
      );
      writeRawWithSig(path, JSON.stringify({ telemetryRetentionDays: 'month' }), 'utf-8');
      expect(loadSettings(path).telemetryRetentionDays).toBe(
        DEFAULT_SETTINGS.telemetryRetentionDays,
      );
    });

    it('defaults securitySetupCompleted and tourCompleted to false', () => {
      writeRawWithSig(path, JSON.stringify({}), 'utf-8');
      const loaded = loadSettings(path);
      expect(loaded.securitySetupCompleted).toBe(false);
      expect(loaded.tourCompleted).toBe(false);
    });

    it('defaults toolPermissionResolveSymlinks to false', () => {
      writeRawWithSig(path, JSON.stringify({}), 'utf-8');
      expect(loadSettings(path).toolPermissionResolveSymlinks).toBe(false);
    });

    it('round-trips toolPermissionResolveSymlinks=true and rejects non-boolean input', () => {
      writeRawWithSig(path, JSON.stringify({ toolPermissionResolveSymlinks: true }));
      expect(loadSettings(path).toolPermissionResolveSymlinks).toBe(true);
      writeRawWithSig(path, JSON.stringify({ toolPermissionResolveSymlinks: 'yes' }));
      expect(loadSettings(path).toolPermissionResolveSymlinks).toBe(
        DEFAULT_SETTINGS.toolPermissionResolveSymlinks,
      );
      writeRawWithSig(path, JSON.stringify({ toolPermissionResolveSymlinks: 1 }));
      expect(loadSettings(path).toolPermissionResolveSymlinks).toBe(
        DEFAULT_SETTINGS.toolPermissionResolveSymlinks,
      );
    });

    it('round-trips securitySetupCompleted/tourCompleted and rejects non-boolean input', () => {
      writeRawWithSig(path, JSON.stringify({ securitySetupCompleted: true, tourCompleted: true }));
      const loaded = loadSettings(path);
      expect(loaded.securitySetupCompleted).toBe(true);
      expect(loaded.tourCompleted).toBe(true);

      writeRawWithSig(path, JSON.stringify({ securitySetupCompleted: 'yes', tourCompleted: 1 }));
      const bad = loadSettings(path);
      expect(bad.securitySetupCompleted).toBe(DEFAULT_SETTINGS.securitySetupCompleted);
      expect(bad.tourCompleted).toBe(DEFAULT_SETTINGS.tourCompleted);
    });

    it('OTEL: defaults the forwarding fields to off/null/signoz on a fresh install', () => {
      const got = loadSettings(path);
      expect(got.otelForwardingEnabled).toBe(false);
      expect(got.otelForwardMetrics).toBe(true);
      expect(got.otelForwardLogs).toBe(true);
      expect(got.otelEmitSentinelMetrics).toBe(true);
      expect(got.otelExporterEndpoint).toBe(null);
      expect(got.otelExporterHeaderName).toBe('signoz-ingestion-key');
    });

    it('OTEL: accepts an https endpoint and strips trailing slashes', () => {
      writeRawWithSig(
        path,
        JSON.stringify({ otelExporterEndpoint: 'https://ingest.us2.signoz.cloud:443/' }),
      );
      expect(loadSettings(path).otelExporterEndpoint).toBe('https://ingest.us2.signoz.cloud:443');
    });

    it('OTEL: accepts http on loopback (localhost / 127.0.0.1)', () => {
      writeRawWithSig(path, JSON.stringify({ otelExporterEndpoint: 'http://localhost:4318' }));
      expect(loadSettings(path).otelExporterEndpoint).toBe('http://localhost:4318');
      writeRawWithSig(path, JSON.stringify({ otelExporterEndpoint: 'http://127.0.0.1:4318' }));
      expect(loadSettings(path).otelExporterEndpoint).toBe('http://127.0.0.1:4318');
    });

    it('OTEL: rejects http to a non-loopback host (TLS-required gate)', () => {
      writeRawWithSig(path, JSON.stringify({ otelExporterEndpoint: 'http://example.com:4318' }));
      expect(loadSettings(path).otelExporterEndpoint).toBe(DEFAULT_SETTINGS.otelExporterEndpoint);
    });

    it('OTEL: rejects malformed URLs', () => {
      writeRawWithSig(path, JSON.stringify({ otelExporterEndpoint: 'not a url' }));
      expect(loadSettings(path).otelExporterEndpoint).toBe(DEFAULT_SETTINGS.otelExporterEndpoint);
    });

    it('OTEL: empty endpoint string maps to null', () => {
      writeRawWithSig(path, JSON.stringify({ otelExporterEndpoint: '' }));
      expect(loadSettings(path).otelExporterEndpoint).toBe(null);
    });

    it('OTEL: header name accepts RFC 7230 tokens', () => {
      writeRawWithSig(path, JSON.stringify({ otelExporterHeaderName: 'x-honeycomb-team' }));
      expect(loadSettings(path).otelExporterHeaderName).toBe('x-honeycomb-team');
    });

    it('OTEL: header name rejects invalid characters and falls back to default', () => {
      writeRawWithSig(path, JSON.stringify({ otelExporterHeaderName: 'has spaces' }));
      expect(loadSettings(path).otelExporterHeaderName).toBe(
        DEFAULT_SETTINGS.otelExporterHeaderName,
      );
    });

    it('OTEL: empty header name resets to the default rather than wiping', () => {
      writeRawWithSig(path, JSON.stringify({ otelExporterHeaderName: '' }));
      expect(loadSettings(path).otelExporterHeaderName).toBe(
        DEFAULT_SETTINGS.otelExporterHeaderName,
      );
    });

    it('OTEL: round-trips the boolean toggles', () => {
      writeRawWithSig(
        path,
        JSON.stringify({
          otelForwardingEnabled: true,
          otelForwardMetrics: false,
          otelForwardLogs: false,
          otelEmitSentinelMetrics: false,
        }),
      );
      const got = loadSettings(path);
      expect(got.otelForwardingEnabled).toBe(true);
      expect(got.otelForwardMetrics).toBe(false);
      expect(got.otelForwardLogs).toBe(false);
      expect(got.otelEmitSentinelMetrics).toBe(false);
    });

    it('OTEL: otelServiceInstanceId is generated when missing, with a UUID v4 shape', () => {
      // Empty file → coerce mints a fresh UUID.
      const got = loadSettings(path);
      expect(got.otelServiceInstanceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('OTEL: otelServiceInstanceId round-trips a valid UUID v4 verbatim', () => {
      const uuid = '12345678-90ab-4cde-8f01-234567890abc';
      writeRawWithSig(path, JSON.stringify({ otelServiceInstanceId: uuid }));
      expect(loadSettings(path).otelServiceInstanceId).toBe(uuid);
    });

    it('OTEL: otelServiceInstanceId regenerates on a malformed value', () => {
      writeRawWithSig(path, JSON.stringify({ otelServiceInstanceId: 'not-a-uuid' }));
      const got = loadSettings(path);
      expect(got.otelServiceInstanceId).not.toBe('not-a-uuid');
      expect(got.otelServiceInstanceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('OTEL: otelServiceInstanceId regenerates on an empty string', () => {
      writeRawWithSig(path, JSON.stringify({ otelServiceInstanceId: '' }));
      const got = loadSettings(path);
      expect(got.otelServiceInstanceId).not.toBe('');
      expect(got.otelServiceInstanceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('OTEL: otelServiceInstanceId rejects a non-v4 UUID (wrong version nibble)', () => {
      // v1-shaped UUID — version nibble is 1, not 4. coerce should regen.
      const v1 = '11111111-1111-1111-8111-111111111111';
      writeRawWithSig(path, JSON.stringify({ otelServiceInstanceId: v1 }));
      const got = loadSettings(path);
      expect(got.otelServiceInstanceId).not.toBe(v1);
      expect(got.otelServiceInstanceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
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
        // Persist a valid UUID so loadSettings preserves it verbatim;
        // DEFAULT_SETTINGS' empty-string sentinel would be regenerated
        // by coerce on load and break the round-trip equality check.
        otelServiceInstanceId: '12345678-90ab-4cde-8f01-234567890abc',
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

    it('Sprint 9: validates daemonHealthFailMode and rejects unknown values', () => {
      saveSettings(DEFAULT_SETTINGS, path);
      const closedMode = updateSettings({ daemonHealthFailMode: 'closed' }, path);
      expect(closedMode.daemonHealthFailMode).toBe('closed');
      const openMode = updateSettings({ daemonHealthFailMode: 'open' }, path);
      expect(openMode.daemonHealthFailMode).toBe('open');
      // Coerce drops unknown strings; the result reverts to the
      // DEFAULT_SETTINGS value (the per-field fallback in coerce).
      const badMode = updateSettings({ daemonHealthFailMode: 'meow' as unknown as 'open' }, path);
      expect(badMode.daemonHealthFailMode).toBe(DEFAULT_SETTINGS.daemonHealthFailMode);
    });

    it('Sprint 9: round-trips the webhook URL and rejects non-http(s) schemes', () => {
      saveSettings(DEFAULT_SETTINGS, path);
      const ok = updateSettings({ securityWebhookUrl: 'https://hooks.example.com/sentinel' }, path);
      expect(ok.securityWebhookUrl).toBe('https://hooks.example.com/sentinel');
      // Empty string also clears (UI sentinel for "off").
      const cleared = updateSettings({ securityWebhookUrl: '' }, path);
      expect(cleared.securityWebhookUrl).toBe(null);
      const httpOk = updateSettings({ securityWebhookUrl: 'http://localhost:9999/sink' }, path);
      expect(httpOk.securityWebhookUrl).toBe('http://localhost:9999/sink');
      // Non-http(s) drops the field; coerce reverts to default null.
      const ftpRejected = updateSettings({ securityWebhookUrl: 'ftp://nope.example' }, path);
      expect(ftpRejected.securityWebhookUrl).toBe(null);
      // Malformed URL also drops to default.
      const malformedRejected = updateSettings({ securityWebhookUrl: 'not-a-url' }, path);
      expect(malformedRejected.securityWebhookUrl).toBe(null);
      // Explicit null is honored.
      const nulled = updateSettings({ securityWebhookUrl: null }, path);
      expect(nulled.securityWebhookUrl).toBe(null);
    });

    it('Sprint 9: webhook secret + severity floor coerce', () => {
      saveSettings(DEFAULT_SETTINGS, path);
      const set = updateSettings(
        { securityWebhookSecret: 'shh', securityWebhookSeverityFloor: 'medium' },
        path,
      );
      expect(set.securityWebhookSecret).toBe('shh');
      expect(set.securityWebhookSeverityFloor).toBe('medium');
      // Empty-string secret coerces to null.
      const cleared = updateSettings({ securityWebhookSecret: '' }, path);
      expect(cleared.securityWebhookSecret).toBe(null);
      // Unknown floor reverts to default 'high'.
      const bogus = updateSettings(
        { securityWebhookSeverityFloor: 'critical' as unknown as 'high' },
        path,
      );
      expect(bogus.securityWebhookSeverityFloor).toBe(
        DEFAULT_SETTINGS.securityWebhookSeverityFloor,
      );
      // Explicit null on the secret clears.
      const nulled = updateSettings({ securityWebhookSecret: null }, path);
      expect(nulled.securityWebhookSecret).toBe(null);
    });

    it('persists across calls', () => {
      updateSettings({ launchAtLogin: false }, path);
      updateSettings({ switchingMode: 'round-robin' }, path);
      const got = loadSettings(path);
      expect(got.launchAtLogin).toBe(false);
      expect(got.switchingMode).toBe('round-robin');
    });

    it('round-trips securityContextVerbosity and coerces unknown values to the default', () => {
      saveSettings(DEFAULT_SETTINGS, path);
      // Default lives at 'standard'.
      expect(loadSettings(path).securityContextVerbosity).toBe('standard');
      const verbose = updateSettings({ securityContextVerbosity: 'verbose' }, path);
      expect(verbose.securityContextVerbosity).toBe('verbose');
      expect(loadSettings(path).securityContextVerbosity).toBe('verbose');
      const compact = updateSettings({ securityContextVerbosity: 'compact' }, path);
      expect(compact.securityContextVerbosity).toBe('compact');
      // Unknown string drops in coerce; reverts to DEFAULT_SETTINGS value,
      // matching how every other enum field behaves (see daemonHealthFailMode
      // test above).
      const bogus = updateSettings(
        { securityContextVerbosity: 'forensic' as unknown as 'verbose' },
        path,
      );
      expect(bogus.securityContextVerbosity).toBe(DEFAULT_SETTINGS.securityContextVerbosity);
    });

    it('resolveSecurityContextWindow returns 0 when securityPersistSnippet is off, regardless of verbosity', () => {
      expect(
        resolveSecurityContextWindow({
          ...DEFAULT_SETTINGS,
          securityPersistSnippet: false,
          securityContextVerbosity: 'verbose',
        }),
      ).toBe(0);
    });

    it('resolveSecurityContextWindow maps each verbosity preset to its char-per-side window', () => {
      const base = { ...DEFAULT_SETTINGS, securityPersistSnippet: true };
      expect(resolveSecurityContextWindow({ ...base, securityContextVerbosity: 'compact' })).toBe(
        40,
      );
      expect(resolveSecurityContextWindow({ ...base, securityContextVerbosity: 'standard' })).toBe(
        200,
      );
      expect(resolveSecurityContextWindow({ ...base, securityContextVerbosity: 'verbose' })).toBe(
        800,
      );
    });

    it('round-trips the autoUpdate toggle', () => {
      const on = updateSettings({ autoUpdate: true }, path);
      expect(on.autoUpdate).toBe(true);
      expect(loadSettings(path).autoUpdate).toBe(true);
      const off = updateSettings({ autoUpdate: false }, path);
      expect(off.autoUpdate).toBe(false);
    });

    it('defaults alternateApiUrl to null', () => {
      expect(loadSettings(path).alternateApiUrl).toBe(null);
    });

    it('round-trips alternateApiUrl and strips trailing path/query/hash to origin', () => {
      saveSettings(DEFAULT_SETTINGS, path);
      const ok = updateSettings({ alternateApiUrl: 'https://router.example.com' }, path);
      expect(ok.alternateApiUrl).toBe('https://router.example.com');
      // Origin-only: path/query/hash are stripped on save.
      const stripped = updateSettings(
        { alternateApiUrl: 'https://router.example.com/foo/bar?q=1#frag' },
        path,
      );
      expect(stripped.alternateApiUrl).toBe('https://router.example.com');
      // http origins are accepted (loopback / lab use cases).
      const httpOk = updateSettings({ alternateApiUrl: 'http://localhost:8080' }, path);
      expect(httpOk.alternateApiUrl).toBe('http://localhost:8080');
      // Empty string clears the setting (UI sentinel).
      const cleared = updateSettings({ alternateApiUrl: '' }, path);
      expect(cleared.alternateApiUrl).toBe(null);
      // Whitespace-only also clears.
      const ws = updateSettings({ alternateApiUrl: '   ' }, path);
      expect(ws.alternateApiUrl).toBe(null);
      // Non-http(s) protocols are dropped (coerce reverts to default null).
      saveSettings(DEFAULT_SETTINGS, path);
      const ftp = updateSettings({ alternateApiUrl: 'ftp://nope.example' }, path);
      expect(ftp.alternateApiUrl).toBe(null);
      // Malformed strings are dropped.
      saveSettings(DEFAULT_SETTINGS, path);
      const garbage = updateSettings({ alternateApiUrl: 'not a url' }, path);
      expect(garbage.alternateApiUrl).toBe(null);
      // Explicit null is honored.
      const nulled = updateSettings({ alternateApiUrl: null }, path);
      expect(nulled.alternateApiUrl).toBe(null);
    });

    it('accepts a well-formed lastScanBenchmark payload', () => {
      // Valid payload — every field passes the shape check, gets persisted.
      const goodUpdate = updateSettings(
        {
          lastScanBenchmark: {
            results: [{ sizeMb: 1, meanMs: 2, p99Ms: 3 }],
            recommendedMb: 4,
            ranAt: 1_700_000_000,
            platform: 'darwin-arm64',
          } as unknown as import('@claude-sentinel/shared').Settings['lastScanBenchmark'],
        },
        path,
      );
      expect(goodUpdate.lastScanBenchmark).not.toBeNull();
      expect(goodUpdate.lastScanBenchmark?.recommendedMb).toBe(4);
      expect(goodUpdate.lastScanBenchmark?.results).toHaveLength(1);
    });

    it('silently drops a malformed lastScanBenchmark payload', () => {
      const bad = updateSettings(
        {
          lastScanBenchmark: {
            results: 'not-an-array',
            recommendedMb: 999,
            ranAt: 'nope',
            platform: 42,
          } as unknown as import('@claude-sentinel/shared').Settings['lastScanBenchmark'],
        },
        path,
      );
      // The malformed fields fail the shape check → value stays at its default.
      expect(bad.lastScanBenchmark).toBeNull();
    });

    it('accepts an explicit null to clear lastScanBenchmark', () => {
      const cleared = updateSettings({ lastScanBenchmark: null }, path);
      expect(cleared.lastScanBenchmark).toBeNull();
    });

    it('defaults optimizeChartView to "realized"', () => {
      expect(DEFAULT_SETTINGS.optimizeChartView).toBe('realized');
      expect(loadSettings(path).optimizeChartView).toBe('realized');
    });

    it('round-trips every valid optimizeChartView value', () => {
      for (const view of [
        'realized',
        'bySubagent',
        'comparison',
        'cumulative',
        'byPattern',
      ] as const) {
        writeRawWithSig(path, JSON.stringify({ ...DEFAULT_SETTINGS, optimizeChartView: view }));
        expect(loadSettings(path).optimizeChartView).toBe(view);
      }
    });

    it('falls back to default optimizeChartView when the value is unknown', () => {
      writeRawWithSig(path, JSON.stringify({ optimizeChartView: 'rainbow' }));
      expect(loadSettings(path).optimizeChartView).toBe('realized');
    });

    it('falls back to default optimizeChartView when the value is not a string', () => {
      writeRawWithSig(path, JSON.stringify({ optimizeChartView: 7 }));
      expect(loadSettings(path).optimizeChartView).toBe('realized');
    });

    it('updateSettings persists a new optimizeChartView selection', () => {
      const next = updateSettings({ optimizeChartView: 'cumulative' }, path);
      expect(next.optimizeChartView).toBe('cumulative');
      // Loading the file back proves it was persisted, not just returned.
      expect(loadSettings(path).optimizeChartView).toBe('cumulative');
    });
  });
});
