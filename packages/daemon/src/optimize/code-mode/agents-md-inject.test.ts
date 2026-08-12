/**
 * Unit tests for the managed code-mode block in opencode's global rules file.
 * Real filesystem via a per-test temp home (SENTINEL_TEST_HOME) and workspace
 * dir (SENTINEL_TEST_CODE_MODE_DIR) — the seams production resolves through.
 *
 * The behavior that carries the most weight here is the *skip*: opencode reads
 * `~/.config/opencode/AGENTS.md` in preference to `~/.claude/CLAUDE.md`, so
 * creating the file would suppress the user's global Claude instructions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  agentsMdPath,
  opencodeConfigDir,
  installCodeModeAgentsMd,
  uninstallCodeModeAgentsMd,
  readCodeModeAgentsMdState,
} from './agents-md-inject.js';
import { codeModeBlockHash } from './claude-md-inject.js';

const BEGIN = '<!-- BEGIN SENTINEL CODE-MODE (managed)';
const END = '<!-- END SENTINEL CODE-MODE (managed) -->';

let home: string;
let codeModeDir: string;
const OPTS = (): { servers: string[]; port: number; dir: string } => ({
  servers: ['mcp-atlassian'],
  port: 47284,
  dir: codeModeDir,
});

/** Create AGENTS.md with the given contents, parent dirs included. */
function seedAgentsMd(contents: string): string {
  const path = agentsMdPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
  return path;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sentinel-amd-home-'));
  codeModeDir = mkdtempSync(join(tmpdir(), 'sentinel-amd-ws-'));
  process.env.SENTINEL_TEST_HOME = home;
  process.env.SENTINEL_TEST_CODE_MODE_DIR = codeModeDir;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  delete process.env.SENTINEL_TEST_HOME;
  delete process.env.SENTINEL_TEST_CODE_MODE_DIR;
  delete process.env.XDG_CONFIG_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(codeModeDir, { recursive: true, force: true });
});

describe('agentsMdPath', () => {
  it('resolves under ~/.config/opencode by default', () => {
    expect(agentsMdPath()).toBe(join(home, '.config', 'opencode', 'AGENTS.md'));
  });

  it('honors XDG_CONFIG_HOME', () => {
    process.env.XDG_CONFIG_HOME = '/xdg-root';
    expect(opencodeConfigDir()).toBe(join('/xdg-root', 'opencode'));
    expect(agentsMdPath()).toBe(join('/xdg-root', 'opencode', 'AGENTS.md'));
  });

  it('ignores an empty XDG_CONFIG_HOME', () => {
    process.env.XDG_CONFIG_HOME = '';
    expect(agentsMdPath()).toBe(join(home, '.config', 'opencode', 'AGENTS.md'));
  });
});

describe('installCodeModeAgentsMd', () => {
  it('does NOT create AGENTS.md when the user has none', async () => {
    const result = await installCodeModeAgentsMd(OPTS());
    // Creating it here would suppress ~/.claude/CLAUDE.md for opencode, which
    // is where the same block already lives.
    expect(result).toBeNull();
    expect(existsSync(agentsMdPath())).toBe(false);
  });

  it('injects the block into an existing AGENTS.md, preserving user content', async () => {
    seedAgentsMd('# My rules\n\nAlways write tests.\n');

    const written = await installCodeModeAgentsMd(OPTS());

    expect(written).toBe(agentsMdPath());
    const text = readFileSync(agentsMdPath(), 'utf8');
    expect(text).toContain('# My rules');
    expect(text).toContain('Always write tests.');
    expect(text).toContain(BEGIN);
    expect(text).toContain(END);
    expect(text).toContain('mcp-atlassian');
    expect(text).toContain('http://127.0.0.1:47284/code-mode/call');
  });

  it('is idempotent — a second install leaves exactly one block', async () => {
    seedAgentsMd('# My rules\n');
    await installCodeModeAgentsMd(OPTS());
    const first = readFileSync(agentsMdPath(), 'utf8');
    await installCodeModeAgentsMd(OPTS());
    const second = readFileSync(agentsMdPath(), 'utf8');

    expect(second).toBe(first);
    expect(second.split(BEGIN)).toHaveLength(2);
  });

  it('replaces a stale block rather than appending a second one', async () => {
    seedAgentsMd('# My rules\n');
    await installCodeModeAgentsMd({ ...OPTS(), servers: ['github'] });
    await installCodeModeAgentsMd({ ...OPTS(), servers: ['mcp-atlassian'] });

    const text = readFileSync(agentsMdPath(), 'utf8');
    expect(text.split(BEGIN)).toHaveLength(2);
    expect(text).toContain('mcp-atlassian');
    expect(text).not.toContain('These MCP servers are bridged through Sentinel: github.');
  });

  it('never inlines the bearer token', async () => {
    seedAgentsMd('# My rules\n');
    await installCodeModeAgentsMd(OPTS());
    const text = readFileSync(agentsMdPath(), 'utf8');
    expect(text).toContain('$(cat ');
    expect(text).toContain('.token');
  });
});

describe('readCodeModeAgentsMdState', () => {
  it('reports absent when the file does not exist', () => {
    expect(readCodeModeAgentsMdState(OPTS())).toEqual({ present: false, upToDate: false });
  });

  it('reports absent when the file exists without our block', () => {
    seedAgentsMd('# Just my rules\n');
    expect(readCodeModeAgentsMdState(OPTS())).toEqual({ present: false, upToDate: false });
  });

  it('reports present + upToDate after an install', async () => {
    seedAgentsMd('# My rules\n');
    await installCodeModeAgentsMd(OPTS());
    expect(readCodeModeAgentsMdState(OPTS())).toEqual({ present: true, upToDate: true });
  });

  it('reports stale when the bridged set changed', async () => {
    seedAgentsMd('# My rules\n');
    await installCodeModeAgentsMd({ ...OPTS(), servers: ['github'] });

    const state = readCodeModeAgentsMdState(OPTS());
    expect(state.present).toBe(true);
    expect(state.upToDate).toBe(false);
    // The installed hash is github's, not the one the current inputs render.
    expect(readFileSync(agentsMdPath(), 'utf8')).toContain(
      codeModeBlockHash({ ...OPTS(), servers: ['github'] }),
    );
  });
});

describe('uninstallCodeModeAgentsMd', () => {
  it('removes the block but keeps the user content and the file', async () => {
    seedAgentsMd('# My rules\n\nAlways write tests.\n');
    await installCodeModeAgentsMd(OPTS());

    await uninstallCodeModeAgentsMd();

    const text = readFileSync(agentsMdPath(), 'utf8');
    expect(existsSync(agentsMdPath())).toBe(true);
    expect(text).not.toContain(BEGIN);
    expect(text).toContain('Always write tests.');
  });

  it('is a no-op when the file does not exist', async () => {
    await expect(uninstallCodeModeAgentsMd()).resolves.toBeUndefined();
    expect(existsSync(agentsMdPath())).toBe(false);
  });

  it('is a no-op when the file exists without our block', async () => {
    seedAgentsMd('# Just my rules\n');
    await uninstallCodeModeAgentsMd();
    expect(readFileSync(agentsMdPath(), 'utf8')).toBe('# Just my rules\n');
  });
});
