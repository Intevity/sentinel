#!/usr/bin/env node
/**
 * HTTP ↔ Unix-socket bridge used by E2E tests.
 *
 * The Tauri app normally talks to the daemon via `invoke('ipc_send')`,
 * which routes through Rust. In a plain browser (Playwright driving the
 * Vite dev server) that path doesn't exist, so packages/app/src/lib/ipc.ts
 * switches to `fetch()` against this bridge when VITE_E2E=true.
 *
 * This script:
 *   1. Listens on HTTP at a port specified by BRIDGE_PORT or 0 (ephemeral).
 *   2. On POST /, reads JSON body (AppToDaemonMessage shape).
 *   3. Forwards it to the daemon's Unix socket (DAEMON_SOCKET env var).
 *   4. Reads the newline-terminated JSON response.
 *   5. Returns it as the HTTP response body.
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end('POST only');
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
      const newline = buffer.indexOf('\n');
      if (newline !== -1) {
        const line = buffer.slice(0, newline);
        sock.end();
        try {
          resolve(JSON.parse(line));
        } catch (err) {
          reject(new Error(`bridge: bad JSON from daemon: ${err.message}`));
        }
      }
    });
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(JSON.stringify(msg) + '\n');
    });
  });
}

server.listen(BRIDGE_PORT, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : BRIDGE_PORT;
  // Stdout line consumed by test-daemon.ts to learn the ephemeral port.
  console.log(`bridge-listening port=${port}`);
});
