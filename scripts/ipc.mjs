#!/usr/bin/env node
/**
 * Send a single IPC message to the running daemon and print the response.
 *
 * Usage:
 *   node scripts/ipc.mjs '{"type":"refresh_accounts"}'
 *   node scripts/ipc.mjs '{"type":"switch_account","accountId":"<uuid>","email":"<email>"}'
 */
import net from 'net';
import path from 'path';
import os from 'os';

const raw = process.argv[2];
if (!raw) {
  console.error('Usage: node scripts/ipc.mjs \'{"type":"...",...}\'');
  process.exit(1);
}

let msg;
try {
  msg = JSON.parse(raw);
} catch {
  console.error('Invalid JSON:', raw);
  process.exit(1);
}

const sockPath =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\claude-sentinel'
    : path.join(os.homedir(), '.claude-sentinel', 'daemon.sock');

const socket = net.connect(sockPath);
let buf = '';

socket.setEncoding('utf-8');

socket.on('connect', () => {
  socket.write(JSON.stringify(msg) + '\n');
});

socket.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      // Only print if it's a response to our request type
      if (parsed.requestType === msg.type) {
        console.log(JSON.stringify(parsed, null, 2));
        socket.destroy();
        process.exit(parsed.success ? 0 : 1);
      }
      // Unsolicited broadcast — print and keep waiting
      console.error('[broadcast]', JSON.stringify(parsed));
    } catch {
      console.error('[raw]', line);
    }
  }
});

socket.on('error', (err) => {
  console.error('Socket error:', err.message);
  process.exit(1);
});

// 5 s timeout
setTimeout(() => {
  console.error('Timed out waiting for daemon response');
  socket.destroy();
  process.exit(1);
}, 5000);
