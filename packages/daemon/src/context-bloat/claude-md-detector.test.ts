import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectClaudeMdFiles } from './claude-md-detector.js';

describe('detectClaudeMdFiles', () => {
  let homeDir: string;
  let projectA: string;
  let projectB: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'sentinel-claudemd-'));
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    projectA = mkdtempSync(join(tmpdir(), 'projA-'));
    projectB = mkdtempSync(join(tmpdir(), 'projB-'));
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  });

  it('detects the global ~/.claude/CLAUDE.md when present', () => {
    writeFileSync(join(homeDir, '.claude', 'CLAUDE.md'), 'global rules\n');
    const out = detectClaudeMdFiles({}, homeDir);
    expect(out).toHaveLength(1);
    expect(out[0]?.scope).toBe('global');
    expect(out[0]?.sizeBytes).toBeGreaterThan(0);
  });

  it('skips global CLAUDE.md when absent', () => {
    const out = detectClaudeMdFiles({}, homeDir);
    expect(out).toHaveLength(0);
  });

  it('detects project CLAUDE.md files for keys in projects map', () => {
    writeFileSync(join(projectA, 'CLAUDE.md'), 'project A guide\n');
    writeFileSync(join(projectB, 'CLAUDE.md'), 'project B much longer file\n');
    const state = {
      projects: {
        [projectA]: {},
        [projectB]: {},
        '/non/existent/project': {},
      },
    };
    const out = detectClaudeMdFiles(state, homeDir);
    // Only existing files emit rows; the non-existent project is silently skipped.
    expect(out.map((f) => f.scope)).toEqual(['project', 'project']);
    const paths = out.map((f) => f.path).sort();
    expect(paths).toEqual([join(projectA, 'CLAUDE.md'), join(projectB, 'CLAUDE.md')].sort());
  });

  it('reports both global and project scopes in one call', () => {
    writeFileSync(join(homeDir, '.claude', 'CLAUDE.md'), 'global\n');
    writeFileSync(join(projectA, 'CLAUDE.md'), 'project\n');
    const out = detectClaudeMdFiles({ projects: { [projectA]: {} } }, homeDir);
    const scopes = out.map((f) => f.scope).sort();
    expect(scopes).toEqual(['global', 'project']);
  });

  it('returns [] when state has no projects key', () => {
    const out = detectClaudeMdFiles({}, homeDir);
    expect(out).toEqual([]);
  });

  it('handles non-object state input', () => {
    expect(detectClaudeMdFiles(null, homeDir)).toEqual([]);
    expect(detectClaudeMdFiles('foo', homeDir)).toEqual([]);
  });
});
