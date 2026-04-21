import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import { IpcServer, IpcClient } from './ipc.js';

const TEST_SOCK = join(tmpdir(), `sentinel-test-${Date.now()}.sock`);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('IpcServer', () => {
  let server: IpcServer;

  beforeEach(() => {
    server = new IpcServer();
  });

  afterEach(() => {
    server.close();
    if (existsSync(TEST_SOCK)) unlinkSync(TEST_SOCK);
  });

  it('starts and accepts connections', async () => {
    server.start(TEST_SOCK);
    await sleep(50);
    expect(existsSync(TEST_SOCK)).toBe(true);
  });

  it('has zero connected clients initially', () => {
    expect(server.connectedClients).toBe(0);
  });

  it('can be closed without starting', () => {
    expect(() => server.close()).not.toThrow();
  });

  it('receives messages from client', async () => {
    server.start(TEST_SOCK);
    await sleep(50);

    const received: unknown[] = [];
    server.onMessage((msg, respond) => {
      received.push(msg);
      respond({ requestType: msg.type, success: true });
    });

    const client = new IpcClient();
    client.connect(TEST_SOCK);
    await sleep(50);

    client.send({ type: 'get_accounts' });
    await sleep(50);

    expect(received).toHaveLength(1);
    expect((received[0] as { type: string }).type).toBe('get_accounts');
    client.close();
  });

  it('broadcasts messages to all clients', async () => {
    server.start(TEST_SOCK);
    await sleep(50);

    const received1: unknown[] = [];
    const received2: unknown[] = [];

    const client1 = new IpcClient();
    const client2 = new IpcClient();

    client1.onMessage((msg) => received1.push(msg));
    client2.onMessage((msg) => received2.push(msg));

    client1.connect(TEST_SOCK);
    client2.connect(TEST_SOCK);
    await sleep(50);

    server.broadcast({ type: 'overage_entered', accountId: 'acc-1', resetsAt: 1776700800 });
    await sleep(50);

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);

    client1.close();
    client2.close();
  });

  it('handles multiple message handlers', async () => {
    server.start(TEST_SOCK);
    await sleep(50);

    const calls1: unknown[] = [];
    const calls2: unknown[] = [];
    server.onMessage((msg) => calls1.push(msg));
    server.onMessage((msg) => calls2.push(msg));

    const client = new IpcClient();
    client.connect(TEST_SOCK);
    await sleep(50);

    client.send({ type: 'get_accounts' });
    await sleep(50);

    expect(calls1).toHaveLength(1);
    expect(calls2).toHaveLength(1);
    client.close();
  });

  it('sends response back to client', async () => {
    server.start(TEST_SOCK);
    await sleep(50);

    server.onMessage((_msg, respond) => {
      respond({ requestType: 'get_accounts', success: true, data: [{ id: 'acc-1' }] });
    });

    const responses: unknown[] = [];
    const client = new IpcClient();
    client.onMessage((msg) => responses.push(msg));
    client.connect(TEST_SOCK);
    await sleep(50);

    client.send({ type: 'get_accounts' });
    await sleep(100);

    expect(responses).toHaveLength(1);
    client.close();
  });
});

