/**
 * Fake MCP servers for code-mode bridge tests — the MCP analogue of
 * fake-anthropic: real listeners and real child processes, no `vi.mock`.
 *
 * Two variants, exposing the SAME canned tool set:
 *
 *   - HTTP: an SDK `Server` over `StreamableHTTPServerTransport` (stateless
 *     JSON mode) on a real ephemeral loopback port. Optionally requires a
 *     bearer token so tests can prove the client manager forwards configured
 *     headers.
 *
 *   - stdio: a ZERO-DEPENDENCY .mjs script (`writeFakeMcpStdioScript`)
 *     speaking newline-delimited JSON-RPC, spawned by the real
 *     `StdioClientTransport` via `process.execPath`. Hand-rolled at the wire
 *     level on purpose: the side under test (the SDK client) stays real,
 *     and the script needs no module resolution wherever it's written.
 *
 * Canned tools:
 *   echo — returns `{"echo":<arguments>}` as text
 *   add  — returns the sum of `a` and `b` as text
 *   blob — returns `bytes` repetitions of "x" (size-cap tests)
 *   fail — always returns `isError: true`
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface FakeMcpToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface FakeMcpHttpServer {
  origin: string;
  url: string;
  port: number;
  /** Every tools/call received, in order. */
  calls: FakeMcpToolCall[];
  /**
   * Change (or, with `null`, drop) the header value this server demands, at
   * any point in a test. Requests carrying anything else get a 401 before
   * reaching the MCP layer.
   *
   * Models credential rotation from the server's side: rotate the accepted
   * value, and a client still holding the old one starts failing exactly as a
   * real server with an expired token would. That is what lets a test prove
   * Sentinel's credential update verifies before it saves.
   */
  setRequiredHeader(name: string, value: string | null): void;
  close(): Promise<void>;
}

export const FAKE_MCP_TOOLS = [
  {
    name: 'echo',
    description: 'Echo the arguments back as JSON text',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
    },
  },
  {
    name: 'add',
    description: 'Add two numbers and return the sum',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'blob',
    description: 'Return a payload of the requested size in bytes',
    inputSchema: {
      type: 'object',
      properties: { bytes: { type: 'number' } },
      required: ['bytes'],
    },
  },
  {
    name: 'fail',
    description: 'Always returns an error result',
    inputSchema: { type: 'object', properties: {} },
  },
] as const;

/** Shared tool semantics for both variants (and for assertions). */
export function runFakeMcpTool(
  tool: string,
  args: Record<string, unknown>,
): { text: string; isError: boolean } {
  switch (tool) {
    case 'echo':
      return { text: JSON.stringify({ echo: args }), isError: false };
    case 'add':
      return { text: String(Number(args['a']) + Number(args['b'])), isError: false };
    case 'blob':
      return { text: 'x'.repeat(Math.max(0, Number(args['bytes']) || 0)), isError: false };
    case 'fail':
      return { text: 'deliberate failure from fake MCP server', isError: true };
    default:
      return { text: `Unknown tool: ${tool}`, isError: true };
  }
}

function buildSdkServer(calls: FakeMcpToolCall[]): Server {
  const server = new Server(
    { name: 'fake-mcp-http', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: FAKE_MCP_TOOLS.map((t) => ({ ...t })),
  }));
  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    calls.push({ tool: req.params.name, args });
    const { text, isError } = runFakeMcpTool(req.params.name, args);
    return { content: [{ type: 'text', text }], isError };
  });
  return server;
}

/**
 * Start the HTTP variant on an ephemeral loopback port. When `requireToken`
 * is set, requests without `Authorization: Bearer <token>` are rejected 401
 * before reaching the MCP layer.
 */
