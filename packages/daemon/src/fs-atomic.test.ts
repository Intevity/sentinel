/**
 * Atomic writes into user-owned files. Real filesystem in a per-test temp dir.
 * The regressions these guard: a symlinked dotfile turned into a regular file
 * (the dotfiles repo stops seeing changes) and a 0600 file widened by the umask.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWriteTarget, writeFileAtomicPreserving } from './fs-atomic.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sentinel-fs-atomic-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveWriteTarget', () => {
  it('returns a missing plain path unchanged', async () => {
    const path = join(dir, 'nope.json');
    expect(await resolveWriteTarget(path)).toBe(path);
  });

  it('follows a chain of symlinks to the real file', async () => {
    const real = join(dir, 'real.json');
    writeFileSync(real, '{}');
    symlinkSync(real, join(dir, 'a'));
    symlinkSync(join(dir, 'a'), join(dir, 'b'));
    expect(await resolveWriteTarget(join(dir, 'b'))).toBe(await resolveWriteTarget(real));
  });

  it('resolves a dangling relative link against its own directory', async () => {
    mkdirSync(join(dir, 'sub'));
    symlinkSync('../target.md', join(dir, 'sub', 'link.md'));
    expect(await resolveWriteTarget(join(dir, 'sub', 'link.md'))).toBe(join(dir, 'target.md'));
  });
});

describe('writeFileAtomicPreserving', () => {
  it('creates a new file and its parent directories', async () => {
    const path = join(dir, 'a', 'b', 'c.txt');
    await writeFileAtomicPreserving(path, 'hello');
    expect(readFileSync(path, 'utf8')).toBe('hello');
  });

  it('keeps a symlink a symlink and updates its target', async () => {
    const real = join(dir, 'real.md');
    writeFileSync(real, 'old');
    const link = join(dir, 'link.md');
    symlinkSync(real, link);

    await writeFileAtomicPreserving(link, 'new');

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('new');
  });

  it('preserves a restrictive file mode', async () => {
    const path = join(dir, 'secret.json');
    writeFileSync(path, '{}');
    chmodSync(path, 0o600);

    await writeFileAtomicPreserving(path, '{"a":1}');

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}');
  });

  it('cleans up its temp file and rethrows when the rename fails', async () => {
    // A directory at the target path: the temp write succeeds, the rename
    // over a non-empty directory cannot.
    const path = join(dir, 'occupied');
    mkdirSync(path);
    writeFileSync(join(path, 'keep'), 'x');

    await expect(writeFileAtomicPreserving(path, 'data')).rejects.toThrow(
      /E(ISDIR|NOTEMPTY|PERM|EXIST)/,
    );

    expect(readdirSync(dir)).toEqual(['occupied']);
  });
});
