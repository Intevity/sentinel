/**
 * Disable / restore a user's native MCP server entry in Claude Code's config,
 * for the plain "turn this unused server off" action and for code-mode
 * migration (where the daemon bridges the server and the native entry must
 * stop loading its tool definitions).
 *
 * Mirrors mcp-install.ts: read-merge-write, preserve every key Sentinel
 * doesn't own, atomic temp+rename for `.mcp.json`. Scopes match Claude
 * Code's own:
 *   user    — `~/.claude.json` top-level `mcpServers[name]`
 *   local   — `~/.claude.json` `projects[dir].mcpServers[name]`
 *   project — `<dir>/.mcp.json` top-level `mcpServers[name]`
 *
 * Disabling removes the entry from `mcpServers` (which is what actually
 * stops Claude Code loading it). For `local` scope the name is additionally
 * recorded in the project's `disabledMcpServers` array — the canonical
 * marker Claude Code and our detector both read — so the server stays
 * visible as "disabled" rather than vanishing. The exact original entry is
 * returned for the caller to stash (Sentinel settings), making restore
 * byte-identical even for entries carrying env vars or auth headers.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { McpInstallScope } from '@sentinel/shared';
import { readClaudeState, writeClaudeState, getClaudeJsonPath } from '../../claude-state.js';

export interface ServerScopeRef {
  server: string;
  scope: McpInstallScope;
  /** Required for `local`/`project`; null for `user`. */
  directory: string | null;
}

export interface DisableResult {
  /** Absolute path of the config file written. */
  configPath: string;
  /** The exact entry removed from `mcpServers` — stash it for restore. */
  originalEntry: unknown;
}

// ── tiny JSON helpers (deliberate mirror of mcp-install.ts) ──────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function requireDir(scope: McpInstallScope, directory: string | null): string {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new Error(`${scope}-scope MCP server action requires a directory`);
  }
  return directory;
}

function mcpJsonPath(directory: string): string {
  return join(directory, '.mcp.json');
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return asRecord(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    // Malformed file: treat as empty so we don't crash. (A corrupt
    // .mcp.json is the user's to fix; we refuse to act on it below
    // because the server entry won't be found.)
    return {};
  }
}