export async function startFakeMcpHttpServer(opts?: {
  requireToken?: string;
}): Promise<FakeMcpHttpServer> {
  const calls: FakeMcpToolCall[] = [];
  /** Mutable header requirement, set via `setRequiredHeader`. Lowercased name
   *  so it matches Node's normalized `req.headers`. */
  let required: { name: string; value: string } | null = null;

  const httpServer: HttpServer = createServer((req, res) => {
    void (async () => {
      if (opts?.requireToken) {
        const header = req.headers['authorization'];
        if (header !== `Bearer ${opts.requireToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
      }
      if (required && req.headers[required.name] !== required.value) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `bad or missing ${required.name}` }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks);
      let parsedBody: unknown;
      if (raw.length > 0) parsedBody = JSON.parse(raw.toString('utf-8'));

      // Stateless pattern: fresh Server + transport per request (the
      // documented approach, mirrored from mcp-retrieve-server.ts).
      const server = buildSdkServer(calls);
      const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(req, res, parsedBody);
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });

  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      resolve(addr && typeof addr === 'object' ? addr.port : 0);
    });
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    calls,
    setRequiredHeader: (name, value) => {
      required = value === null ? null : { name: name.toLowerCase(), value };
    },
    close: () =>
      new Promise<void>((resolve) => {
        // `close()` alone waits for every open connection to end, and a
        // connected MCP client holds one open indefinitely (the streamable
        // transport keeps a GET parked for server→client messages). A test
        // that closes the fake while a client is still bridged would therefore
        // hang forever. Destroying the sockets is also the honest simulation:
        // closing the fake models the server going away, not draining politely.
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

/**
 * The stdio variant: newline-delimited JSON-RPC over stdin/stdout, zero
 * dependencies. Handles initialize / notifications/initialized / ping /
 * tools/list / tools/call with the same canned tools as the HTTP variant.
 * `FAKE_MCP_EXIT_EARLY=1` makes the script exit immediately (spawn-failure
 * tests).
 */
const STDIO_SCRIPT = `// Auto-generated by @sentinel/test-harness (fake-mcp-server).
// Zero-dependency stdio MCP server for code-mode bridge tests.
if (process.env.FAKE_MCP_EXIT_EARLY === '1') process.exit(3);

const TOOLS = ${JSON.stringify(FAKE_MCP_TOOLS, null, 2)};

function run(tool, args) {
  switch (tool) {
    case 'echo':
      return { text: JSON.stringify({ echo: args }), isError: false };
    case 'add':
      return { text: String(Number(args.a) + Number(args.b)), isError: false };
    case 'blob':
      return { text: 'x'.repeat(Math.max(0, Number(args.bytes) || 0)), isError: false };
    case 'fail':
      return { text: 'deliberate failure from fake MCP server', isError: true };
    default:
      return { text: 'Unknown tool: ' + tool, isError: true };
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\\n');
}

let buffer = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));

function handle(msg) {
  if (msg.method === 'initialize') {
    if (process.env.FAKE_MCP_BAD_INIT === '1') {
      // Fail the handshake AFTER the process (and anything it spawned) is
      // already up — the state in which a spawned child would be stranded.
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: 'deliberate initialize failure from fake MCP server' },
      });
      return;
    }
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        // Echo the client's requested protocol version so the SDK's
        // version negotiation always succeeds.
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp-stdio', version: '1.0.0' },
      },
    });
    return;
  }
  if (msg.method === 'notifications/initialized') return; // notification: no reply
  if (msg.method === 'ping') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    return;
  }
  if (msg.method === 'tools/call') {
    const { text, isError } = run(msg.params.name, msg.params.arguments || {});
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text }], isError },
    });
    return;
  }
  if (msg.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: 'Method not found: ' + msg.method },
    });
  }
}
`;

/** Write the stdio server script to a tmp file. Spawn it with
 *  `{ command: process.execPath, args: [path] }`. */
export function writeFakeMcpStdioScript(): { path: string; cleanup: () => void } {
  const path = join(tmpdir(), `fake-mcp-stdio-${randomUUID()}.mjs`);
  writeFileSync(path, STDIO_SCRIPT, 'utf-8');
  return {
    path,
    cleanup: () => {
      if (existsSync(path)) unlinkSync(path);
    },
  };
}

/**
 * A stdio server that spawns a long-lived GRANDCHILD before serving, modelling
 * the launchers real MCP servers actually ship with: `uv tool uvx mcp-atlassian`
 * and `npm exec mongodb-mcp-server` both run the real server one level down.
 *
 * This is the shape that leaks. Signalling the direct child does nothing to the
 * grandchild, which survives and reparents to init — observed in the wild as
 * months-old MCP processes at ppid 1. A test asserts the grandchild is dead
 * after teardown; without process-tree reaping it stays alive.
 *
 * The grandchild uses `stdio: 'ignore'` so it cannot corrupt the JSON-RPC
 * stream, and is deliberately NOT detached: a plain child already outlives a
 * SIGKILLed parent, which is precisely the bug being reproduced.
 */
export function writeFakeMcpStdioScriptWithGrandchild(): {
  path: string;
  cleanup: () => void;
} {
  const path = join(tmpdir(), `fake-mcp-stdio-grandchild-${randomUUID()}.mjs`);
  const preamble = [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    // Sleeps effectively forever; the test kills it via the manager's reaper,
    // and an unref'd handle would let it exit on its own and mask a leak.
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000)'], { stdio: 'ignore' });",
    // Publishing the pid lets a test assert the grandchild died even on paths
    // where the manager never registered the connection (a failed handshake),
    // and so has no pid of its own to report.
    'if (process.env.FAKE_MCP_CHILD_PID_FILE) {',
    "  writeFileSync(process.env.FAKE_MCP_CHILD_PID_FILE, String(grandchild.pid), 'utf-8');",
    '}',
  ].join('\n');
  writeFileSync(path, `${preamble}\n${STDIO_SCRIPT}`, 'utf-8');
  return {
    path,
    cleanup: () => {
      if (existsSync(path)) unlinkSync(path);
    },
  };
}

/**
 * A stdio server that writes the given lines to stderr on startup, then serves
 * normally. Models the real diagnostic case a bridged server presents — the
 * process starts fine and the failure is only ever announced on stderr (an
 * expired token's 401, a Python traceback) — so a test can prove Sentinel
 * captures and redacts that output instead of discarding it.
 */
export function writeFakeMcpStdioScriptWithStderr(lines: string[]): {
  path: string;
  cleanup: () => void;
} {
  const path = join(tmpdir(), `fake-mcp-stdio-noisy-${randomUUID()}.mjs`);
  const preamble = lines
    .map((l) => `process.stderr.write(${JSON.stringify(`${l}\n`)});`)
    .join('\n');
  writeFileSync(path, `${preamble}\n${STDIO_SCRIPT}`, 'utf-8');
  return {
    path,
    cleanup: () => {
      if (existsSync(path)) unlinkSync(path);
    },
  };
}
