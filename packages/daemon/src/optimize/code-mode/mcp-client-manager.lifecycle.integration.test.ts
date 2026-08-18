/**
 * Integration: child-process lifecycle for bridged stdio servers, against real
 * spawned processes.
 *
 * This file exists because of a specific production defect. A developer's
 * daemon was found owning three concurrent `uv tool uvx mcp-atlassian`
 * children — one twelve days old — despite a five-minute idle shutdown, with
 * the manager's own map believing all of them were gone. Two mechanisms
 * produced that, and both are pinned down here:
 *
 *   1. A child that spawned but failed the MCP handshake was never registered,
 *      so nothing could ever drop it.
 *   2. Real launchers (`uv tool uvx X`, `npm exec X`) run the server as a
 *      GRANDCHILD, and signalling the direct child strands it.
 *
 * The fake stdio server used here spawns a long-lived grandchild for exactly
 * that reason. Every assertion below fails if teardown stops verifying.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeFakeMcpStdioScript,
  writeFakeMcpStdioScriptWithGrandchild,
  FAKE_MCP_TOOLS,
} from '@sentinel/test-harness';
import { redactSecretsInString } from '../../security/detectors.js';
import { createMcpClientManager, type McpClientManager } from './mcp-client-manager.js';
import { isAlive, listDescendants } from './process-tree.js';

/** Poll until the pid is gone, up to `timeoutMs`. Returns whether it died.
 *  Signals are asynchronous — asserting liveness on the next tick would be a
 *  race, and a bare sleep would be slower and still racy. */
async function waitForDeath(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isAlive(pid);
}

