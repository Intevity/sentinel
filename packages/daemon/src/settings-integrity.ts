/**
 * Settings-file integrity (Sprint 2 anti-tamper).
 *
 * Sentinel signs `~/.claude-sentinel/settings.json` with HMAC-SHA256 using
 * a per-installation key stored in the OS keychain. The signature lives in
 * the sidecar `settings.json.sig` (hex string, no JSON wrapping).
 *
 * Threat model: a malicious agent running as the same OS user can write
 * arbitrary files in the user's home dir. Without integrity, the agent
 * could flip `toolPermissionsEnabled: false` directly in `settings.json`.
 * With this module wired into `settings.ts::loadSettings`, that tamper is
 * detected on the next read — Sentinel falls back to DEFAULT_SETTINGS and
 * the daemon broadcasts `settings_tamper_detected` so the UI can warn.
 *
 * The HMAC key is in the keychain because: (a) OS keychain entries are
 * gated by user signature on macOS — a different process trying to read
 * the entry triggers an OS-level prompt, not silent access; (b) on Linux
 * libsecret offers similar isolation; (c) the existing accounts.ts
 * pattern already handles the platform fan-out and a test-file fallback
 * via `CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE`, so we get the test seam for
 * free.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { readCredentialBlob, writeCredentialBlob, deleteCredentialBlob } from './accounts.js';

const HMAC_SERVICE = 'Claude Sentinel-settings-hmac';
const HMAC_ACCOUNT = 'default';
const KEY_BYTES = 32;

/** Cached in-process so repeated load/save calls don't shell out to the
 *  keychain each time. Cleared by `clearSettingsHmacKey()` in tests. */
let cachedKey: Buffer | null = null;

/**
 * Return the per-installation HMAC key, generating + persisting one on
 * first call. Subsequent calls hit the in-process cache; the cache is
 * cleared by `clearSettingsHmacKey()` (tests + reset flow only).
 *
 * The keychain blob is a hex string — keychain values are utf-8 strings,
 * not raw bytes, so we encode/decode here.
 */
export function getOrCreateSettingsHmacKey(): Buffer {
  if (cachedKey) return cachedKey;
  const existing = readCredentialBlob(HMAC_SERVICE, HMAC_ACCOUNT);
  if (existing && /^[0-9a-f]+$/i.test(existing) && existing.length === KEY_BYTES * 2) {
    cachedKey = Buffer.from(existing, 'hex');
    return cachedKey;
  }
  const fresh = randomBytes(KEY_BYTES);
  writeCredentialBlob(HMAC_SERVICE, HMAC_ACCOUNT, fresh.toString('hex'));
  cachedKey = fresh;
  return cachedKey;
}

/**
 * Compute HMAC-SHA256 over `bytes` using the installation key. Returns a
 * hex digest suitable for writing as the `.sig` sidecar.
 */
export function signSettings(bytes: Buffer | string): string {
  const key = getOrCreateSettingsHmacKey();
  return createHmac('sha256', key).update(bytes).digest('hex');
}

/**
 * Constant-time verification of a hex signature against `bytes`. Returns
 * false on any decode error (malformed hex, length mismatch) so callers
 * can treat all failure modes uniformly.
 */
export function verifySettings(bytes: Buffer | string, expectedHex: string): boolean {
  if (typeof expectedHex !== 'string' || !/^[0-9a-f]+$/i.test(expectedHex)) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    /* v8 ignore next */
    return false;
  }
  const key = getOrCreateSettingsHmacKey();
  const actual = createHmac('sha256', key).update(bytes).digest();
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Forget the cached key and remove the keychain entry. Used by tests to
 * exercise key-rotation behaviour and by the user-facing reset flow.
 */
export function clearSettingsHmacKey(): void {
  cachedKey = null;
  deleteCredentialBlob(HMAC_SERVICE, HMAC_ACCOUNT);
}

/**
 * Drop the in-process cache without touching the keychain. Used by tests
 * that simulate a daemon restart while keeping the persisted key.
 */
export function resetSettingsHmacKeyCache(): void {
  cachedKey = null;
}
