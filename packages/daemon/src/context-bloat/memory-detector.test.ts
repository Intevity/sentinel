import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectMemoryDirs } from './memory-detector.js';

describe('detectMemoryDirs', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'sentinel-mem-'));
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  function seed(projectId: string, files: Record<string, string>): void {
    const dir = join(homeDir, '.claude', 'projects', projectId, 'memory');
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
  }

  it('returns [] when ~/.claude/projects does not exist', () => {
    expect(detectMemoryDirs(homeDir)).toEqual([]);
  });

  it('aggregates fileCount + totalBytes per project', () => {
    seed('proj-a', { 'a.md': 'aaa', 'b.md': 'bbbbb' });
    seed('proj-b', { 'x.md': 'x'.repeat(1000) });
    const out = detectMemoryDirs(homeDir);
    expect(out).toHaveLength(2);
    const a = out.find((d) => d.projectId === 'proj-a');
    const b = out.find((d) => d.projectId === 'proj-b');
    expect(a?.fileCount).toBe(2);
    expect(a?.totalBytes).toBe(8); // 3 + 5
    expect(b?.fileCount).toBe(1);
    expect(b?.totalBytes).toBe(1000);
  });

  it('skips projects whose memory dir is missing', () => {
    // Create a project dir without a `memory/` subfolder.
    mkdirSync(join(homeDir, '.claude', 'projects', 'no-memory'), { recursive: true });
    seed('has-memory', { 'a.md': 'x' });
    const out = detectMemoryDirs(homeDir);
    expect(out).toHaveLength(1);
    expect(out[0]?.projectId).toBe('has-memory');
  });

  it('skips projects whose memory dir is empty', () => {
    // Create memory dir but no files. fileCount=0 → skipped.
    mkdirSync(join(homeDir, '.claude', 'projects', 'empty', 'memory'), {
      recursive: true,
    });
    expect(detectMemoryDirs(homeDir)).toEqual([]);
  });
});
