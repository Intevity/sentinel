import { describe, it, expect } from 'vitest';
import {
  getCuratedLibrary,
  getCuratedSubagent,
  curatedLibraryVersion,
  _resetCuratedLibraryCacheForTest,
} from './curated-library.js';

describe('curated library', () => {
  it('ships the curated subagent set with curated_ids stable across releases', () => {
    const lib = getCuratedLibrary();
    const ids = lib.map((s) => s.curatedId).sort();
    expect(ids).toEqual([
      'bash-loop-summarizer',
      'bulk-reader',
      'dep-tracer',
      'diff-pre-pass',
      'file-explorer',
      'log-analyzer',
      'output-formatter',
      'patch-applier',
      'repo-mapper',
      'test-failure-investigator',
      'test-runner-parser',
      'web-fetcher',
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
    expect(getCuratedSubagent('web-fetcher')).not.toBeNull();
    expect(getCuratedSubagent('test-failure-investigator')).not.toBeNull();
    expect(getCuratedSubagent('dep-tracer')).not.toBeNull();
    expect(getCuratedSubagent('patch-applier')).not.toBeNull();
    expect(getCuratedSubagent('bulk-reader')).not.toBeNull();
    expect(getCuratedSubagent('bash-loop-summarizer')).not.toBeNull();
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

  it('sonnet is reserved for medium-judgment agents (diff-pre-pass, patch-applier); the rest are haiku', () => {
    const byId = new Map(getCuratedLibrary().map((s) => [s.curatedId, s]));
    for (const id of ['diff-pre-pass', 'patch-applier']) {
      expect(byId.get(id)?.gap.model).toBe('sonnet');
    }
    for (const id of [
      'file-explorer',
      'test-runner-parser',
      'log-analyzer',
      'repo-mapper',
      'output-formatter',
      'web-fetcher',
      'test-failure-investigator',
      'dep-tracer',
      'bulk-reader',
      'bash-loop-summarizer',
    ]) {
      expect(byId.get(id)?.gap.model).toBe('haiku');
    }
  });
});
