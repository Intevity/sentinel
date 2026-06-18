import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server, IncomingMessage, ServerResponse } from 'http';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, unlinkSync } from 'fs';
import { createProxyServer, type DaemonHealthSnapshot } from './proxy.js';
import { getDb, closeDb } from './db.js';
import { IpcServer } from './ipc.js';

const noopOtelHandler = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
  res.writeHead(204);
  res.end();
};

interface Fixture {
  port: number;
  server: Server;
  ipc: IpcServer;
  dbPath: string;
  cleanup: () => Promise<void>;
}

async function startWithHealth(
  health: DaemonHealthSnapshot,
  failMode: 'closed' | 'open' | 'warn' = 'warn',
): Promise<Fixture> {
  const dbPath = join(
    tmpdir(),
    `sentinel-health-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const db = getDb(dbPath);
  const ipc = new IpcServer();
  const proxy = createProxyServer(
    {
      db,
      ipcServer: ipc,
      getHealth: () => health,
      getSettings: () => ({ daemonHealthFailMode: failMode }),
    },
    noopOtelHandler,
  );
  await new Promise<void>((res) => proxy.listen(0, '127.0.0.1', res));
  const port = (proxy.address() as AddressInfo).port;
  return {
    port,
    server: proxy,
    ipc,
    dbPath,
    cleanup: async () => {
      await new Promise<void>((res) => proxy.close(() => res()));
      closeDb();
      if (existsSync(dbPath)) unlinkSync(dbPath);
    },
  };
}

describe('Sprint 9 — /health endpoint', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    await fx?.cleanup();
    fx = null;
  });

  it('returns 200 with components.{db,scanner,enforcer}=ok when all are healthy', async () => {
    fx = await startWithHealth({ db: 'ok', scanner: 'ok', enforcer: 'ok' });
    const res = await fetch(`http://127.0.0.1:${fx.port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      components: DaemonHealthSnapshot;
    };
    expect(body.status).toBe('ok');
    expect(body.components).toEqual({ db: 'ok', scanner: 'ok', enforcer: 'ok' });
  });

  it('returns 503 with the failing component reason when any check is degraded', async () => {
    fx = await startWithHealth({ db: 'error:closed', scanner: 'ok', enforcer: 'ok' });
    const res = await fetch(`http://127.0.0.1:${fx.port}/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      components: DaemonHealthSnapshot;
    };
    expect(body.status).toBe('degraded');
    expect(body.components.db).toBe('error:closed');
    expect(body.components.scanner).toBe('ok');
  });
});

describe('Sprint 9 — daemonHealthFailMode gate', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    await fx?.cleanup();
    fx = null;
  });

  it("'closed' mode synthesizes 503 on every non-/health request when degraded", async () => {
    fx = await startWithHealth({ db: 'error:locked', scanner: 'ok', enforcer: 'ok' }, 'closed');
    const res = await fetch(`http://127.0.0.1:${fx.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/degraded/);
  });

  it("'warn' mode logs the degradation but lets the request fall through", async () => {
    fx = await startWithHealth(
      { db: 'ok', scanner: 'error:not_initialized', enforcer: 'ok' },
      'warn',
    );
    // No upstream wired in the fixture, so the proxy will try to forward
    // and (depending on platform) return a 502 or hang. We're testing the
    // gate decision: when 'warn' is set, the request is NOT short-circuited
    // by a 503 from the gate. We rely on the connection completing past
    // the gate by checking that we did NOT get the 'sentinel daemon
    // degraded' synthetic body.
    const res = await fetch(`http://127.0.0.1:${fx.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      // No upstream is wired, so the forward can hang on some platforms (seen on
      // CI) rather than failing fast. Bound it: a hang becomes a quick abort
      // (res = null, handled below) instead of blowing the vitest timeout. The
      // gate decision is still observable — a 503 short-circuit returns
      // immediately, well inside this window.
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    if (res) {
      const text = await res.text().catch(() => '');
      expect(text).not.toMatch(/sentinel daemon degraded/);
    }
  });

  it("'open' mode is treated like 'warn' (forward despite degradation)", async () => {
    fx = await startWithHealth({ db: 'ok', scanner: 'ok', enforcer: 'error:cache_empty' }, 'open');
    const res = await fetch(`http://127.0.0.1:${fx.port}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      // No upstream is wired, so the forward can hang on some platforms (seen on
      // CI) rather than failing fast. Bound it: a hang becomes a quick abort
      // (res = null, handled below) instead of blowing the vitest timeout. The
      // gate decision is still observable — a 503 short-circuit returns
      // immediately, well inside this window.
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    if (res) {
      const text = await res.text().catch(() => '');
      expect(text).not.toMatch(/sentinel daemon degraded/);
    }
  });
});
