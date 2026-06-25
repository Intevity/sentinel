import { describe, it, expect } from 'vitest';
import type { PermissionBypassEntry } from '@sentinel/shared';
import { filterBypasses } from './bypassFilter.js';

/** Full PermissionBypassEntry with sane defaults; override only what a case needs. */
function makeEntry(over: Partial<PermissionBypassEntry> = {}): PermissionBypassEntry {
  return {
    id: 1,
    ruleId: 'rule-1',
    toolName: 'Bash',
    inputHash: 'abc123',
    mask: 'rm -rf /tmp/demo',
    note: null,
    createdAt: 0,
    ...over,
  };
}

const names = (entries: PermissionBypassEntry[]): string[] => entries.map((e) => e.toolName);

describe('filterBypasses', () => {
  const entries = [
    makeEntry({ id: 1, toolName: 'Bash', mask: 'rm -rf /tmp/demo', note: null }),
    makeEntry({ id: 2, toolName: 'WebFetch', mask: 'domain:example.com', note: 'docs site' }),
    makeEntry({ id: 3, toolName: 'Read', mask: '/etc/hosts', note: null }),
  ];

  it('returns the same array reference for an empty query (no-op)', () => {
    expect(filterBypasses(entries, '')).toBe(entries);
  });

  it('returns the same array reference for a whitespace-only query (no-op)', () => {
    expect(filterBypasses(entries, '   ')).toBe(entries);
  });

  it('matches on tool name, case-insensitively', () => {
    expect(names(filterBypasses(entries, 'bash'))).toEqual(['Bash']);
  });

  it('matches on the mask', () => {
    expect(names(filterBypasses(entries, 'example.com'))).toEqual(['WebFetch']);
  });

  it('matches on the note', () => {
    expect(names(filterBypasses(entries, 'docs'))).toEqual(['WebFetch']);
  });

  it('treats a null note as empty without throwing', () => {
    // 'docs' lives only in entry #2's note; entries #1 and #3 have null notes
    // and must be skipped via the `?? ''` arm rather than crashing.
    expect(() => filterBypasses(entries, 'docs')).not.toThrow();
    expect(filterBypasses(entries, 'docs')).toHaveLength(1);
  });

  it('trims surrounding whitespace before matching', () => {
    expect(names(filterBypasses(entries, '  read  '))).toEqual(['Read']);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterBypasses(entries, 'zzz-no-match')).toEqual([]);
  });
});
