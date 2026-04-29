import { createServer, connect, type Server, type Socket } from 'net';
import { existsSync, unlinkSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { timingSafeEqual } from 'crypto';
import type { DaemonToAppMessage, AppToDaemonMessage, IpcResponse } from '@claude-sentinel/shared';

/* v8 ignore next 3 */
export const IPC_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\claude-sentinel'
    : join(homedir(), '.claude-sentinel', 'daemon.sock');

/** Sprint 2: every connection's first line must be a handshake message
 *  with this shape carrying the per-spawn token. The token is shared
 *  out-of-band via the daemon's stdin (Tauri writes it before the daemon
 *  reads it). The constant is a `_`-prefixed type so it can never collide
 *  with a real `AppToDaemonMessage` — the union shape excludes it. */
export const HANDSHAKE_MSG_TYPE = '_handshake' as const;

export type AppMessageHandler = (
  message: AppToDaemonMessage,
  respond: (response: IpcResponse) => void,
) => void;

/** Constant-time string equality for the handshake comparison. Falls
 *  back to false on length mismatch (the common attack-shape, since the
 *  real token is fixed-length). */
function safeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * IPC server — runs inside the daemon and accepts connections from the Tauri app.
 *
 * Sprint 2 anti-tamper: when started with a non-null `expectedToken`, every
 * incoming connection must send a handshake message of shape
 *
 *   { "type": "_handshake", "token": "<hex>" }
 *
 * as its first complete line; mismatches and missing handshakes cause the
 * socket to be destroyed before any other handler sees data. The
 * `CLAUDE_SENTINEL_TEST_IPC_TOKEN` env var bypasses the check (set with a
 * blank value) for legacy integration tests that don't go through Tauri.
 */
export class IpcServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private messageHandlers: AppMessageHandler[] = [];
  /** Sprint 9: in-process listeners that observe every outgoing
   *  broadcast. Used by the webhook emitter to filter by severity and
   *  POST to the user's URL without intercepting the broadcast itself. */
  private broadcastListeners: Array<(msg: DaemonToAppMessage) => void> = [];
  /** Per-socket flag: true once the handshake has been validated. New
   *  sockets start false; the first line either flips this to true or
   *  destroys the socket. */
  private authenticated = new WeakSet<Socket>();
  private expectedToken: string | null = null;

  onMessage(handler: AppMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /** Sprint 9: register a daemon-internal observer fired on every
   *  broadcast. Synchronous; listeners must not throw — caught and
   *  logged here so a faulty subscriber can't break the IPC stream. */
  onBroadcast(listener: (msg: DaemonToAppMessage) => void): void {
    this.broadcastListeners.push(listener);
  }

  start(
    socketPath: string = process.env.CLAUDE_SENTINEL_TEST_IPC_SOCKET ?? IPC_PATH,
    expectedToken: string | null = null,
  ): void {
    this.expectedToken = expectedToken;
    // Clean up stale socket file on Unix
    /* v8 ignore next 3 */
    if (process.platform !== 'win32' && existsSync(socketPath)) {
      unlinkSync(socketPath);
    }

    const dir = dirname(socketPath);
    /* v8 ignore next 3 */
    if (process.platform !== 'win32' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.server = createServer((socket: Socket) => {
      this.clients.add(socket);
      // Pre-auth in test/dev modes so broadcasts that fire before the
      // peer sends any data still reach it. When `expectedToken` is set
      // and no test-bypass env is present, the socket stays in the
      // unauthenticated bucket until its first line passes the handshake.
      if (this.expectedToken === null || process.env.CLAUDE_SENTINEL_TEST_IPC_TOKEN !== undefined) {
        this.authenticated.add(socket);
      }
      let buffer = '';

      socket.setEncoding('utf-8');

      socket.on('data', (chunk: Buffer | string) => {
        /* v8 ignore next 3 */
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;

          // Handshake gate: every connection's FIRST line must auth.
          // After auth, normal message routing applies. This check is
          // skipped when `expectedToken` is null (test mode / dev CLI)
          // OR when the bypass env var is present (legacy integration
          // tests that don't go through Tauri's spawn pipe).
          if (
            !this.authenticated.has(socket) &&
            this.expectedToken !== null &&
            process.env.CLAUDE_SENTINEL_TEST_IPC_TOKEN === undefined
          ) {
            if (!this.acceptHandshake(socket, line)) {
              // Reject and close. Don't read any further data.
              socket.destroy();
              this.clients.delete(socket);
              return;
            }
            // Valid handshake — don't dispatch as a normal message.
            continue;
          }
          // Test bypass: mark authenticated on first line so subsequent
          // checks short-circuit cheaply.
          if (!this.authenticated.has(socket)) {
            this.authenticated.add(socket);
          }

          try {
            const msg = JSON.parse(line) as AppToDaemonMessage;
            const respond = (response: IpcResponse) => {
              if (!socket.destroyed) {
                socket.write(JSON.stringify(response) + '\n');
              }
            };
            this.messageHandlers.forEach((h) => h(msg, respond));
          } catch {
            // ignore malformed messages
          }
        }
      });

      socket.on('close', () => {
        this.clients.delete(socket);
      });

      /* v8 ignore next 3 */
      socket.on('error', () => {
        this.clients.delete(socket);
      });
    });

    this.server.listen(socketPath, () => {
      // Socket permissions: 0600 on Unix
      /* v8 ignore next 7 */
      if (process.platform !== 'win32') {
        try {
          chmodSync(socketPath, 0o600);
        } catch {
          // non-fatal
        }
      }
    });

    this.server.on('error', (err: Error) => {
      /* v8 ignore next */
      console.error('[IPC] Server error:', err);
    });
  }

  /**
   * Try to accept a handshake line. Returns true on success (token
   * matches) and marks the socket authenticated; returns false on any
   * failure. Logs a single WARN on rejection so an attacker probing the
   * socket leaves a forensic trail.
   */
  private acceptHandshake(socket: Socket, line: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn('[IPC] Rejected unauthenticated peer: malformed first line');
      return false;
    }
    if (!parsed || typeof parsed !== 'object') {
      console.warn('[IPC] Rejected unauthenticated peer: first line was not an object');
      return false;
    }
    const obj = parsed as { type?: unknown; token?: unknown };
    if (obj.type !== HANDSHAKE_MSG_TYPE) {
      console.warn(
        `[IPC] Rejected unauthenticated peer: first message type was ${
          typeof obj.type === 'string' ? JSON.stringify(obj.type) : '<not a string>'
        }, expected handshake`,
      );
      return false;
    }
    if (typeof obj.token !== 'string' || this.expectedToken === null) {
      /* v8 ignore next 2 */
      console.warn('[IPC] Rejected unauthenticated peer: missing token');
      return false;
    }
    if (!safeEqualStrings(obj.token, this.expectedToken)) {
      console.warn('[IPC] Rejected unauthenticated peer: token mismatch');
      return false;
    }
    this.authenticated.add(socket);
    return true;
  }

  /**
   * Broadcast a message to all connected Tauri app clients.
   */
  broadcast(message: DaemonToAppMessage): void {
    const line = JSON.stringify(message) + '\n';
    for (const client of this.clients) {
      // Don't broadcast to peers that haven't completed the handshake —
      // pre-auth peers may be probing connections we never trusted.
      if (!client.destroyed && this.authenticated.has(client)) {
        client.write(line);
      }
    }
    // Notify daemon-internal listeners (Sprint 9 webhook emitter, etc.).
    // Listeners run after the on-the-wire write so a slow listener
    // can't delay the IPC stream the UI sees.
    for (const listener of this.broadcastListeners) {
      try {
        listener(message);
      } catch (err) {
        console.error('[IPC] broadcast listener threw:', err);
      }
    }
  }

  close(): void {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    this.server?.close();
    this.server = null;
    this.expectedToken = null;
  }

  get connectedClients(): number {
    return this.clients.size;
  }
}

