/**
 * Detect Claude Code's per-project memory directories. These live at
 * `~/.claude/projects/<id>/memory/` and are loaded into every request's
 * context. We report file count + total bytes per project so the user
 * can see which projects accumulated the most memory state.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface DetectedMemoryDir {
  /** Project id directory name under `~/.claude/projects/`. */
  projectId: string;
  fileCount: number;
  totalBytes: number;
}

/**
 * Walk `<home>/.claude/projects/*\/memory/` and return aggregate
 * stats per project. Skips projects that don't have a memory dir
 * altogether — those contribute nothing to surface.
 */
export function detectMemoryDirs(homeOverride?: string): DetectedMemoryDir[] {
  const home = homeOverride ?? homedir();
  const root = join(home, '.claude', 'projects');
  if (!existsSync(root)) return [];

  let projectIds: string[];
  try {
    projectIds = readdirSync(root);
    /* v8 ignore next 3 — readdir can fail on permissions errors; surface as empty inventory */
  } catch {
    return [];
  }

  const out: DetectedMemoryDir[] = [];
  for (const projectId of projectIds) {
    const memDir = join(root, projectId, 'memory');
    if (!existsSync(memDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(memDir);
      /* v8 ignore next 3 */
    } catch {
      continue;
    }
    let fileCount = 0;
    let totalBytes = 0;
    for (const entry of entries) {
      const full = join(memDir, entry);
      try {
        const stat = statSync(full);
        if (!stat.isFile()) continue;
        fileCount += 1;
        totalBytes += stat.size;
        /* v8 ignore next 3 */
      } catch {
        /* ignore individual file read errors */
      }
    }
    if (fileCount === 0) continue;
    out.push({ projectId, fileCount, totalBytes });
  }
  return out;
}
