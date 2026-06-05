import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { getOrCreateCodeModeToken, resetCodeModeTokenCache } from './code-mode-token.js';
import { getOrCreateMcpToken, resetMcpTokenCache } from '../compress/mcp-token.js';

describe('getOrCreateCodeModeToken', () => {
  let keychainPath: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE;
    keychainPath = join(tmpdir(), `sentinel-code-mode-token-${randomUUID()}.json`);
    process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE = keychainPath;
    resetCodeModeTokenCache();
    resetMcpTokenCache();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE;
    else process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE = prev;
    if (existsSync(keychainPath)) rmSync(keychainPath);
    resetCodeModeTokenCache();
    resetMcpTokenCache();
  });

  it('generates a 256-bit hex token and caches it within the process', () => {
    const a = getOrCreateCodeModeToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(getOrCreateCodeModeToken()).toBe(a);
  });

  it('persists the token so a fresh cache reads the same value', () => {
    const a = getOrCreateCodeModeToken();
    resetCodeModeTokenCache();
    expect(getOrCreateCodeModeToken()).toBe(a);
  });

  it('regenerates when the stored value is malformed', () => {
    getOrCreateCodeModeToken();
    // Corrupt the stored blob, drop the cache, and expect a fresh mint.
    const raw = JSON.parse(readFileSync(keychainPath, 'utf-8')) as Record<
      string,
      Record<string, string>
    >;
    raw['Claude Sentinel-code-mode-auth']!['default'] = 'not-a-hex-token';
    writeFileSync(keychainPath, JSON.stringify(raw));
    resetCodeModeTokenCache();
    expect(getOrCreateCodeModeToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of the retrieval-MCP token (blast-radius isolation)', () => {
    const codeMode = getOrCreateCodeModeToken();
    const retrieval = getOrCreateMcpToken();
    expect(codeMode).not.toBe(retrieval);
    // Each lives under its own keychain service entry.
    const raw = JSON.parse(readFileSync(keychainPath, 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual([
      'Claude Sentinel-code-mode-auth',
      'Claude Sentinel-mcp-auth',
    ]);
  });
});
