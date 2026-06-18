import { execFileSync, execSync } from 'child_process';
import { homedir, userInfo as osUserInfo } from 'os';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import type { ClaudeCodeCredentials } from '@sentinel/shared';

/** Claude Code's keychain service name (single shared slot, keyed by OS username). */
const CC_SERVICE = 'Claude Code-credentials';

/** When set, credential reads/writes use a JSON file instead of the OS
 *  keychain. Used by E2E tests and Playwright so the test harness never
 *  touches the user's real keychain. Production always leaves this unset. */
const TEST_KEYCHAIN_ENV = 'SENTINEL_TEST_KEYCHAIN_FILE';

function testKeychainPath(): string | null {
  return process.env[TEST_KEYCHAIN_ENV] ?? null;
}

function readTestKeychain(): Record<string, Record<string, string>> {
  const path = testKeychainPath();
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, Record<string, string>>;
  } catch {
    return {};
  }
}

function writeTestKeychain(data: Record<string, Record<string, string>>): void {
  const path = testKeychainPath();
  if (!path) return;
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/**
 * Sentinel's own per-email credential store.
 * Whenever we see an account become active we snapshot its token here so we
 * can restore it later even after Claude Code has overwritten its single slot.
 */
const SENTINEL_SERVICE = 'Sentinel-credentials';

/**
 * New keychain service name → its pre-rename "Claude Sentinel-*" name. Drives
 * the lazy migrate-on-read fallback (`readCredentialBlobMigrating`) so users
 * upgrading across the "Claude Sentinel" → "Sentinel" rename keep their stored
 * secrets without re-authenticating. Covers all five Sentinel-owned services;
 * the singletons live in sibling modules but key off these exact string values.
 */
const LEGACY_SERVICE: Record<string, string> = {
  'Sentinel-credentials': 'Claude Sentinel-credentials',
  'Sentinel-settings-hmac': 'Claude Sentinel-settings-hmac',
  'Sentinel-otel-exporter': 'Claude Sentinel-otel-exporter',
  'Sentinel-mcp-auth': 'Claude Sentinel-mcp-auth',
  'Sentinel-code-mode-auth': 'Claude Sentinel-code-mode-auth',
};

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Read credentials for a given account from Sentinel's own store.
 * @param accountId  - account UUID (preferred) or email address
 * @param activeId   - the UUID or email of the currently active account;
 *                     used to decide whether to fall back to Claude Code's
 *                     single keychain slot (only safe if it's the same account)
 */
export function readActiveCredentials(
  accountId: string,
  activeId?: string,
): ClaudeCodeCredentials | null {
  // 1. Try Sentinel's own per-account entry first
  const sentinel = readSentinelCredentials(accountId);
  if (sentinel) return sentinel;

  // 2. Fall back to Claude Code's current slot only if this is the active account
  if (!activeId || activeId === accountId) {
    try {
      const osUser = osUserInfo().username;
      const blob = readCredentialBlob(CC_SERVICE, osUser);
      if (blob) {
        const parsed = JSON.parse(blob) as { claudeAiOauth?: ClaudeCodeCredentials };
        return parsed.claudeAiOauth ?? null;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Snapshot the credential currently in Claude Code's keychain slot and store
 * it in Sentinel's own store under the given account key (UUID preferred;
 * falls back to email).  Call this on every sync so we accumulate a full
 * credential set across account switches.
 *
 * Preserves fields that CC's keychain slot doesn't carry (e.g. subscriptionType
 * written by Sentinel's own OAuth flow) so they survive repeated refresh calls.
 */
export function captureCurrentCredentials(accountKey: string): ClaudeCodeCredentials | null {
  try {
    const osUser = osUserInfo().username;
    const blob = readCredentialBlob(CC_SERVICE, osUser);
    if (!blob) return null;
    const parsed = JSON.parse(blob) as { claudeAiOauth?: ClaudeCodeCredentials };
    const creds = parsed.claudeAiOauth ?? null;
    if (creds) {
      // CC's keychain slot doesn't include subscriptionType / rateLimitTier.
      // Preserve those fields from Sentinel's existing entry so a refresh call
      // doesn't clobber the plan information stored by the OAuth flow.
      const existing = readSentinelCredentials(accountKey);
      if (existing?.subscriptionType && !creds.subscriptionType) {
        creds.subscriptionType = existing.subscriptionType;
      }
      if (existing?.rateLimitTier && !creds.rateLimitTier) {
        creds.rateLimitTier = existing.rateLimitTier;
      }
      // Skip the store write when nothing changed. On Windows every write
      // costs two synchronous PowerShell/DPAPI spawns (re-decrypt + encrypt)
      // that block the daemon's event loop — refresh_accounts runs this on
      // every UI refresh, and on a cold VM the spawns alone could push the
      // IPC response past the app's request timeout.
      if (!existing || !sameCredentials(existing, creds)) {
        writeSentinelCredentials(accountKey, creds);
      }
    }
    return creds;
  } catch {
    return null;
  }
}

/** Top-level-key-order-insensitive equality for credential blobs. `existing`
 *  round-trips through the on-disk store while `creds` is freshly parsed from
 *  CC's slot, so key order can differ even when content is identical. */
function sameCredentials(a: ClaudeCodeCredentials, b: ClaudeCodeCredentials): boolean {
  const ar = a as unknown as Record<string, unknown>;
  const br = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(ar), ...Object.keys(br)]);
  for (const k of keys) {
    if (JSON.stringify(ar[k]) !== JSON.stringify(br[k])) return false;
  }
  return true;
}

/**
 * Read Sentinel's stored credentials.
 * @param key - account UUID (preferred) or email address
 */
export function readSentinelCredentials(key: string): ClaudeCodeCredentials | null {
  try {
    const blob = readCredentialBlobMigrating(SENTINEL_SERVICE, key);
    if (!blob) return null;
    return JSON.parse(blob) as ClaudeCodeCredentials;
  } catch {
    return null;
  }
}

/**
 * Persist credentials into Sentinel's own store.
 * @param key - account UUID (preferred) or email address
 */
export function writeSentinelCredentials(key: string, creds: ClaudeCodeCredentials): void {
  writeCredentialBlob(SENTINEL_SERVICE, key, JSON.stringify(creds));
}

/**
 * Delete a single Sentinel keychain entry. No-op if it does not exist.
 * Used by the Uninstall flow when wiping all data. Platform-specific helpers
 * (deleteDarwin/deleteWindows/deleteLinux) already swallow not-found errors,
 * so this is safe to call even when we're not sure the entry exists.
 */
export function deleteSentinelCredentials(key: string): void {
  deleteCredentialBlob(SENTINEL_SERVICE, key);
}

/**
 * Write credentials into Claude Code's single keychain slot.
 * Call this after switching accounts so Claude Code picks up the new token
 * and so that captureCurrentCredentials() reads the correct creds afterwards.
 */
export function writeClaudeCodeCredentials(creds: ClaudeCodeCredentials): void {
  const osUser = osUserInfo().username;
  writeCredentialBlob(CC_SERVICE, osUser, JSON.stringify({ claudeAiOauth: creds }));
}

// ─── Low-level keychain helpers ──────────────────────────────────────────────
//
// `readCredentialBlob` / `writeCredentialBlob` / `deleteCredentialBlob` are
// exported so other daemon modules can reuse the same OS-keychain plumbing
// (and the same `SENTINEL_TEST_KEYCHAIN_FILE` test seam) for storing
// non-credential secrets keyed by their own service name. Sprint 2 uses
// this for `Sentinel-settings-hmac` (settings-integrity.ts).

export function readCredentialBlob(service: string, account: string): string | null {
  if (testKeychainPath()) {
    const data = readTestKeychain();
    return data[service]?.[account] ?? null;
  }
  try {
    if (process.platform === 'darwin') return readDarwin(service, account);
    // Non-darwin: Claude Code keeps its credentials in a plain file, not the
    // OS secret store — route the CC slot there (see the CC file section).
    /* v8 ignore next 4 */
    if (service === CC_SERVICE) return readClaudeCodeFile();
    if (process.platform === 'win32') return readWindows(service, account);
    return readLinux(service, account);
  } catch {
    return null;
  }
}

/**
 * Read a credential blob, transparently migrating it from the pre-rename
 * "Claude Sentinel-*" keychain service when it only exists under the legacy
 * name. Reads the new service first; on a miss, falls back to the legacy
 * service and copies the value forward so subsequent reads hit the new name.
 *
 * This is how users upgrading across the "Claude Sentinel" → "Sentinel" rename
 * keep every Sentinel-owned secret — per-account OAuth credentials, the settings
 * HMAC key (so the signed settings file still verifies instead of tripping a
 * false tamper warning), and the otel/mcp/code-mode bearer tokens — without
 * re-authenticating. The legacy entry is left in place (invisible and
 * regenerable); deleting a token on a copy-forward that might silently fail is
 * not worth the risk. Self-healing and enumeration-free, so it also covers the
 * per-account credentials service whose keys we cannot list on macOS/Linux.
 */
export function readCredentialBlobMigrating(service: string, account: string): string | null {
  const current = readCredentialBlob(service, account);
  if (current !== null) return current;
  const legacy = LEGACY_SERVICE[service];
  if (legacy === undefined) return null;
  const old = readCredentialBlob(legacy, account);
  if (old !== null) {
    try {
      writeCredentialBlob(service, account, old);
    } catch {
      // Best-effort copy-forward; returning the legacy value still works and
      // the next read retries the copy.
    }
  }
  return old;
}

export function writeCredentialBlob(service: string, account: string, blob: string): void {
  if (testKeychainPath()) {
    const data = readTestKeychain();
    if (!data[service]) data[service] = {};
    data[service][account] = blob;
    writeTestKeychain(data);
    return;
  }
  if (process.platform === 'darwin') {
    writeDarwin(service, account, blob);
    return;
  }
  // Non-darwin: Claude Code's slot is a plain file (see the CC file section).
  /* v8 ignore next 8 */
  if (service === CC_SERVICE) {
    writeClaudeCodeFile(blob);
    return;
  }
  if (process.platform === 'win32') {
    writeWindows(service, account, blob);
    return;
  }
  writeLinux(service, account, blob);
}

/* v8 ignore next 23 */
export function deleteCredentialBlob(service: string, account: string): void {
  if (testKeychainPath()) {
    const data = readTestKeychain();
    if (data[service]) {
      delete data[service][account];
      writeTestKeychain(data);
    }
    return;
  }
  if (process.platform === 'darwin') {
    deleteDarwin(service, account);
    return;
  }
  // Non-darwin: Claude Code's slot is a plain file (see the CC file section).
  if (service === CC_SERVICE) {
    deleteClaudeCodeFile();
    return;
  }
  if (process.platform === 'win32') {
    deleteWindows(service, account);
    return;
  }
  deleteLinux(service, account);
}

// ─── macOS ───────────────────────────────────────────────────────────────────

function readDarwin(service: string, account: string): string | null {
  const result = execSync(
    `security find-generic-password -s ${JSON.stringify(service)} -a ${JSON.stringify(account)} -w 2>/dev/null`,
    { encoding: 'utf-8' },
  ).trim();
  return result || null;
}

function writeDarwin(service: string, account: string, blob: string): void {
  execSync(
    `security add-generic-password -U -s ${JSON.stringify(service)} -a ${JSON.stringify(account)} -w ${JSON.stringify(blob)}`,
    { encoding: 'utf-8' },
  );
}

/* v8 ignore next 9 */
function deleteDarwin(service: string, account: string): void {
  try {
    execSync(
      `security delete-generic-password -s ${JSON.stringify(service)} -a ${JSON.stringify(account)} 2>/dev/null`,
      { encoding: 'utf-8' },
    );
  } catch {
    // security exits non-zero when the item is not found; treat as success.
  }
}

// ─── Windows ─────────────────────────────────────────────────────────────────
//
// Windows Credential Manager has no usable in-box CLI: `cmdkey` cannot read
// secrets back (and mangles JSON blobs passed on the command line), and
// PowerShell's Get-StoredCredential needs a third-party module. Instead we
// keep one DPAPI-protected file — ~/.sentinel/credentials.dat —
// holding the same { [service]: { [account]: blob } } map shape as the test
// keychain. DPAPI with CurrentUser scope is the same per-user protection
// Credential Manager itself relies on. The PowerShell scripts travel via
// -EncodedCommand and the payload via stdin/stdout as base64, so neither
// shell quoting nor the console codepage can corrupt the data.

/** Shape of the DPAPI-protected store (matches the test-keychain file). */
export type CredentialMap = Record<string, Record<string, string>>;

export function serializeCredentialMap(map: CredentialMap): string {
  return JSON.stringify(map);
}

/** Parse a serialized credential map; malformed input degrades to `{}`. */
export function parseCredentialMap(json: string): CredentialMap {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as CredentialMap;
  } catch {
    return {};
  }
}

export function mapGet(map: CredentialMap, service: string, account: string): string | null {
  return map[service]?.[account] ?? null;
}

/** Immutable insert/update of one (service, account) blob. */
export function mapSet(
  map: CredentialMap,
  service: string,
  account: string,
  blob: string,
): CredentialMap {
  return { ...map, [service]: { ...(map[service] ?? {}), [account]: blob } };
}

/** Immutable removal of one (service, account) entry; no-op when absent. */
export function mapDelete(map: CredentialMap, service: string, account: string): CredentialMap {
  if (!map[service]) return map;
  const inner = { ...map[service] };
  delete inner[account];
  return { ...map, [service]: inner };
}

// stdin → base64-decode → DPAPI Protect/Unprotect → base64 on stdout.
// ProtectedData ships in-box with Windows PowerShell 5.1 (System.Security
// is a framework assembly — no module install, no C# compile).
const DPAPI_PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  "$out=[Security.Cryptography.ProtectedData]::Protect($in,$null,'CurrentUser')",
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
].join(';');

const DPAPI_UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  "$out=[Security.Cryptography.ProtectedData]::Unprotect($in,$null,'CurrentUser')",
  '[Console]::Out.Write([Convert]::ToBase64String($out))',
].join(';');

// `powershell -EncodedCommand` takes the script as UTF-16LE base64, so the
// script text never touches a shell parser either.
const DPAPI_PROTECT_B64 = Buffer.from(DPAPI_PROTECT_SCRIPT, 'utf16le').toString('base64');
const DPAPI_UNPROTECT_B64 = Buffer.from(DPAPI_UNPROTECT_SCRIPT, 'utf16le').toString('base64');

// win32-only DPAPI store: needs powershell.exe + DPAPI, unreachable on the
// macOS/Linux machines that run the test suite. The pure map layer above
// carries the unit coverage for everything that doesn't shell out.
/* v8 ignore start */
const winStoreDir = () => join(homedir(), '.sentinel');
const winStorePath = () => join(winStoreDir(), 'credentials.dat');

/** Decrypted-store cache so reads don't spawn PowerShell repeatedly (the
 *  token rotator re-reads every account on each refresh). The daemon is the
 *  only writer (port-bound singleton), so within-process invalidation on
 *  write is sufficient. */
let winCache: CredentialMap | null = null;

function runPowerShell(scriptUtf16leB64: string, inputB64: string): string {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      scriptUtf16leB64,
    ],
    { input: inputB64, encoding: 'utf-8', windowsHide: true },
  );
}

