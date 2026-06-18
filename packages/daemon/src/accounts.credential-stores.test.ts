/**
 * Tests for the credential-store helpers added for Windows support:
 *
 *  - the pure credential-map layer backing the DPAPI-protected store
 *    (~/.sentinel/credentials.dat on win32), and
 *  - the Claude Code `.credentials.json` file mapping used on win32 + linux,
 *    where Claude Code does NOT use the OS keychain.
 *
 * No mocks: file operations run against a real temp directory injected via
 * CLAUDE_CONFIG_DIR (the same env var Claude Code itself honors).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from 'fs';
import { tmpdir, homedir, userInfo } from 'os';
import { join } from 'path';

import {
  serializeCredentialMap,
  parseCredentialMap,
  mapGet,
  mapSet,
  mapDelete,
  claudeCredentialsFilePath,
  readClaudeCodeFile,
  writeClaudeCodeFile,
  deleteClaudeCodeFile,
  readCredentialBlob,
  writeClaudeCodeCredentials,
  deleteCredentialBlob,
  type CredentialMap,
} from './accounts.js';

const realPlatform = process.platform;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sentinel-cc-store-'));
  process.env.CLAUDE_CONFIG_DIR = tmp;
});

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe('credential map (pure layer)', () => {
  const sample: CredentialMap = {
    'Sentinel-credentials': { 'uuid-1': '{"accessToken":"at-1"}', 'uuid-2': 'blob-2' },
    'Sentinel-settings-hmac': { default: 'deadbeef' },
  };

  it('round-trips through serialize/parse', () => {
    expect(parseCredentialMap(serializeCredentialMap(sample))).toEqual(sample);
  });

  it('parse degrades malformed JSON to an empty map', () => {
    expect(parseCredentialMap('not-json{')).toEqual({});
  });

  it('parse degrades non-object JSON to an empty map', () => {
    expect(parseCredentialMap('"a string"')).toEqual({});
    expect(parseCredentialMap('42')).toEqual({});
    expect(parseCredentialMap('null')).toEqual({});
    expect(parseCredentialMap('[1,2]')).toEqual({});
  });

  it('mapGet returns the blob on hit and null on service/account miss', () => {
    expect(mapGet(sample, 'Sentinel-credentials', 'uuid-2')).toBe('blob-2');
    expect(mapGet(sample, 'no-such-service', 'uuid-1')).toBeNull();
    expect(mapGet(sample, 'Sentinel-credentials', 'no-such-account')).toBeNull();
  });

  it('mapSet adds an entry without mutating the input map', () => {
    const next = mapSet(sample, 'svc-new', 'acct', 'blob-new');
    expect(next['svc-new']).toEqual({ acct: 'blob-new' });
    // Existing services carried over untouched.
    expect(next['Sentinel-settings-hmac']).toEqual({ default: 'deadbeef' });
    // Input not mutated.
    expect(sample['svc-new']).toBeUndefined();
  });

  it('mapSet updates an existing (service, account) in place', () => {
    const next = mapSet(sample, 'Sentinel-credentials', 'uuid-1', 'rotated');
    expect(next['Sentinel-credentials']).toEqual({
      'uuid-1': 'rotated',
      'uuid-2': 'blob-2',
    });
    expect(sample['Sentinel-credentials']?.['uuid-1']).toBe('{"accessToken":"at-1"}');
  });

  it('mapDelete removes only the targeted account without mutating the input', () => {
    const next = mapDelete(sample, 'Sentinel-credentials', 'uuid-1');
    expect(next['Sentinel-credentials']).toEqual({ 'uuid-2': 'blob-2' });
    expect(sample['Sentinel-credentials']?.['uuid-1']).toBe('{"accessToken":"at-1"}');
  });

  it('mapDelete is a no-op for a missing service or account', () => {
    expect(mapDelete(sample, 'no-such-service', 'uuid-1')).toBe(sample);
    const next = mapDelete(sample, 'Sentinel-settings-hmac', 'no-such-account');
    expect(next['Sentinel-settings-hmac']).toEqual({ default: 'deadbeef' });
  });
});

describe('claudeCredentialsFilePath', () => {
  it('honors CLAUDE_CONFIG_DIR', () => {
    expect(claudeCredentialsFilePath()).toBe(join(tmp, '.credentials.json'));
  });

  it('defaults to ~/.claude/.credentials.json when CLAUDE_CONFIG_DIR is unset', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeCredentialsFilePath()).toBe(join(homedir(), '.claude', '.credentials.json'));
  });

  it('treats an empty CLAUDE_CONFIG_DIR as unset', () => {
    process.env.CLAUDE_CONFIG_DIR = '';
    expect(claudeCredentialsFilePath()).toBe(join(homedir(), '.claude', '.credentials.json'));
  });
});

describe('Claude Code credentials file ops', () => {
  it('read returns null when the file does not exist', () => {
    expect(readClaudeCodeFile()).toBeNull();
  });

  it('write/read round-trips the blob verbatim', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'at-x', expiresAt: 123 } });
    writeClaudeCodeFile(blob);
    expect(readClaudeCodeFile()).toBe(blob);
    expect(readFileSync(join(tmp, '.credentials.json'), 'utf-8')).toBe(blob);
  });

  it('write creates the config directory when missing and sets mode 0600', () => {
    const nested = join(tmp, 'does', 'not', 'exist');
    process.env.CLAUDE_CONFIG_DIR = nested;
    writeClaudeCodeFile('{"claudeAiOauth":{}}');
    const p = join(nested, '.credentials.json');
    expect(readFileSync(p, 'utf-8')).toBe('{"claudeAiOauth":{}}');
    if (process.platform !== 'win32') {
      expect(statSync(p).mode & 0o777).toBe(0o600);
    }
  });

  it('write replaces existing content atomically (no tmp file left behind)', () => {
    writeClaudeCodeFile('old');
    writeClaudeCodeFile('new');
    expect(readClaudeCodeFile()).toBe('new');
    expect(readdirSync(tmp)).toEqual(['.credentials.json']);
  });

  it('delete removes the file and is a no-op when already gone', () => {
    writeClaudeCodeFile('bye');
    deleteClaudeCodeFile();
    expect(existsSync(join(tmp, '.credentials.json'))).toBe(false);
    expect(() => deleteClaudeCodeFile()).not.toThrow();
    expect(readClaudeCodeFile()).toBeNull();
  });
});

describe('CC_SERVICE dispatch on non-darwin platforms', () => {
  // On win32 + linux the 'Claude Code-credentials' slot must map to the
  // .credentials.json file, because Claude Code itself never looks at the
  // OS secret store there. Stub the platform to linux so the dispatch in
  // read/write/deleteCredentialBlob takes the file branch (no keychain or
  // secret-tool is reachable: CC_SERVICE returns before either backend).
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });

  it('writeClaudeCodeCredentials lands in .credentials.json with the claudeAiOauth wrapper', () => {
    const creds = {
      accessToken: 'at-disp',
      refreshToken: 'rt-disp',
      expiresAt: 999,
      scopes: ['user:inference'],
    };
    writeClaudeCodeCredentials(creds);
    const onDisk = JSON.parse(readFileSync(join(tmp, '.credentials.json'), 'utf-8')) as {
      claudeAiOauth?: typeof creds;
    };
    expect(onDisk.claudeAiOauth).toEqual(creds);
  });

  it('readCredentialBlob(CC_SERVICE) returns the file content', () => {
    writeClaudeCodeFile('{"claudeAiOauth":{"accessToken":"from-file"}}');
    const blob = readCredentialBlob('Claude Code-credentials', userInfo().username);
    expect(blob).toBe('{"claudeAiOauth":{"accessToken":"from-file"}}');
  });

  it('deleteCredentialBlob(CC_SERVICE) removes the file', () => {
    writeClaudeCodeFile('{"claudeAiOauth":{}}');
    deleteCredentialBlob('Claude Code-credentials', userInfo().username);
    expect(existsSync(join(tmp, '.credentials.json'))).toBe(false);
  });
});
