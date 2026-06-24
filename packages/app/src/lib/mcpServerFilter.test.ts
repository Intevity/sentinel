import { describe, it, expect } from 'vitest';
import type { McpContextInsight, McpRecommendationBadge } from '@sentinel/shared';
import {
  filterMcpInsights,
  type McpServerChipState,
  type McpServerFilterState,
} from './mcpServerFilter.js';

/** Full McpContextInsight with sane defaults; override only what a case needs. */
function makeInsight(over: Partial<McpContextInsight> = {}): McpContextInsight {
  return {
    server: 'example',
    projects: [],
    mcpJsonProjects: [],
    enabled: true,
    global: false,
    managed: true,
    definition: { bytes: 0, estTokens: 0, toolCount: 0, requestCount: 0, measured: true },
    usage7d: { calls: 0, bytesIn: 0, bytesOut: 0, estTokens: 0 },
    cacheWriteEstUsd: 0,
    recommendations: [],
    bridgeStatus: 'native',
    ...over,
  };
}

const NO_CHIPS: McpServerChipState = {
  global: false,
  bridged: false,
  unused: false,
  recommended: false,
};

/** Base state: nothing filters (matches the panel before the user touches it,
 *  except hideUnmanaged which defaults on in the UI — set per-case here). */
function state(over: Partial<McpServerFilterState> = {}): McpServerFilterState {
  return { search: '', hideUnmanaged: false, chips: { ...NO_CHIPS }, ...over };
}

function names(result: { visible: McpContextInsight[] }): string[] {
  return result.visible.map((i) => i.server);
}

describe('filterMcpInsights — hide-unmanaged toggle', () => {
  const insights = [
    makeInsight({ server: 'managed-a', managed: true }),
    makeInsight({ server: 'external-b', managed: false }),
    makeInsight({ server: 'managed-c', managed: true }),
  ];

  it('drops managed===false rows and counts them when the toggle is on', () => {
    const r = filterMcpInsights(insights, state({ hideUnmanaged: true }));
    expect(names(r)).toEqual(['managed-a', 'managed-c']);
    expect(r.hiddenUnmanaged).toBe(1);
  });

  it('keeps every row and reports zero hidden when the toggle is off', () => {
    const r = filterMcpInsights(insights, state({ hideUnmanaged: false }));
    expect(names(r)).toEqual(['managed-a', 'external-b', 'managed-c']);
    expect(r.hiddenUnmanaged).toBe(0);
  });
});

describe('filterMcpInsights — search (server name only)', () => {
  const insights = [
    makeInsight({ server: 'MongoDB' }),
    makeInsight({ server: 'github' }),
    makeInsight({ server: 'mongo-atlas' }),
  ];

  it('matches case-insensitively on a substring of the server name', () => {
    expect(names(filterMcpInsights(insights, state({ search: 'mongo' })))).toEqual([
      'MongoDB',
      'mongo-atlas',
    ]);
  });

  it('excludes servers whose name does not contain the query', () => {
    expect(names(filterMcpInsights(insights, state({ search: 'slack' })))).toEqual([]);
  });

  it('trims surrounding whitespace before matching', () => {
    expect(names(filterMcpInsights(insights, state({ search: '  github  ' })))).toEqual(['github']);
  });

  it('an empty (or whitespace-only) query matches everything', () => {
    expect(names(filterMcpInsights(insights, state({ search: '   ' })))).toHaveLength(3);
  });

  it('does NOT match against project paths — name only', () => {
    const withProject = [makeInsight({ server: 'github', projects: ['/Users/x/mongo-app'] })];
    expect(names(filterMcpInsights(withProject, state({ search: 'mongo' })))).toEqual([]);
  });
});

describe('filterMcpInsights — quick-filter chips', () => {
  const unusedBadge: McpRecommendationBadge = { kind: 'unused' };
  const codeModeBadge: McpRecommendationBadge = { kind: 'code-mode' };
  const insights = [
    makeInsight({ server: 'global-one', global: true }),
    makeInsight({ server: 'bridged-one', bridgeStatus: 'bridged' }),
    makeInsight({ server: 'unused-one', recommendations: [unusedBadge] }),
    makeInsight({ server: 'recommended-one', recommendations: [codeModeBadge] }),
    makeInsight({ server: 'plain-one' }),
  ];

  it('no active chip imposes no constraint (pass-through)', () => {
    expect(names(filterMcpInsights(insights, state()))).toHaveLength(5);
  });

  it('global chip keeps only user-scope servers', () => {
    const r = filterMcpInsights(insights, state({ chips: { ...NO_CHIPS, global: true } }));
    expect(names(r)).toEqual(['global-one']);
  });

  it('bridged chip keeps only bridgeStatus==="bridged"', () => {
    const r = filterMcpInsights(insights, state({ chips: { ...NO_CHIPS, bridged: true } }));
    expect(names(r)).toEqual(['bridged-one']);
  });

  it('unused chip keeps only servers carrying the unused recommendation', () => {
    const r = filterMcpInsights(insights, state({ chips: { ...NO_CHIPS, unused: true } }));
    expect(names(r)).toEqual(['unused-one']);
  });

  it('recommended chip keeps only servers carrying the code-mode recommendation', () => {
    const r = filterMcpInsights(insights, state({ chips: { ...NO_CHIPS, recommended: true } }));
    expect(names(r)).toEqual(['recommended-one']);
  });

  it('two active chips OR together', () => {
    const r = filterMcpInsights(
      insights,
      state({ chips: { ...NO_CHIPS, global: true, bridged: true } }),
    );
    expect(names(r)).toEqual(['global-one', 'bridged-one']);
  });
});

describe('filterMcpInsights — combined constraints', () => {
  it('AND-combines managed, search, and the chip OR-group; preserves order', () => {
    const insights = [
      makeInsight({ server: 'mongo-global', global: true, managed: true }),
      makeInsight({ server: 'mongo-external', global: true, managed: false }),
      makeInsight({ server: 'mongo-plain', global: false, managed: true }),
      makeInsight({ server: 'github-global', global: true, managed: true }),
    ];
    const r = filterMcpInsights(
      insights,
      state({ search: 'mongo', hideUnmanaged: true, chips: { ...NO_CHIPS, global: true } }),
    );
    // github-global fails search; mongo-external fails managed; mongo-plain
    // fails the global chip. Only mongo-global satisfies all three.
    expect(names(r)).toEqual(['mongo-global']);
    expect(r.hiddenUnmanaged).toBe(1);
  });

  it('returns an empty visible list (not an error) when nothing matches', () => {
    const insights = [makeInsight({ server: 'a' }), makeInsight({ server: 'b' })];
    const r = filterMcpInsights(insights, state({ search: 'zzz' }));
    expect(r.visible).toEqual([]);
    expect(r.hiddenUnmanaged).toBe(0);
  });
});
