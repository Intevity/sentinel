import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { getOrCreateMcpToken, resetMcpTokenCache } from './mcp-token.js';

describe('getOrCreateMcpToken', () => {
  let keychainPath: string;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE;
    keychainPath = join(tmpdir(), `sentinel-mcp-token-${randomUUID()}.json`);
    process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE = keychainPath;
    resetMcpTokenCache();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE;
    else process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE = prev;
    if (existsSync(keychainPath)) rmSync(keychainPath);
    resetMcpTokenCache();
  });

  it('generates a 256-bit hex token and caches it within the process', () => {
    const a = getOrCreateMcpToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Cached: same value without re-reading the keychain.
    expect(getOrCreateMcpToken()).toBe(a);
  });

  it('persists the token so a fresh cache reads the same value', () => {
    const a = getOrCreateMcpToken();
    resetMcpTokenCache();
    expect(getOrCreateMcpToken()).toBe(a);
  });

  it('mints distinct tokens for distinct keychains', () => {
    const a = getOrCreateMcpToken();
    // Point at a fresh keychain.
    const other = join(tmpdir(), `sentinel-mcp-token-${randomUUID()}.json`);
    process.env.CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE = other;
    resetMcpTokenCache();
    try {
      const b = getOrCreateMcpToken();
      expect(b).toMatch(/^[0-9a-f]{64}$/);
      expect(b).not.toBe(a);
    } finally {
      if (existsSync(other)) rmSync(other);
    }
  });
});
