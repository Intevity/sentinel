/**
 * Migration across the "Claude Sentinel" → "Sentinel" rename.
 *
 * Before the rename, every Sentinel-owned keychain secret lived under a
 * "Claude Sentinel-*" service. `readCredentialBlobMigrating` — and the five
 * getters wired through it — must transparently adopt the legacy entry so
 * upgrading users never re-authenticate and the signed settings file still
 * verifies (the HMAC key is adopted rather than regenerated).
 *
 * No mocks: this exercises the real credential adapter through the
 * `SENTINEL_TEST_KEYCHAIN_FILE` file seam (a JSON keychain) — identical to
 * production minus the OS keychain backend.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  readCredentialBlob,
  writeCredentialBlob,
  readCredentialBlobMigrating,
  readSentinelCredentials,
} from './accounts.js';
import { getOrCreateSettingsHmacKey, resetSettingsHmacKeyCache } from './settings-integrity.js';
import { readOtelExporterSecret } from './otel-forwarder-secret.js';
import { getOrCreateMcpToken, resetMcpTokenCache } from './optimize/compress/mcp-token.js';
import {
  getOrCreateCodeModeToken,
  resetCodeModeTokenCache,
} from './optimize/code-mode/code-mode-token.js';

let dir: string;
let kcFile: string;

function resetCaches(): void {
  resetSettingsHmacKeyCache();
  resetMcpTokenCache();
  resetCodeModeTokenCache();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sentinel-rename-mig-'));
  kcFile = join(dir, 'keychain.json');
  process.env.SENTINEL_TEST_KEYCHAIN_FILE = kcFile;
  resetCaches();
});

afterEach(() => {
  delete process.env.SENTINEL_TEST_KEYCHAIN_FILE;
  try {
    chmodSync(kcFile, 0o600);
  } catch {
    /* file may not exist in some cases */
  }
  rmSync(dir, { recursive: true, force: true });
  resetCaches();
});

describe('readCredentialBlobMigrating', () => {
  it('returns the new-service value directly, ignoring any legacy entry', () => {
    writeCredentialBlob('Sentinel-mcp-auth', 'default', 'new-value');
    writeCredentialBlob('Claude Sentinel-mcp-auth', 'default', 'legacy-value');
    expect(readCredentialBlobMigrating('Sentinel-mcp-auth', 'default')).toBe('new-value');
  });

  it('falls back to the legacy "Claude Sentinel-*" entry and copies it forward', () => {
    writeCredentialBlob('Claude Sentinel-mcp-auth', 'default', 'legacy-value');
    expect(readCredentialBlobMigrating('Sentinel-mcp-auth', 'default')).toBe('legacy-value');
    // Copy-forward: the new service now holds the value, so the legacy lookup
    // is not needed again.
    expect(readCredentialBlob('Sentinel-mcp-auth', 'default')).toBe('legacy-value');
  });

  it('returns null when neither the new nor the legacy entry exists', () => {
    expect(readCredentialBlobMigrating('Sentinel-mcp-auth', 'default')).toBeNull();
  });

  it('returns null for a service that has no legacy mapping', () => {
    writeCredentialBlob('Claude Sentinel-mcp-auth', 'default', 'legacy-value');
    expect(readCredentialBlobMigrating('Some-unmapped-service', 'default')).toBeNull();
  });

  it('still returns the legacy value when the copy-forward write fails', () => {
    writeCredentialBlob('Claude Sentinel-mcp-auth', 'default', 'legacy-value');
    // Read-only keychain file: reads still succeed, but the copy-forward write
    // throws and is swallowed — the legacy value must still come back.
    chmodSync(kcFile, 0o444);
    expect(readCredentialBlobMigrating('Sentinel-mcp-auth', 'default')).toBe('legacy-value');
  });
});

describe('the five getters adopt their pre-rename keychain entry', () => {
  it('readSentinelCredentials adopts legacy Claude Sentinel-credentials', () => {
    const creds = {
      accessToken: 'at-legacy',
      refreshToken: 'rt',
      expiresAt: 9999999999000,
      scopes: ['read'],
    };
    writeCredentialBlob('Claude Sentinel-credentials', 'uuid-1', JSON.stringify(creds));
    expect(readSentinelCredentials('uuid-1')?.accessToken).toBe('at-legacy');
    expect(readCredentialBlob('Sentinel-credentials', 'uuid-1')).toContain('at-legacy');
  });

  it('getOrCreateSettingsHmacKey adopts the legacy HMAC key instead of regenerating', () => {
    const legacyHex = 'a'.repeat(64); // 32 bytes, valid hex
    writeCredentialBlob('Claude Sentinel-settings-hmac', 'default', legacyHex);
    expect(getOrCreateSettingsHmacKey().toString('hex')).toBe(legacyHex);
    expect(readCredentialBlob('Sentinel-settings-hmac', 'default')).toBe(legacyHex);
  });

  it('readOtelExporterSecret adopts the legacy otel secret', () => {
    writeCredentialBlob('Claude Sentinel-otel-exporter', 'default', 'legacy-otel');
    expect(readOtelExporterSecret()).toBe('legacy-otel');
    expect(readCredentialBlob('Sentinel-otel-exporter', 'default')).toBe('legacy-otel');
  });

  it('getOrCreateMcpToken adopts the legacy MCP bearer token', () => {
    const legacyTok = 'b'.repeat(64);
    writeCredentialBlob('Claude Sentinel-mcp-auth', 'default', legacyTok);
    expect(getOrCreateMcpToken()).toBe(legacyTok);
    expect(readCredentialBlob('Sentinel-mcp-auth', 'default')).toBe(legacyTok);
  });

  it('getOrCreateCodeModeToken adopts the legacy code-mode bearer token', () => {
    const legacyTok = 'c'.repeat(64);
    writeCredentialBlob('Claude Sentinel-code-mode-auth', 'default', legacyTok);
    expect(getOrCreateCodeModeToken()).toBe(legacyTok);
    expect(readCredentialBlob('Sentinel-code-mode-auth', 'default')).toBe(legacyTok);
  });
});
