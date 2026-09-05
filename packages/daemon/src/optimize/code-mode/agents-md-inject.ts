/**
 * Inject (and remove) the Sentinel code-mode block in opencode's global rules
 * file, `~/.config/opencode/AGENTS.md`.
 *
 * The block body is byte-identical to the one written into `~/.claude/CLAUDE.md`
 * — this module only differs in *where* it writes and, crucially, in *whether*
 * it writes at all.
 *
 * ## Why creating the file would be harmful
 *
 * opencode resolves global rules in priority order, first match wins:
 *
 *   1. `~/.config/opencode/AGENTS.md`
 *   2. `~/.claude/CLAUDE.md`   (the Claude Code fallback)
 *
 * So the mere existence of an `AGENTS.md` suppresses `~/.claude/CLAUDE.md`
 * entirely. If Sentinel created one, every user with global Claude Code
 * instructions would silently lose them from opencode's context — and gain
 * nothing, because the code-mode block Sentinel already maintains in
 * `~/.claude/CLAUDE.md` is exactly what opencode was reading through that
 * fallback.
 *
 * Hence the policy: **write only into an `AGENTS.md` the user already has.**
 *
 *   - File exists → inject/refresh our managed block in it. The user already
 *     accepted the suppression, so the Claude fallback is already unread and
 *     this file is the only place the bridge can be advertised.
 *   - File absent → no-op. opencode falls through to `~/.claude/CLAUDE.md`,
 *     which `claude-md-inject.ts` keeps current. Coverage either way, and
 *     Sentinel never changes which file opencode reads.
 *
 * Known gap: a user who sets `OPENCODE_DISABLE_CLAUDE_CODE` *and* has no
 * `AGENTS.md` gets no advertisement. Creating the file for them would trade a
 * silent gap for a silent behavior change, which is the worse of the two.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  installCodeModeBlockAt,
  readCodeModeBlockStateAt,
  uninstallCodeModeBlockAt,
  type CodeModeBlockOpts,
} from './claude-md-inject.js';

function resolveHome(): string {
  return process.env.SENTINEL_TEST_HOME ?? homedir();
}

/** opencode's global config directory: `$XDG_CONFIG_HOME/opencode`, falling
 *  back to `~/.config/opencode`. Same resolution opencode itself uses. */
export function opencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(resolveHome(), '.config');
  return join(base, 'opencode');
}

/** Absolute path of opencode's global rules file. */
export function agentsMdPath(): string {
  return join(opencodeConfigDir(), 'AGENTS.md');
}

/**
 * Refresh the managed block in `AGENTS.md` **if the user already has one**.
 * Returns the written path, or `null` when the file is absent and the write was
 * deliberately skipped (see the module comment).
 */
export async function installCodeModeAgentsMd(opts: CodeModeBlockOpts): Promise<string | null> {
  const path = agentsMdPath();
  if (!existsSync(path)) return null;
  return installCodeModeBlockAt(path, opts);
}

/** Remove the managed block from `AGENTS.md`. No-op when the file or block is
 *  absent; never deletes the file itself. */
export async function uninstallCodeModeAgentsMd(): Promise<void> {
  return uninstallCodeModeBlockAt(agentsMdPath());
}

/** Whether the managed block is present in `AGENTS.md` and current for the
 *  given bridged set. Reports `present: false` when the file does not exist,
 *  which is also the skip case — callers treat both as "nothing to refresh". */
export function readCodeModeAgentsMdState(opts: CodeModeBlockOpts): {
  present: boolean;
  upToDate: boolean;
} {
  return readCodeModeBlockStateAt(agentsMdPath(), opts);
}
