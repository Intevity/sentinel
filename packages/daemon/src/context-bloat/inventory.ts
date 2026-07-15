/**
 * Compose the full ContextInventory the dashboard renders. Reads
 * `~/.claude.json` and `~/.claude/settings.json`, walks
 * `~/.claude/projects/*\/memory/`, and joins MCP usage from
 * `tool_calls` to produce a single snapshot for the UI.
 *
 * Test seam: `SENTINEL_TEST_CLAUDE_JSON` overrides the
 * claude.json path (already honored by `getClaudeJsonPath`), and
 * `SENTINEL_TEST_HOME` overrides the home directory used for
 * `~/.claude/...` lookups (settings.json, CLAUDE.md, memory dirs).
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type Database from 'better-sqlite3';
import type { ContextInventory } from '@sentinel/shared';
import { getClaudeJsonPath } from '../claude-state.js';
import { desktopAppConfigPath } from '../claude-desktop-config.js';
import { listSubagentInstalls } from '../db.js';
import {
  detectMcpServers,
  detectUserScopeMcpServers,
  detectDesktopMcpServers,
  USER_SCOPE_LABEL,
  DESKTOP_SCOPE_LABEL,
} from './mcp-detector.js';
import { detectClaudeMdFiles } from './claude-md-detector.js';
import { detectMemoryDirs } from './memory-detector.js';
import { detectPlugins } from './plugin-detector.js';
import { estimateMcpCosts } from './mcp-cost-estimator.js';

function resolveHome(): string {
  return process.env['SENTINEL_TEST_HOME'] ?? homedir();
}

function safeReadJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    /* v8 ignore next 3 — defensive against corrupted user state */
  } catch {
    return null;
  }
}

export function buildContextInventory(db: Database.Database): ContextInventory {
  const home = resolveHome();

  const claudeJson = safeReadJson(getClaudeJsonPath());
  const settings = safeReadJson(join(home, '.claude', 'settings.json'));

  // MCP servers from every configured surface, tagged by scope:
  //   - per-project entries in ~/.claude.json (absolute path as before)
  //   - user-scope entries at the top of ~/.claude.json ("(user)") — these
  //     load into every CLI project and were previously invisible here
  //   - Claude Desktop's claude_desktop_config.json ("(claude desktop)") —
  //     the desktop app injects these into Chat and its embedded Code
  //     sessions, including Sentinel's own bridge entry
  const mcpServersRaw = [
    ...detectMcpServers(claudeJson),
    ...detectUserScopeMcpServers(claudeJson).map((name) => ({
      project: USER_SCOPE_LABEL,
      name,
      enabled: true,
    })),
    ...detectDesktopMcpServers(safeReadJson(desktopAppConfigPath())).map((name) => ({
      project: DESKTOP_SCOPE_LABEL,
      name,
      enabled: true,
    })),
  ];
  const mcpCosts = estimateMcpCosts(db);
  const costsByServer = new Map(mcpCosts.map((c) => [c.server, c]));

  const mcpServers = mcpServersRaw.map((s) => {
    const cost = costsByServer.get(s.name);
    return {
      project: s.project,
      name: s.name,
      enabled: s.enabled,
      recent7d: {
        calls: cost?.callCount ?? 0,
        bytesIn: cost?.bytesIn ?? 0,
        bytesOut: cost?.bytesOut ?? 0,
        estimatedTokens: cost?.estimatedTokens ?? 0,
      },
    };
  });
  // Heaviest tokens first; ties broken by call count desc, then name.
  mcpServers.sort((a, b) => {
    if (b.recent7d.estimatedTokens !== a.recent7d.estimatedTokens) {
      return b.recent7d.estimatedTokens - a.recent7d.estimatedTokens;
    }
    if (b.recent7d.calls !== a.recent7d.calls) return b.recent7d.calls - a.recent7d.calls;
    return a.name.localeCompare(b.name);
  });

  const claudeMdFiles = detectClaudeMdFiles(claudeJson, home).sort(
    (a, b) => b.sizeBytes - a.sizeBytes,
  );

  const memoryDirs = detectMemoryDirs(home).sort((a, b) => b.totalBytes - a.totalBytes);

  const plugins = detectPlugins(settings);

  // Globally enabled subagents = currently-active rows in
  // subagent_installs. Reuse the existing query — context-bloat doesn't
  // own a separate concept of "global subagent."
  const globalSubagents = listSubagentInstalls(db)
    .filter((s) => s.uninstalledAt === null)
    .map((s) => ({ name: s.name, source: s.source }));

  return {
    mcpServers,
    claudeMdFiles,
    memoryDirs,
    plugins,
    globalSubagents,
  };
}
