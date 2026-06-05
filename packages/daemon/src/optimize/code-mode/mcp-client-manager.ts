/**
 * Daemon-side MCP client manager — the heart of the code-mode bridge. The
 * daemon connects to the user's own MCP servers (stdio or HTTP) so Claude can
 * call their tools through the loopback `/code-mode/call` endpoint instead of
 * carrying every tool definition in every request.
 *
 * Uses the official SDK client (`Client` + `StdioClientTransport` /
 * `StreamableHTTPClientTransport` / `SSEClientTransport`) — no hand-rolled
 * JSON-RPC. Connection config (including env vars and auth headers) is
 * resolved through `deps.resolveEntry` at CONNECT time only: before migration
 * that reads the live `~/.claude.json` entry, afterwards the stash in
 * Sentinel settings. Secrets never flow into generated files or the model.
 *
 * Security boundary: `call`/`listTools` refuse any server `deps.isAllowed`
 * rejects — the allowlist is the recorded code-mode migrations, so the
 * endpoint can never be used to spawn an arbitrary configured server.
 * `verify` is exempt (it powers the pre-migration connectivity check).
 *
 * Lifecycle: lazy connect on first use; an idle timer closes the client
 * (killing a spawned stdio child) after IDLE_SHUTDOWN_MS without calls;
 * `stopAll()` closes everything on daemon shutdown. A transport error drops
 * the cached client so the next call reconnects fresh.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

/** Concrete transport union — the SDK's `Transport` interface clashes with
 *  exactOptionalPropertyTypes on the concrete classes (same mismatch the
 *  retrieve server bridges with a cast at connect time). */
type ClientTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
/** Cap on the serialized tool-result content returned to callers. Large
 *  results defeat the point of code mode (the caller is expected to filter
 *  in code); cap mirrors the cache-TTL non-SSE buffer philosophy. */
const MAX_RESULT_BYTES = 1024 * 1024;

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpCallResult {
  /** The MCP tool result `content` array, JSON-serialized. Truncated to the
   *  byte cap when oversized (see `truncated`). */
  contentJson: string;
  isError: boolean;
  bytes: number;
  truncated: boolean;
}

export type VerifyResult = { ok: true; tools: McpToolDescriptor[] } | { ok: false; error: string };

export interface McpClientManagerDeps {
  /** Resolve a server's connection entry (the `mcpServers[name]` value).
   *  Returns undefined for unknown servers. */
  resolveEntry: (server: string) => unknown;
  /** The bridged-server allowlist (recorded code-mode migrations). */
  isAllowed: (server: string) => boolean;
  /** Availability callback for status surfacing (Context tab's
   *  native/bridged/unavailable pill). */
  onAvailability?: (server: string, available: boolean) => void;
  /** Test seams. */
  idleShutdownMs?: number;
  maxResultBytes?: number;
}

export interface McpClientManager {
  listTools(server: string): Promise<McpToolDescriptor[]>;
  call(server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
  /** Connect + tools/list without the allowlist gate — the pre-migration
   *  connectivity check. Returns the live tool descriptors on success (the
   *  workspace generator's input, fetched before the server is bridged).
   *  Never throws. */
  verify(server: string): Promise<VerifyResult>;
  /** Number of currently-connected clients (test/status introspection). */
  connectedCount(): number;
  stopAll(): Promise<void>;
}

interface ManagedClient {
  client: Client;
  idleTimer: NodeJS.Timeout | null;
}

/** Narrow a raw `mcpServers[name]` entry into a transport. Throws a
 *  user-readable error for shapes we can't bridge. */
function buildTransport(server: string, entry: unknown): ClientTransport {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`No usable config entry for MCP server '${server}'`);
  }
  const e = entry as Record<string, unknown>;
  if (typeof e['command'] === 'string' && e['command'].length > 0) {
    const args = Array.isArray(e['args'])
      ? e['args'].filter((a): a is string => typeof a === 'string')
      : [];
    const env =
      e['env'] && typeof e['env'] === 'object'
        ? Object.fromEntries(
            Object.entries(e['env'] as Record<string, unknown>).filter(
              (kv): kv is [string, string] => typeof kv[1] === 'string',
            ),
          )
        : {};
    return new StdioClientTransport({
      command: e['command'],
      args,
      // Default safe env plus the entry's own vars — matching how Claude
      // Code itself spawns the server. Secrets stay in this process.
      env: { ...getDefaultEnvironment(), ...env },
      stderr: 'ignore',
    });
  }
  if (typeof e['url'] === 'string' && e['url'].length > 0) {
    const headers =
      e['headers'] && typeof e['headers'] === 'object'
        ? (e['headers'] as Record<string, string>)
        : {};
    const url = new URL(e['url']);
    if (e['type'] === 'sse') {
      // Legacy SSE-only servers.
      return new SSEClientTransport(url, { requestInit: { headers } });
    }
    return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  }
  throw new Error(
    `MCP server '${server}' has neither a command nor a url — cannot bridge this entry`,
  );
}

