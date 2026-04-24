#!/usr/bin/env node
/**
 * HTTP ↔ Unix-socket bridge used by E2E tests.
 *
 * The Tauri app normally talks to the daemon via `invoke('ipc_send')`,
 * which routes through Rust. In a plain browser (Playwright driving the
 * Vite dev server) that path doesn't exist, so packages/app/src/lib/ipc.ts
 * switches to `fetch()` against this bridge when VITE_E2E=true.
 *
 * Two endpoints:
 *   POST /           — request/response round-trip. Short-lived socket.
 *   GET  /events     — SSE stream of daemon broadcasts. Persistent socket.
 *
 * The daemon's IPC protocol newline-frames every JSON message. Request
 * responses carry a `requestType` field; broadcasts (DaemonToAppMessage)
 * do not. That discriminator is how /events routes incoming frames:
 * anything without `requestType` is treated as a broadcast and streamed
 * to subscribed clients.
 *
 * CORS is open so the Vite dev server on :5173 can talk to any port here.
 */

import { createServer } from 'node:http';
import { connect } from 'node:net';

const BRIDGE_PORT = Number(process.env.BRIDGE_PORT ?? 0);
const DAEMON_SOCKET = process.env.DAEMON_SOCKET;
if (!DAEMON_SOCKET) {
  console.error('ipc-http-bridge: DAEMON_SOCKET env var is required');
  process.exit(1);
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url && req.url.startsWith('/events')) {
    handleSse(req, res);
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('POST or GET /events only');
    return;
  }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  let msg;
  try {
    msg = JSON.parse(body);
  } catch (err) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: `invalid JSON: ${err.message}` }));
    return;
  }

  try {
    const response = await forwardToDaemon(msg);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ error: `bridge forward failed: ${err.message}` }));
  }
});

function forwardToDaemon(msg) {
  return new Promise((resolve, reject) => {
    const sock = connect(DAEMON_SOCKET);
    let buffer = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buffer += chunk;
      // The daemon may interleave broadcasts on the same socket before
      // the actual response arrives. Scan every complete line and take
      // the first one that looks like an IpcResponse (has `requestType`).
      // Broadcasts that land here during a request are dropped — /events
      // subscribers get their own persistent socket and don't need them.
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) {
          newline = buffer.indexOf('\n');
          continue;
        }
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object' && 'requestType' in parsed) {
            sock.end();
            resolve(parsed);
            return;
          }
        } catch {
          // Drop malformed frames instead of failing the whole request —
          // a stray broadcast with non-JSON payload should not poison
          // the round-trip for a well-formed response that follows.
        }
        newline = buffer.indexOf('\n');
      }
    });
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(JSON.stringify(msg) + '\n');
    });
  });
}

/**
 * Handle a GET /events subscription. Opens its own persistent connection
 * to the daemon and streams every broadcast (JSON line without a
 * `requestType` field) to the subscriber as an SSE `data:` frame.
 * Request/response frames that happen to land here are ignored — the
 * POST path opens its own short-lived socket for those.
 */
function handleSse(req, res) {
  // Open the daemon socket BEFORE writing SSE headers. The headers serve
  // as the readiness signal for the consumer: once they arrive, the
  // bridge is already registered as a client on the daemon's IpcServer
  // and any subsequent broadcast will be forwarded. Without this
  // ordering, subscribers routinely miss broadcasts fired in the small
  // window between "SSE flushed" and "daemon socket connected" — which
  // manifested as every usage-metrics spec timing out on the first
  // `rate_limits_updated` after a freshly-issued `probe_rate_limits`.
  const sock = connect(DAEMON_SOCKET);
  sock.once('connect', () => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Repeat CORS headers since the preflight path didn't handle GET.
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();
    res.write(': connected\n\n');
  });
  let buffer = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) {
        newline = buffer.indexOf('\n');
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && !('requestType' in parsed)) {
          res.write(`data: ${line}\n\n`);
        }
      } catch {
        // Malformed frame — drop.
      }
      newline = buffer.indexOf('\n');
    }
  });
  sock.on('error', () => {
    try {
      res.end();
    } catch {
      // Socket already torn down.
    }
  });
  req.on('close', () => {
    try {
      sock.end();
    } catch {
      // Already ended.
    }
  });
}

server.listen(BRIDGE_PORT, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : BRIDGE_PORT;
  // Stdout line consumed by test-daemon.ts to learn the ephemeral port.
  console.log(`bridge-listening port=${port}`);
});
