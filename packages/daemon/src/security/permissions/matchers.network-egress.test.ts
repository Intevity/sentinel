/**
 * Network-egress default-deny tests.
 *
 * Two layers under test:
 *   1. The pure helper `isLinkLocalOrMetadata(host, includePrivateRanges)`
 *      — no DNS, no I/O. Each branch (link-local, loopback, unspecified,
 *      RFC-1918, IPv6 forms, FQDN forms) gets a positive + a near-miss
 *      negative.
 *   2. The evaluator wiring — `evaluateToolCall` synthesizes a deny
 *      with id `__sentinel/network-egress-default-deny__` after the
 *      user's allow tier and before the default-action fallback. An
 *      explicit user allow rule still wins.
 *
 * Like `matchers.adversarial.test.ts`, these tests are pure string
 * evaluation — the real network is never touched.
 */

import { describe, it, expect } from 'vitest';
import type { PermissionRule } from '@claude-sentinel/shared';
import { isLinkLocalOrMetadata, pickHost } from './matchers.js';
import {
  compileRules,
  evaluateToolCall,
  SYNTHETIC_NETWORK_EGRESS_DENY_ID,
  type EvaluatorSettingsView,
} from './evaluator.js';

function settings(overrides: Partial<EvaluatorSettingsView> = {}): EvaluatorSettingsView {
  return {
    toolPermissionsEnabled: true,
    toolPermissionDefaultAction: 'allow',
    toolPermissionSkipInAutoMode: true,
    toolPermissionAutoModeActive: false,
    denyPrivateNetworkByDefault: false,
    toolPermissionResolveSymlinks: false,
    ...overrides,
  };
}

function rule(overrides: Partial<PermissionRule>): PermissionRule {
  return {
    id: overrides.id ?? `r-${Math.random().toString(36).slice(2)}`,
    decision: overrides.decision ?? 'allow',
    tool: overrides.tool ?? 'WebFetch',
    pattern: overrides.pattern ?? null,
    raw: overrides.raw ?? 'WebFetch',
    note: overrides.note ?? null,
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 100,
    createdAt: overrides.createdAt ?? 0,
    source: overrides.source ?? 'local',
    projectScope: overrides.projectScope ?? null,
  };
}

describe('isLinkLocalOrMetadata: IPv4 link-local (169.254/16, includes IMDS)', () => {
  it('169.254.169.254 is link-local', () => {
    const r = isLinkLocalOrMetadata('169.254.169.254', false);
    expect(r).toEqual({ match: true, category: 'ipv4-link-local' });
  });

  it('169.254.0.1 (low end of /16) is link-local', () => {
    expect(isLinkLocalOrMetadata('169.254.0.1', false).match).toBe(true);
  });

  it('169.255.0.1 is NOT link-local (just outside /16)', () => {
    expect(isLinkLocalOrMetadata('169.255.0.1', false).match).toBe(false);
  });

  it('pickHost extracts hostname for evaluator integration', () => {
    expect(pickHost({ url: 'http://169.254.169.254/latest/meta-data/iam/' })).toBe(
      '169.254.169.254',
    );
    expect(pickHost({ url: 'https://169.254.169.254' })).toBe('169.254.169.254');
  });
});

describe('isLinkLocalOrMetadata: loopback / unspecified', () => {
  it('127.0.0.1 is loopback', () => {
    expect(isLinkLocalOrMetadata('127.0.0.1', false)).toEqual({
      match: true,
      category: 'ipv4-loopback',
    });
  });

  it('127.255.255.254 (high end of /8) is loopback', () => {
    expect(isLinkLocalOrMetadata('127.255.255.254', false).match).toBe(true);
  });

  it('128.0.0.1 is NOT loopback', () => {
    expect(isLinkLocalOrMetadata('128.0.0.1', false).match).toBe(false);
  });

  it('localhost (literal name) is matched', () => {
    expect(isLinkLocalOrMetadata('localhost', false)).toEqual({
      match: true,
      category: 'localhost-name',
    });
  });

  it('foo.localhost is matched', () => {
    expect(isLinkLocalOrMetadata('foo.localhost', false).match).toBe(true);
  });

  it('localhost.evil.com is NOT matched (suffix-confusion guard)', () => {
    expect(isLinkLocalOrMetadata('localhost.evil.com', false).match).toBe(false);
  });

  it('0.0.0.0 is unspecified', () => {
    expect(isLinkLocalOrMetadata('0.0.0.0', false)).toEqual({
      match: true,
      category: 'ipv4-unspecified',
    });
  });
});

