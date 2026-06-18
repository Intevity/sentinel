/**
 * Bearer token for the daemon's local `/code-mode/call` bridge endpoint.
 *
 * Separate keychain entry from the retrieval-MCP token on purpose: the bridge
 * can invoke the user's own MCP servers (a strictly more powerful capability
 * than reading back elided tool output), so revoking or rotating one token
 * never affects the other. Same storage rules: OS keychain, test seam via
 * `SENTINEL_TEST_KEYCHAIN_FILE`.
 *
 * The token is also written to `~/.sentinel/code-mode/.token` (0600)
 * by skill-install so the SKILL.md curl one-liner can read it via
 * `$(cat ...)` without the literal secret ever appearing in skill text or
 * conversation context.
 */

import { randomBytes } from 'node:crypto';
import { readCredentialBlobMigrating, writeCredentialBlob } from '../../accounts.js';

const CODE_MODE_SERVICE = 'Sentinel-code-mode-auth';
const CODE_MODE_ACCOUNT = 'default';
const TOKEN_BYTES = 32; // 256-bit, hex-encoded → 64 chars

let cached: string | null = null;

/** Return the per-installation code-mode bearer token, generating +
 *  persisting one on first call. Cached in-process. */
export function getOrCreateCodeModeToken(): string {
  if (cached) return cached;
  const existing = readCredentialBlobMigrating(CODE_MODE_SERVICE, CODE_MODE_ACCOUNT);
  if (existing && /^[0-9a-f]{64}$/i.test(existing)) {
    cached = existing;
    return cached;
  }
  const fresh = randomBytes(TOKEN_BYTES).toString('hex');
  writeCredentialBlob(CODE_MODE_SERVICE, CODE_MODE_ACCOUNT, fresh);
  cached = fresh;
  return cached;
}

/** Drop the in-process cache. Tests only. */
export function resetCodeModeTokenCache(): void {
  cached = null;
}
