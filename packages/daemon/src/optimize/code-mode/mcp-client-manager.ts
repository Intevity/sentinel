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
 * Lifecycle: lazy connect on first use; an idle timer closes the client after
 * IDLE_SHUTDOWN_MS without calls; a client older than MAX_CLIENT_AGE_MS is
 * recycled on the next acquire (never mid-call), so a server launched through
 * an unpinned `uvx`/`npx` eventually picks up upstream changes instead of
 * running whatever it resolved months ago; `stopAll()` closes everything on
 * daemon shutdown. A transport error drops the cached client so the next call
 * reconnects fresh.
 *
 * Teardown is verified, not assumed. The SDK signals the direct child only,
 * which strands the grandchild that wrapper launchers (`uv tool uvx X`,
 * `npm exec X`) actually run the server as. Every path that lets go of a
 * client checks the pid actually died and reaps the tree if it didn't — most
 * importantly the CONNECT-FAILURE path, where a child that spawned but failed
 * to hand shake is never registered, so nothing could ever drop it.
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
import { isAlive, listDescendants, reapPids, snapshotProcessTree } from './process-tree.js';

/** Concrete transport union — the SDK's `Transport` interface clashes with
 *  exactOptionalPropertyTypes on the concrete classes (same mismatch the
 *  retrieve server bridges with a cast at connect time). */
type ClientTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

/** What `buildTransport` produces: the transport plus the two facts about it
 *  worth keeping for the status payload. */
interface BuiltTransport {
  transport: ClientTransport;
  kind: 'stdio' | 'http' | 'sse';
  descriptor: string;
}

const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;
/** Cap on the serialized tool-result content returned to callers. Large
 *  results defeat the point of code mode (the caller is expected to filter
 *  in code); cap mirrors the cache-TTL non-SSE buffer philosophy. */
const MAX_RESULT_BYTES = 1024 * 1024;
/** Recycle a connected client this old on its next acquire. `uvx mcp-atlassian`
 *  and friends resolve their version at spawn time, so a long-lived child runs
 *  whatever was current when it started — a bridge that stays busy would never
 *  otherwise pick up an upstream fix. Enforced on acquire rather than by a
 *  timer so a recycle can never interrupt an in-flight call. */
const MAX_CLIENT_AGE_MS = 4 * 60 * 60 * 1000;
/** How long a `ps` tree snapshot is reused when counting live processes for the
 *  status payload. The UI refetches status on every broadcast, and the count is
 *  a health signal, not a live monitor. */
const LIVE_PROCESS_CACHE_MS = 5000;

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
  maxClientAgeMs?: number;
}

/** Live state of one connected client, for the status UI and for diagnosing a
 *  bridge that is misbehaving. One entry per CONFIG RECORD, so a server
 *  configured differently in two projects reports one row per configuration. */
export interface McpClientRuntime {
  /** The config-record cache key. Opaque to the UI; useful in logs. */
  key: string;
  /** When this child was spawned / this connection established. */
  connectedAt: number;
  /** Direct child pid for stdio servers; null for HTTP/SSE (nothing local
   *  runs) and if the SDK reports none. */
  pid: number | null;
  transport: 'stdio' | 'http' | 'sse';
  /** Redacted command + args actually spawned, or the URL for HTTP/SSE. This
   *  is what the user correlates with `ps`. */
  descriptor: string;
  /** Tools reported at the last successful list; null until one happens. */
  toolCount: number | null;
  lastCallAt: number | null;
  lastCallOk: boolean | null;
}

