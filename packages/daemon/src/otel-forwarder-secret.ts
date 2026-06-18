/**
 * Storage helpers for the external OTEL exporter ingestion key.
 *
 * The secret value is held in the OS keychain (parallel to OAuth tokens
 * and the settings HMAC key), never in `~/.sentinel/settings.json`.
 * Only the header NAME (e.g. `signoz-ingestion-key`) and the endpoint URL
 * live in settings. Tests route through `SENTINEL_TEST_KEYCHAIN_FILE`
 * automatically — these helpers don't need to know about the test seam.
 *
 * Single global slot — there's only one external destination per Sentinel
 * install for v1, so the account key is the constant `'default'`.
 */
import {
  deleteCredentialBlob,
  readCredentialBlobMigrating,
  writeCredentialBlob,
} from './accounts.js';

const OTEL_SERVICE = 'Sentinel-otel-exporter';
const OTEL_ACCOUNT = 'default';

export function readOtelExporterSecret(): string | null {
  return readCredentialBlobMigrating(OTEL_SERVICE, OTEL_ACCOUNT);
}

export function writeOtelExporterSecret(value: string): void {
  writeCredentialBlob(OTEL_SERVICE, OTEL_ACCOUNT, value);
}

export function deleteOtelExporterSecret(): void {
  deleteCredentialBlob(OTEL_SERVICE, OTEL_ACCOUNT);
}

export function hasOtelExporterSecret(): boolean {
  const v = readOtelExporterSecret();
  return v !== null && v.length > 0;
}
