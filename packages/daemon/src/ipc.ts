import { createServer, connect, type Server, type Socket } from 'net';
import { existsSync, unlinkSync, mkdirSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import type {
  DaemonToAppMessage,
  AppToDaemonMessage,
  IpcResponse,
} from '@claude-sentinel/shared';

/* v8 ignore next 3 */
export const IPC_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\claude-sentinel'
    : join(homedir(), '.claude-sentinel', 'daemon.sock');

export type AppMessageHandler = (
  message: AppToDaemonMessage,
  respond: (response: IpcResponse) => void,
) => void;

/**
 * IPC server — runs inside the daemon and accepts connections from the Tauri app.
 */
export class IpcServer {
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private messageHandlers: AppMessageHandler[] = [];

  onMessage(handler: AppMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  start(socketPath: string = IPC_PATH): void {
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
      let buffer = '';

      socket.setEncoding('utf-8');

      socket.on('data', (chunk: Buffer | string) => {
        /* v8 ignore next 3 */
        buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
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
   * Broadcast a message to all connected Tauri app clients.
   */
  broadcast(message: DaemonToAppMessage): void {
    const line = JSON.stringify(message) + '\n';
    for (const client of this.clients) {
      if (!client.destroyed) {
        client.write(line);
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

  connect(socketPath: string = IPC_PATH): void {
    this.socket = connect(socketPath, () => {
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