function dpapiProtect(plaintext: string): string {
  const b64 = Buffer.from(plaintext, 'utf-8').toString('base64');
  const startedAt = Date.now();
  const out = runPowerShell(DPAPI_PROTECT_B64, b64).trim();
  // Spawn timing is the key Windows diagnostic: each call synchronously
  // blocks the daemon's event loop for the full PowerShell startup cost.
  console.log(`[Keychain] dpapi protect (${Date.now() - startedAt}ms)`);
  return out;
}

function dpapiUnprotect(cipherB64: string): string {
  const startedAt = Date.now();
  const b64 = runPowerShell(DPAPI_UNPROTECT_B64, cipherB64).trim();
  console.log(`[Keychain] dpapi unprotect (${Date.now() - startedAt}ms)`);
  return Buffer.from(b64, 'base64').toString('utf-8');
}

function loadWinMap(): CredentialMap {
  if (winCache) return winCache;
  try {
    const cipher = existsSync(winStorePath()) ? readFileSync(winStorePath(), 'utf-8').trim() : '';
    winCache = cipher ? parseCredentialMap(dpapiUnprotect(cipher)) : {};
  } catch {
    // Undecryptable/corrupt store — degrade to empty rather than crash;
    // every secret in it (tokens, HMAC key) is regenerable.
    winCache = {};
  }
  return winCache;
}

