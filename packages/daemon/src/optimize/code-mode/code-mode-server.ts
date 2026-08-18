/**
 * Loopback HTTP endpoint for the code-mode bridge: `POST /code-mode/call`
 * with body `{ server, tool, args }` invokes a tool on a bridged MCP server
 * via the daemon's client manager and returns the result as plain JSON.
 *
 * This is what the sentinel-code-mode skill's curl one-liner hits — the
 * replacement for carrying the server's tool definitions in every Claude
 * request. Call flow stays inside Claude Code's existing Bash permission
 * model; Sentinel adds no auto-allow rules.
 *
 * Security layers, in order:
 *   1. Loopback only (the proxy binds 127.0.0.1).
 *   2. Constant-time bearer token (separate from the retrieval token).
 *   3. `codeModeEnabled` master switch.
 *   4. Per-server allowlist inside the client manager (recorded migrations).
 *   5. Request body cap + response size cap (manager-side).
 *   6. Audit row per call — metadata only, never args or results.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CodeModeAuditRow } from '@sentinel/shared';
import { bearerAuthorized } from '../compress/mcp-retrieve-server.js';
import type { McpClientManager, McpToolDescriptor } from './mcp-client-manager.js';

export type CodeModeHttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer | null,
  /** Path the proxy matched, minus the query string. Defaults to the call
   *  endpoint so existing callers (and tests) keep working unchanged. */
  path?: string,
) => Promise<void>;

/** Endpoint paths this handler serves. */
export const CODE_MODE_CALL_PATH = '/code-mode/call';
export const CODE_MODE_RESTART_PATH = '/code-mode/restart';

/** Minimum gap between restarts of the same server. Restart is reachable by
 *  agents, and an agent that reads a failure as "try again" can otherwise pin a
 *  server in a spawn loop — each iteration costing a real process spawn. */
const RESTART_COOLDOWN_MS = 5000;

/** Requests larger than this are refused outright — tool arguments have no
 *  business being megabytes. */
const MAX_REQUEST_BYTES = 256 * 1024;

export interface CodeModeServerDeps {
  manager: McpClientManager;
  getToken: () => string;
  /** Live read of `settings.codeModeEnabled` — the master switch. */
  isEnabled: () => boolean;
  /** Audit sink (ContextCostStore.recordCall). Metadata only. */
  recordCall: (row: CodeModeAuditRow) => void;
  /** Invoked after a successful restart so the daemon can regenerate the tool
   *  docs and broadcast status. Optional: omitting it leaves the endpoint
   *  purely a reconnect. */
  onRestarted?: (server: string, tools: McpToolDescriptor[]) => Promise<void>;
  /** Test seam. */
  restartCooldownMs?: number;
}

interface RestartRequest {
  server: string;
  cwd?: string;
}

function parseRestartRequest(body: Buffer | null): RestartRequest | null {
  if (!body || body.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf-8')) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;
  if (typeof r['server'] !== 'string' || r['server'].length === 0) return null;
  return {
    server: r['server'],
    ...(typeof r['cwd'] === 'string' ? { cwd: r['cwd'] } : {}),
  };
}

interface CallRequest {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  /** Calling directory, so a server configured per-project resolves to THAT
   *  project's credentials. Optional and backwards-compatible: omitting it
   *  falls back to the deterministic record (user scope first). */
  cwd?: string;
}

function parseCallRequest(body: Buffer | null): CallRequest | null {
  if (!body || body.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o['server'] !== 'string' || o['server'].length === 0) return null;
  if (typeof o['tool'] !== 'string' || o['tool'].length === 0) return null;
  const args =
    o['args'] && typeof o['args'] === 'object' && !Array.isArray(o['args'])
      ? (o['args'] as Record<string, unknown>)
      : {};
  const cwd = typeof o['cwd'] === 'string' && o['cwd'].length > 0 ? o['cwd'] : undefined;
  return { server: o['server'], tool: o['tool'], args, ...(cwd ? { cwd } : {}) };
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function createCodeModeHandler(deps: CodeModeServerDeps): CodeModeHttpHandler {
  const cooldownMs = deps.restartCooldownMs ?? RESTART_COOLDOWN_MS;
  /** Last restart per server, for the cooldown. */
  const lastRestart = new Map<string, number>();

  return async (req, res, body, path = CODE_MODE_CALL_PATH) => {
    // Auth before anything else — unauthorized callers learn nothing about
    // method support, enablement, or allowlist contents.
    if (!bearerAuthorized(req, deps.getToken())) {
      respondJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    if (req.method !== 'POST') {
      respondJson(res, 405, { ok: false, error: 'POST only' });
      return;
    }
    if (!deps.isEnabled()) {
      respondJson(res, 403, { ok: false, error: 'code mode is disabled in Sentinel settings' });
      return;
    }
    if (body && body.length > MAX_REQUEST_BYTES) {
      respondJson(res, 413, {
        ok: false,
        error: `request body exceeds the ${MAX_REQUEST_BYTES}-byte cap`,
      });
      return;
    }
    if (path === CODE_MODE_RESTART_PATH) {
      await handleRestart(res, body);
      return;
    }
    const call = parseCallRequest(body);
    if (!call) {
      respondJson(res, 400, {
        ok: false,
        error: 'expected JSON body { "server": string, "tool": string, "args": object }',
      });
      return;
    }

    const startMs = Date.now();
    try {
      const result = await deps.manager.call(call.server, call.tool, call.args, call.cwd);
      deps.recordCall({
        ts: startMs,
        server: call.server,
        tool: call.tool,
        ok: !result.isError,
        bytesOut: result.bytes,
        durationMs: Date.now() - startMs,
      });
      respondJson(res, 200, {
        ok: true,
        isError: result.isError,
        truncated: result.truncated,
        // contentJson is already JSON text; re-parse so the response is one
        // clean object for jq-style consumers rather than nested JSON.
        content: JSON.parse(result.contentJson) as unknown,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.recordCall({
        ts: startMs,
        server: call.server,
        tool: call.tool,
        ok: false,
        bytesOut: 0,
        durationMs: Date.now() - startMs,
      });
      // The allowlist rejection is the one failure that deserves a distinct
      // status: it means the caller asked for a server the user never bridged.
      if (message.includes('not bridged')) {
        respondJson(res, 403, { ok: false, error: message });
        return;
      }
      respondJson(res, 502, { ok: false, error: message });
    }
  };

  async function handleRestart(res: ServerResponse, body: Buffer | null): Promise<void> {
    const request = parseRestartRequest(body);
    if (!request) {
      respondJson(res, 400, { ok: false, error: 'expected JSON body { "server": string }' });
      return;
    }
    const since = Date.now() - (lastRestart.get(request.server) ?? 0);
    if (since < cooldownMs) {
      respondJson(res, 429, {
        ok: false,
        error:
          `'${request.server}' was restarted ${Math.round(since / 1000)}s ago; ` +
          `wait ${Math.ceil((cooldownMs - since) / 1000)}s before restarting again`,
      });
      return;
    }
    lastRestart.set(request.server, Date.now());
    try {
      const tools = await deps.manager.restartServer(request.server, request.cwd);
      if (deps.onRestarted) await deps.onRestarted(request.server, tools);
      respondJson(res, 200, {
        ok: true,
        server: request.server,
        toolCount: tools.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Same distinction the call path draws: asking to restart a server the
      // user never bridged is a permission answer, not a server fault.
      respondJson(res, message.includes('not bridged') ? 403 : 502, { ok: false, error: message });
    }
  }
}
