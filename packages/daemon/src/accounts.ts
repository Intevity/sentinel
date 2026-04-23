import { execSync } from 'child_process';
import { userInfo as osUserInfo } from 'os';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { ClaudeCodeCredentials } from '@claude-sentinel/shared';

/** Claude Code's keychain service name (single shared slot, keyed by OS username). */
const CC_SERVICE = 'Claude Code-credentials';

/** When set, credential reads/writes use a JSON file instead of the OS
 *  keychain. Used by E2E tests and Playwright so the test harness never
 *  touches the user's real keychain. Production always leaves this unset. */
const TEST_KEYCHAIN_ENV = 'CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE';

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
const SENTINEL_SERVICE = 'Claude Sentinel-credentials';

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
      if (!creds.subscriptionType || !creds.rateLimitTier) {
        const existing = readSentinelCredentials(accountKey);
        if (existing?.subscriptionType && !creds.subscriptionType) {
          creds.subscriptionType = existing.subscriptionType;
        }
        if (existing?.rateLimitTier && !creds.rateLimitTier) {
          creds.rateLimitTier = existing.rateLimitTier;
        }
      }
      writeSentinelCredentials(accountKey, creds);
    }
    return creds;
  } catch {
    return null;
  }
}

/**
 * Read Sentinel's stored credentials.
 * @param key - account UUID (preferred) or email address
 */
export function readSentinelCredentials(key: string): ClaudeCodeCredentials | null {
  try {
    const blob = readCredentialBlob(SENTINEL_SERVICE, key);
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

function readCredentialBlob(service: string, account: string): string | null {
  if (testKeychainPath()) {
    const data = readTestKeychain();
    return data[service]?.[account] ?? null;
  }
  try {
    if (process.platform === 'darwin') return readDarwin(service, account);
    /* v8 ignore next 3 */
    if (process.platform === 'win32') return readWindows(service);
    return readLinux(service, account);
  } catch {
    return null;
  }
}

function writeCredentialBlob(service: string, account: string, blob: string): void {
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
  /* v8 ignore next 3 */
  if (process.platform === 'win32') {
    writeWindows(service, account, blob);
    return;
  }
  writeLinux(service, account, blob);
}

/* v8 ignore next 14 */
function deleteCredentialBlob(service: string, account: string): void {
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
  if (process.platform === 'win32') {
    deleteWindows(service);
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

/* v8 ignore next 15 */
function readWindows(service: string): string | null {
  const psScript = `
    try {
      $cred = Get-StoredCredential -Target ${JSON.stringify(service)}
      if ($cred) { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($cred.Password)) }
    } catch { }
  `.trim();
  const result = execSync(`powershell -Command "${psScript}"`, { encoding: 'utf-8' }).trim();
  return result || null;
}

/* v8 ignore next 5 */
function writeWindows(service: string, account: string, blob: string): void {
  execSync(
    `cmdkey /add:${JSON.stringify(service)} /user:${JSON.stringify(account)} /pass:${JSON.stringify(blob)}`,
    { encoding: 'utf-8' },
  );
}

/* v8 ignore next 7 */
function deleteWindows(service: string): void {
  try {
    execSync(`cmdkey /delete:${JSON.stringify(service)}`, { encoding: 'utf-8' });
  } catch {
    // Missing target — fine.
  }
}

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
