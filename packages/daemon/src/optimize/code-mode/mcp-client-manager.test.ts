/**
 * Unit tests for the pure helpers in mcp-client-manager: PATH augmentation
 * (the GUI-inherited-PATH repair) and ENOENT error clarification. The spawn
 * behavior these protect is exercised end-to-end in the integration suite.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { augmentedPath, clarifySpawnError } from './mcp-client-manager.js';

describe('augmentedPath', () => {
  const home = '/home/tester';

  it('prepends the common user-bin dirs so uvx/npx resolve', () => {
    const result = augmentedPath({ basePath: '/usr/sbin:/sbin', home, platform: 'darwin' });
    expect(result.split(':')).toEqual([
      path.join(home, '.local', 'bin'),
      path.join(home, '.bun', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]);
  });

  it('dedupes dirs already present in the base PATH', () => {
    const dirs = augmentedPath({ basePath: '/usr/local/bin:/custom', home, platform: 'linux' }).split(
      ':',
    );
    expect(dirs.filter((d) => d === '/usr/local/bin')).toHaveLength(1);
    expect(dirs).toContain('/custom');
  });

  it('drops empty segments from an empty base PATH', () => {
    const dirs = augmentedPath({ basePath: '', home, platform: 'darwin' }).split(':');
    expect(dirs).not.toContain('');
    expect(dirs).toContain('/usr/local/bin');
  });

  it('returns the base PATH unchanged on Windows', () => {
    const base = 'C:\\Windows;C:\\Windows\\System32';
    expect(augmentedPath({ basePath: base, home, platform: 'win32' })).toBe(base);
  });

  it.skipIf(process.platform === 'win32')('uses process defaults when called with no options', () => {
    // Exercises the `?? process.platform / process.env.PATH / os.homedir()` defaults.
    expect(augmentedPath().split(':')).toContain('/usr/bin');
  });
});

describe('clarifySpawnError', () => {
  const enoent = (message: string) => Object.assign(new Error(message), { code: 'ENOENT' });

  it('rewrites an ENOENT (detected by code) to name the missing command', () => {
    const out = clarifySpawnError('atlassian', { command: 'uvx' }, enoent('spawn uvx ENOENT'));
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toContain("command 'uvx'");
    expect((out as Error).message).toContain('not found on PATH');
  });

  it('detects ENOENT from the message when no error code is set', () => {
    const out = clarifySpawnError('gh', { command: 'npx' }, new Error('spawn npx ENOENT'));
    expect((out as Error).message).toContain("command 'npx'");
  });

  it('falls back to a generic phrase when the entry has no command', () => {
    expect((clarifySpawnError('x', {}, enoent('spawn  ENOENT')) as Error).message).toContain(
      'the configured command',
    );
  });

  it('falls back for a null entry', () => {
    expect((clarifySpawnError('x', null, enoent('spawn z ENOENT')) as Error).message).toContain(
      'the configured command',
    );
  });

  it('falls back for a truthy non-object entry', () => {
    expect((clarifySpawnError('x', 42, enoent('spawn z ENOENT')) as Error).message).toContain(
      'the configured command',
    );
  });

  it('passes non-ENOENT errors through unchanged (same reference)', () => {
    const err = new Error('connection refused');
    expect(clarifySpawnError('x', { command: 'uvx' }, err)).toBe(err);
  });

  it('passes non-Error values through unchanged', () => {
    expect(clarifySpawnError('x', { command: 'uvx' }, 'not-an-error')).toBe('not-an-error');
  });
});
