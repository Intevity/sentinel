/**
 * Detect CLAUDE.md files contributing to every Claude Code request's
 * context. Two scopes:
 *   - global: `~/.claude/CLAUDE.md` (loaded for every project)
 *   - project: `<project>/CLAUDE.md` for each project key in
 *     `~/.claude.json:projects`
 *
 * We report path + size; the dashboard sums sizes for the header.
 */

import { existsSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export type ClaudeMdScope = 'global' | 'project';

export interface DetectedClaudeMd {
  path: string;
  sizeBytes: number;
  scope: ClaudeMdScope;
}

interface ClaudeJsonShape {
  projects?: Record<string, unknown>;
}

/**
 * Walk both scopes and return only files that exist. The home directory
 * is overridable via `homeOverride` so tests can point at a fixture
 * without touching the real `~/.claude/`.
 */
export function detectClaudeMdFiles(state: unknown, homeOverride?: string): DetectedClaudeMd[] {
  const home = homeOverride ?? homedir();
  const out: DetectedClaudeMd[] = [];

  const globalPath = join(home, '.claude', 'CLAUDE.md');
  if (existsSync(globalPath)) {
    try {
      const stat = statSync(globalPath);
      out.push({ path: globalPath, sizeBytes: stat.size, scope: 'global' });
      /* v8 ignore next 3 — defensive for race between existsSync and statSync */
    } catch {
      /* ignore */
    }
  }

  if (state && typeof state === 'object') {
    const projects = (state as ClaudeJsonShape).projects;
    if (projects && typeof projects === 'object') {
      for (const project of Object.keys(projects)) {
        const path = join(project, 'CLAUDE.md');
        if (!existsSync(path)) continue;
        try {
          const stat = statSync(path);
          out.push({ path, sizeBytes: stat.size, scope: 'project' });
          /* v8 ignore next 3 */
        } catch {
          /* ignore */
        }
      }
    }
  }

  return out;
}
