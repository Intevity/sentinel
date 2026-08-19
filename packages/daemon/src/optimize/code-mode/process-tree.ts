/**
 * Process-tree reaping for bridged MCP children.
 *
 * `ChildProcess.kill()` signals ONE pid, not a tree. That is a problem for the
 * launchers real MCP servers ship with: `uv tool uvx mcp-atlassian` and
 * `npm exec mongodb-mcp-server` each spawn the actual server as a grandchild,
 * so signalling the wrapper strands the leaf, which reparents to init and runs
 * forever. Observed in the wild on a developer machine: leaf `mcp-atlassian`
 * processes still parented to their `uv` wrapper, whole trees sitting at ppid 1
 * months after the daemon that started them exited.
 *
 * Spawning detached (so the child leads its own process group and can be
 * signalled as `-pid`) is not available to us — the MCP SDK owns the spawn —
 * so we reconstruct the tree from a `ps` snapshot instead and signal each pid.
 *
 * Deliberately narrow: every entry point takes a pid the daemon itself spawned.
 * Nothing here scans for or reaps processes Sentinel did not start.
 *
 * Timing is a safety property, not an optimisation. A pid identifies a process
 * only while that process is alive; once it exits the kernel is free to reuse
 * the number. Callers must therefore walk and signal a tree while its root is
 * still running, and must never signal a pid whose process they know has died.
 */

import { execFile } from 'node:child_process';

/** Signalling anything at or below this is never right: 0 means "our whole
 *  process group", 1 is init. A bad pid must be a no-op, not a catastrophe. */
const MIN_SAFE_PID = 2;

/** Grace between SIGTERM and SIGKILL. These are helper processes losing the
 *  server they served, so this only needs to cover a fast exit path, not a
 *  full graceful shutdown. */
const DEFAULT_GRACE_MS = 250;

export interface ProcessTreeOpts {
  /** Test seam. */
  platform?: NodeJS.Platform;
  /** Test seam: pre-built `[pid, ppid]` rows instead of shelling out to `ps`. */
  snapshot?: Array<[number, number]>;
  /** Test seam: replaces the `ps`/`taskkill` invocation. */
  exec?: (file: string, args: string[]) => Promise<string>;
}

function defaultExec(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Whether a pid is still running. `signal 0` performs the permission and
 *  existence checks without delivering anything. EPERM means it exists but
 *  belongs to someone else — still alive, just not ours to signal. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < MIN_SAFE_PID) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Parse `ps -eo pid=,ppid=` output into `[pid, ppid]` rows, skipping any line
 *  that isn't two integers (locale banners, truncated final line). */
export function parsePsSnapshot(stdout: string): Array<[number, number]> {
  const rows: Array<[number, number]> = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    rows.push([Number(m[1]), Number(m[2])]);
  }
  return rows;
}

/** One `ps` snapshot, for callers that walk several trees at once and want to
 *  pay for the scan only once (pass the result as `opts.snapshot`). */
export async function snapshotProcessTree(
  opts: ProcessTreeOpts = {},
): Promise<Array<[number, number]>> {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? defaultExec;
  try {
    if (platform === 'win32') {
      return parseWmicSnapshot(
        await exec('powershell', [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
        ]),
      );
    }
    return parsePsSnapshot(await exec('ps', ['-eo', 'pid=,ppid=']));
  } catch {
    // No snapshot means no descendants we can prove; callers still reap the
    // root they know about.
    return [];
  }
}

/** PowerShell's output is already `<pid> <ppid>` per line, so it parses with
 *  the same rule as `ps`. Kept as a named alias so the call site reads
 *  honestly about which platform produced the text. */
const parseWmicSnapshot = parsePsSnapshot;

/** Every transitive child of `pid`, breadth-first (shallowest first). */
export async function listDescendants(pid: number, opts: ProcessTreeOpts = {}): Promise<number[]> {
  if (!Number.isInteger(pid) || pid < MIN_SAFE_PID) return [];
  const rows = opts.snapshot ?? (await snapshotProcessTree(opts));
  const childrenOf = new Map<number, number[]>();
  for (const [child, parent] of rows) {
    const list = childrenOf.get(parent);
    if (list) list.push(child);
    else childrenOf.set(parent, [child]);
  }
  const out: number[] = [];
  const queue: number[] = [pid];
  // A `ps` snapshot is taken while the tree is changing, so a cycle is
  // theoretically representable. `seen` makes the walk terminate regardless.
  const seen = new Set<number>([pid]);
  while (queue.length > 0) {
    const current = queue.shift() as number;
    for (const child of childrenOf.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** SIGTERM → grace → SIGKILL an explicit list of pids, in the order given.
 *  Returns how many were still alive when signalled.
 *
 *  Takes an explicit list rather than discovering one, because the caller is
 *  the only party that can know the pids were captured while their root was
 *  alive — see the note on timing at the top of this file. */
export async function reapPids(
  pids: number[],
  opts: { graceMs?: number; self?: number; parent?: number } = {},
): Promise<number> {
  // Belt and braces. Callers are supposed to hand us only pids they spawned,
  // but a stale or reused pid that resolved to our own process — or to the
  // process that launched us, such as a test runner supervising workers —
  // would turn a cleanup into an outage. Never signal either.
  const self = opts.self ?? process.pid;
  const parent = opts.parent ?? process.ppid;
  const alive = pids.filter((pid) => pid !== self && pid !== parent && isAlive(pid));
  if (alive.length === 0) return 0;
  for (const target of alive) signal(target, 'SIGTERM');
  const survivors = await waitForExit(alive, opts.graceMs ?? DEFAULT_GRACE_MS);
  for (const target of survivors) signal(target, 'SIGKILL');
  return alive.length;
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Exited between the liveness check and here, or not ours to signal.
  }
}

/** Poll until every pid has exited or `graceMs` elapses; returns the ones still
 *  alive. Polling (rather than waiting on an exit event) is required because
 *  these are not our direct children — we have no handle to await. */
async function waitForExit(pids: number[], graceMs: number): Promise<number[]> {
  const deadline = Date.now() + graceMs;
  let remaining = pids.filter((p) => isAlive(p));
  while (remaining.length > 0 && Date.now() < deadline) {
    // NOT unref'd. An unref'd timer does not hold the event loop open, so if
    // this poll is the only pending work — which is exactly the case during
    // shutdown, when reaping happens — Node considers the loop empty and exits
    // the process mid-await. Under a test runner that reuses worker processes
    // it kills the worker, taking whatever file it runs next with it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    remaining = remaining.filter((p) => isAlive(p));
  }
  return remaining;
}
