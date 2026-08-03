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

import os from 'node:os';
import path from 'node:path';
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

/** A server's connection entry plus the cache key it belongs under. */
export interface ResolvedEntry {
  /** Stable identity of the CONFIG RECORD this entry came from, not the server.
   *  Two scopes of the same server can hold different credentials (a
   *  per-project token, a different Jira project filter), so they must not
   *  share one spawned child — keying the client cache by server name alone
   *  would silently serve one scope's connection to another. */
  key: string;
  entry: unknown;
}

export interface McpClientManagerDeps {
  /** Resolve a server's connection entry (the `mcpServers[name]` value) for the
   *  calling directory. `cwd` is optional — callers that don't know it get the
   *  deterministic fallback record. Returns undefined for unknown servers. */
  resolveEntry: (server: string, cwd?: string) => ResolvedEntry | undefined;
  /** The bridged-server allowlist (recorded code-mode migrations). */
  isAllowed: (server: string) => boolean;
  /** Availability callback for status surfacing (Context tab's
   *  native/bridged/unavailable pill). */
  onAvailability?: (server: string, available: boolean) => void;
  /** Leg B sandbox wrapper. When provided and it returns non-null, the stdio
   *  child is spawned through the returned sandboxed command/args/env instead of
   *  the raw ones. Returning null (or omitting the dep) runs the child
   *  unsandboxed — the degrade path. Only applies to stdio servers; HTTP/SSE
   *  transports execute no local command and are never wrapped. */
  wrapStdioCommand?: (
    command: string,
    args: string[],
    env: Record<string, string>,
  ) => Promise<{ command: string; args: string[]; env: Record<string, string> } | null>;
  /** Redactor applied to every captured stderr line before it is stored or
   *  surfaced. Production wires `redactSecretsInString`; a bridged server that
   *  echoes its own config on an auth failure would otherwise leak the user's
   *  token into the status payload. */
  redact: (text: string) => string;
  /** Test seams. */
  idleShutdownMs?: number;
  maxResultBytes?: number;
}

export interface McpClientManager {
  listTools(server: string, cwd?: string): Promise<McpToolDescriptor[]>;
  call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    cwd?: string,
  ): Promise<McpCallResult>;
  /** Connect + tools/list without the allowlist gate — the pre-migration
   *  connectivity check. Returns the live tool descriptors on success (the
   *  workspace generator's input, fetched before the server is bridged).
   *  Never throws. */
  verify(server: string, cwd?: string): Promise<VerifyResult>;
  /** Number of currently-connected clients (test/status introspection). */
  connectedCount(): number;
  /** Redacted stderr tail for this server, oldest first, or an empty array when
   *  it has printed nothing noteworthy. Survives disconnects so a server that
   *  dies on startup is still diagnosable. */
  lastStderr(server: string): string[];
  /** Close and forget this server's client, killing any spawned stdio child.
   *  The next call reconnects and re-reads its config, which is what makes a
   *  credential update take effect immediately instead of after the idle
   *  timeout. No-op when the server isn't connected. */
  dropServer(server: string): Promise<void>;
  stopAll(): Promise<void>;
}

interface ManagedClient {
  client: Client;
  idleTimer: NodeJS.Timeout | null;
  /** Server this client belongs to, so `dropClient` can maintain the
   *  server → record-keys index without a reverse scan. */
  server: string;
}

/** A GUI-launched app (the Tauri shell that spawns this daemon) inherits a
 *  minimal PATH, so bare-name launchers like `uvx`/`npx` — installed under
 *  Homebrew or `~/.local/bin` — fail to spawn with ENOENT. Prepend the common
 *  user-bin locations so bridged stdio MCP servers resolve the same way they do
 *  from the user's shell. Mirrors the Rust `augmented_path()` in
 *  `packages/app/src-tauri/src/setup_token.rs`. Pure + injectable for tests. */
export function augmentedPath(
  opts: { basePath?: string; home?: string; platform?: NodeJS.Platform } = {},
): string {
  const platform = opts.platform ?? process.platform;
  const basePath = opts.basePath ?? process.env['PATH'] ?? '';
  // Windows GUI apps inherit the full system+user PATH, so there's nothing to
  // repair — and the unix bin dirs below wouldn't apply anyway.
  if (platform === 'win32') return basePath;
  const home = opts.home ?? os.homedir();
  const extra = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const p of [...extra, ...basePath.split(':')]) {
    if (p.length > 0 && !seen.has(p)) {
      seen.add(p);
      parts.push(p);
    }
  }
  return parts.join(':');
}

