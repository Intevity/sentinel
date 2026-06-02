/**
 * Bearer token for the daemon's local `/mcp` retrieval endpoint.
 *
 * The endpoint returns stored tool-output originals, so even though it binds
 * to loopback we gate it on a per-installation token. The token is written
 * into the MCP server config's `Authorization` header at install time and
 * validated on every `/mcp` request. Stored in the OS keychain (mirroring
 * `settings-integrity`'s HMAC key) so a different local process can't read it
 * silently, and honoring `CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE` for tests.
 */

import { randomBytes } from 'node:crypto';
import { readCredentialBlob, writeCredentialBlob } from '../../accounts.js';

const MCP_SERVICE = 'Claude Sentinel-mcp-auth';
const MCP_ACCOUNT = 'default';
const TOKEN_BYTES = 32; // 256-bit, hex-encoded → 64 chars

let cached: string | null = null;

/** Return the per-installation MCP bearer token, generating + persisting one
 *  on first call. Cached in-process; reset via {@link resetMcpTokenCache}. */
export function getOrCreateMcpToken(): string {
  if (cached) return cached;
  const existing = readCredentialBlob(MCP_SERVICE, MCP_ACCOUNT);
  if (existing && /^[0-9a-f]{64}$/i.test(existing)) {
    cached = existing;
    return cached;
  }
  const fresh = randomBytes(TOKEN_BYTES).toString('hex');
  writeCredentialBlob(MCP_SERVICE, MCP_ACCOUNT, fresh);
  cached = fresh;
  return cached;
}

/** Drop the in-process cache. Tests only (each test gets its own keychain
 *  file, so a stale worker-level cache would not match the on-disk value). */
export function resetMcpTokenCache(): void {
  cached = null;
}