function saveWinMap(map: CredentialMap): void {
  const cipher = dpapiProtect(serializeCredentialMap(map));
  mkdirSync(winStoreDir(), { recursive: true });
  const tmp = `${winStorePath()}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, cipher, 'utf-8');
  renameSync(tmp, winStorePath()); // atomic replace, mirrors claude-state.ts
  winCache = map;
}

function readWindows(service: string, account: string): string | null {
  return mapGet(loadWinMap(), service, account);
}

function writeWindows(service: string, account: string, blob: string): void {
  winCache = null; // re-read the file before read-modify-write
  saveWinMap(mapSet(loadWinMap(), service, account, blob));
}

function deleteWindows(service: string, account: string): void {
  winCache = null;
  saveWinMap(mapDelete(loadWinMap(), service, account));
}
/* v8 ignore stop */

// ─── Linux ───────────────────────────────────────────────────────────────────

/* v8 ignore next 9 */
function readLinux(service: string, account: string): string | null {
  const result = execSync(
    `secret-tool lookup service ${JSON.stringify(service)} username ${JSON.stringify(account)} 2>/dev/null`,
    { encoding: 'utf-8' },
  ).trim();
  return result || null;
}

/* v8 ignore next 5 */
function writeLinux(service: string, account: string, blob: string): void {
  execSync(
    `echo ${JSON.stringify(blob)} | secret-tool store --label=${JSON.stringify(service)} service ${JSON.stringify(service)} username ${JSON.stringify(account)}`,
    { encoding: 'utf-8', shell: '/bin/sh' },
  );
}

/* v8 ignore next 10 */
function deleteLinux(service: string, account: string): void {
  try {
    execSync(
      `secret-tool clear service ${JSON.stringify(service)} username ${JSON.stringify(account)}`,
      { encoding: 'utf-8' },
    );
  } catch {
    // secret-tool clear is a no-op/non-zero when no match — treat as success.
  }
}

// ─── Claude Code credentials file (win32 + linux) ────────────────────────────
//
// Claude Code only uses the OS keychain on macOS. On Windows and Linux it
// reads/writes <config dir>/.credentials.json (config dir = CLAUDE_CONFIG_DIR
// or ~/.claude), so the CC_SERVICE slot must target that file — otherwise
// account switches and existing-login imports are invisible to Claude Code.
// The CC blob is already exactly the file's content shape
// ({"claudeAiOauth": {...}}), so blobs pass through verbatim.

/** Resolve Claude Code's credentials file, honoring CLAUDE_CONFIG_DIR. */
export function claudeCredentialsFilePath(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(base, '.credentials.json');
}

export function readClaudeCodeFile(): string | null {
  try {
    return readFileSync(claudeCredentialsFilePath(), 'utf-8');
  } catch {
    // Missing or unreadable — same as an empty keychain slot.
    return null;
  }
}

export function writeClaudeCodeFile(blob: string): void {
  const p = claudeCredentialsFilePath();
  mkdirSync(dirname(p), { recursive: true });
  // Fresh tmp + rename = atomic replace. Mode 0600 matches Claude Code's own
  // file permissions (user-only bits, so umask cannot widen it); the mode is
  // ignored on Windows, where ACLs come from the profile directory.
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, blob, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, p);
}

export function deleteClaudeCodeFile(): void {
  try {
    unlinkSync(claudeCredentialsFilePath());
  } catch {
    // Already gone — fine.
  }
}