/** Rewrite a child-spawn ENOENT into a message that names the missing command
 *  and points at the real cause, instead of the SDK's bare `spawn uvx ENOENT`.
 *  After PATH augmentation a persistent ENOENT means the tool isn't installed,
 *  so say so. Any other error passes through unchanged. */
export function clarifySpawnError(server: string, entry: unknown, err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== 'ENOENT' && !/ ENOENT\b/.test(err.message)) return err;
  const command =
    entry &&
    typeof entry === 'object' &&
    typeof (entry as Record<string, unknown>)['command'] === 'string'
      ? ((entry as Record<string, unknown>)['command'] as string)
      : 'the configured command';
  return new Error(
    `MCP server '${server}': command '${command}' was not found on PATH — is it ` +
      `installed? (Sentinel already searches Homebrew and ~/.local/bin.)`,
  );
}

/** Narrow a raw `mcpServers[name]` entry into a transport. Throws a
 *  user-readable error for shapes we can't bridge. Async because the optional
 *  Leg B sandbox wrapper may need to wrap the stdio spawn. */
async function buildTransport(
  server: string,
  entry: unknown,
  wrapStdioCommand?: McpClientManagerDeps['wrapStdioCommand'],
): Promise<ClientTransport> {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`No usable config entry for MCP server '${server}'`);
  }
  const e = entry as Record<string, unknown>;
  if (typeof e['command'] === 'string' && e['command'].length > 0) {
    const command = e['command'];
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
    // Default safe env plus the entry's own vars — matching how Claude
    // Code itself spawns the server. Secrets stay in this process.
    const stdioEnv: Record<string, string> = { ...getDefaultEnvironment(), ...env };
    // Repair the minimal GUI-inherited PATH so uvx/npx resolve, unless the
    // entry pinned its own PATH (that's an explicit user override — respect it).
    if (env['PATH'] === undefined) {
      stdioEnv['PATH'] = augmentedPath();
    }
    // Leg B: wrap the spawn in the OS sandbox when enforcement is active.
    // A null result (or no wrapper) is the degrade path — run unsandboxed.
    let spawnCommand = command;
    let spawnArgs = args;
    let spawnEnv = stdioEnv;
    if (wrapStdioCommand) {
      const wrapped = await wrapStdioCommand(command, args, stdioEnv);
      if (wrapped) {
        spawnCommand = wrapped.command;
        spawnArgs = wrapped.args;
        spawnEnv = wrapped.env;
      }
    }
    // 'pipe', not 'ignore': a bridged server's stderr is where an expired
    // token's 401 shows up, and discarding it left users with a bridge that
    // silently returned errors and no way to find out why. The caller attaches
    // a redacted, bounded reader (`attachStderr`).
    return new StdioClientTransport({
      command: spawnCommand,
      args: spawnArgs,
      env: spawnEnv,
      stderr: 'pipe',
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

/** Longest stderr tail kept per server. Enough to hold a short auth error or a
 *  Python traceback's last frames without letting a chatty server grow the
 *  daemon's heap. */
const STDERR_TAIL_LINES = 8;
const STDERR_TAIL_BYTES = 4 * 1024;

/** Lines a well-behaved MCP server prints on a healthy startup. Keeping them
 *  out of `lastError` is what stops the UI showing "Starting server..." as
 *  though it were a fault. */
const STDERR_NOISE = /^\s*(?:\[?info\]?\b|debug\b|starting\b|listening\b|ready\b)/i;

export function createMcpClientManager(deps: McpClientManagerDeps): McpClientManager {
  const idleMs = deps.idleShutdownMs ?? IDLE_SHUTDOWN_MS;
  const maxBytes = deps.maxResultBytes ?? MAX_RESULT_BYTES;
  /** Keyed by CONFIG RECORD (`ResolvedEntry.key`), not server name — see the
   *  note on that field. */
  const clients = new Map<string, ManagedClient>();
  /** Record keys currently cached per server, so `dropServer` can evict every
   *  scope's client at once. */
  const keysByServer = new Map<string, Set<string>>();
  /** Redacted stderr tail per server, newest last. Survives `dropClient` so a
   *  crash-on-startup loop is still diagnosable after the client is gone. */
  const stderrTails = new Map<string, string[]>();
  let stopped = false;

  /** Stream a spawned child's stderr into the bounded per-server tail, running
   *  every line through the secret redactor first — a server that echoes its
   *  own config on failure would otherwise write the user's token into the
   *  status payload and the audit UI. */
  function attachStderr(server: string, transport: ClientTransport): void {
    const stream = (transport as StdioClientTransport).stderr;
    if (!stream) return;
    let carry = '';
    stream.on('data', (chunk: Buffer | string) => {
      carry += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() ?? '';
      const tail = stderrTails.get(server) ?? [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || STDERR_NOISE.test(trimmed)) continue;
        tail.push(deps.redact(trimmed).slice(0, STDERR_TAIL_BYTES));
      }
      while (tail.length > STDERR_TAIL_LINES) tail.shift();
      if (tail.length > 0) stderrTails.set(server, tail);
    });
    // A closed/errored stderr pipe must never take the daemon down; the tail we
    // already captured is still the useful part.
    stream.on('error', () => {});
  }

  function touchIdle(key: string, managed: ManagedClient): void {
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    managed.idleTimer = setTimeout(() => {
      void dropClient(key);
    }, idleMs);
    if (typeof managed.idleTimer.unref === 'function') managed.idleTimer.unref();
  }

  async function dropClient(key: string): Promise<void> {
    const managed = clients.get(key);
    if (!managed) return;
    clients.delete(key);
    keysByServer.get(managed.server)?.delete(key);
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    try {
      await managed.client.close();
    } catch {
      // Already-broken transport — closing is best-effort.
    }
  }

  async function ensureClient(server: string, cwd?: string): Promise<Client> {
    const resolved = deps.resolveEntry(server, cwd);
    // No record at all: fall through to buildTransport, which raises the
    // "no usable config entry" error naming the server.
    const key = resolved?.key ?? server;
    const existing = clients.get(key);
    if (existing) {
      touchIdle(key, existing);
      return existing.client;
    }
    if (stopped) throw new Error('MCP client manager is shut down');
    const entry = resolved?.entry;
    const transport = await buildTransport(server, entry, deps.wrapStdioCommand);
    // Attach before connect: a server that dies during the handshake writes its
    // reason to stderr and nowhere else, and that is exactly the case worth
    // capturing.
    attachStderr(server, transport);
    const client = new Client({ name: 'sentinel-code-mode', version: '1.0.0' });
    try {
      // Cast bridges the same exactOptionalPropertyTypes mismatch as the
      // retrieve server's transport (SDK concrete classes vs Transport).
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    } catch (err) {
      deps.onAvailability?.(server, false);
      throw clarifySpawnError(server, entry, err);
    }
    const managed: ManagedClient = { client, idleTimer: null, server };
    clients.set(key, managed);
    let keys = keysByServer.get(server);
    if (!keys) {
      keys = new Set();
      keysByServer.set(server, keys);
    }
    keys.add(key);
    touchIdle(key, managed);
    deps.onAvailability?.(server, true);
    return client;
  }

  /** Run an SDK call, dropping the cached client on failure so the next
   *  call reconnects instead of reusing a broken transport. */
  async function withClient<T>(
    server: string,
    cwd: string | undefined,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    const key = deps.resolveEntry(server, cwd)?.key ?? server;
    const client = await ensureClient(server, cwd);
    try {
      return await fn(client);
    } catch (err) {
      await dropClient(key);
      throw err;
    }
  }

  function requireAllowed(server: string): void {
    if (!deps.isAllowed(server)) {
      throw new Error(`MCP server '${server}' is not bridged to code mode`);
    }
  }

  return {
    async listTools(server, cwd) {
      requireAllowed(server);
      const result = await withClient(server, cwd, (c) => c.listTools());
      return result.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
      }));
    },

    async call(server, tool, args, cwd) {
      requireAllowed(server);
      const result = await withClient(server, cwd, (c) =>
        c.callTool({ name: tool, arguments: args }),
      );
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
              `[result truncated by Sentinel: ${bytes} bytes exceeded the ` +
              `${maxBytes}-byte code-mode cap; narrow the query or filter server-side] ` +
              contentJson.slice(0, 4096),
          },
        ]);
        truncated = true;
      }
      return { contentJson, isError, bytes, truncated };
    },

    async verify(server, cwd) {
      try {
        const result = await withClient(server, cwd, (c) => c.listTools());
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

    lastStderr(server) {
      return [...(stderrTails.get(server) ?? [])];
    },

    async dropServer(server) {
      // Every scope's client, not just one: a credential update may rewrite
      // several records, and any of them could have a live child.
      const keys = [...(keysByServer.get(server) ?? [])];
      await Promise.all(keys.map((key) => dropClient(key)));
    },

    async stopAll() {
      stopped = true;
      await Promise.all([...clients.keys()].map((key) => dropClient(key)));
    },
  };
}
