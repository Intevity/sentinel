/**
 * Install / refresh / remove the `sentinel-code-mode` Claude Code skill and
 * the bearer-token file its curl one-liner reads.
 *
 * Token handling is the load-bearing security decision: the token lives in
 * `~/.sentinel/code-mode/.token` with 0600 perms and SKILL.md only
 * ever references it as `$(cat <path>)`. The literal secret never appears in
 * skill text (which may be synced or committed by users) and never enters
 * conversation context. The skill goes to `~/.claude/skills/sentinel-code-mode/`
 * (home resolved via `SENTINEL_TEST_HOME` in tests, matching
 * context-bloat's seam).
 */

import { promises as fs } from 'node:fs';
import { chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { codeModeTokenFilePath, resolveCodeModeDir } from './workspace-gen.js';

export const SKILL_NAME = 'sentinel-code-mode';

function resolveHome(): string {
  return process.env.SENTINEL_TEST_HOME ?? homedir();
}

export function skillDirPath(): string {
  return join(resolveHome(), '.claude', 'skills', SKILL_NAME);
}

export function skillFilePath(): string {
  return join(skillDirPath(), 'SKILL.md');
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, path);
}

/** Write the bearer token to the workspace's `.token` file with 0600 perms
 *  (the settings.ts chmod pattern, win32-guarded). Idempotent. */
export async function writeCodeModeTokenFile(token: string, dir?: string): Promise<string> {
  const path = codeModeTokenFilePath(dir ?? resolveCodeModeDir());
  await writeFileAtomic(path, `${token}\n`);
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {
      /* v8 ignore next */
      // non-fatal
    }
  }
  return path;
}

export interface InstallSkillOpts {
  /** Display names of the bridged servers, for the skill body. */
  servers: string[];
  port: number;
  /** Workspace root override (tests). */
  dir?: string;
}

/** Write (or rewrite) SKILL.md covering the given servers. Idempotent;
 *  call again whenever the bridged set changes. */
export async function installCodeModeSkill(opts: InstallSkillOpts): Promise<string> {
  const root = opts.dir ?? resolveCodeModeDir();
  const tokenFile = codeModeTokenFilePath(root);
  const serverList = opts.servers.join(', ');
  const content = [
    '---',
    `name: ${SKILL_NAME}`,
    `description: Call MCP tools from the bridged servers (${serverList}) through Sentinel's local code-mode endpoint. Use whenever a task needs one of these servers; their native mcp__ tools are intentionally not loaded.`,
    '---',
    '',
    '# Sentinel code mode',
    '',
    `These MCP servers are bridged through Sentinel: ${serverList}.`,
    'Their tool definitions are not in your context (saving the tokens they',
    'would occupy on every request) and their native `mcp__<server>__*` tools',
    'are NOT available. Call them through the local bridge instead:',
    '',
    `1. Read \`${join(root, 'servers')}/<server>/index.md\` for the tool list.`,
    '2. Read `tools/<tool>.md` next to it for the full description and input schema.',
    '3. Invoke the tool:',
    '',
    '```sh',
    `curl -s -X POST http://127.0.0.1:${opts.port}/code-mode/call \\`,
    `  -H "Authorization: Bearer $(cat ${tokenFile})" \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"server":"<server>","tool":"<tool>","args":{...}}'`,
    '```',
    '',
    'The response is `{"ok":true,"isError":false,"truncated":false,"content":[...]}`.',
    '',
    'Guidelines:',
    '',
    '- Filter large results in the shell (jq, node) BEFORE surfacing them;',
    '  only echo the fields the task needs. That is the point of code mode.',
    '- `"truncated": true` means the result exceeded the size cap; narrow the',
    '  query instead of retrying as-is.',
    '- An HTTP 403 naming an unbridged server means the user has not migrated',
    '  it; fall back to native tools or ask the user.',
    '- Never print the contents of the token file.',
    '',
  ].join('\n');
  await writeFileAtomic(skillFilePath(), content);
  return skillFilePath();
}

/** Remove the skill directory and the token file. Used when the last
 *  bridged server reverts. */
export async function uninstallCodeModeSkill(dir?: string): Promise<void> {
  await fs.rm(skillDirPath(), { recursive: true, force: true });
  const tokenFile = codeModeTokenFilePath(dir ?? resolveCodeModeDir());
  if (existsSync(tokenFile)) {
    await fs.rm(tokenFile, { force: true });
  }
}
