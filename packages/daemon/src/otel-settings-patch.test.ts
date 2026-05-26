import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { repatchClaudeOtelSettings } from './otel-settings-patch.js';
import { SENTINEL_OTEL_ENV_VARS, SENTINEL_BASE_URL } from './claude-otel-config.js';

describe('repatchClaudeOtelSettings', () => {
  let workdir: string;
  let settingsPath: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'patch-'));
    settingsPath = join(workdir, 'settings.json');
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  const readBack = (): { env: Record<string, string>; other: Record<string, unknown> } => {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    const env = parsed['env'] as Record<string, string>;
    const { env: _, ...other } = parsed;
    return { env, other };
  };

  it('creates a file with the eight managed keys when none exists', async () => {
    await repatchClaudeOtelSettings(settingsPath);
    const { env } = readBack();
    for (const [k, v] of Object.entries(SENTINEL_OTEL_ENV_VARS)) {
      expect(env[k]).toBe(v);
    }
  });

  it('preserves unrelated top-level keys', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        permissions: { allow: ['Bash(ls)'] },
        customField: 'untouched',
      }),
    );
    await repatchClaudeOtelSettings(settingsPath);
    const { other } = readBack();
    expect(other['permissions']).toEqual({ allow: ['Bash(ls)'] });
    expect(other['customField']).toBe('untouched');
  });

  it('preserves unrelated env entries the user set themselves', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          MY_CUSTOM_VAR: 'user-value',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://wrong.example',
        },
      }),
    );
    await repatchClaudeOtelSettings(settingsPath);
    const { env } = readBack();
    expect(env['MY_CUSTOM_VAR']).toBe('user-value');
    expect(env['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe(SENTINEL_BASE_URL);
  });

  it('strips signal-specific endpoint overrides', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://wrong.example',
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://elsewhere.example',
          OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://elsewhere.example/logs',
        },
      }),
    );
    await repatchClaudeOtelSettings(settingsPath);
    const { env } = readBack();
    expect(env['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT']).toBeUndefined();
    expect(env['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT']).toBeUndefined();
    expect(env['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe(SENTINEL_BASE_URL);
  });

  it('writes atomically and does not leave a temp file behind', async () => {
    writeFileSync(settingsPath, JSON.stringify({}));
    await repatchClaudeOtelSettings(settingsPath);
    // Verify no .tmp-* file is left around — a leak indicates a rename
    // failure or a future codepath that writes without cleanup.
    const { readdirSync } = await import('fs');
    const remaining = readdirSync(workdir).filter((f) => f.includes('.tmp-'));
    expect(remaining).toEqual([]);
  });

  it('handles a corrupt source file by overwriting with a known-good shape', async () => {
    writeFileSync(settingsPath, '{not valid');
    await repatchClaudeOtelSettings(settingsPath);
    expect(existsSync(settingsPath)).toBe(true);
    const { env } = readBack();
    expect(env['ANTHROPIC_BASE_URL']).toBe(SENTINEL_BASE_URL);
  });

  it('treats an array at root as no usable state and writes a fresh object', async () => {
    writeFileSync(settingsPath, JSON.stringify([1, 2, 3]));
    await repatchClaudeOtelSettings(settingsPath);
    const { env } = readBack();
    expect(env['CLAUDE_CODE_ENABLE_TELEMETRY']).toBe('1');
  });

  it('treats an array under env as no usable state and overwrites with managed keys', async () => {
    writeFileSync(settingsPath, JSON.stringify({ env: ['weird'] }));
    await repatchClaudeOtelSettings(settingsPath);
    const { env } = readBack();
    expect(env['CLAUDE_CODE_ENABLE_TELEMETRY']).toBe('1');
  });

  it('returns the parsed settings object that was written', async () => {
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [] } }));
    const written = await repatchClaudeOtelSettings(settingsPath);
    expect(written['permissions']).toEqual({ allow: [] });
    const env = written['env'] as Record<string, string>;
    expect(env['CLAUDE_CODE_ENABLE_TELEMETRY']).toBe('1');
  });

  it('rethrows non-ENOENT read errors', async () => {
    // Pointing at the directory triggers EISDIR — we want loud failure.
    await expect(repatchClaudeOtelSettings(workdir)).rejects.toThrow();
  });
});
