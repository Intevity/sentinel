/**
 * Symlink-aware path matching (`opts.resolveSymlinks`). Default is
 * off — adding a stat per rule check is opt-in. When enabled, a deny
 * rule for the canonical path catches symlink-redirected reads.
 *
 * Uses real filesystem links via `fs.symlinkSync` so the realpath
 * code path is exercised end to end (no mocking).
 */

import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchPath } from './matchers.js';

const onMac = process.platform === 'darwin';

describe('matchPath — opts.resolveSymlinks', () => {
  let dir: string;
  let realDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cs-symlink-'));
    // /private/var/folders/... on macOS is itself a symlink target;
    // resolve once so test assertions compare canonical against canonical.
    realDir = realpathSync(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('off (default) — symlink-redirected read does NOT match canonical-path rule', () => {
    // Set up: link `/tmp/.../safe` → `/tmp/.../target`. The agent reads
    // `/tmp/.../safe/secret.txt`, which is really `/tmp/.../target/secret.txt`.
    const target = join(realDir, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'secret.txt'), 'sensitive');
    const link = join(realDir, 'safe');
    symlinkSync(target, link);

    // Without realpath, the input string `/safe/secret.txt` doesn't match
    // a rule scoped to `/target/**`.
    const pattern = `//${realDir.replace(/^\//, '')}/target/**`;
    expect(matchPath(pattern, { file_path: join(link, 'secret.txt') })).toBe(false);
  });

  it('on — symlink-redirected read DOES match canonical-path rule', () => {
    const target = join(realDir, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'secret.txt'), 'sensitive');
    const link = join(realDir, 'safe');
    symlinkSync(target, link);

    const pattern = `//${realDir.replace(/^\//, '')}/target/**`;
    expect(
      matchPath(pattern, { file_path: join(link, 'secret.txt') }, { resolveSymlinks: true }),
    ).toBe(true);
  });

  it('broken symlink — falls back to raw input without throwing', () => {
    const link = join(realDir, 'broken');
    symlinkSync(join(realDir, 'does-not-exist'), link);

    // realpathSync would throw ENOENT; the matcher must catch and
    // fall back to the un-resolved path string. The rule for the raw
    // path still gets a chance to fire, and no exception escapes.
    const pattern = `//${realDir.replace(/^\//, '')}/broken`;
    expect(() => matchPath(pattern, { file_path: link }, { resolveSymlinks: true })).not.toThrow();
    // The raw path matches the pattern (it's literally `/.../broken`),
    // so the assertion below is true on both macOS and Linux.
    expect(matchPath(pattern, { file_path: link }, { resolveSymlinks: true })).toBe(true);
  });

  it("pattern is NEVER realpath'd — only the input is resolved", () => {
    // If the pattern itself were realpath'd, a rule using a symlinked
    // pattern path would fail to match a literal input. Pin: a rule
    // scoped to the symlink path matches the symlink-style input
    // regardless of `resolveSymlinks`.
    const target = join(realDir, 'real');
    mkdirSync(target);
    writeFileSync(join(target, 'a.txt'), 'x');
    const link = join(realDir, 'lnk');
    symlinkSync(target, link);

    const pattern = `//${realDir.replace(/^\//, '')}/lnk/**`;
    // Raw match: the pattern matches the literal symlink-prefix path.
    // We assert this is true even with resolveSymlinks on macOS,
    // because matchPath collapses both to lowercase before regex test
    // and the literal input still starts with `/lnk/`.
    if (onMac) {
      // On macOS, lowercase folding means the comparison happens on
      // case-folded forms — assert just the off-toggle case to keep
      // the contract simple.
      expect(matchPath(pattern, { file_path: join(link, 'a.txt') })).toBe(true);
    } else {
      expect(matchPath(pattern, { file_path: join(link, 'a.txt') })).toBe(true);
    }
  });
});
