import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  classifyDrift,
  parseOtlpHeaders,
  pickAuthHeader,
  maskSecret,
  buildPromotePreview,
  canonHashManagedEnv,
  inspectClaudeOtelConfig,
  type ObservedOtelEnv,
} from './otel-settings-drift.js';
import { SENTINEL_BASE_URL, isUrlSafeForForwarder } from './claude-otel-config.js';

const baseObserved = (overrides: Partial<ObservedOtelEnv> = {}): ObservedOtelEnv => ({
  endpoint: SENTINEL_BASE_URL,
  metricsEndpoint: null,
  logsEndpoint: null,
  telemetryEnabled: true,
  protocol: 'http/json',
  headers: null,
  baseUrl: SENTINEL_BASE_URL,
  ...overrides,
});

describe('classifyDrift', () => {
  it('returns ok for a clean Sentinel-pointed env', () => {
    expect(classifyDrift(baseObserved())).toBe('ok');
  });

  it('returns telemetry-disabled when CLAUDE_CODE_ENABLE_TELEMETRY is missing/0', () => {
    expect(classifyDrift(baseObserved({ telemetryEnabled: false }))).toBe('telemetry-disabled');
  });

  it('returns foreign-endpoint when the base endpoint points elsewhere', () => {
    expect(classifyDrift(baseObserved({ endpoint: 'https://api.honeycomb.io' }))).toBe(
      'foreign-endpoint',
    );
  });

  it('returns foreign-endpoint when the base endpoint is null', () => {
    expect(classifyDrift(baseObserved({ endpoint: null }))).toBe('foreign-endpoint');
  });

  it('returns foreign-endpoint when only the metrics-specific override drifts', () => {
    expect(classifyDrift(baseObserved({ metricsEndpoint: 'https://api.honeycomb.io' }))).toBe(
      'foreign-endpoint',
    );
  });

  it('returns foreign-endpoint when only the logs-specific override drifts', () => {
    expect(classifyDrift(baseObserved({ logsEndpoint: 'https://api.honeycomb.io' }))).toBe(
      'foreign-endpoint',
    );
  });

  it('treats telemetry-disabled as winning over foreign-endpoint', () => {
    expect(
      classifyDrift(
        baseObserved({
          telemetryEnabled: false,
          endpoint: 'https://api.honeycomb.io',
        }),
      ),
    ).toBe('telemetry-disabled');
  });

  it('accepts signal-specific endpoints that equal Sentinel as ok', () => {
    expect(
      classifyDrift(
        baseObserved({
          metricsEndpoint: SENTINEL_BASE_URL,
          logsEndpoint: SENTINEL_BASE_URL,
        }),
      ),
    ).toBe('ok');
  });
});

describe('parseOtlpHeaders', () => {
  it('returns [] for null/empty/whitespace', () => {
    expect(parseOtlpHeaders(null)).toEqual([]);
    expect(parseOtlpHeaders(undefined)).toEqual([]);
    expect(parseOtlpHeaders('')).toEqual([]);
    expect(parseOtlpHeaders('   ')).toEqual([]);
  });

  it('parses a single key=value', () => {
    expect(parseOtlpHeaders('x-api-key=abc')).toEqual([{ name: 'x-api-key', value: 'abc' }]);
  });

  it('parses multiple comma-separated headers', () => {
    expect(parseOtlpHeaders('a=1,b=2, c=3')).toEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: '2' },
      { name: 'c', value: '3' },
    ]);
  });

  it('percent-decodes values', () => {
    expect(parseOtlpHeaders('authorization=Bearer%20abc')).toEqual([
      { name: 'authorization', value: 'Bearer abc' },
    ]);
  });

  it('tolerates malformed (no =) entries by skipping them', () => {
    expect(parseOtlpHeaders('orphan,a=1,nope=')).toEqual([
      { name: 'a', value: '1' },
      { name: 'nope', value: '' },
    ]);
  });

  it('skips entries with empty name', () => {
    expect(parseOtlpHeaders('=value,a=1')).toEqual([{ name: 'a', value: '1' }]);
  });

  it('falls back to raw value when decode fails', () => {
    // %ZZ is invalid percent-encoding; decodeURIComponent throws.
    const out = parseOtlpHeaders('a=%ZZ');
    expect(out).toEqual([{ name: 'a', value: '%ZZ' }]);
  });

  it('ignores non-string input defensively', () => {
    // TS prevents this, but runtime callers might still hand us garbage.
    expect(parseOtlpHeaders(123 as unknown as string)).toEqual([]);
  });
});

