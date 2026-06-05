/**
 * Generate the code-mode wrapper workspace: progressive-disclosure files
 * describing each bridged server's tools, read on demand by Claude instead
 * of carrying every definition in every request (the core trade of the
 * "code execution with MCP" pattern).
 *
 * Layout under `~/.claude-sentinel/code-mode/`:
 *   README.md                       — index of bridged servers
 *   servers/<server>/index.md       — tool list, one line each
 *   servers/<server>/tools/<tool>.md — full description + input schema + call example
 *
 * Content comes from a live `tools/list` against the real server, so
 * descriptions and schemas are authoritative. Files contain ONLY tool
 * metadata — never env vars, headers, or tokens. Writes are atomic
 * temp+rename (agents-sync pattern). Names are path-sanitized: tool and
 * server names originate from external server responses, so anything
 * outside [A-Za-z0-9_-] becomes '_' before touching the filesystem.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SENTINEL_DIR } from '../../db.js';
import type { McpToolDescriptor } from './mcp-client-manager.js';

/** Workspace root; `CLAUDE_SENTINEL_TEST_CODE_MODE_DIR` overrides for tests. */
export function resolveCodeModeDir(): string {
  return process.env.CLAUDE_SENTINEL_TEST_CODE_MODE_DIR ?? join(SENTINEL_DIR, 'code-mode');
}

/** The bearer-token file the SKILL.md curl one-liner reads. */
export function codeModeTokenFilePath(dir: string = resolveCodeModeDir()): string {
  return join(dir, '.token');
}

/** Path-safe rendering of an externally-controlled name. */
export function sanitizePathSegment(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe.length > 0 ? safe : '_';
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, path);
}

function curlExample(port: number, server: string, tool: string, tokenFile: string): string {
  return [
    '```sh',
    `curl -s -X POST http://127.0.0.1:${port}/code-mode/call \\`,
    `  -H "Authorization: Bearer $(cat ${tokenFile})" \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"server":"${server}","tool":"${tool}","args":{}}'`,
    '```',
  ].join('\n');
}

function firstLine(text: string): string {
  const idx = text.indexOf('\n');
  return idx === -1 ? text : text.slice(0, idx);
}

export interface GenerateWorkspaceOpts {
  server: string;
  tools: McpToolDescriptor[];
  port: number;
  dir?: string;
}

/** Write (or rewrite) one server's wrapper files and refresh the global
 *  README. Returns the server's directory. */
export async function generateServerWorkspace(opts: GenerateWorkspaceOpts): Promise<string> {
  const root = opts.dir ?? resolveCodeModeDir();
  const serverSeg = sanitizePathSegment(opts.server);
  const serverDir = join(root, 'servers', serverSeg);
  const tokenFile = codeModeTokenFilePath(root);

  // Wipe any previous generation so removed tools don't linger.
  await fs.rm(join(serverDir, 'tools'), { recursive: true, force: true });

  const indexLines = [
    `# MCP server: ${opts.server} (bridged by Claude Sentinel)`,
    '',
    `This server's tools are available through Sentinel's code-mode endpoint,`,
    `not as native MCP tools. Read \`tools/<tool>.md\` for a tool's input`,
    `schema, then invoke it with curl. Example:`,
    '',
    curlExample(opts.port, opts.server, opts.tools[0]?.name ?? '<tool>', tokenFile),
    '',
    `## Tools (${opts.tools.length})`,
    '',
  ];
  for (const tool of opts.tools) {
    const seg = sanitizePathSegment(tool.name);
    indexLines.push(`- [\`${tool.name}\`](tools/${seg}.md): ${firstLine(tool.description)}`);
  }
  indexLines.push('');

  for (const tool of opts.tools) {
    const seg = sanitizePathSegment(tool.name);
    const body = [
      `# ${tool.name}`,
      '',
      `Server: \`${opts.server}\` (bridged by Claude Sentinel)`,
      '',
      tool.description || '(no description provided by the server)',
      '',
      '## Input schema',
      '',
      '```json',
      JSON.stringify(tool.inputSchema ?? { type: 'object' }, null, 2),
      '```',
      '',
      '## Call',
      '',
      curlExample(opts.port, opts.server, tool.name, tokenFile),
      '',
      'Pass tool arguments as the `args` object. Filter large results in',
      'code (jq, node) before surfacing them; only return what you need.',
      '',
    ].join('\n');
    await writeFileAtomic(join(serverDir, 'tools', `${seg}.md`), body);
  }
  await writeFileAtomic(join(serverDir, 'index.md'), indexLines.join('\n'));
  await refreshWorkspaceReadme(root);
  return serverDir;
}

/** Delete a server's wrapper files and refresh the README. */
export async function removeServerWorkspace(server: string, dir?: string): Promise<void> {
  const root = dir ?? resolveCodeModeDir();
  await fs.rm(join(root, 'servers', sanitizePathSegment(server)), {
    recursive: true,
    force: true,
  });
  await refreshWorkspaceReadme(root);
}

/** List the bridged server directories currently present. */
export async function listWorkspaceServers(dir?: string): Promise<string[]> {
  const root = dir ?? resolveCodeModeDir();
  try {
    const entries = await fs.readdir(join(root, 'servers'), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    /* v8 ignore next 2 -- non-ENOENT readdir failures need fs fault injection */
    throw err;
  }
}

async function refreshWorkspaceReadme(root: string): Promise<void> {
  const servers = await listWorkspaceServers(root);
  if (servers.length === 0) {
    // Last server removed: drop the README rather than leaving a stale
    // pointer to an empty workspace.
    if (existsSync(join(root, 'README.md'))) {
      await fs.rm(join(root, 'README.md'), { force: true });
    }
    return;
  }
  const lines = [
    '# Claude Sentinel code-mode workspace',
    '',
    'MCP servers bridged through Claude Sentinel. Their tool definitions are',
    'NOT loaded into context; read the per-server index, then the per-tool',
    'file, then call via the documented curl one-liner.',
    '',
    '## Bridged servers',
    '',
    ...servers.map((s) => `- [\`${s}\`](servers/${s}/index.md)`),
    '',
  ];
  await writeFileAtomic(join(root, 'README.md'), lines.join('\n'));
}
