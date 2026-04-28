/**
 * Platform-specific path matcher behavior. macOS APFS / HFS+ default
 * to case-insensitive filesystems, so a deny rule for `Read(//etc/**)`
 * MUST also catch `Read(/Etc/Passwd)`. Linux is case-sensitive and
 * MUST NOT widen.
 */

import { describe, it, expect } from 'vitest';
import { matchPath } from './matchers.js';

const onMac = process.platform === 'darwin';
const onLinux = process.platform === 'linux';

describe.runIf(onMac)('matchPath on macOS — case-insensitive', () => {
  it('matches `Read(/Etc/Passwd)` against rule `//etc/**`', () => {
    expect(matchPath('//etc/**', { file_path: '/Etc/Passwd' })).toBe(true);
  });

  it('matches `/library/launchAgents/x.plist` against `//Library/LaunchAgents/**`', () => {
    expect(
      matchPath('//Library/LaunchAgents/**', { file_path: '/library/launchAgents/x.plist' }),
    ).toBe(true);
  });

  it('matches `/foo/x.KEY` against bare-glob rule `*.key`', () => {
    expect(matchPath('*.key', { file_path: '/foo/x.KEY' })).toBe(true);
  });

  it('does NOT lowercase via locale-fold (Turkish dotless-i regression pin)', () => {
    // `İ` (U+0130) lowercases to `i̇` under Turkish locale fold;
    // under `.toLowerCase()` it lowercases to `i̇` regardless,
    // so a deny rule for `i` would NOT spuriously match `İ` because
    // the captured-side string is two characters, not one.
    // Pin: `Read(/İ/x)` does NOT match rule `//i/x` — the lowercase
    // forms differ in length.
    expect(matchPath('//i/x', { file_path: '/İ/x' })).toBe(false);
  });

  it('still matches an exact-case input on macOS', () => {
    // Sanity: lowercasing both sides preserves exact-case matches too.
    expect(matchPath('//etc/passwd', { file_path: '/etc/passwd' })).toBe(true);
  });
});

describe.runIf(onLinux)('matchPath on Linux — case-sensitive', () => {
  it('does NOT match `Read(/Etc/Passwd)` against rule `//etc/**`', () => {
    // Linux filesystems are case-sensitive; the rule author who writes
    // `//etc/**` explicitly means lowercase `etc`. Widening would
    // surprise users.
    expect(matchPath('//etc/**', { file_path: '/Etc/Passwd' })).toBe(false);
  });

  it('still matches when case is exact', () => {
    expect(matchPath('//etc/passwd', { file_path: '/etc/passwd' })).toBe(true);
  });
});