describe('pickAuthHeader', () => {
  it('returns null on empty list', () => {
    expect(pickAuthHeader([])).toBeNull();
  });

  it('picks the single matching authorization header', () => {
    expect(
      pickAuthHeader([
        { name: 'authorization', value: 'Bearer abc' },
        { name: 'x-trace-id', value: 'xyz' },
      ]),
    ).toEqual({ name: 'authorization', value: 'Bearer abc' });
  });

  it('picks signoz-ingestion-key style names', () => {
    expect(pickAuthHeader([{ name: 'signoz-ingestion-key', value: 'abc' }])).toEqual({
      name: 'signoz-ingestion-key',
      value: 'abc',
    });
  });

  it('picks x-api-key style names', () => {
    expect(pickAuthHeader([{ name: 'x-api-key', value: 'abc' }])).toEqual({
      name: 'x-api-key',
      value: 'abc',
    });
  });

  it('returns null when multiple match (ambiguous)', () => {
    expect(
      pickAuthHeader([
        { name: 'authorization', value: 'a' },
        { name: 'x-api-key', value: 'b' },
      ]),
    ).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(pickAuthHeader([{ name: 'x-trace-id', value: 'xyz' }])).toBeNull();
  });
});

describe('maskSecret', () => {
  it('masks long values as head…tail', () => {
    expect(maskSecret('abcdefghijklmnop')).toBe('abcd…mnop');
  });

  it('returns an ellipsis for short values', () => {
    expect(maskSecret('short')).toBe('…');
    expect(maskSecret('12345678')).toBe('…');
  });

  it('handles exactly the boundary length', () => {
    expect(maskSecret('123456789')).toBe('1234…6789');
  });
});

describe('buildPromotePreview', () => {
  it('builds a preview with masked secret + replacesExisting', () => {
    const out = buildPromotePreview(
      baseObserved({
        endpoint: 'https://api.honeycomb.io',
        headers: 'x-api-key=verylongsecretkeyvalue',
      }),
      'https://ingest.signoz.cloud',
    );
    expect(out).toEqual({
      endpoint: 'https://api.honeycomb.io',
      headerName: 'x-api-key',
      headerValueMasked: 'very…alue',
      replacesExisting: 'https://ingest.signoz.cloud',
    });
  });

  it('omits replacesExisting when the existing endpoint matches', () => {
    const out = buildPromotePreview(
      baseObserved({ endpoint: 'https://api.honeycomb.io' }),
      'https://api.honeycomb.io',
    );
    expect(out?.replacesExisting).toBeNull();
  });

  it('prefers metricsEndpoint over the base endpoint when both exist', () => {
    const out = buildPromotePreview(
      baseObserved({
        endpoint: 'https://wrong.example',
        metricsEndpoint: 'https://api.honeycomb.io',
      }),
      null,
    );
    expect(out?.endpoint).toBe('https://api.honeycomb.io');
  });

  it('falls back to logsEndpoint when metricsEndpoint is null', () => {
    const out = buildPromotePreview(
      baseObserved({
        endpoint: null,
        metricsEndpoint: null,
        logsEndpoint: 'https://logs.elsewhere',
      }),
      null,
    );
    expect(out?.endpoint).toBe('https://logs.elsewhere');
  });

  it('falls back to base endpoint when both signal-specific overrides are null', () => {
    const out = buildPromotePreview(
      baseObserved({
        endpoint: 'https://base.example',
        metricsEndpoint: null,
        logsEndpoint: null,
      }),
      null,
    );
    expect(out?.endpoint).toBe('https://base.example');
  });

  it('returns empty string when nothing is set (defensive)', () => {
    const out = buildPromotePreview(
      baseObserved({ endpoint: null, metricsEndpoint: null, logsEndpoint: null }),
      null,
    );
    expect(out?.endpoint).toBe('');
  });

  it('reports headerName=null when no auth header is recognisable', () => {
    const out = buildPromotePreview(
      baseObserved({
        endpoint: 'https://api.honeycomb.io',
        headers: 'x-trace-id=xyz',
      }),
      null,
    );
    expect(out?.headerName).toBeNull();
    expect(out?.headerValueMasked).toBeNull();
  });
});

describe('canonHashManagedEnv', () => {
  it('produces identical hashes for permutation-equivalent inputs', () => {
    const a = canonHashManagedEnv({ ANTHROPIC_BASE_URL: 'x', CLAUDE_CODE_ENABLE_TELEMETRY: '1' });
    const b = canonHashManagedEnv({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', ANTHROPIC_BASE_URL: 'x' });
    expect(a).toBe(b);
  });

  it('produces different hashes when a managed value changes', () => {
    const a = canonHashManagedEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: SENTINEL_BASE_URL });
    const b = canonHashManagedEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://elsewhere' });
    expect(a).not.toBe(b);
  });

  it('is insensitive to unrelated keys', () => {
    const a = canonHashManagedEnv({});
    const b = canonHashManagedEnv({ UNRELATED_USER_VAR: 'something' });
    expect(a).toBe(b);
  });
});