/**
 * IPC client — runs inside the Tauri app (or tests) to communicate with the daemon.
 */
export class IpcClient {
  private socket: Socket | null = null;
  private buffer = '';
  private messageHandlers: Array<(msg: DaemonToAppMessage) => void> = [];
  private connectListeners: Array<() => void> = [];
  private errorListeners: Array<(err: Error) => void> = [];

  onMessage(handler: (msg: DaemonToAppMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onConnect(handler: () => void): void {
    this.connectListeners.push(handler);
  }

  onError(handler: (err: Error) => void): void {
    this.errorListeners.push(handler);
  }

  connect(
    socketPath: string = process.env.CLAUDE_SENTINEL_TEST_IPC_SOCKET ?? IPC_PATH,
    token: string | null = null,
  ): void {
    this.socket = connect(socketPath, () => {
      // Sprint 2: send the handshake as the first line on the socket
      // before any caller-issued messages. The daemon rejects connections
      // whose first line isn't a valid handshake; if token is null, the
      // daemon is in test/dev mode and the handshake is unnecessary.
      if (token !== null && this.socket && !this.socket.destroyed) {
        this.socket.write(JSON.stringify({ type: HANDSHAKE_MSG_TYPE, token }) + '\n');
      }
      this.connectListeners.forEach((h) => h());
    });

    this.socket.setEncoding('utf-8');

    this.socket.on('data', (chunk: Buffer | string) => {
      /* v8 ignore next 3 */
      this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as DaemonToAppMessage;
          this.messageHandlers.forEach((h) => h(msg));
        } catch {
          // ignore malformed messages
        }
      }
    });

    this.socket.on('error', (err: Error) => {
      this.errorListeners.forEach((h) => h(err));
    });
  }

  send(message: AppToDaemonMessage): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(JSON.stringify(message) + '\n');
    }
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