/** Per-server runtime rollup. */
export interface McpServerRuntime {
  server: string;
  /** Redacted message from the most recent failure, and when. Kept per SERVER
   *  rather than per client because the failures worth reading are exactly the
   *  ones that dropped the client — a per-client field would vanish with it.
   *  Cleared by the next success. */
  lastError: string | null;
  lastErrorAt: number | null;
  /** Processes still alive for this server: each tracked pid plus its live
   *  descendants. Exceeding `clients.length` means something leaked — the
   *  symptom this whole surface exists to make visible. Always 0 for
   *  HTTP/SSE-only servers. */
  liveProcesses: number;
  clients: McpClientRuntime[];
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
  /** Close, reap, and immediately reconnect every client for this server,
   *  returning the freshly-listed tools. The recovery path for a server that
   *  has gone bad in a way a reconnect fixes (stale build, wedged child,
   *  credentials rotated out of band). Throws if it cannot come back, having
   *  already dropped the old client. */
  restartServer(server: string, cwd?: string): Promise<McpToolDescriptor[]>;
  /** Live per-server state for the status UI. Async because counting live
   *  processes needs a `ps` snapshot (cached briefly). */
  runtime(): Promise<McpServerRuntime[]>;
  stopAll(): Promise<void>;
}

interface ManagedClient {
  client: Client;
  idleTimer: NodeJS.Timeout | null;
  /** Server this client belongs to, so `dropClient` can maintain the
   *  server → record-keys index without a reverse scan. */
  server: string;
  /** Everything below is runtime state surfaced by `runtime()`. `pid` is also
   *  the hook the teardown paths use to prove the child actually died. */
  key: string;
  watch: SpawnWatch;
  transport: 'stdio' | 'http' | 'sse';
  descriptor: string;
  connectedAt: number;
  toolCount: number | null;
  lastCallAt: number | null;
  lastCallOk: boolean | null;
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
): Promise<BuiltTransport> {
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
    return {
      transport: new StdioClientTransport({
        command: spawnCommand,
        args: spawnArgs,
        env: spawnEnv,
        stderr: 'pipe',
      }),
      kind: 'stdio',
      // The POST-wrap command: under Leg B the direct child is the sandbox
      // helper, and that is what the user will see in `ps`.
      descriptor: [spawnCommand, ...spawnArgs].join(' '),
    };
  }
  if (typeof e['url'] === 'string' && e['url'].length > 0) {
    const headers =
      e['headers'] && typeof e['headers'] === 'object'
        ? (e['headers'] as Record<string, string>)
        : {};
    const url = new URL(e['url']);
    if (e['type'] === 'sse') {
      // Legacy SSE-only servers.
      return {
        transport: new SSEClientTransport(url, { requestInit: { headers } }),
        kind: 'sse',
        descriptor: url.toString(),
      };
    }
    return {
      transport: new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
      kind: 'http',
      descriptor: url.toString(),
    };
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

/** What we know about a transport's spawned child, recorded at the only two
 *  moments the information is actually available. */
interface SpawnWatch {
  /** Direct child pid; null for HTTP/SSE, which spawn nothing locally. */
  pid: number | null;
  /** Its descendants as of teardown. */
  tree: number[];
}

/** Instrument a transport so its spawned child can still be reaped after the
 *  SDK has forgotten about it.
 *
 *  Two races make the naive approach wrong, and both are lost reliably:
 *
 *  - Reading `transport.pid` in a catch block is too late. A failed MCP
 *    handshake makes the SDK call its own `close()`, which drops the process
 *    handle synchronously — the pid is gone before we can look. So `start()`
 *    is wrapped, capturing the pid on the child's `spawn` event.
 *  - Listing descendants after `close()` is too late. Closing ends the child's
 *    stdin, it exits, and its own children instantly reparent to init, erasing
 *    the only links we had to find them by. So `close()` is wrapped too,
 *    snapshotting the tree while the child is still there to walk from — and
 *    because the wrapper sits on the transport, it fires whether WE close it or
 *    the SDK does.
 *
 *  Returns a box rather than values because both facts are only known later,
 *  once `connect()` has run. */
function watchSpawnedChild(transport: ClientTransport, server: string): SpawnWatch {
  const watch: SpawnWatch = { pid: null, tree: [] };
  const start = transport.start.bind(transport);
  transport.start = async (): Promise<void> => {
    await start();
    watch.pid = (transport as StdioClientTransport).pid ?? null;
  };
  const close = transport.close.bind(transport);
  // Shared so EVERY caller of close() awaits the same teardown. The SDK fires
  // its own `void this.close()` on a failed handshake without awaiting it, so
  // both it and our own call must converge on one reap rather than racing.
  let teardown: Promise<void> | null = null;
  transport.close = async (): Promise<void> => {
    if (teardown === null) teardown = reapDescendants(watch, server);
    await teardown;
    await close();
  };
  return watch;
}

/** Kill everything the child spawned, BEFORE the child itself is closed.
 *
 *  The ordering is the whole point, and getting it wrong is dangerous rather
 *  than merely ineffective. Once the direct child dies, two things happen at
 *  once: its children reparent to init (so the tree can no longer be walked),
 *  and its pid becomes free for the kernel to REUSE. Signalling a pid whose
 *  process is known dead therefore risks killing an unrelated process that
 *  inherited the number — and walking its "descendants" can return a whole
 *  foreign process tree. On Linux, where pids recycle quickly, that is not
 *  theoretical: an earlier revision of this code killed CI's own test workers.
 *
 *  While the child is alive its pid unambiguously identifies it and the tree
 *  below it is real, so capture and signal happen back to back, here. The
 *  direct child is deliberately NOT signalled: the SDK's `close()` owns it and
 *  escalates to SIGKILL, and it is our own child, so it is always reaped. */
async function reapDescendants(watch: SpawnWatch, server: string): Promise<void> {
  if (watch.pid === null) return;
  try {
    const rows = await snapshotProcessTree();
    // Identity check, not an optimisation. If the child already exited on its
    // own, its pid may have been REUSED by an unrelated process, and walking
    // that number would hand us a foreign process tree to kill. A live pid
    // that is still parented to us is provably the child we spawned.
    const stillOurs = rows.some(([pid, ppid]) => pid === watch.pid && ppid === process.pid);
    if (!stillOurs) return;
    watch.tree = await listDescendants(watch.pid, { snapshot: rows });
    if (watch.tree.length === 0) return;
    // Deepest-first: leaves before any wrapper that might restart one.
    const reaped = await reapPids([...watch.tree].reverse());
    if (reaped > 0) {
      console.log(`[CodeMode] '${server}' left ${reaped} child process(es); reaped`);
    }
    /* v8 ignore next 4 -- reaping is best-effort: a process-table hiccup or a
       permission change mid-reap must never reject the close that called it. */
  } catch (err) {
    console.error(`[CodeMode] reaping '${server}' pid ${watch.pid} failed:`, err);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createMcpClientManager(deps: McpClientManagerDeps): McpClientManager {
  const idleMs = deps.idleShutdownMs ?? IDLE_SHUTDOWN_MS;
  const maxBytes = deps.maxResultBytes ?? MAX_RESULT_BYTES;
  const maxAgeMs = deps.maxClientAgeMs ?? MAX_CLIENT_AGE_MS;
  /** Keyed by CONFIG RECORD (`ResolvedEntry.key`), not server name — see the
   *  note on that field. */
  const clients = new Map<string, ManagedClient>();
  /** Record keys currently cached per server, so `dropServer` can evict every
   *  scope's client at once. */
  const keysByServer = new Map<string, Set<string>>();
  /** Redacted stderr tail per server, newest last. Survives `dropClient` so a
   *  crash-on-startup loop is still diagnosable after the client is gone. */
  const stderrTails = new Map<string, string[]>();
  /** Most recent failure per server. Like `stderrTails` this deliberately
   *  outlives the client it belonged to — the interesting error is usually the
   *  one that caused the drop. */
  const lastErrors = new Map<string, { message: string; at: number }>();
  /** Reused `ps` snapshot for the status payload's live-process count. */
  let treeSnapshot: { at: number; rows: Array<[number, number]> } | null = null;
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
      void dropClient(key, 'idle');
    }, idleMs);
    if (typeof managed.idleTimer.unref === 'function') managed.idleTimer.unref();
  }

  async function dropClient(key: string, reason: string): Promise<void> {
    const managed = clients.get(key);
    if (!managed) return;
    clients.delete(key);
    keysByServer.get(managed.server)?.delete(key);
    if (managed.idleTimer) clearTimeout(managed.idleTimer);
    try {
      // The transport wrapper reaps the child's own children on the way
      // through; the SDK's close kills the direct child itself.
      await managed.client.close();
    } catch {
      // Already-broken transport — closing is best-effort.
    }
    console.log(`[CodeMode] dropped '${managed.server}' (${reason})`);
  }

  async function ensureClient(server: string, cwd?: string): Promise<Client> {
    const resolved = deps.resolveEntry(server, cwd);
    // No record at all: fall through to buildTransport, which raises the
    // "no usable config entry" error naming the server.
    const key = resolved?.key ?? server;
    const existing = clients.get(key);
    if (existing) {
      // Age check happens HERE, on acquire, rather than on a timer: a timer
      // could fire mid-call and kill a request in flight. The cost is that a
      // permanently-idle client is recycled lazily, which is free.
      if (Date.now() - existing.connectedAt < maxAgeMs) {
        touchIdle(key, existing);
        return existing.client;
      }
      console.log(
        `[CodeMode] recycling '${server}' after ${Math.round(
          (Date.now() - existing.connectedAt) / 60000,
        )}m (max age reached)`,
      );
      await dropClient(key, 'max-age');
    }
    if (stopped) throw new Error('MCP client manager is shut down');
    const entry = resolved?.entry;
    const built = await buildTransport(server, entry, deps.wrapStdioCommand);
    const { transport, kind } = built;
    const descriptor = deps.redact(built.descriptor);
    // Attach before connect: a server that dies during the handshake writes its
    // reason to stderr and nowhere else, and that is exactly the case worth
    // capturing.
    attachStderr(server, transport);
    const watch = watchSpawnedChild(transport, server);
    const client = new Client({ name: 'sentinel-code-mode', version: '1.0.0' });
    try {
      // Cast bridges the same exactOptionalPropertyTypes mismatch as the
      // retrieve server's transport (SDK concrete classes vs Transport).
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    } catch (err) {
      // The child is already spawned by the time connect() can fail on the
      // handshake, and it was never registered in `clients` — so nothing else
      // would ever close it. This is the leak that left daemon-owned MCP
      // children alive for days despite a 5-minute idle timer. Close and reap
      // before rethrowing.
      try {
        // Idempotent: the SDK fires its own close on a failed handshake, and
        // both calls converge on the single reap inside the wrapper.
        await transport.close();
      } catch {
        // Best-effort; the wrapper's reap is the guarantee.
      }
      deps.onAvailability?.(server, false);
      const clarified = clarifySpawnError(server, entry, err);
      // Recorded here rather than in `withClient`, whose try block only covers
      // calls made on an already-connected client. A server that cannot
      // connect at all is exactly the one whose error the user needs to read.
      lastErrors.set(server, { message: deps.redact(errText(clarified)), at: Date.now() });
      console.warn(`[CodeMode] connect to '${server}' failed: ${errText(clarified)}`);
      throw clarified;
    }
    const managed: ManagedClient = {
      client,
      idleTimer: null,
      server,
      key,
      watch,
      transport: kind,
      descriptor,
      connectedAt: Date.now(),
      toolCount: null,
      lastCallAt: null,
      lastCallOk: null,
    };
    console.log(
      `[CodeMode] connected '${server}' via ${kind}` +
        `${watch.pid === null ? '' : ` (pid ${watch.pid})`}`,
    );
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
      const result = await fn(client);
      const managed = clients.get(key);
      if (managed) {
        managed.lastCallAt = Date.now();
        managed.lastCallOk = true;
      }
      lastErrors.delete(server);
      return result;
    } catch (err) {
      lastErrors.set(server, { message: deps.redact(errText(err)), at: Date.now() });
      await dropClient(key, 'call failed');
      // Previously only a failed CONNECT flipped availability, so a server
      // that connected and then died mid-call kept showing as healthy.
      deps.onAvailability?.(server, false);
      throw err;
    }
  }

  /** Connect (if needed), list, and record the count on the live client.
   *  Shared by `listTools` (allowlisted) and `verify` (deliberately not). */
  async function listToolsInternal(server: string, cwd?: string): Promise<McpToolDescriptor[]> {
    const key = deps.resolveEntry(server, cwd)?.key ?? server;
    const result = await withClient(server, cwd, (c) => c.listTools());
    const tools = result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema,
    }));
    const managed = clients.get(key);
    if (managed) managed.toolCount = tools.length;
    return tools;
  }

  async function dropServerInternal(server: string, reason: string): Promise<void> {
    // Every scope's client, not just one: a credential update may rewrite
    // several records, and any of them could have a live child.
    const keys = [...(keysByServer.get(server) ?? [])];
    await Promise.all(keys.map((key) => dropClient(key, reason)));
  }

  function requireAllowed(server: string): void {
    if (!deps.isAllowed(server)) {
      throw new Error(`MCP server '${server}' is not bridged to code mode`);
    }
  }

  return {
    async listTools(server, cwd) {
      requireAllowed(server);
      return listToolsInternal(server, cwd);
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
        return { ok: true, tools: await listToolsInternal(server, cwd) };
      } catch (err) {
        return { ok: false, error: errText(err) };
      }
    },

    connectedCount() {
      return clients.size;
    },

    lastStderr(server) {
      return [...(stderrTails.get(server) ?? [])];
    },

    async dropServer(server) {
      await dropServerInternal(server, 'dropped');
    },

    async restartServer(server, cwd) {
      requireAllowed(server);
      console.log(`[CodeMode] restarting '${server}'`);
      await dropServerInternal(server, 'restart');
      // Reconnect eagerly rather than waiting for the next call, so the caller
      // learns immediately whether the server actually came back — and gets the
      // fresh tool list, which is what regenerates the docs.
      return listToolsInternal(server, cwd);
    },

    async runtime() {
      const now = Date.now();
      if (treeSnapshot === null || now - treeSnapshot.at > LIVE_PROCESS_CACHE_MS) {
        treeSnapshot = { at: now, rows: await snapshotProcessTree() };
      }
      const rows = treeSnapshot.rows;
      const byServer = new Map<string, McpClientRuntime[]>();
      for (const managed of clients.values()) {
        const list = byServer.get(managed.server) ?? [];
        list.push({
          key: managed.key,
          connectedAt: managed.connectedAt,
          pid: managed.watch.pid,
          transport: managed.transport,
          descriptor: managed.descriptor,
          toolCount: managed.toolCount,
          lastCallAt: managed.lastCallAt,
          lastCallOk: managed.lastCallOk,
        });
        byServer.set(managed.server, list);
      }
      // A server with no live client but a recorded failure still needs a row —
      // "not connected, and here is why" is the whole point.
      const servers = new Set([...byServer.keys(), ...lastErrors.keys()]);
      const out: McpServerRuntime[] = [];
      for (const server of servers) {
        const list = byServer.get(server) ?? [];
        let liveProcesses = 0;
        for (const entry of list) {
          if (entry.pid === null) continue;
          if (isAlive(entry.pid)) liveProcesses += 1;
          for (const child of await listDescendants(entry.pid, { snapshot: rows })) {
            if (isAlive(child)) liveProcesses += 1;
          }
        }
        const failure = lastErrors.get(server);
        out.push({
          server,
          liveProcesses,
          lastError: failure?.message ?? null,
          lastErrorAt: failure?.at ?? null,
          clients: list,
        });
      }
      return out.sort((a, b) => a.server.localeCompare(b.server));
    },

    async stopAll() {
      stopped = true;
      await Promise.all([...clients.keys()].map((key) => dropClient(key, 'shutdown')));
    },
  };
}
