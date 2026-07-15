/**
 * stdio ⇄ HTTP bridge for Sentinel's MCP server.
 *
 * Claude Desktop only accepts **stdio** (`command`-based) local MCP servers —
 * both its `claude_desktop_config.json` schema and the embedded claude-code
 * session collector validate `type === undefined | 'stdio'` and drop
 * `type: 'http'` entries silently. Sentinel's MCP server (retrieve +
 * code-mode) is HTTP-only on the local daemon, so the desktop app spawns the
 * daemon binary with the `mcp-stdio` command and this bridge relays
 * newline-delimited JSON-RPC between the app and the daemon's `/mcp`
 * endpoint.
 *
 * The daemon's MCP transport is the SDK's StreamableHTTPServerTransport in
 * stateless mode with `enableJsonResponse: true` (a fresh server per
 * request), which keeps the relay trivial:
 *   - requests (have `id`)  → POST, JSON body comes back → write to stdout
 *   - notifications (no id) → POST, 202/204 with no body → nothing to write
 * There are no server-initiated messages, so no SSE listener is needed.
 *
 * Config comes from env (set by the desktop config installer):
 *   SENTINEL_MCP_URL    e.g. http://127.0.0.1:47284/mcp
 *   SENTINEL_MCP_TOKEN  bearer for the daemon's /mcp auth
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

interface BridgeIo {
  input: Readable;
  output: Writable;
  fetchImpl?: typeof fetch;
}

/** True for JSON-RPC messages that expect a response (single or batch). */
function expectsResponse(msg: unknown): boolean {
  if (Array.isArray(msg)) return msg.some((m) => expectsResponse(m));
  return (
    !!msg &&
    typeof msg === 'object' &&
    'id' in msg &&
    (msg as { id?: unknown }).id !== undefined &&
    (msg as { id?: unknown }).id !== null
  );
}

/** Extract the request id (for synthesizing an error reply on relay failure).
 *  Batches synthesize per-member errors, so this only handles single messages. */
function messageId(msg: unknown): string | number | null {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const id = (msg as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

/**
 * Run the bridge until stdin closes. Exported with injectable streams/fetch
 * so tests can drive it against a real local HTTP MCP endpoint.
 */
export async function runMcpStdioBridge(url: string, token: string, io: BridgeIo): Promise<void> {
  const fetchImpl = io.fetchImpl ?? fetch;
  const writeLine = (msg: unknown): void => {
    io.output.write(`${JSON.stringify(msg)}\n`);
  };

  const relay = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not JSON — nothing sane to relay or reply to.
      return;
    }
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The stateless transport answers requests as plain JSON
          // (enableJsonResponse), but the SDK still requires the SSE accept
          // type to be offered.
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
        },
        body: trimmed,
      });
      const text = await res.text();
      if (!res.ok) {
        if (expectsResponse(parsed)) {
          writeLine({
            jsonrpc: '2.0',
            id: messageId(parsed),
            error: { code: -32603, message: `Sentinel daemon returned HTTP ${res.status}` },
          });
        }
        return;
      }
      // Notifications come back 202 with an empty body — nothing to forward.
      if (!text.trim()) return;
      writeLine(JSON.parse(text));
    } catch (err) {
      if (expectsResponse(parsed)) {
        writeLine({
          jsonrpc: '2.0',
          id: messageId(parsed),
          error: {
            code: -32603,
            message: `Sentinel daemon unreachable: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      }
    }
  };

  // Process sequentially: the daemon answers in milliseconds and ordering
  // stays deterministic for the client.
  const rl = createInterface({ input: io.input });
  for await (const line of rl) {
    await relay(line);
  }
}

/** Entry point for `sentinel-daemon mcp-stdio` (wired in cli.ts). */
export async function mcpStdioMain(): Promise<number> {
  const url = process.env.SENTINEL_MCP_URL ?? '';
  const token = process.env.SENTINEL_MCP_TOKEN ?? '';
  if (!url || !token) {
    process.stderr.write('mcp-stdio: SENTINEL_MCP_URL and SENTINEL_MCP_TOKEN are required\n');
    return 1;
  }
  await runMcpStdioBridge(url, token, { input: process.stdin, output: process.stdout });
  return 0;
}
