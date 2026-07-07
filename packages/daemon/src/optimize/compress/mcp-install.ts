/**
 * Install / uninstall Sentinel's retrieval MCP server into Claude Code's
 * config at a chosen scope. Writes are read-merge-write and preserve every
 * key Sentinel doesn't own:
 *   user    — `~/.claude.json` top-level `mcpServers.sentinel`
 *   local   — `~/.claude.json` `projects[dir].mcpServers.sentinel`
 *   project — `<dir>/.mcp.json` top-level `mcpServers.sentinel` (committable)
 *
 * The server name is "sentinel", so Claude Code surfaces the tool as
 * `mcp__sentinel__retrieve`.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { McpInstallScope } from '@sentinel/shared';
import { readClaudeState, writeClaudeState, getClaudeJsonPath } from '../../claude-state.js';

export const MCP_SERVER_NAME = 'sentinel';

export interface McpServerEntry {
  type: 'http';
  url: string;
  headers: { Authorization: string };
  /** Load the tool eagerly rather than deferring it behind ToolSearch. Deferred
   *  MCP tools trip Claude Code bug #28580 (the persisted allow rule isn't
   *  consulted), so retrieve would prompt on every call. See mcp-retrieve-server. */
  alwaysLoad: true;
}

/** The MCP server config entry Claude Code connects to. */
export function buildMcpServerEntry(port: number, token: string): McpServerEntry {
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
    alwaysLoad: true,
  };
}

export interface InstallOpts {
  scope: McpInstallScope;
  /** Required for `local`/`project`; ignored for `user`. */
  directory: string | null;
  port: number;
  token: string;
}

export interface InstallResult {
  /** Absolute path of the config file written. */
  configPath: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function requireDir(scope: McpInstallScope, directory: string | null): string {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new Error(`${scope}-scope MCP install requires a directory`);
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
    // Malformed file: treat as empty so we don't crash, but we still preserve
    // nothing we can't parse. (A corrupt .mcp.json is the user's to fix.)
    return {};
  }
}

/** Atomic temp-file + rename write (mirrors claude-sync's pattern). */
function writeJsonObjectAtomic(path: string, obj: Record<string, unknown>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

/** Install the server entry at the given scope. Returns the config path. */
export function installMcpServer(opts: InstallOpts): InstallResult {
  const entry = buildMcpServerEntry(opts.port, opts.token);

  if (opts.scope === 'user') {
    const state = readClaudeState();
    const servers = asRecord(state['mcpServers']);
    servers[MCP_SERVER_NAME] = entry;
    state['mcpServers'] = servers;
    writeClaudeState(state);
    return { configPath: getClaudeJsonPath() };
  }

  if (opts.scope === 'local') {
    const dir = requireDir('local', opts.directory);
    const state = readClaudeState();
    const projects = asRecord(state['projects']);
    const project = asRecord(projects[dir]);
    const servers = asRecord(project['mcpServers']);
    servers[MCP_SERVER_NAME] = entry;
    project['mcpServers'] = servers;
    projects[dir] = project;
    state['projects'] = projects;
    writeClaudeState(state);
    return { configPath: getClaudeJsonPath() };
  }

  // project scope → .mcp.json in the directory (committable).
  const dir = requireDir('project', opts.directory);
  const path = mcpJsonPath(dir);
  const obj = readJsonObject(path);
  const servers = asRecord(obj['mcpServers']);
  servers[MCP_SERVER_NAME] = entry;
  obj['mcpServers'] = servers;
  writeJsonObjectAtomic(path, obj);
  return { configPath: path };
}

/** Remove the server entry at the given scope. Returns the config path (even
 *  if nothing was present). */
export function uninstallMcpServer(opts: {
  scope: McpInstallScope;
  directory: string | null;
}): InstallResult {
  if (opts.scope === 'user') {
    const state = readClaudeState();
    const servers = asRecord(state['mcpServers']);
    delete servers[MCP_SERVER_NAME];
    state['mcpServers'] = servers;
    writeClaudeState(state);
    return { configPath: getClaudeJsonPath() };
  }

  if (opts.scope === 'local') {
    const dir = requireDir('local', opts.directory);
    const state = readClaudeState();
    const projects = asRecord(state['projects']);
    const project = asRecord(projects[dir]);
    const servers = asRecord(project['mcpServers']);
    delete servers[MCP_SERVER_NAME];
    project['mcpServers'] = servers;
    projects[dir] = project;
    state['projects'] = projects;
    writeClaudeState(state);
    return { configPath: getClaudeJsonPath() };
  }

  const dir = requireDir('project', opts.directory);
  const path = mcpJsonPath(dir);
  if (existsSync(path)) {
    const obj = readJsonObject(path);
    const servers = asRecord(obj['mcpServers']);
    delete servers[MCP_SERVER_NAME];
    obj['mcpServers'] = servers;
    writeJsonObjectAtomic(path, obj);
  }
  return { configPath: path };
}

/** Whether the sentinel server entry is currently present at the given scope.
 *  Used to verify (and prune) stored install records. */
export function isMcpInstalled(opts: {
  scope: McpInstallScope;
  directory: string | null;
}): boolean {
  return readInstalledEntry(opts) !== null;
}

/** Read the currently-installed sentinel server entry at the given scope, or
 *  null if it isn't present (or the directory is missing for local/project). */
function readInstalledEntry(opts: {
  scope: McpInstallScope;
  directory: string | null;
}): Record<string, unknown> | null {
  let servers: Record<string, unknown>;
  if (opts.scope === 'user') {
    servers = asRecord(readClaudeState()['mcpServers']);
  } else if (opts.scope === 'local') {
    if (typeof opts.directory !== 'string' || opts.directory.length === 0) return null;
    const project = asRecord(asRecord(readClaudeState()['projects'])[opts.directory]);
    servers = asRecord(project['mcpServers']);
  } else {
    if (typeof opts.directory !== 'string' || opts.directory.length === 0) return null;
    servers = asRecord(readJsonObject(mcpJsonPath(opts.directory))['mcpServers']);
  }
  const entry = servers[MCP_SERVER_NAME];
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)
    : null;
}

/** True when the server is installed at the given scope but its entry predates
 *  the `alwaysLoad` flag — so Claude Code defers the tool via ToolSearch and
 *  trips bug #28580 (the persisted allow rule is ignored). The startup
 *  self-heal re-installs these entries so existing users recover with no
 *  action on their part. */
export function mcpInstallNeedsAlwaysLoad(opts: {
  scope: McpInstallScope;
  directory: string | null;
}): boolean {
  const entry = readInstalledEntry(opts);
  return entry !== null && entry['alwaysLoad'] !== true;
}
