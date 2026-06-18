/**
 * Minimal MCP server exposing a single `retrieve` tool, served over the
 * daemon's existing HTTP server at `/mcp`. Reversible compression elides
 * content and leaves a content-hash id in a marker; Claude Code calls
 * `mcp__sentinel__retrieve({ id })` and this returns the original.
 *
 * Uses the official SDK's low-level `Server` + `StreamableHTTPServerTransport`
 * in stateless mode with `enableJsonResponse` (single JSON responses, no SSE).
 * A fresh Server + transport is built per request — the SDK's documented
 * stateless pattern — so concurrent requests never share JSON-RPC ids.
 *
 * Security: the endpoint binds to loopback (the proxy listens on 127.0.0.1)
 * and requires a per-installation bearer token, checked with a constant-time
 * comparison. DNS-rebinding protection is unnecessary given the token (a
 * rebinding attacker's browser JS can't read the token from ~/.claude.json).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const RETRIEVE_TOOL_NAME = 'retrieve';
/** The fully-qualified tool name Claude Code surfaces for server "sentinel". */
export const RETRIEVE_QUALIFIED_NAME = 'mcp__sentinel__retrieve';

export interface RetrieveMcpDeps {
  /** Look up an elided original by content-hash id. */
  getRetrieval: (id: string) => { originalText: string } | null;
  /** The expected bearer token. */
  getToken: () => string;
}

export type McpHttpHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer | null,
) => Promise<void>;

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Exported for the code-mode bridge endpoint, which gates on the same
 *  constant-time bearer check (with its own token). */
export function bearerAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m || !m[1]) return false;
  return constantTimeEquals(m[1], token);
}

function buildServer(deps: RetrieveMcpDeps): Server {
  const server = new Server(
    { name: 'sentinel', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: RETRIEVE_TOOL_NAME,
        description:
          'Retrieve the full original text that Sentinel elided from a tool result. ' +
          'When a tool result contains a marker like [... elided by Sentinel; ' +
          'retrieve the full output with the sentinel retrieve tool, id="..."], call this ' +
          'tool with that id to get the omitted content.',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'The id from the elision marker.',
            },
          },
          required: ['id'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, (req) => {
    const { name, arguments: args } = req.params;
    if (name !== RETRIEVE_TOOL_NAME) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    const id = (args as Record<string, unknown> | undefined)?.['id'];
    if (typeof id !== 'string' || id.length === 0) {
      return {
        content: [{ type: 'text', text: 'Missing required string argument "id".' }],
        isError: true,
      };
    }
    const found = deps.getRetrieval(id);
    if (!found) {
      return {
        content: [
          {
            type: 'text',
            text: `No stored original for id "${id}" (it may have expired or never existed).`,
          },
        ],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: found.originalText }] };
  });

  return server;
}

/** Build the `/mcp` HTTP handler. The caller (proxy route) reads the request
 *  body and passes it as `body` (null for GET/DELETE). */
export function createRetrieveMcpHandler(deps: RetrieveMcpDeps): McpHttpHandler {
  return async (req, res, body) => {
    if (!bearerAuthorized(req, deps.getToken())) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    let parsedBody: unknown;
    if (req.method === 'POST' && body && body.length > 0) {
      try {
        parsedBody = JSON.parse(body.toString('utf-8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32700, message: 'Parse error' },
            id: null,
          }),
        );
        return;
      }
    }

    const server = buildServer(deps);
    // Omitting `sessionIdGenerator` selects stateless mode. `enableJsonResponse`
    // returns a single JSON object per request instead of an SSE stream.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    // Cast bridges an exactOptionalPropertyTypes mismatch between the SDK's
    // concrete transport (onclose getter typed `(() => void) | undefined`) and
    // the Transport interface's optional `onclose?`. Runtime behavior is correct.
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(req, res, parsedBody);
  };
}
