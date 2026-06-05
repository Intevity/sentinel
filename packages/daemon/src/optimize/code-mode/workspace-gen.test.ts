import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateServerWorkspace,
  removeServerWorkspace,
  listWorkspaceServers,
  sanitizePathSegment,
  codeModeTokenFilePath,
  resolveCodeModeDir,
} from './workspace-gen.js';
import type { McpToolDescriptor } from './mcp-client-manager.js';

const PORT = 47284;

const TOOLS: McpToolDescriptor[] = [
  {
    name: 'search_code',
    description: 'Search code across repositories.\nSecond line of detail.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } } },
  },
];

describe('workspace-gen', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sentinel-codemode-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes index.md + one file per tool with schema, description, and call example', async () => {
    const serverDir = await generateServerWorkspace({
      server: 'github',
      tools: TOOLS,
      port: PORT,
      dir,
    });
    expect(serverDir).toBe(join(dir, 'servers', 'github'));

    const index = readFileSync(join(serverDir, 'index.md'), 'utf-8');
    expect(index).toContain('# MCP server: github');
    expect(index).toContain('## Tools (2)');
    // First line only in the index — progressive disclosure.
    expect(index).toContain(
      '[`search_code`](tools/search_code.md): Search code across repositories.',
    );
    expect(index).not.toContain('Second line of detail');

    const toolMd = readFileSync(join(serverDir, 'tools', 'search_code.md'), 'utf-8');
    expect(toolMd).toContain('# search_code');
    expect(toolMd).toContain('Second line of detail');
    expect(toolMd).toContain('"required": [\n    "query"\n  ]');
    expect(toolMd).toContain(`http://127.0.0.1:${PORT}/code-mode/call`);
    expect(toolMd).toContain(`$(cat ${codeModeTokenFilePath(dir)})`);
    expect(toolMd).toContain('"server":"github","tool":"search_code"');
  });

  it('refreshes the global README as servers come and go', async () => {
    await generateServerWorkspace({ server: 'github', tools: TOOLS, port: PORT, dir });
    await generateServerWorkspace({ server: 'mongo', tools: [TOOLS[0]!], port: PORT, dir });
    let readme = readFileSync(join(dir, 'README.md'), 'utf-8');
    expect(readme).toContain('[`github`](servers/github/index.md)');
    expect(readme).toContain('[`mongo`](servers/mongo/index.md)');
    expect(await listWorkspaceServers(dir)).toEqual(['github', 'mongo']);

    await removeServerWorkspace('github', dir);
    expect(existsSync(join(dir, 'servers', 'github'))).toBe(false);
    readme = readFileSync(join(dir, 'README.md'), 'utf-8');
    expect(readme).not.toContain('github');
    expect(readme).toContain('mongo');

    await removeServerWorkspace('mongo', dir);
    // Last server gone: README removed, no stale pointer.
    expect(existsSync(join(dir, 'README.md'))).toBe(false);
    expect(await listWorkspaceServers(dir)).toEqual([]);
  });

  it('regeneration drops tools that no longer exist', async () => {
    await generateServerWorkspace({ server: 'github', tools: TOOLS, port: PORT, dir });
    expect(existsSync(join(dir, 'servers', 'github', 'tools', 'list_issues.md'))).toBe(true);
    await generateServerWorkspace({ server: 'github', tools: [TOOLS[0]!], port: PORT, dir });
    expect(existsSync(join(dir, 'servers', 'github', 'tools', 'list_issues.md'))).toBe(false);
    expect(readdirSync(join(dir, 'servers', 'github', 'tools'))).toEqual(['search_code.md']);
  });

  it('sanitizes hostile server and tool names so nothing escapes the workspace', async () => {
    const hostile: McpToolDescriptor = {
      name: '../../escape',
      description: 'bad',
      inputSchema: { type: 'object' },
    };
    await generateServerWorkspace({
      server: 'plugin:mongodb:mongodb',
      tools: [hostile],
      port: PORT,
      dir,
    });
    // Server segment sanitized; tool file sanitized; nothing written outside.
    const serverDir = join(dir, 'servers', 'plugin_mongodb_mongodb');
    expect(existsSync(serverDir)).toBe(true);
    expect(readdirSync(join(serverDir, 'tools'))).toEqual(['______escape.md']);
    expect(existsSync(join(dir, '..', 'escape.md'))).toBe(false);
    expect(sanitizePathSegment('../../x')).toBe('______x');
    expect(sanitizePathSegment('')).toBe('_');
  });

  it('never writes secrets into generated files', async () => {
    // The generator's inputs are tool metadata only, but assert the output
    // anyway: no header/env/token-looking strings for a server whose config
    // carries them (the config never reaches the generator by design).
    await generateServerWorkspace({ server: 'github', tools: TOOLS, port: PORT, dir });
    const all = [
      readFileSync(join(dir, 'servers', 'github', 'index.md'), 'utf-8'),
      readFileSync(join(dir, 'servers', 'github', 'tools', 'search_code.md'), 'utf-8'),
      readFileSync(join(dir, 'README.md'), 'utf-8'),
    ].join('\n');
    expect(all).not.toMatch(/ghp_[A-Za-z0-9]/); // GitHub token shape
    expect(all).not.toMatch(/Bearer [0-9a-f]{16,}/); // literal bearer values
    expect(all).toContain('$(cat '); // token only ever by file reference
  });

  it('resolveCodeModeDir honors the test env seam', () => {
    const prev = process.env.CLAUDE_SENTINEL_TEST_CODE_MODE_DIR;
    process.env.CLAUDE_SENTINEL_TEST_CODE_MODE_DIR = '/tmp/somewhere';
    expect(resolveCodeModeDir()).toBe('/tmp/somewhere');
    if (prev === undefined) delete process.env.CLAUDE_SENTINEL_TEST_CODE_MODE_DIR;
    else process.env.CLAUDE_SENTINEL_TEST_CODE_MODE_DIR = prev;
    expect(resolveCodeModeDir()).toContain('.claude-sentinel');
  });
});