describe('mcp-client-manager (child process lifecycle)', () => {
  let manager: McpClientManager | null = null;
  let cleanupScript: (() => void) | null = null;
  let tmp: string | null = null;
  /** Anything spawned by a test, killed in afterEach so a FAILING test cannot
   *  leave a stray process behind on the developer's machine. */
  const spawned = new Set<number>();

  afterEach(async () => {
    await manager?.stopAll();
    cleanupScript?.();
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
    for (const pid of spawned) {
      try {
        if (isAlive(pid)) process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    spawned.clear();
    manager = null;
    cleanupScript = null;
    tmp = null;
  });

  function pidFilePath(): string {
    tmp = mkdtempSync(join(tmpdir(), 'sentinel-mcp-lifecycle-'));
    return join(tmp, 'grandchild.pid');
  }

  function readPid(path: string): number {
    const pid = Number(readFileSync(path, 'utf-8').trim());
    expect(Number.isInteger(pid)).toBe(true);
    spawned.add(pid);
    return pid;
  }

  function managerFor(
    entry: Record<string, unknown>,
    extra: Partial<Parameters<typeof createMcpClientManager>[0]> = {},
  ): McpClientManager {
    manager = createMcpClientManager({
      resolveEntry: (server) => (server === 'grandkid' ? { key: 'grandkid', entry } : undefined),
      isAllowed: () => true,
      redact: redactSecretsInString,
      ...extra,
    });
    return manager;
  }

  function grandchildEntry(pidFile: string, env: Record<string, string> = {}) {
    const script = writeFakeMcpStdioScriptWithGrandchild();
    cleanupScript = script.cleanup;
    return {
      command: process.execPath,
      args: [script.path],
      env: { FAKE_MCP_CHILD_PID_FILE: pidFile, ...env },
    };
  }

  it('kills the grandchild, not just the direct child, when a server is dropped', async () => {
    const pidFile = pidFilePath();
    const m = managerFor(grandchildEntry(pidFile));
    await m.listTools('grandkid');

    const [runtime] = await m.runtime();
    const childPid = runtime?.clients[0]?.pid ?? null;
    expect(childPid).not.toBeNull();
    spawned.add(childPid as number);

    // The grandchild must really be a descendant — otherwise this test would
    // pass for the wrong reason.
    const grandchildPid = readPid(pidFile);
    expect(await listDescendants(childPid as number)).toContain(grandchildPid);
    expect(isAlive(grandchildPid)).toBe(true);

    await m.dropServer('grandkid');

    expect(await waitForDeath(childPid as number)).toBe(true);
    // The regression: closing the transport signals the wrapper alone, which
    // leaves this process running forever.
    expect(await waitForDeath(grandchildPid)).toBe(true);
  });

  it('reaps a child stranded by a failed handshake', async () => {
    const pidFile = pidFilePath();
    const m = managerFor(grandchildEntry(pidFile, { FAKE_MCP_BAD_INIT: '1' }));

    await expect(m.listTools('grandkid')).rejects.toThrow(/initialize failure/);

    // Nothing was ever registered, so no drop path could reach these — they
    // are only cleaned up because the connect-failure path reaps explicitly.
    const grandchildPid = readPid(pidFile);
    expect(await waitForDeath(grandchildPid)).toBe(true);
    expect(await m.runtime()).toEqual([
      expect.objectContaining({
        server: 'grandkid',
        liveProcesses: 0,
        clients: [],
        lastError: expect.stringContaining('initialize failure'),
      }),
    ]);
  });

  it('kills the whole tree on stopAll', async () => {
    const pidFile = pidFilePath();
    const m = managerFor(grandchildEntry(pidFile));
    await m.listTools('grandkid');
    const grandchildPid = readPid(pidFile);

    await m.stopAll();
    manager = null;

    expect(await waitForDeath(grandchildPid)).toBe(true);
  });

  it('kills the whole tree when the idle timeout fires', async () => {
    const pidFile = pidFilePath();
    const m = managerFor(grandchildEntry(pidFile), { idleShutdownMs: 60 });
    await m.listTools('grandkid');
    const grandchildPid = readPid(pidFile);

    expect(await waitForDeath(grandchildPid)).toBe(true);
    expect(m.connectedCount()).toBe(0);
  });

  it('recycles a client past its max age on the next acquire, replacing the process', async () => {
    const pidFile = pidFilePath();
    // Long idle timeout so age, not idleness, is provably what recycles it.
    const m = managerFor(grandchildEntry(pidFile), {
      maxClientAgeMs: 40,
      idleShutdownMs: 60_000,
    });
    await m.listTools('grandkid');
    const firstPid = (await m.runtime())[0]?.clients[0]?.pid ?? null;
    const firstGrandchild = readPid(pidFile);
    expect(firstPid).not.toBeNull();
    spawned.add(firstPid as number);

    await new Promise((resolve) => setTimeout(resolve, 60));
    await m.listTools('grandkid');

    const secondPid = (await m.runtime())[0]?.clients[0]?.pid ?? null;
    expect(secondPid).not.toBe(firstPid);
    // The recycle must take the old tree with it, or recycling would itself
    // become the leak.
    expect(await waitForDeath(firstGrandchild)).toBe(true);
    spawned.add(secondPid as number);
  });

  it('does not recycle a client that is still within its max age', async () => {
    const pidFile = pidFilePath();
    const m = managerFor(grandchildEntry(pidFile), { maxClientAgeMs: 60_000 });
    await m.listTools('grandkid');
    const firstPid = (await m.runtime())[0]?.clients[0]?.pid ?? null;
    spawned.add(firstPid as number);

    await m.listTools('grandkid');

    expect((await m.runtime())[0]?.clients[0]?.pid).toBe(firstPid);
    expect(m.connectedCount()).toBe(1);
  });

  it('restarts a server with a fresh process and returns its tools', async () => {
    const pidFile = pidFilePath();
    const m = managerFor(grandchildEntry(pidFile), { idleShutdownMs: 60_000 });
    await m.listTools('grandkid');
    const firstPid = (await m.runtime())[0]?.clients[0]?.pid ?? null;
    const firstGrandchild = readPid(pidFile);
    spawned.add(firstPid as number);

    const tools = await m.restartServer('grandkid');

    expect(tools.map((t) => t.name)).toEqual(FAKE_MCP_TOOLS.map((t) => t.name));
    const secondPid = (await m.runtime())[0]?.clients[0]?.pid ?? null;
    expect(secondPid).not.toBe(firstPid);
    expect(isAlive(secondPid as number)).toBe(true);
    expect(await waitForDeath(firstGrandchild)).toBe(true);
    spawned.add(secondPid as number);
  });

  it('refuses to restart a server that is not bridged', async () => {
    const script = writeFakeMcpStdioScript();
    cleanupScript = script.cleanup;
    manager = createMcpClientManager({
      resolveEntry: (server) => ({
        key: server,
        entry: { command: process.execPath, args: [script.path] },
      }),
      isAllowed: () => false,
      redact: redactSecretsInString,
    });

    await expect(manager.restartServer('nope')).rejects.toThrow(
      "MCP server 'nope' is not bridged to code mode",
    );
  });
});
