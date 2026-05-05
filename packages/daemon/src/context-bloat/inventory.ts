/**
 * Compose the full ContextInventory the dashboard renders. Reads
 * `~/.claude.json` and `~/.claude/settings.json`, walks
 * `~/.claude/projects/*\/memory/`, and joins MCP usage from
 * `tool_calls` to produce a single snapshot for the UI.
 *
 * Test seam: `CLAUDE_SENTINEL_TEST_CLAUDE_JSON` overrides the
 * claude.json path (already honored by `getClaudeJsonPath`), and
 * `CLAUDE_SENTINEL_TEST_HOME` overrides the home directory used for
 * `~/.claude/...` lookups (settings.json, CLAUDE.md, memory dirs).
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type Database from 'better-sqlite3';
import type { ContextInventory } from '@claude-sentinel/shared';
import { getClaudeJsonPath } from '../claude-state.js';
import { listSubagentInstalls } from '../db.js';
import { detectMcpServers } from './mcp-detector.js';
import { detectClaudeMdFiles } from './claude-md-detector.js';
import { detectMemoryDirs } from './memory-detector.js';
import { detectPlugins } from './plugin-detector.js';
import { estimateMcpCosts } from './mcp-cost-estimator.js';

function resolveHome(): string {
  return process.env['CLAUDE_SENTINEL_TEST_HOME'] ?? homedir();
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

  const mcpServersRaw = detectMcpServers(claudeJson);
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
