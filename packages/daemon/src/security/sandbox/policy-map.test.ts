import { describe, it, expect } from 'vitest';
import type { IsolationPolicy } from '@sentinel/shared';
import type { ParsedSandboxContent } from './policy-map.js';
import {
  isValidSandboxDomain,
  toClaudeCodeSandboxBlock,
  toSandboxRuntimeConfig,
  fromClaudeCodeSandboxBlock,
  applyPulledSandboxContent,
} from './policy-map.js';

/** An empty parsed-content block to start from in reducer tests. */
function emptyParsed(): ParsedSandboxContent {
  return {
    claudeCodeEnabled: false,
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
    credentials: { files: [], envVars: [] },
  };
}

/** A fully-populated canonical policy for mapper tests. */
function fullPolicy(): IsolationPolicy {
  return {
    enabled: true,
    syncToClaudeCode: true,
    enforceCodeMode: true,
    network: {
      allowedDomains: ['example.com', '*.npmjs.org'],
      deniedDomains: ['evil.test'],
    },
    filesystem: {
      allowWrite: ['~/.kube', '/tmp/build'],
      denyWrite: ['/etc'],
      denyRead: ['~/'],
      allowRead: ['.'],
    },
    credentials: {
      files: ['~/.aws/credentials', '~/.ssh'],
      envVars: ['GITHUB_TOKEN', 'NPM_TOKEN'],
    },
  };
}

describe('isValidSandboxDomain', () => {
  it('accepts bare hostnames and dotted domains', () => {
    expect(isValidSandboxDomain('example.com')).toBe(true);
    expect(isValidSandboxDomain('sub.example.com')).toBe(true);
    expect(isValidSandboxDomain('localhost')).toBe(true);
    expect(isValidSandboxDomain('a-b.example.co.uk')).toBe(true);
  });

  it('accepts a single leading-wildcard domain with ≥2 labels', () => {
    expect(isValidSandboxDomain('*.example.com')).toBe(true);
    expect(isValidSandboxDomain('*.foo.example.com')).toBe(true);
  });

  it('accepts the bare wildcard-all token', () => {
    expect(isValidSandboxDomain('*')).toBe(true);
  });

  it('rejects overly-broad single-label wildcards', () => {
    expect(isValidSandboxDomain('*.com')).toBe(false);
  });

  it('rejects protocols, paths, and ports', () => {
    expect(isValidSandboxDomain('https://example.com')).toBe(false);
    expect(isValidSandboxDomain('example.com/path')).toBe(false);
    expect(isValidSandboxDomain('example.com:8080')).toBe(false);
  });

  it('rejects misplaced or multiple wildcards', () => {
    expect(isValidSandboxDomain('*foo.com')).toBe(false);
    expect(isValidSandboxDomain('foo.*.com')).toBe(false);
    expect(isValidSandboxDomain('**.example.com')).toBe(false);
    expect(isValidSandboxDomain('*.foo*.com')).toBe(false); // second wildcard in the tail
  });

  it('rejects empty, whitespace, and non-string input', () => {
    expect(isValidSandboxDomain('')).toBe(false);
    expect(isValidSandboxDomain('   ')).toBe(false);
    expect(isValidSandboxDomain(' example.com ')).toBe(false);
    expect(isValidSandboxDomain('exa mple.com')).toBe(false);
    expect(isValidSandboxDomain(123)).toBe(false);
    expect(isValidSandboxDomain(null)).toBe(false);
    expect(isValidSandboxDomain(undefined)).toBe(false);
  });

  it('rejects malformed labels (leading/trailing hyphen, empty label)', () => {
    expect(isValidSandboxDomain('-example.com')).toBe(false);
    expect(isValidSandboxDomain('example-.com')).toBe(false);
    expect(isValidSandboxDomain('foo..com')).toBe(false);
  });
});