export function createMcpClientManager(deps: McpClientManagerDeps): McpClientManager {
  const idleMs = deps.idleShutdownMs ?? IDLE_SHUTDOWN_MS;
  const maxBytes = deps.maxResultBytes ?? MAX_RESULT_BYTES;
  const clients = new Map<string, ManagedClient>();
  let stopped = false;

  function touchIdle(server: string, managed: ManagedClient): void {
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    managed.idleTimer = setTimeout(() => {
      void dropClient(server);
    }, idleMs);
    if (typeof managed.idleTimer.unref === 'function') managed.idleTimer.unref();
  }

  async function dropClient(server: string): Promise<void> {
    const managed = clients.get(server);
    if (!managed) return;
    clients.delete(server);
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    try {
      await managed.client.close();
    } catch {
      // Already-broken transport — closing is best-effort.
    }
  }

  async function ensureClient(server: string): Promise<Client> {
    const existing = clients.get(server);
    if (existing) {
      touchIdle(server, existing);
      return existing.client;
    }
    if (stopped) throw new Error('MCP client manager is shut down');
    const entry = deps.resolveEntry(server);
    const transport = buildTransport(server, entry);
    const client = new Client({ name: 'claude-sentinel-code-mode', version: '1.0.0' });
    try {
      // Cast bridges the same exactOptionalPropertyTypes mismatch as the
      // retrieve server's transport (SDK concrete classes vs Transport).
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    } catch (err) {
      deps.onAvailability?.(server, false);
      throw err;
    }
    const managed: ManagedClient = { client, idleTimer: null };
    clients.set(server, managed);
    touchIdle(server, managed);
    deps.onAvailability?.(server, true);
    return client;
  }

  /** Run an SDK call, dropping the cached client on failure so the next
   *  call reconnects instead of reusing a broken transport. */
  async function withClient<T>(server: string, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await ensureClient(server);
    try {
      return await fn(client);
    } catch (err) {
      await dropClient(server);
      throw err;
    }
  }

  function requireAllowed(server: string): void {
    if (!deps.isAllowed(server)) {
      throw new Error(`MCP server '${server}' is not bridged to code mode`);
    }
  }

  return {
    async listTools(server) {
      requireAllowed(server);
      const result = await withClient(server, (c) => c.listTools());
      return result.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      }));
    },

    async call(server, tool, args) {
      requireAllowed(server);
      const result = await withClient(server, (c) => c.callTool({ name: tool, arguments: args }));
      const isError = result.isError === true;
      let contentJson = JSON.stringify(result.content ?? []);
      let truncated = false;
      const bytes = Buffer.byteLength(contentJson, 'utf-8');
      if (bytes > maxBytes) {
        // Hard cap. The sliced JSON is no longer parseable — by design the
        // caller sees an explicit truncation marker instead of silently
        // incomplete data, and should narrow the query.
        contentJson = JSON.stringify([
          {
            type: 'text',
            text:
              `[result truncated by Claude Sentinel: ${bytes} bytes exceeded the ` +
              `${maxBytes}-byte code-mode cap; narrow the query or filter server-side] ` +
              contentJson.slice(0, 4096),
          },
        ]);
        truncated = true;
      }
      return { contentJson, isError, bytes, truncated };
    },

    async verify(server) {
      try {
        const result = await withClient(server, (c) => c.listTools());
        return {
          ok: true,
          tools: result.tools.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.inputSchema,
          })),
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    connectedCount() {
      return clients.size;
    },

    async stopAll() {
      stopped = true;
      await Promise.all([...clients.keys()].map((server) => dropClient(server)));
    },
  };
}