describe('inspectClaudeOtelConfig', () => {
  let workdir: string;
  let settingsPath: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'drift-inspect-'));
    settingsPath = join(workdir, 'settings.json');
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('returns no-settings-file when the file is absent', async () => {
    const result = await inspectClaudeOtelConfig(settingsPath);
    expect(result.state).toBe('no-settings-file');
    expect(result.canPromote).toBe(false);
    expect(result.promotePreview).toBeNull();
  });

  it('returns ok for a correctly-patched file', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
          OTEL_EXPORTER_OTLP_ENDPOINT: SENTINEL_BASE_URL,
        },
      }),
    );
    const result = await inspectClaudeOtelConfig(settingsPath);
    expect(result.state).toBe('ok');
    expect(result.canPromote).toBe(false);
  });

  it('surfaces ANTHROPIC_BASE_URL in actual.baseUrl without affecting the drift state', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: SENTINEL_BASE_URL,
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
          OTEL_EXPORTER_OTLP_ENDPOINT: SENTINEL_BASE_URL,
        },
      }),
    );
    const result = await inspectClaudeOtelConfig(settingsPath);
    // OTEL drift classification stays scoped to OTEL keys ...
    expect(result.state).toBe('ok');
    // ... but the base URL is reported for the capture-health check to read.
    expect(result.actual.baseUrl).toBe(SENTINEL_BASE_URL);
  });

  it('reports actual.baseUrl as null when ANTHROPIC_BASE_URL is absent', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
          OTEL_EXPORTER_OTLP_ENDPOINT: SENTINEL_BASE_URL,
        },
      }),
    );
    const result = await inspectClaudeOtelConfig(settingsPath);
    expect(result.actual.baseUrl).toBeNull();
  });

  it('returns foreign-endpoint with a populated promote preview for HTTPS foreign endpoints', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://api.honeycomb.io',
          OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=verylongsecretkeyvalue',
        },
      }),
    );
    const result = await inspectClaudeOtelConfig(settingsPath, null);
    expect(result.state).toBe('foreign-endpoint');
    expect(result.canPromote).toBe(true);
    expect(result.promotePreview).not.toBeNull();
    expect(result.promotePreview?.endpoint).toBe('https://api.honeycomb.io');
    expect(result.promotePreview?.headerName).toBe('x-api-key');
  });

  it('refuses to promote HTTP non-loopback endpoints', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://insecure.example',
        },
      }),
    );
    const result = await inspectClaudeOtelConfig(settingsPath);
    expect(result.state).toBe('foreign-endpoint');
    expect(result.canPromote).toBe(false);
    expect(result.promotePreview).toBeNull();
  });

  it('allows promote for HTTP loopback (local Datadog agent etc.)', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: '1',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
        },
      }),
    );
    const result = await inspectClaudeOtelConfig(settingsPath);
    expect(result.canPromote).toBe(true);
  });

  it('returns telemetry-disabled when the toggle is missing', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: SENTINEL_BASE_URL,
        },
      }),
    );
    const result = await inspectClaudeOtelConfig(settingsPath);
    expect(result.state).toBe('telemetry-disabled');
  });

  it('treats corrupt JSON as missing (no-settings-file)', async () => {
    // Corrupt content is untrustworthy; treat as if the file isn't there
    // so the UI offers re-patch (which will overwrite the corrupt file
    // with a known-good shape).
    writeFileSync(settingsPath, '{not valid json');
    const result = await inspectClaudeOtelConfig(settingsPath);
    expect(result.state).toBe('no-settings-file');
  });

  it('treats a non-object env block as empty', async () => {
    writeFileSync(settingsPath, JSON.stringify({ env: 'a-string' }));
    const result = await inspectClaudeOtelConfig(settingsPath);
    expect(result.state).toBe('telemetry-disabled');
  });

  it('accepts the boolean form of CLAUDE_CODE_ENABLE_TELEMETRY=true', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          CLAUDE_CODE_ENABLE_TELEMETRY: true,
          OTEL_EXPORTER_OTLP_ENDPOINT: SENTINEL_BASE_URL,
        },
      }),
    );
    const result = await inspectClaudeOtelConfig(settingsPath);
    expect(result.state).toBe('ok');
  });

  it('rethrows non-ENOENT read errors', async () => {
    // Pointing the inspector at a directory triggers EISDIR, which we
    // do NOT want to swallow — only file-absence should map to the
    // empty state.
    await expect(inspectClaudeOtelConfig(workdir)).rejects.toThrow();
  });

  it('treats JSON parsing to a primitive as empty env (telemetry-disabled)', async () => {
    writeFileSync(settingsPath, '42');
    const result = await inspectClaudeOtelConfig(settingsPath);
    expect(result.state).toBe('telemetry-disabled');
  });

  it('treats JSON parsing to null as empty env', async () => {
    writeFileSync(settingsPath, 'null');
    const result = await inspectClaudeOtelConfig(settingsPath);
    expect(result.state).toBe('telemetry-disabled');
  });
});

describe('isUrlSafeForForwarder', () => {
  it('returns true for HTTPS endpoints', () => {
    expect(isUrlSafeForForwarder('https://api.example.com')).toBe(true);
  });

  it('returns true for HTTP on loopback hosts', () => {
    expect(isUrlSafeForForwarder('http://localhost:4318')).toBe(true);
    expect(isUrlSafeForForwarder('http://127.0.0.1:4318')).toBe(true);
  });

  it('returns false for HTTP non-loopback', () => {
    expect(isUrlSafeForForwarder('http://insecure.example')).toBe(false);
  });

  it('returns false for non-URL strings', () => {
    expect(isUrlSafeForForwarder('not a url')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(isUrlSafeForForwarder('')).toBe(false);
  });
});