describe('toClaudeCodeSandboxBlock', () => {
  it('maps every field to the verified Claude Code key shape', () => {
    expect(toClaudeCodeSandboxBlock(fullPolicy())).toEqual({
      enabled: true,
      network: {
        allowedDomains: ['example.com', '*.npmjs.org'],
        deniedDomains: ['evil.test'],
      },
      filesystem: {
        allowWrite: ['~/.kube', '/tmp/build'],
        denyWrite: ['/etc'],
        denyRead: ['~/'],
        allowRead: ['.'],
      },
      credentials: {
        files: [
          { path: '~/.aws/credentials', mode: 'deny' },
          { path: '~/.ssh', mode: 'deny' },
        ],
        envVars: [
          { name: 'GITHUB_TOKEN', mode: 'deny' },
          { name: 'NPM_TOKEN', mode: 'deny' },
        ],
      },
    });
  });

  it('reflects a disabled policy in the block enabled flag', () => {
    const p = fullPolicy();
    p.enabled = false;
    expect(toClaudeCodeSandboxBlock(p).enabled).toBe(false);
  });

  it('includes only the claudeCode passthrough keys that are set', () => {
    const p = fullPolicy();
    p.claudeCode = { failIfUnavailable: true, excludedCommands: ['docker *'] };
    const block = toClaudeCodeSandboxBlock(p);
    expect(block.failIfUnavailable).toBe(true);
    expect(block.excludedCommands).toEqual(['docker *']);
    expect('allowUnsandboxedCommands' in block).toBe(false);
    expect('allowAppleEvents' in block).toBe(false);
  });

  it('includes every claudeCode passthrough key when all are set', () => {
    const p = fullPolicy();
    p.claudeCode = {
      failIfUnavailable: false,
      allowUnsandboxedCommands: false,
      excludedCommands: ['docker *', 'gh *'],
      allowAppleEvents: true,
    };
    const block = toClaudeCodeSandboxBlock(p);
    expect(block.failIfUnavailable).toBe(false);
    expect(block.allowUnsandboxedCommands).toBe(false);
    expect(block.excludedCommands).toEqual(['docker *', 'gh *']);
    expect(block.allowAppleEvents).toBe(true);
  });

  it('omits all passthrough keys when claudeCode is absent', () => {
    const block = toClaudeCodeSandboxBlock(fullPolicy());
    expect('failIfUnavailable' in block).toBe(false);
    expect('allowUnsandboxedCommands' in block).toBe(false);
    expect('excludedCommands' in block).toBe(false);
    expect('allowAppleEvents' in block).toBe(false);
  });

  it('returns arrays independent of the source policy (no aliasing)', () => {
    const p = fullPolicy();
    const block = toClaudeCodeSandboxBlock(p);
    block.network.allowedDomains.push('mutated.test');
    block.filesystem.allowWrite.push('/mutated');
    expect(p.network.allowedDomains).toEqual(['example.com', '*.npmjs.org']);
    expect(p.filesystem.allowWrite).toEqual(['~/.kube', '/tmp/build']);
  });
});