function writeJsonObjectAtomic(path: string, obj: Record<string, unknown>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

// ── reads ─────────────────────────────────────────────────────────────────────

/** The server's current `mcpServers` entry at the given scope, or undefined
 *  when absent. Used by the migration flow to verify the server exists (and
 *  by the bridge to read connection config BEFORE the entry is removed). */
export function readNativeServerEntry(ref: ServerScopeRef): unknown {
  if (ref.scope === 'user') {
    return asRecord(readClaudeState()['mcpServers'])[ref.server];
  }
  if (ref.scope === 'local') {
    const dir = requireDir('local', ref.directory);
    const projects = asRecord(readClaudeState()['projects']);
    return asRecord(asRecord(projects[dir])['mcpServers'])[ref.server];
  }
  const dir = requireDir('project', ref.directory);
  return asRecord(readJsonObject(mcpJsonPath(dir))['mcpServers'])[ref.server];
}

/** True when the server is NOT currently present in `mcpServers` at the
 *  scope — i.e. the disable is still in effect. A hand-restored entry flips
 *  this back to false, which the status endpoint surfaces as drift. */
export function isNativeDisabled(ref: ServerScopeRef): boolean {
  return readNativeServerEntry(ref) === undefined;
}

export interface NativeServerEntry {
  scope: McpInstallScope;
  directory: string | null;
  entry: unknown;
}

/** Every `mcpServers` entry for the server across Claude Code's config
 *  surfaces: `~/.claude.json` top-level (user scope), each project's local
 *  scope, then each known project directory's `.mcp.json` (project scope) —
 *  user first, then projects in key order. Claude Code resolves same-named
 *  servers local-over-global, so migration must act on ALL of these —
 *  disabling only the global entry leaves every project with its own entry
 *  still loading the server natively. The `.mcp.json` scan is bounded by the
 *  project list `~/.claude.json` already tracks; no blind filesystem walk. */
export function findNativeServerEntries(server: string): NativeServerEntry[] {
  const state = readClaudeState();
  const out: NativeServerEntry[] = [];
  const top = asRecord(state['mcpServers']);
  if (server in top) out.push({ scope: 'user', directory: null, entry: top[server] });
  const projects = asRecord(state['projects']);
  for (const [dir, project] of Object.entries(projects)) {
    const servers = asRecord(asRecord(project)['mcpServers']);
    if (server in servers) out.push({ scope: 'local', directory: dir, entry: servers[server] });
  }
  for (const dir of Object.keys(projects)) {
    const servers = asRecord(readJsonObject(mcpJsonPath(dir))['mcpServers']);
    if (server in servers) out.push({ scope: 'project', directory: dir, entry: servers[server] });
  }
  return out;
}

// ── writes ────────────────────────────────────────────────────────────────────

/** Remove the server from `mcpServers` at the scope (recording it in the
 *  project's `disabledMcpServers` for `local`). Throws when the entry is
 *  absent — disabling something that isn't there is a caller bug, and
 *  proceeding would stash `undefined` as the restore payload. */
export function disableNativeServer(ref: ServerScopeRef): DisableResult {
  if (ref.scope === 'user') {
    const state = readClaudeState();
    const servers = asRecord(state['mcpServers']);
    if (!(ref.server in servers)) throw missingEntry(ref);
    const originalEntry = servers[ref.server];
    delete servers[ref.server];
    state['mcpServers'] = servers;
    writeClaudeState(state);
    return { configPath: getClaudeJsonPath(), originalEntry };
  }

  if (ref.scope === 'local') {
    const dir = requireDir('local', ref.directory);
    const state = readClaudeState();
    const projects = asRecord(state['projects']);
    const project = asRecord(projects[dir]);
    const servers = asRecord(project['mcpServers']);
    if (!(ref.server in servers)) throw missingEntry(ref);
    const originalEntry = servers[ref.server];
    delete servers[ref.server];
    const disabled = stringArray(project['disabledMcpServers']);
    if (!disabled.includes(ref.server)) disabled.push(ref.server);
    project['mcpServers'] = servers;
    project['disabledMcpServers'] = disabled;
    projects[dir] = project;
    state['projects'] = projects;
    writeClaudeState(state);
    return { configPath: getClaudeJsonPath(), originalEntry };
  }

  const dir = requireDir('project', ref.directory);
  const path = mcpJsonPath(dir);
  const obj = readJsonObject(path);
  const servers = asRecord(obj['mcpServers']);
  if (!(ref.server in servers)) throw missingEntry(ref);
  const originalEntry = servers[ref.server];
  delete servers[ref.server];
  obj['mcpServers'] = servers;
  writeJsonObjectAtomic(path, obj);
  return { configPath: path, originalEntry };
}

/** Put the stashed entry back into `mcpServers` at the scope and clear the
 *  `disabledMcpServers` marker (`local`). Overwrites any entry the user may
 *  have hand-added under the same name in the meantime — restore is an
 *  explicit user action and the stash is the contract. */
export function restoreNativeServer(ref: ServerScopeRef & { originalEntry: unknown }): {
  configPath: string;
} {
  if (ref.scope === 'user') {
    const state = readClaudeState();
    const servers = asRecord(state['mcpServers']);
    servers[ref.server] = ref.originalEntry;
    state['mcpServers'] = servers;
    writeClaudeState(state);
    return { configPath: getClaudeJsonPath() };
  }

  if (ref.scope === 'local') {
    const dir = requireDir('local', ref.directory);
    const state = readClaudeState();
    const projects = asRecord(state['projects']);
    const project = asRecord(projects[dir]);
    const servers = asRecord(project['mcpServers']);
    servers[ref.server] = ref.originalEntry;
    project['mcpServers'] = servers;
    const disabled = stringArray(project['disabledMcpServers']).filter((s) => s !== ref.server);
    project['disabledMcpServers'] = disabled;
    projects[dir] = project;
    state['projects'] = projects;
    writeClaudeState(state);
    return { configPath: getClaudeJsonPath() };
  }

  const dir = requireDir('project', ref.directory);
  const path = mcpJsonPath(dir);
  const obj = readJsonObject(path);
  const servers = asRecord(obj['mcpServers']);
  servers[ref.server] = ref.originalEntry;
  obj['mcpServers'] = servers;
  writeJsonObjectAtomic(path, obj);
  return { configPath: path };
}

function missingEntry(ref: ServerScopeRef): Error {
  return new Error(
    `MCP server '${ref.server}' not found in mcpServers at ${ref.scope} scope` +
      (ref.directory ? ` (${ref.directory})` : ''),
  );
}