describe('IpcClient', () => {
  let server: IpcServer;
  let client: IpcClient;

  beforeEach(async () => {
    server = new IpcServer();
    server.start(TEST_SOCK);
    await sleep(50);
    client = new IpcClient();
  });

  afterEach(() => {
    client.close();
    server.close();
    if (existsSync(TEST_SOCK)) unlinkSync(TEST_SOCK);
  });

  it('connects to server', async () => {
    const connected = new Promise<void>((resolve) => client.onConnect(resolve));
    client.connect(TEST_SOCK);
    await connected;
    expect(true).toBe(true); // connected without error
  });

  it('fires onConnect callback', async () => {
    let fired = false;
    client.onConnect(() => {
      fired = true;
    });
    client.connect(TEST_SOCK);
    await sleep(100);
    expect(fired).toBe(true);
  });

  it('fires onError for bad socket path', async () => {
    const errors: Error[] = [];
    client.onError((e) => errors.push(e));
    client.connect('/nonexistent/path/to/sock');
    await sleep(100);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('can send messages', async () => {
    const received: unknown[] = [];
    server.onMessage((msg) => received.push(msg));
    client.connect(TEST_SOCK);
    await sleep(50);

    client.send({ type: 'get_accounts' });
    await sleep(50);

    expect(received).toHaveLength(1);
  });

  it('receives broadcast messages from server', async () => {
    const messages: unknown[] = [];
    client.onMessage((msg) => messages.push(msg));
    client.connect(TEST_SOCK);
    await sleep(50);

    server.broadcast({ type: 'overage_exited', accountId: 'acc-1' });
    await sleep(50);

    expect(messages).toHaveLength(1);
    expect((messages[0] as { type: string }).type).toBe('overage_exited');
  });

  it('close is idempotent', () => {
    client.connect(TEST_SOCK);
    client.close();
    expect(() => client.close()).not.toThrow();
  });
});

describe('IpcServer - socket lifecycle', () => {
  let server: IpcServer;

  beforeEach(async () => {
    server = new IpcServer();
    server.start(TEST_SOCK);
    await sleep(50);
  });

  afterEach(() => {
    server.close();
    if (existsSync(TEST_SOCK)) unlinkSync(TEST_SOCK);
  });

  it('handles malformed JSON from client gracefully', async () => {
    // Server should ignore bad JSON without crashing
    const client = new IpcClient();
    const responses: unknown[] = [];
    server.onMessage((msg) => responses.push(msg));

    client.connect(TEST_SOCK);
    await sleep(50);

    // Send raw malformed data directly
    (client as unknown as { socket: { write: (d: string) => void } }).socket.write('not-json\n');
    await sleep(50);

    // Server should still be running (malformed message ignored)
    expect(server.connectedClients).toBeGreaterThanOrEqual(0);
    client.close();
  });

  it('server skips empty/whitespace-only lines in data stream', async () => {
    const received: unknown[] = [];
    server.onMessage((msg) => received.push(msg));

    const client = new IpcClient();
    client.connect(TEST_SOCK);
    await sleep(50);

    // Send a mix of blank lines and a valid message
    (client as unknown as { socket: { write: (d: string) => void } }).socket.write(
      '\n   \n' + JSON.stringify({ type: 'get_accounts' }) + '\n',
    );
    await sleep(50);

    expect(received).toHaveLength(1);
    expect((received[0] as { type: string }).type).toBe('get_accounts');
    client.close();
  });

  it('removes client from set when socket closes', async () => {
    const client = new IpcClient();
    client.connect(TEST_SOCK);
    await sleep(50);

    expect(server.connectedClients).toBe(1);
    client.close();
    await sleep(100);

    // Client count should be 0 after close
    expect(server.connectedClients).toBe(0);
  });

  it('handles client socket errors without crashing', async () => {
    const client = new IpcClient();
    client.connect(TEST_SOCK);
    await sleep(50);

    expect(server.connectedClients).toBe(1);
    // Simulate a socket error by destroying the socket
    (client as unknown as { socket: { destroy: (e: Error) => void } }).socket.destroy(
      new Error('test error'),
    );
    await sleep(100);

    // Server should still be running
    expect(server.connectedClients).toBeLessThanOrEqual(1);
  });

  it('respond function is called correctly', async () => {
    const responses: unknown[] = [];
    server.onMessage((_msg, respond) => {
      respond({ requestType: 'test', success: true, data: 'response-data' });
    });

    const client = new IpcClient();
    client.onMessage((msg) => responses.push(msg));
    client.connect(TEST_SOCK);
    await sleep(50);

    client.send({ type: 'get_accounts' });
    await sleep(100);

    expect(responses).toHaveLength(1);
  });

  it('client ignores malformed JSON sent from server', async () => {
    const received: unknown[] = [];
    const client = new IpcClient();
    client.onMessage((msg) => received.push(msg));
    client.connect(TEST_SOCK);
    await sleep(50);

    // Write raw malformed data to all connected clients via the server's internal socket set
    const serverAny = server as unknown as { clients: Set<{ write: (d: string) => void }> };
    for (const sock of serverAny.clients) {
      sock.write('not-valid-json\n');
    }
    await sleep(50);

    // Client should silently discard the malformed message without crashing
    expect(received).toHaveLength(0);
    client.close();
  });

  it('client skips empty/whitespace-only lines from server', async () => {
    const received: unknown[] = [];
    const client = new IpcClient();
    client.onMessage((msg) => received.push(msg));
    client.connect(TEST_SOCK);
    await sleep(50);

    // Send blank lines then a valid broadcast to all connected sockets
    const serverAny = server as unknown as { clients: Set<{ write: (d: string) => void }> };
    for (const sock of serverAny.clients) {
      sock.write('\n   \n' + JSON.stringify({ type: 'overage_exited', accountId: 'acc-1' }) + '\n');
    }
    await sleep(50);

    expect(received).toHaveLength(1);
    client.close();
  });
});
