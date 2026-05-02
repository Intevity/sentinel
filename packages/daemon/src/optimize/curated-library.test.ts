import { describe, it, expect } from 'vitest';
import {
  getCuratedLibrary,
  getCuratedSubagent,
  curatedLibraryVersion,
  _resetCuratedLibraryCacheForTest,
} from './curated-library.js';

describe('curated library', () => {
  it('ships exactly the v1 set of six subagents', () => {
    const lib = getCuratedLibrary();
    const ids = lib.map((s) => s.curatedId).sort();
    expect(ids).toEqual([
      'diff-pre-pass',
      'file-explorer',
      'log-analyzer',
      'output-formatter',
      'repo-mapper',
      'test-runner-parser',
    ]);
  });

  it('every entry has a non-empty rendered .md and 64-char fingerprint', () => {
    for (const s of getCuratedLibrary()) {
      expect(s.renderedMd.length).toBeGreaterThan(100);
      expect(s.renderedMd.startsWith('---\n')).toBe(true);
      expect(s.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('every entry references its curated_id in frontmatter name', () => {
    for (const s of getCuratedLibrary()) {
      expect(s.renderedMd).toMatch(new RegExp(`^name: ${s.curatedId}$`, 'm'));
    }
  });

  it('curated_ids are stable strings used by analyzer heuristics', () => {
    // Defensive — these names are the contract between
    // optimization-analyzer.ts and the install path.
    expect(getCuratedSubagent('file-explorer')).not.toBeNull();
    expect(getCuratedSubagent('test-runner-parser')).not.toBeNull();
    expect(getCuratedSubagent('log-analyzer')).not.toBeNull();
    expect(getCuratedSubagent('repo-mapper')).not.toBeNull();
    expect(getCuratedSubagent('diff-pre-pass')).not.toBeNull();
    expect(getCuratedSubagent('output-formatter')).not.toBeNull();
    expect(getCuratedSubagent('does-not-exist')).toBeNull();
  });

  it('curated entries cache the rendered content across calls', () => {
    _resetCuratedLibraryCacheForTest();
    const a = getCuratedLibrary();
    const b = getCuratedLibrary();
    expect(a).toBe(b);
    expect(a[0]).toBe(b[0]);
  });

  it('library version is a 12-char hex digest', () => {
    expect(curatedLibraryVersion()).toMatch(/^[0-9a-f]{12}$/);
  });

  it('every curated subagent has model set explicitly (not inherit)', () => {
    // v1 design: every curated subagent picks its own model. Inherit
    // would defeat the cost-routing premise.
    for (const s of getCuratedLibrary()) {
      expect(s.gap.model).not.toBe('inherit');
    }
  });

  it('diff-pre-pass uses sonnet, all others use haiku', () => {
    const byId = new Map(getCuratedLibrary().map((s) => [s.curatedId, s]));
    expect(byId.get('diff-pre-pass')?.gap.model).toBe('sonnet');
    for (const id of [
      'file-explorer',
      'test-runner-parser',
      'log-analyzer',
      'repo-mapper',
      'output-formatter',
    ]) {
      expect(byId.get(id)?.gap.model).toBe('haiku');
    }
  });
});
