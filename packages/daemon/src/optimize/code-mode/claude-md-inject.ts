/**
 * Inject (and remove) a Sentinel-managed "code mode" block in the user's
 * global `~/.claude/CLAUDE.md`.
 *
 * Why CLAUDE.md and not just the skill: Claude Code subagents do NOT receive
 * the ambient skill advertisement the main thread sees, and a subagent with an
 * explicit `tools:` list can't invoke the `Skill` tool at all — so a bridged
 * MCP server is invisible to them. But every non-Explore/Plan subagent DOES
 * inherit the full memory hierarchy, including `~/.claude/CLAUDE.md`. A managed
 * block there is therefore the one mechanism that reaches user, project AND
 * plugin subagents in every project, with no per-agent editing and no global
 * skill-preload switch (which Claude Code does not provide).
 *
 * The block is delimited by stable HTML-comment markers and carries a
 * `data-hash` of its own rendered body so drift detection can tell a current
 * block from a stale one (server set changed, port changed, template bumped).
 * Everything outside the markers is preserved untouched; the block is always
 * (re)written at the end of the file so its position is deterministic.
 *
 * The bearer token is only ever referenced as `$(cat <path>)`, never inlined —
 * matching skill-install.ts. Home is resolved via `SENTINEL_TEST_HOME` in
 * tests, the same seam skill-install uses.
 */

import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { codeModeTokenFilePath, resolveCodeModeDir } from './workspace-gen.js';

const BEGIN_PREFIX = '<!-- BEGIN SENTINEL CODE-MODE (managed)';
const END_MARKER = '<!-- END SENTINEL CODE-MODE (managed) -->';

/** Matches the whole managed block regardless of the data-hash in the BEGIN
 *  marker. Non-greedy body so multiple blocks (shouldn't happen) each match. */
const BLOCK_RE =
  /<!-- BEGIN SENTINEL CODE-MODE \(managed\)[^\n]*-->[\s\S]*?<!-- END SENTINEL CODE-MODE \(managed\) -->/g;

/** Extracts the data-hash from an installed BEGIN marker, if present. */
const HASH_RE = /<!-- BEGIN SENTINEL CODE-MODE \(managed\) data-hash=([0-9a-f]+) -->/;

function resolveHome(): string {
  return process.env.SENTINEL_TEST_HOME ?? homedir();
}

export function claudeMdPath(): string {
  return join(resolveHome(), '.claude', 'CLAUDE.md');
}

export interface CodeModeBlockOpts {
  /** Bridged server display names (order-insensitive; sorted internally). */
  servers: string[];
  port: number;
  /** Workspace root override (tests). Defaults to `resolveCodeModeDir()`. */
  dir?: string;
}

/** The body between the markers. Pure; identical inputs → identical bytes. */
function renderBlockBody(opts: CodeModeBlockOpts): string {
  const root = opts.dir ?? resolveCodeModeDir();
  const tokenFile = codeModeTokenFilePath(root);
  const servers = [...opts.servers].sort();
  const serverList = servers.join(', ');
  return [
    '## Sentinel code mode (bridged MCP servers)',
    '',
    `These MCP servers are bridged through Sentinel: ${serverList}.`,
    'Their native `mcp__<server>__*` tools are intentionally NOT loaded (saving',
    'the tokens their definitions would cost on every request). Subagents do not',
    'receive the code-mode skill advertisement, so this block is how you — and any',
    'subagent — learn the bridge exists. To use a bridged server (requires the',
    'Bash tool):',
    '',
    `1. Read \`${join(root, 'servers')}/<server>/index.md\` for the tool list.`,
    '2. Read `tools/<tool>.md` next to it for the description and input schema.',
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
    '- Filter large results in the shell (jq, node) BEFORE surfacing them; only',
    '  echo the fields the task needs. That is the point of code mode.',
    '- `"truncated": true` means the result exceeded the size cap; narrow the query.',
    '- An HTTP 403 naming an unbridged server means it is not migrated; fall back',
    '  to native tools or ask the user.',
    '- Never print the contents of the token file.',
  ].join('\n');
}

/** Short content hash embedded in the BEGIN marker for drift detection. */
export function codeModeBlockHash(opts: CodeModeBlockOpts): string {
  return createHash('sha256').update(renderBlockBody(opts)).digest('hex').slice(0, 12);
}

/** The full managed block, markers included. */
export function renderCodeModeBlock(opts: CodeModeBlockOpts): string {
  const body = renderBlockBody(opts);
  return `${BEGIN_PREFIX} data-hash=${codeModeBlockHash(opts)} -->\n${body}\n${END_MARKER}`;
}

/** Remove any managed block and collapse the blank space it leaves behind. */
function stripBlock(text: string): string {
  return text.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n');
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, path);
}

/**
 * Write (or refresh) the managed block in `~/.claude/CLAUDE.md`, preserving all
 * other content. The block is placed at the end of the file. Idempotent: call
 * again whenever the bridged set changes. Returns the file path.
 */
export async function installCodeModeClaudeMd(opts: CodeModeBlockOpts): Promise<string> {
  const path = claudeMdPath();
  let existing = '';
  try {
    existing = await fs.readFile(path, 'utf8');
  } catch (err) {
    /* v8 ignore next 1 -- non-ENOENT read failures need fs fault injection */
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const base = stripBlock(existing).replace(/^\s+/, '').trimEnd();
  const block = renderCodeModeBlock(opts);
  const next = base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`;
  await writeFileAtomic(path, next);
  return path;
}

/**
 * Remove the managed block from `~/.claude/CLAUDE.md`. Never deletes the file
 * itself (the user may keep their own content there). No-op when the file or
 * block is absent.
 */
export async function uninstallCodeModeClaudeMd(): Promise<void> {
  const path = claudeMdPath();
  if (!existsSync(path)) return;
  const existing = await fs.readFile(path, 'utf8');
  if (!existing.includes(BEGIN_PREFIX)) return;
  const stripped = stripBlock(existing).replace(/^\s+/, '').trimEnd();
  await writeFileAtomic(path, stripped.length > 0 ? `${stripped}\n` : '');
}

/**
 * Report whether the managed block is present and up to date for the current
 * bridged set. Synchronous (tiny file, called on status polls / startup).
 * `upToDate` compares the installed block's data-hash to what the current
 * inputs would render.
 */
export function readCodeModeBlockState(opts: CodeModeBlockOpts): {
  present: boolean;
  upToDate: boolean;
} {
  const path = claudeMdPath();
  if (!existsSync(path)) return { present: false, upToDate: false };
  const text = readFileSync(path, 'utf8');
  const m = text.match(HASH_RE);
  if (!m) return { present: false, upToDate: false };
  return { present: true, upToDate: m[1] === codeModeBlockHash(opts) };
}
