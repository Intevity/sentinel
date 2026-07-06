/**
 * Unit tests for the managed `~/.claude/CLAUDE.md` code-mode block. Real
 * filesystem via a per-test temp home (SENTINEL_TEST_HOME) and a temp
 * workspace dir (SENTINEL_TEST_CODE_MODE_DIR) — the same seams production
 * resolves through. No mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeMdPath,
  installCodeModeClaudeMd,
  uninstallCodeModeClaudeMd,
  readCodeModeBlockState,
  renderCodeModeBlock,
  codeModeBlockHash,
} from './claude-md-inject.js';

const BEGIN = '<!-- BEGIN SENTINEL CODE-MODE (managed)';
const END = '<!-- END SENTINEL CODE-MODE (managed) -->';

let home: string;
let codeModeDir: string;
const OPTS = () => ({ servers: ['github', 'mcp-atlassian'], port: 47284, dir: codeModeDir });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sentinel-cmmd-home-'));
  codeModeDir = mkdtempSync(join(tmpdir(), 'sentinel-cmmd-ws-'));
  process.env.SENTINEL_TEST_HOME = home;
  process.env.SENTINEL_TEST_CODE_MODE_DIR = codeModeDir;
});

afterEach(() => {
  delete process.env.SENTINEL_TEST_HOME;
  delete process.env.SENTINEL_TEST_CODE_MODE_DIR;
  rmSync(home, { recursive: true, force: true });
  rmSync(codeModeDir, { recursive: true, force: true });
});

describe('renderCodeModeBlock', () => {
  it('lists the servers, the endpoint, and references the token only via $(cat …)', () => {
    const block = renderCodeModeBlock(OPTS());
    expect(block).toContain(BEGIN);
    expect(block).toContain(END);
    expect(block).toContain('github, mcp-atlassian');
    expect(block).toContain('http://127.0.0.1:47284/code-mode/call');
    expect(block).toContain(`$(cat ${join(codeModeDir, '.token')})`);
    // The literal token value must never be embedded.
    expect(block).not.toMatch(/Bearer [A-Za-z0-9]{16}/);
  });

  it('is order-insensitive in the server list (sorted → stable hash)', () => {
    const a = codeModeBlockHash({ servers: ['b', 'a'], port: 1, dir: codeModeDir });
    const b = codeModeBlockHash({ servers: ['a', 'b'], port: 1, dir: codeModeDir });
    expect(a).toBe(b);
  });

  it('changes the hash when the server set or port changes', () => {
    const base = codeModeBlockHash(OPTS());
    expect(codeModeBlockHash({ ...OPTS(), servers: ['github'] })).not.toBe(base);
    expect(codeModeBlockHash({ ...OPTS(), port: 9999 })).not.toBe(base);
  });
});

describe('installCodeModeClaudeMd', () => {
  it('creates CLAUDE.md with just the block when the file is absent', async () => {
    expect(existsSync(claudeMdPath())).toBe(false);
    const path = await installCodeModeClaudeMd(OPTS());
    expect(path).toBe(claudeMdPath());
    const text = readFileSync(path, 'utf8');
    expect(text).toContain(BEGIN);
    expect(text).toContain(END);
    expect(readCodeModeBlockState(OPTS())).toEqual({ present: true, upToDate: true });
  });

  it('preserves existing user content and appends the block at the end', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(claudeMdPath(), '# My rules\n\nDo the thing.\n');
    await installCodeModeClaudeMd(OPTS());
    const text = readFileSync(claudeMdPath(), 'utf8');
    expect(text.startsWith('# My rules\n\nDo the thing.')).toBe(true);
    expect(text.indexOf('# My rules')).toBeLessThan(text.indexOf(BEGIN));
    // Exactly one managed block.
    expect(text.split(BEGIN)).toHaveLength(2);
  });

  it('replaces an existing block in place when the server set changes', async () => {
    await installCodeModeClaudeMd(OPTS());
    expect(readCodeModeBlockState({ ...OPTS(), servers: ['github'] })).toEqual({
      present: true,
      upToDate: false,
    });
    await installCodeModeClaudeMd({ ...OPTS(), servers: ['github'] });
    const text = readFileSync(claudeMdPath(), 'utf8');
    expect(text.split(BEGIN)).toHaveLength(2); // still exactly one block
    expect(readCodeModeBlockState({ ...OPTS(), servers: ['github'] })).toEqual({
      present: true,
      upToDate: true,
    });
    // Old two-server hash is now stale.
    expect(readCodeModeBlockState(OPTS()).upToDate).toBe(false);
  });

  it('is idempotent for identical inputs', async () => {
    await installCodeModeClaudeMd(OPTS());
    const first = readFileSync(claudeMdPath(), 'utf8');
    await installCodeModeClaudeMd(OPTS());
    expect(readFileSync(claudeMdPath(), 'utf8')).toBe(first);
  });
});

describe('uninstallCodeModeClaudeMd', () => {
  it('removes the block but keeps surrounding user content', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(claudeMdPath(), '# Keep me\n');
    await installCodeModeClaudeMd(OPTS());
    await uninstallCodeModeClaudeMd();
    const text = readFileSync(claudeMdPath(), 'utf8');
    expect(text).toContain('# Keep me');
    expect(text).not.toContain(BEGIN);
    expect(text).not.toContain(END);
    expect(readCodeModeBlockState(OPTS())).toEqual({ present: false, upToDate: false });
  });

  it('leaves an empty file (never deletes it) when the block was the only content', async () => {
    await installCodeModeClaudeMd(OPTS());
    await uninstallCodeModeClaudeMd();
    expect(existsSync(claudeMdPath())).toBe(true);
    expect(readFileSync(claudeMdPath(), 'utf8')).toBe('');
  });

  it('is a no-op when the file is missing', async () => {
    await expect(uninstallCodeModeClaudeMd()).resolves.toBeUndefined();
    expect(existsSync(claudeMdPath())).toBe(false);
  });

  it('is a no-op when the file has no managed block', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(claudeMdPath(), '# Untouched\n');
    await uninstallCodeModeClaudeMd();
    expect(readFileSync(claudeMdPath(), 'utf8')).toBe('# Untouched\n');
  });
});

describe('readCodeModeBlockState', () => {
  it('reports absent when the file does not exist', () => {
    expect(readCodeModeBlockState(OPTS())).toEqual({ present: false, upToDate: false });
  });

  it('reports absent when the file exists but has no marker', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(claudeMdPath(), '# no block here\n');
    expect(readCodeModeBlockState(OPTS())).toEqual({ present: false, upToDate: false });
  });

  it('treats a reordered server list as up to date (sorted match)', async () => {
    await installCodeModeClaudeMd(OPTS());
    const reordered = { servers: ['mcp-atlassian', 'github'], port: 47284, dir: codeModeDir };
    expect(readCodeModeBlockState(reordered)).toEqual({ present: true, upToDate: true });
  });
});