describe('isLinkLocalOrMetadata: cloud-metadata FQDNs', () => {
  it('metadata.google.internal is matched (case-insensitive)', () => {
    expect(isLinkLocalOrMetadata('metadata.google.internal', false)).toEqual({
      match: true,
      category: 'cloud-metadata-fqdn',
    });
    expect(isLinkLocalOrMetadata('Metadata.Google.INTERNAL', false).match).toBe(true);
  });

  it('metadata.googleapis.com is matched', () => {
    expect(isLinkLocalOrMetadata('metadata.googleapis.com', false).match).toBe(true);
  });

  it('subdomains of metadata.google.internal are matched', () => {
    expect(isLinkLocalOrMetadata('foo.metadata.google.internal', false).match).toBe(true);
  });

  it('metadata.attacker.com.evil.com is NOT matched (suffix-confusion guard)', () => {
    expect(isLinkLocalOrMetadata('metadata.attacker.com.evil.com', false).match).toBe(false);
  });

  it('*.compute.internal is matched', () => {
    expect(isLinkLocalOrMetadata('ip-10-0-0-1.compute.internal', false)).toEqual({
      match: true,
      category: 'compute-internal-fqdn',
    });
    expect(isLinkLocalOrMetadata('compute.internal', false).match).toBe(true);
  });

  it('compute.internal.evil.com is NOT matched', () => {
    expect(isLinkLocalOrMetadata('compute.internal.evil.com', false).match).toBe(false);
  });
});

describe('isLinkLocalOrMetadata: IPv6 link-local + loopback', () => {
  it('fe80::1 is IPv6 link-local', () => {
    expect(isLinkLocalOrMetadata('fe80::1', false)).toEqual({
      match: true,
      category: 'ipv6-link-local',
    });
  });

  it('fe80::1 with surrounding brackets is matched (URL hostname keeps them)', () => {
    expect(isLinkLocalOrMetadata('[fe80::1]', false).match).toBe(true);
  });

  it('febf::1 (high end of fe80::/10) is matched', () => {
    expect(isLinkLocalOrMetadata('febf::1', false).match).toBe(true);
  });

  it('fec0::1 is NOT IPv6 link-local (outside /10)', () => {
    expect(isLinkLocalOrMetadata('fec0::1', false).match).toBe(false);
  });

  it('::1 is IPv6 loopback', () => {
    expect(isLinkLocalOrMetadata('::1', false)).toEqual({
      match: true,
      category: 'ipv6-loopback',
    });
  });

  it(':: is IPv6 unspecified', () => {
    expect(isLinkLocalOrMetadata('::', false)).toEqual({
      match: true,
      category: 'ipv6-unspecified',
    });
  });

  it('IPv4-mapped IPv6 ::ffff:169.254.169.254 still triggers link-local', () => {
    expect(isLinkLocalOrMetadata('::ffff:169.254.169.254', false)).toEqual({
      match: true,
      category: 'ipv6-mapped-ipv4',
    });
  });

  it('IPv4-mapped IPv6 ::ffff:8.8.8.8 (public) is NOT matched', () => {
    expect(isLinkLocalOrMetadata('::ffff:8.8.8.8', false).match).toBe(false);
  });
});

describe('isLinkLocalOrMetadata: RFC-1918 gated by includePrivateRanges', () => {
  it('10.1.2.3 NOT denied with the gate off', () => {
    expect(isLinkLocalOrMetadata('10.1.2.3', false).match).toBe(false);
  });

  it('10.1.2.3 denied with the gate on', () => {
    expect(isLinkLocalOrMetadata('10.1.2.3', true)).toEqual({
      match: true,
      category: 'ipv4-rfc1918',
    });
  });

  it('172.16.5.5 (low end of 12-bit) denied with gate on', () => {
    expect(isLinkLocalOrMetadata('172.16.5.5', true).match).toBe(true);
  });

  it('172.31.99.99 (high end of 12-bit) denied with gate on', () => {
    expect(isLinkLocalOrMetadata('172.31.99.99', true).match).toBe(true);
  });

  it('172.15.5.5 (just outside 12-bit) NOT denied even with gate on', () => {
    expect(isLinkLocalOrMetadata('172.15.5.5', true).match).toBe(false);
  });

  it('172.32.5.5 (just outside 12-bit upper) NOT denied even with gate on', () => {
    expect(isLinkLocalOrMetadata('172.32.5.5', true).match).toBe(false);
  });

  it('192.168.0.1 denied with gate on', () => {
    expect(isLinkLocalOrMetadata('192.168.0.1', true).match).toBe(true);
  });

  it('192.169.0.1 NOT denied even with gate on', () => {
    expect(isLinkLocalOrMetadata('192.169.0.1', true).match).toBe(false);
  });

  it('IPv4-mapped IPv6 RFC-1918 gated by setting (off → no match)', () => {
    expect(isLinkLocalOrMetadata('::ffff:10.0.0.1', false).match).toBe(false);
  });

  it('IPv4-mapped IPv6 RFC-1918 gated by setting (on → match)', () => {
    expect(isLinkLocalOrMetadata('::ffff:10.0.0.1', true).match).toBe(true);
  });
});