describe('fromClaudeCodeSandboxBlock', () => {
  it('returns empty content for a missing or non-object block', () => {
    const empty = {
      claudeCodeEnabled: false,
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
      credentials: { files: [], envVars: [] },
    };
    expect(fromClaudeCodeSandboxBlock(undefined)).toEqual(empty);
    expect(fromClaudeCodeSandboxBlock(null)).toEqual(empty);
    expect(fromClaudeCodeSandboxBlock('nope')).toEqual(empty);
    expect(fromClaudeCodeSandboxBlock(42)).toEqual(empty);
  });

  it('parses a full block, flattening object credentials and surfacing enabled', () => {
    expect(
      fromClaudeCodeSandboxBlock({
        enabled: true,
        network: { allowedDomains: ['example.com'], deniedDomains: ['evil.test'] },
        filesystem: { allowWrite: ['~/.kube'], denyWrite: ['/etc'], denyRead: ['~/'], allowRead: ['.'] },
        credentials: {
          files: [{ path: '~/.aws/credentials', mode: 'deny' }],
          envVars: [{ name: 'GITHUB_TOKEN', mode: 'deny' }],
        },
      }),
    ).toEqual({
      claudeCodeEnabled: true,
      network: { allowedDomains: ['example.com'], deniedDomains: ['evil.test'] },
      filesystem: { allowWrite: ['~/.kube'], denyWrite: ['/etc'], denyRead: ['~/'], allowRead: ['.'] },
      credentials: { files: ['~/.aws/credentials'], envVars: ['GITHUB_TOKEN'] },
    });
  });

  it('tolerates bare-string credential entries and drops malformed ones', () => {
    const parsed = fromClaudeCodeSandboxBlock({
      credentials: {
        files: ['~/.ssh', { path: '~/.aws' }, { nope: 1 }, 42],
        envVars: ['TOKEN', { name: 'KEY' }, { bogus: true }],
      },
    });
    expect(parsed.credentials.files).toEqual(['~/.ssh', '~/.aws']);
    expect(parsed.credentials.envVars).toEqual(['TOKEN', 'KEY']);
  });

  it('treats non-array list fields as empty', () => {
    const parsed = fromClaudeCodeSandboxBlock({
      network: { allowedDomains: 'nope', deniedDomains: 5 },
      filesystem: { allowWrite: 'nope', denyWrite: {}, denyRead: 7, allowRead: null },
      credentials: { files: 'nope', envVars: 42 },
    });
    expect(parsed.network).toEqual({ allowedDomains: [], deniedDomains: [] });
    expect(parsed.filesystem).toEqual({ allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] });
    expect(parsed.credentials).toEqual({ files: [], envVars: [] });
  });

  it('filters invalid domains on import', () => {
    const parsed = fromClaudeCodeSandboxBlock({
      network: { allowedDomains: ['ok.com', '*.com', 'https://bad'], deniedDomains: ['x.test', '  '] },
    });
    expect(parsed.network.allowedDomains).toEqual(['ok.com']);
    expect(parsed.network.deniedDomains).toEqual(['x.test']);
  });

  it('extracts only the passthrough keys present and omits the block otherwise', () => {
    const withKeys = fromClaudeCodeSandboxBlock({
      allowAppleEvents: true,
      excludedCommands: ['docker *'],
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
    });
    expect(withKeys.claudeCode).toEqual({
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      excludedCommands: ['docker *'],
      allowAppleEvents: true,
    });
    expect('claudeCode' in fromClaudeCodeSandboxBlock({ enabled: true })).toBe(false);
  });

  it('round-trips a policy block through push then pull (content preserved)', () => {
    const block = toClaudeCodeSandboxBlock(fullPolicy());
    const parsed = fromClaudeCodeSandboxBlock(block);
    expect(parsed.network).toEqual(fullPolicy().network);
    expect(parsed.filesystem).toEqual(fullPolicy().filesystem);
    expect(parsed.credentials).toEqual(fullPolicy().credentials);
    expect(parsed.claudeCodeEnabled).toBe(true);
  });
});

describe('applyPulledSandboxContent', () => {
  it('always preserves the Sentinel-owned control flags regardless of mode', () => {
    const current = fullPolicy(); // enabled/sync/enforce all true
    for (const mode of ['merge', 'import'] as const) {
      const out = applyPulledSandboxContent(current, emptyParsed(), mode);
      expect(out.enabled).toBe(true);
      expect(out.syncToClaudeCode).toBe(true);
      expect(out.enforceCodeMode).toBe(true);
    }
  });

  it('import mode replaces content with the file (add and remove propagate)', () => {
    const current = fullPolicy();
    const parsed: ParsedSandboxContent = {
      ...emptyParsed(),
      network: { allowedDomains: ['only-this.com'], deniedDomains: [] },
      filesystem: { allowWrite: ['/srv'], denyWrite: [], denyRead: [], allowRead: [] },
      credentials: { files: ['~/.ssh'], envVars: [] },
    };
    const out = applyPulledSandboxContent(current, parsed, 'import');
    expect(out.network.allowedDomains).toEqual(['only-this.com']);
    expect(out.filesystem.allowWrite).toEqual(['/srv']);
    expect(out.credentials.files).toEqual(['~/.ssh']);
    // The original example.com / ~/.kube entries are gone (file wins).
    expect(out.network.allowedDomains).not.toContain('example.com');
  });

  it('merge mode unions content and never wipes Sentinel-only entries', () => {
    const current = fullPolicy();
    // File carries one new domain and nothing else.
    const parsed: ParsedSandboxContent = {
      ...emptyParsed(),
      network: { allowedDomains: ['new.com', 'example.com'], deniedDomains: [] },
    };
    const out = applyPulledSandboxContent(current, parsed, 'merge');
    // Existing entries preserved, new one appended, no duplicate of example.com.
    expect(out.network.allowedDomains).toEqual(['example.com', '*.npmjs.org', 'new.com']);
    // Empty file fields don't clobber existing policy content.
    expect(out.filesystem.allowWrite).toEqual(['~/.kube', '/tmp/build']);
    expect(out.credentials.files).toEqual(['~/.aws/credentials', '~/.ssh']);
  });

  it('import mode takes the file passthrough verbatim (and drops it when absent)', () => {
    const current = fullPolicy();
    current.claudeCode = { failIfUnavailable: true };
    const withPassthrough = applyPulledSandboxContent(
      current,
      { ...emptyParsed(), claudeCode: { allowAppleEvents: true } },
      'import',
    );
    expect(withPassthrough.claudeCode).toEqual({ allowAppleEvents: true });

    const noPassthrough = applyPulledSandboxContent(current, emptyParsed(), 'import');
    expect('claudeCode' in noPassthrough).toBe(false);
  });

  it('merge mode layers the file passthrough over the existing keys', () => {
    const current = fullPolicy();
    current.claudeCode = { failIfUnavailable: true, allowAppleEvents: false };
    const out = applyPulledSandboxContent(
      current,
      { ...emptyParsed(), claudeCode: { allowAppleEvents: true } },
      'merge',
    );
    expect(out.claudeCode).toEqual({ failIfUnavailable: true, allowAppleEvents: true });
  });
});

