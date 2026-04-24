import type { Database } from 'better-sqlite3';
import type { ClaudeCodeCredentials, OAuthAccount } from '@claude-sentinel/shared';
import { fetchProfile } from './oauth.js';
import type { ProfileResult } from './oauth.js';
import { listAccounts, markAccountRemoved } from './db.js';

/**
 * Narrow dependency seams for the startup credential-verification helpers.
 * The production paths wire these to the real network + keychain; tests swap
 * them for in-memory stubs so the drift logic is testable without mocking
 * fetch or file I/O.
 */
export interface CredentialVerifierDeps {
  /** `/api/oauth/profile` fetcher. Defaults to oauth.ts's real fetchProfile. */
  profileFetcher?: (accessToken: string) => Promise<ProfileResult>;
  /** Keychain read — returns the credential stored under a given sentinelKey. */
  readCredentials: (key: string) => ClaudeCodeCredentials | null;
  /** Log sink. Defaults to console.warn. */
  log?: (msg: string) => void;
}

export interface StartupDriftResult {
  /** Activity-normalized account (matches the token's actual org scope). */
  activeAccount: OAuthAccount;
  /** sentinelKey derived from the verified orgUuid (or accountUuid fallback). */
  startupKey: string;
  /** True when the verifier realigned because ~/.claude.json disagreed with
   *  the token's actual org. */
  drifted: boolean;
}

/**
 * Verify that the token stored for a given starting account is actually
 * scoped to the org the caller expects. If the token's profile org differs,
 * return a realigned account object + new sentinelKey so the caller can
 * seed the DB against the TOKEN's reality — not the stale JSON file.
 *
 * Returns null when there's no verifiable starting state (no active account,
 * no creds, or the profile fetch failed — callers should fall through to the
 * optimistic seed in that case; drift gets caught on a later boot).
 */
export async function verifyStartupActiveAccount(
  activeAccount: OAuthAccount | null,
  startupCreds: ClaudeCodeCredentials | null,
  deps: CredentialVerifierDeps,
): Promise<StartupDriftResult | null> {
  if (!activeAccount || !startupCreds?.accessToken) return null;
  const fetcher = deps.profileFetcher ?? fetchProfile;
  const log = deps.log ?? ((m: string) => console.warn(m));

  let verified: ProfileResult;
  try {
    verified = await fetcher(startupCreds.accessToken);
  } catch {
    return null;
  }
  if (!verified.orgUuid || !verified.accountUuid) return null;

  const claimed = activeAccount.organizationUuid ?? '';
  if (verified.orgUuid === claimed) {
    return {
      activeAccount,
      startupKey: sentinelKey(verified.orgUuid, verified.accountUuid),
      drifted: false,
    };
  }

  log(
    `[Startup] Credential drift: ~/.claude.json claims org=${claimed || '(none)'} but the stored token is for org=${verified.orgUuid} — realigning to the token`,
  );
  const realigned: OAuthAccount = {
    ...activeAccount,
    accountUuid: verified.accountUuid,
    organizationUuid: verified.orgUuid,
    organizationName: verified.orgName || activeAccount.organizationName || '',
    workspaceRole:
      verified.workspaceRole !== null && verified.workspaceRole !== undefined
        ? (verified.workspaceRole as OAuthAccount['workspaceRole'])
        : activeAccount.workspaceRole,
  };
  return {
    activeAccount: realigned,
    startupKey: sentinelKey(verified.orgUuid, verified.accountUuid),
    drifted: true,
  };
}

/**
 * Walk every stored credential at startup and soft-remove any DB row whose
 * token is actually scoped to a different org than the row claims. This is
 * the counterpart to verifyStartupActiveAccount: it catches drift on
 * non-active rows that the startup-seed path never touches.
 *
 * "Soft-remove" means `markAccountRemoved` — the UI hides it, but the
 * credential and row remain so a future fix or re-add path can resurrect
 * them. Drift shows up as two rows with identical usage and the same plan
 * label in the tray UI; removing the orphaned row collapses the duplicate.
 */
export async function healDriftedRows(db: Database, deps: CredentialVerifierDeps): Promise<number> {
  const fetcher = deps.profileFetcher ?? fetchProfile;
  const log = deps.log ?? ((m: string) => console.warn(m));

  let drifted = 0;
  const rows = listAccounts(db);
  for (const acct of rows) {
    const creds = deps.readCredentials(acct.id);
    if (!creds?.accessToken) continue;
    let verified: ProfileResult;
    try {
      verified = await fetcher(creds.accessToken);
    } catch {
      continue;
    }
    if (!verified.orgUuid) continue;
    if (verified.orgUuid === acct.orgUuid) continue;
    log(
      `[Startup] Row ${acct.id} (${acct.email}, ${acct.orgName || '?'}) holds a token actually scoped to org=${verified.orgUuid} — soft-removing the stale row`,
    );
    markAccountRemoved(db, acct.id);
    drifted++;
  }
  return drifted;
}

/** Re-exported so callers can key rows consistently without re-importing
 *  index.ts's private helper. Mirrors index.ts:sentinelKey. */
export function sentinelKey(orgUuid: string, accountUuid: string): string {
  return orgUuid || accountUuid;
}
