import { describe, it, expect } from 'vitest';
import { resolvePlatformPaths } from './platform-paths.js';

describe('resolvePlatformPaths', () => {
  it('returns nothing on non-Linux platforms', () => {
    expect(resolvePlatformPaths({ platform: 'darwin' })).toEqual({});
    expect(resolvePlatformPaths({ platform: 'win32' })).toEqual({});
  });

  it('honors the env override when the file exists', () => {
    const out = resolvePlatformPaths({
      platform: 'linux',
      envSeccompPath: '/opt/seccomp/apply-seccomp',
      exists: (p) => p === '/opt/seccomp/apply-seccomp',
    });
    expect(out).toEqual({ seccompApplyPath: '/opt/seccomp/apply-seccomp' });
  });

  it('ignores the env override when the file is missing and falls through', () => {
    const out = resolvePlatformPaths({
      platform: 'linux',
      envSeccompPath: '/nope/apply-seccomp',
      packaged: false,
      exists: () => false,
    });
    expect(out).toEqual({});
  });

  it('resolves the binary beside the sidecar in packaged mode', () => {
    const out = resolvePlatformPaths({
      platform: 'linux',
      packaged: true,
      execPath: '/Applications/Sentinel.app/Contents/MacOS/sentinel-daemon',
      envSeccompPath: undefined,
      exists: (p) =>
        p === '/Applications/Sentinel.app/Contents/MacOS/sandbox-bins/apply-seccomp',
    });
    expect(out).toEqual({
      seccompApplyPath: '/Applications/Sentinel.app/Contents/MacOS/sandbox-bins/apply-seccomp',
    });
  });

  it('returns nothing in packaged mode when the beside-binary is absent', () => {
    const out = resolvePlatformPaths({
      platform: 'linux',
      packaged: true,
      execPath: '/app/sentinel-daemon',
      envSeccompPath: undefined,
      exists: () => false,
    });
    expect(out).toEqual({});
  });

  it('returns nothing in dev (unbundled) mode so the package self-resolves', () => {
    const out = resolvePlatformPaths({
      platform: 'linux',
      packaged: false,
      envSeccompPath: undefined,
      exists: () => true,
    });
    expect(out).toEqual({});
  });

  it('uses the real process.platform default when none is given', () => {
    // The test host is macOS/Linux/Windows; on the non-Linux CI runners this
    // exercises the early return, and overall the default-coalescing branch.
    const out = resolvePlatformPaths();
    expect(typeof out).toBe('object');
  });

  it('falls back to real exists/env/packaged defaults on linux', () => {
    // No exists/env/packaged injected → uses fs.existsSync, process.env, and
    // process.pkg. In the (unbundled) test process this resolves to {}.
    expect(resolvePlatformPaths({ platform: 'linux' })).toEqual({});
  });

  it('uses the real execPath default in packaged mode', () => {
    const out = resolvePlatformPaths({
      platform: 'linux',
      packaged: true,
      envSeccompPath: undefined,
      exists: () => false, // beside-binary not present → {}
    });
    expect(out).toEqual({});
  });
});