describe('toSandboxRuntimeConfig', () => {
  it('maps the network/filesystem/credentials core', () => {
    expect(toSandboxRuntimeConfig(fullPolicy())).toEqual({
      network: {
        allowedDomains: ['example.com', '*.npmjs.org'],
        deniedDomains: ['evil.test'],
      },
      filesystem: {
        denyRead: ['~/'],
        allowRead: ['.'],
        allowWrite: ['~/.kube', '/tmp/build'],
        denyWrite: ['/etc'],
      },
      credentials: {
        files: [
          { path: '~/.aws/credentials', mode: 'deny' },
          { path: '~/.ssh', mode: 'deny' },
        ],
        envVars: [
          { name: 'GITHUB_TOKEN', mode: 'deny' },
          { name: 'NPM_TOKEN', mode: 'deny' },
        ],
      },
    });
  });

  it('omits the credentials block entirely when no credentials are set', () => {
    const p = fullPolicy();
    p.credentials = { files: [], envVars: [] };
    const config = toSandboxRuntimeConfig(p);
    expect('credentials' in config).toBe(false);
  });

  it('never leaks the Claude-Code-only passthrough into the runtime config', () => {
    const p = fullPolicy();
    p.claudeCode = { allowAppleEvents: true, excludedCommands: ['docker *'] };
    const config = toSandboxRuntimeConfig(p) as unknown as Record<string, unknown>;
    expect('allowAppleEvents' in config).toBe(false);
    expect('excludedCommands' in config).toBe(false);
    expect('failIfUnavailable' in config).toBe(false);
  });

  it('injects resolved platform helper-binary paths when provided', () => {
    const config = toSandboxRuntimeConfig(fullPolicy(), {
      bwrapPath: '/usr/bin/bwrap',
      socatPath: '/usr/bin/socat',
      seccompApplyPath: '/opt/sentinel/apply-seccomp',
      ripgrepCommand: '/opt/sentinel/rg',
    });
    expect(config.bwrapPath).toBe('/usr/bin/bwrap');
    expect(config.socatPath).toBe('/usr/bin/socat');
    expect(config.seccomp).toEqual({ applyPath: '/opt/sentinel/apply-seccomp' });
    expect(config.ripgrep).toEqual({ command: '/opt/sentinel/rg' });
  });

  it('omits platform path fields when not provided', () => {
    const config = toSandboxRuntimeConfig(fullPolicy());
    expect('bwrapPath' in config).toBe(false);
    expect('socatPath' in config).toBe(false);
    expect('seccomp' in config).toBe(false);
    expect('ripgrep' in config).toBe(false);
  });
});