describe('isLinkLocalOrMetadata: public addresses + invalid input', () => {
  it('8.8.8.8 (public) NOT matched in either mode', () => {
    expect(isLinkLocalOrMetadata('8.8.8.8', false).match).toBe(false);
    expect(isLinkLocalOrMetadata('8.8.8.8', true).match).toBe(false);
  });

  it('example.com (regular FQDN) NOT matched', () => {
    expect(isLinkLocalOrMetadata('example.com', true).match).toBe(false);
  });

  it('empty string returns no match (no crash)', () => {
    expect(isLinkLocalOrMetadata('', false).match).toBe(false);
  });

  it('octets out of range fall through (e.g. 999.0.0.1 is not IPv4)', () => {
    expect(isLinkLocalOrMetadata('999.0.0.1', false).match).toBe(false);
  });
});

describe('evaluator: synthetic network-egress deny is wired in', () => {
  const compiled = compileRules([]);

  it('WebFetch to 169.254.169.254 is denied even with default-allow + no rules', () => {
    const res = evaluateToolCall(
      'WebFetch',
      { url: 'http://169.254.169.254/latest/meta-data/' },
      compiled,
      settings(),
    );
    expect(res.decision).toBe('deny');
    expect(res.matchedRule?.id).toBe(SYNTHETIC_NETWORK_EGRESS_DENY_ID);
    // Synthetic rule's pattern records the host so audit rows can show
    // exactly which address was blocked.
    expect(res.matchedRule?.pattern).toBe('domain:169.254.169.254');
    expect(res.matchedRule?.raw).toBe(`${SYNTHETIC_NETWORK_EGRESS_DENY_ID}(169.254.169.254)`);
    expect(res.reason).toMatch(/network-egress default \(ipv4-link-local\)/);
  });

  it('explicit user allow rule for the metadata host overrides the synthetic deny', () => {
    const compiledWithAllow = compileRules([
      rule({
        decision: 'allow',
        tool: 'WebFetch',
        pattern: 'domain:169.254.169.254',
        raw: 'WebFetch(domain:169.254.169.254)',
      }),
    ]);
    const res = evaluateToolCall(
      'WebFetch',
      { url: 'http://169.254.169.254/' },
      compiledWithAllow,
      settings(),
    );
    expect(res.decision).toBe('allow');
    expect(res.matchedRule?.id).not.toBe(SYNTHETIC_NETWORK_EGRESS_DENY_ID);
  });

  it('user deny rule still wins in the deny tier (synthetic never runs)', () => {
    const compiledWithDeny = compileRules([
      rule({
        decision: 'deny',
        tool: 'WebFetch',
        pattern: null,
        raw: 'WebFetch',
        id: 'user-rule-1',
      }),
    ]);
    const res = evaluateToolCall(
      'WebFetch',
      { url: 'http://169.254.169.254/' },
      compiledWithDeny,
      settings(),
    );
    expect(res.decision).toBe('deny');
    expect(res.matchedRule?.id).toBe('user-rule-1');
  });

  it('public WebFetch URL falls through to default-allow when no synthetic match', () => {
    const res = evaluateToolCall('WebFetch', { url: 'https://example.com/' }, compiled, settings());
    expect(res.decision).toBe('allow');
    expect(res.matchedRule).toBeNull();
  });

  it('RFC-1918 falls through to default-allow when setting is off', () => {
    const res = evaluateToolCall(
      'WebFetch',
      { url: 'http://10.0.0.1/' },
      compiled,
      settings({ denyPrivateNetworkByDefault: false }),
    );
    expect(res.decision).toBe('allow');
    expect(res.matchedRule).toBeNull();
  });

  it('RFC-1918 is synthetically denied when setting is on', () => {
    const res = evaluateToolCall(
      'WebFetch',
      { url: 'http://10.0.0.1/' },
      compiled,
      settings({ denyPrivateNetworkByDefault: true }),
    );
    expect(res.decision).toBe('deny');
    expect(res.matchedRule?.id).toBe(SYNTHETIC_NETWORK_EGRESS_DENY_ID);
    expect(res.matchedRule?.pattern).toBe('domain:10.0.0.1');
  });

  it('WebSearch is also gated (isWebTool covers both)', () => {
    const res = evaluateToolCall(
      'WebSearch',
      { query: 'http://169.254.169.254/' },
      compiled,
      settings(),
    );
    // WebSearch's input shape uses `query` not `url`; pickUrl picks
    // either, so a query that parses as a URL routes through.
    expect(res.decision).toBe('deny');
    expect(res.matchedRule?.id).toBe(SYNTHETIC_NETWORK_EGRESS_DENY_ID);
  });

  it('non-web tools do NOT get synthetic deny applied', () => {
    const res = evaluateToolCall(
      'Bash',
      { command: 'curl http://169.254.169.254/' },
      compiled,
      settings(),
    );
    // The synthetic gate is web-only; Bash falls to default-action.
    // (The Bash detector layer catches credential-shaped curl strings
    // separately; that's exercised in detectors.test.ts.)
    expect(res.decision).toBe('allow');
  });

  it('invalid URL input does not throw and falls through', () => {
    const res = evaluateToolCall('WebFetch', { url: 'not a url' }, compiled, settings());
    expect(res.decision).toBe('allow');
  });
});
