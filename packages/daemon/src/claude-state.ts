import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ClaudeState, OAuthAccount } from '@sentinel/shared';

export const CLAUDE_JSON_PATH = join(homedir(), '.claude.json');

/**
 * Resolve the claude.json path, honoring SENTINEL_TEST_CLAUDE_JSON when
 * set so integration tests can point at a tmp file without patching imports or
 * touching the real user state. Production callers read CLAUDE_JSON_PATH
 * unchanged.
 */
export function getClaudeJsonPath(): string {
  return process.env.SENTINEL_TEST_CLAUDE_JSON ?? CLAUDE_JSON_PATH;
}

/**
 * Read a claude.json file at the given path. Returns an empty object if missing.
 * @param filePath - path to the claude.json file (defaults to ~/.claude.json)
 */
export function readClaudeState(filePath: string = getClaudeJsonPath()): ClaudeState {
  if (!existsSync(filePath)) {
    return {};
  }
  const raw = readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw) as ClaudeState;
  } catch (err) {
    // A corrupt ~/.claude.json must not take down callers: before this guard,
    // the parse error propagated into the IPC dispatch, was swallowed there,
    // and the UI saw only a request timeout ("refresh failed") with no account
    // list. Degrade to empty state and leave a diagnosable trail instead.
    console.warn(`[ClaudeState] ${filePath} is not valid JSON; treating as empty:`, err);
    return {};
  }
}

/**
 * Atomically merge a partial update into the claude.json file.
 * Uses write-to-tmp + rename to match Claude Code's own write pattern.
 * @param patch - fields to merge in
 * @param filePath - path to the claude.json file (defaults to ~/.claude.json)
 */
export function updateClaudeState(
  patch: Partial<ClaudeState>,
  filePath: string = getClaudeJsonPath(),
): void {
  const current = readClaudeState(filePath);
  const updated = { ...current, ...patch };
  writeClaudeState(updated, filePath);
}

/**
 * Atomically write the full state to the claude.json file.
 * @param state - complete state to write
 * @param filePath - path to the claude.json file (defaults to ~/.claude.json)
 */
export function writeClaudeState(state: ClaudeState, filePath: string = getClaudeJsonPath()): void {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o644 });
  renameSync(tmp, filePath);
}

/**
 * Update only the oauthAccount field in the claude.json file.
 * @param account - the account to make active
 * @param filePath - path to the claude.json file (defaults to ~/.claude.json)
 */
export function setActiveAccount(
  account: OAuthAccount,
  filePath: string = getClaudeJsonPath(),
): void {
  updateClaudeState({ oauthAccount: account }, filePath);
}

/**
 * Read the current active account from the claude.json file.
 * @param filePath - path to the claude.json file (defaults to ~/.claude.json)
 */
export function getActiveAccount(filePath: string = getClaudeJsonPath()): OAuthAccount | null {
  const state = readClaudeState(filePath);
  return state.oauthAccount ?? null;
}
