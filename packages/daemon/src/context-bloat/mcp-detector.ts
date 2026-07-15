/**
 * Detect MCP servers configured in `~/.claude.json`. Claude Code stores
 * MCP servers per-project (keyed under `projects[<absolute path>]`),
 * with a parallel `disabledMcpServers` array. We surface both so the
 * Optimize tab can show users every server contributing to their
 * context — including ones already disabled (so they remember they
 * exist) — and the project they're scoped to.
 */

export interface DetectedMcpServer {
  /** Absolute project path key from `~/.claude.json:projects`. */
  project: string;
  /** Server name as it appears under `mcpServers`, OR an entry from
   *  `disabledMcpServers` (for those, `enabled` is false). */
  name: string;
  enabled: boolean;
}

/** Top-level shape we care about. We don't import `ClaudeState` from
 *  shared because the MCP keys aren't part of its public surface — and
 *  spelling them out here makes the parsing rules explicit. */
interface ClaudeJsonShape {
  projects?: Record<string, ProjectEntry>;
}

interface ProjectEntry {
  mcpServers?: Record<string, unknown>;
  disabledMcpServers?: string[];
}

/**
 * Pure parse: takes the already-deserialised JSON and returns one row
 * per (project × server). Order: enabled servers first, then disabled,
 * preserving each project's project-key order. The dashboard sorts by
 * estimated cost downstream.
 */
export function detectMcpServers(state: unknown): DetectedMcpServer[] {
  if (!state || typeof state !== 'object') return [];
  const projects = (state as ClaudeJsonShape).projects;
  if (!projects || typeof projects !== 'object') return [];

  const out: DetectedMcpServer[] = [];
  for (const [project, entry] of Object.entries(projects)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as ProjectEntry;
    if (e.mcpServers && typeof e.mcpServers === 'object') {
      for (const name of Object.keys(e.mcpServers)) {
        out.push({ project, name, enabled: true });
      }
    }
    if (Array.isArray(e.disabledMcpServers)) {
      for (const name of e.disabledMcpServers) {
        if (typeof name !== 'string') continue;
        out.push({ project, name, enabled: false });
      }
    }
  }
  return out;
}

/** Pseudo-project labels for MCP config surfaces that aren't a project
 *  directory. The inventory panel renders `project` verbatim, so these read
 *  as scope tags rather than paths. */
export const USER_SCOPE_LABEL = '(user)';
export const DESKTOP_SCOPE_LABEL = '(claude desktop)';

/**
 * User-scope servers from the top level of `~/.claude.json:mcpServers` —
 * these load into every CLI project, so a context inventory that omits them
 * (as this module did before Desktop support) undercounts the biggest
 * always-on contributors.
 */
export function detectUserScopeMcpServers(state: unknown): string[] {
  if (!state || typeof state !== 'object') return [];
  const servers = (state as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  return Object.keys(servers);
}

/**
 * Local MCP servers Claude Desktop spawns from `claude_desktop_config.json:
 * mcpServers` (stdio entries — includes Sentinel's own bridge entry when
 * desktop routing is on). The desktop app injects these into its Chat and
 * embedded Code sessions, so they contribute request context exactly like
 * the CLI's servers do.
 */
export function detectDesktopMcpServers(desktopConfig: unknown): string[] {
  if (!desktopConfig || typeof desktopConfig !== 'object') return [];
  const servers = (desktopConfig as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return [];
  return Object.keys(servers);
}
