import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import type { LogEntry, LogLevel } from '@sentinel/shared';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const TAG_RE = /^\[([A-Za-z0-9._-]{1,32})\]/;

export interface LoggerOptions {
  dir?: string;
  fileName?: string;
  maxBytes?: number;
  maxRotations?: number;
  ringBufferSize?: number;
  initialLevel?: LogLevel;
  batchFlushMs?: number;
  maxBatchSize?: number;
  now?: () => number;
}

/** Input for the specialized `log.request()` helper. Carries the metadata
 *  needed both to format a concise one-liner (`POST /v1/messages → 200 (1.2s)`)
 *  and to tag the resulting `LogEntry` with `requestId` so the Logs UI knows
 *  the row is expandable into the captured request/response detail. */
export interface RequestLogInput {
  requestId: string;
  method: string;
  path: string;
  status: number | null;
  durationMs: number | null;
  errored?: boolean;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Emit a proxy-origin log entry with an attached `requestId`. Entries with
   *  `requestId` render as clickable rows in the Logs UI; clicking fetches
   *  the full detail via the `get_request_detail` IPC. */
  request(input: RequestLogInput): void;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
  getHistory(limit?: number): LogEntry[];
  clear(): { count: number };
  onBroadcast(handler: (entries: LogEntry[]) => void): void;
  installConsolePatch(): void;
  shutdown(): Promise<void>;
}

function formatArg(a: unknown): string {
  if (a instanceof Error) return a.stack ?? a.message;
  if (typeof a === 'string') return a;
  if (typeof a === 'number' || typeof a === 'boolean' || a == null) return String(a);
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function extractTag(message: string): string | null {
  const m = TAG_RE.exec(message);
  return m ? m[1]! : null;
}

function formatFileLine(entry: LogEntry): string {
  const levelStr = entry.level.toUpperCase().padEnd(5);
  return `[${new Date(entry.timestamp).toISOString()}] ${levelStr} ${entry.message}\n`;
}

/**
 * Where the daemon writes `daemon.log` by default. In production this is
 * `~/.sentinel`. Under tests it must NEVER be the user's real data dir: the
 * test daemon runs in-process and the `log` singleton is created at import
 * time (before any test harness sets its overrides), so a stray daemon.log
 * would land in the real `~/.sentinel` — and a pre-existing `~/.sentinel` is
 * exactly what defeats the one-time data-dir migration. `VITEST` is set by the
 * runner before any module loads, so it's a reliable pre-import signal; under
 * it, logs go to a per-process temp dir. An explicit `opts.dir` still wins.
 */
function defaultLogDir(): string {
  if (process.env.VITEST) {
    return (
      process.env.SENTINEL_TEST_LOG_DIR ?? join(tmpdir(), 'sentinel-test-logs', String(process.pid))
    );
  }
  /* v8 ignore next -- production path; unreachable under the vitest runner */
  return join(homedir(), '.sentinel');
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const dir = opts.dir ?? defaultLogDir();
  const fileName = opts.fileName ?? 'daemon.log';
  const path = join(dir, fileName);
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const maxRotations = opts.maxRotations ?? 3;
  const ringBufferSize = opts.ringBufferSize ?? 2000;
  const batchFlushMs = opts.batchFlushMs ?? 100;
  const maxBatchSize = opts.maxBatchSize ?? 50;
  const now = opts.now ?? Date.now;

  let level: LogLevel = opts.initialLevel ?? 'info';
  let seq = 0;

  mkdirSync(dir, { recursive: true });

  // Ring buffer — plain array with wrap-around writeIdx.
  const ring: (LogEntry | undefined)[] = new Array(ringBufferSize);
  let writeIdx = 0;
  let ringSize = 0;

  // File writer — synchronous so the log file is always in a consistent
  // state when tail -f / grep consumers read it, and so tests can read the
  // file immediately after a log call without flushing a stream.
  let fd: number = openSync(path, 'a');
  let bytesWritten = existsSync(path) ? statSync(path).size : 0;

  // Broadcast.
  const broadcastHandlers: ((entries: LogEntry[]) => void)[] = [];
  let pending: LogEntry[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushBroadcast(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    for (const h of broadcastHandlers) {
      try {
        h(batch);
      } catch {
        // never let a broken listener crash the logger
      }
    }
  }

  function scheduleBroadcast(entry: LogEntry): void {
    pending.push(entry);
    if (pending.length >= maxBatchSize) {
      flushBroadcast();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(flushBroadcast, batchFlushMs);
    }
  }

  function rotate(): void {
    // Close the current fd so the rename is safe on platforms that hold
    // file locks (primarily Windows).
    /* v8 ignore next 2 */
    try {
      closeSync(fd);
    } catch {
      /* best effort */
    }
    // Drop oldest rotation (.maxRotations) if present.
    const oldest = `${path}.${maxRotations}`;
    if (existsSync(oldest)) {
      /* v8 ignore next 2 */
      try {
        unlinkSync(oldest);
      } catch {
        /* best effort */
      }
    }
    // Shift: .N-1 → .N, ..., .1 → .2
    for (let i = maxRotations - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      const to = `${path}.${i + 1}`;
      if (existsSync(from)) {
        /* v8 ignore next 2 */
        try {
          renameSync(from, to);
        } catch {
          /* best effort */
        }
      }
    }
    // base → .1
    if (existsSync(path)) {
      /* v8 ignore next 2 */
      try {
        renameSync(path, `${path}.1`);
      } catch {
        /* best effort */
      }
    }
    fd = openSync(path, 'a');
    bytesWritten = 0;
  }

  function writeLine(line: string): void {
    const buf = Buffer.from(line, 'utf-8');
    /* v8 ignore next 4 — best-effort disk write; errors are swallowed to
       keep the daemon alive if the log volume briefly fills the disk. */
    try {
      writeSync(fd, buf);
    } catch {
      /* ignore */
    }
    bytesWritten += buf.length;
    if (bytesWritten >= maxBytes) {
      rotate();
    }
  }

  function emit(entryLevel: LogLevel, args: unknown[], requestId?: string): void {
    const entryRank = LEVELS[entryLevel];
    const curRank = LEVELS[level];
    if (entryRank < curRank) return;
    const message = args.map(formatArg).join(' ');
    const entry: LogEntry = {
      seq: seq++,
      timestamp: now(),
      level: entryLevel,
      message,
      tag: extractTag(message),
    };
    if (requestId) entry.requestId = requestId;
    // Ring buffer.
    ring[writeIdx] = entry;
    writeIdx = (writeIdx + 1) % ringBufferSize;
    if (ringSize < ringBufferSize) ringSize++;
    // File.
    writeLine(formatFileLine(entry));
    // Broadcast.
    scheduleBroadcast(entry);
  }

  function formatRequestMessage(input: RequestLogInput): string {
    const parts = [`[proxy] ${input.method} ${input.path}`];
    if (input.errored) {
      parts.push('→ ERROR');
    } else if (input.status !== null) {
      parts.push(`→ ${input.status}`);
    } else {
      parts.push('→ no response');
    }
    if (input.durationMs !== null) {
      parts.push(`(${(input.durationMs / 1000).toFixed(2)}s)`);
    }
    return parts.join(' ');
  }

  function getHistory(limit?: number): LogEntry[] {
    const cap = Math.min(limit ?? ringBufferSize, ringSize);
    const out: LogEntry[] = new Array(cap);
    // Oldest index in the buffer.
    const oldest = ringSize < ringBufferSize ? 0 : writeIdx;
    const startOffset = ringSize - cap;
    for (let i = 0; i < cap; i++) {
      const idx = (oldest + startOffset + i) % ringBufferSize;
      out[i] = ring[idx]!;
    }
    return out;
  }

  function clearBuffer(): { count: number } {
    const count = ringSize;
    for (let i = 0; i < ringBufferSize; i++) ring[i] = undefined;
    writeIdx = 0;
    ringSize = 0;
    // Flush any pending broadcast batch so the UI doesn't receive entries
    // after the cleared event.
    pending = [];
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // Truncate the file and reopen the fd. writeFileSync may replace the
    // inode via an unlink+create on some platforms; without reopening, our
    // cached fd would point to an orphaned inode and subsequent writes would
    // silently drop on the floor.
    /* v8 ignore next 7 */
    try {
      closeSync(fd);
    } catch {
      /* best effort */
    }
    try {
      writeFileSync(path, '');
    } catch {
      /* best effort */
    }
    fd = openSync(path, 'a');
    bytesWritten = 0;
    return { count };
  }

  let consolePatched = false;
  function installConsolePatch(): void {
    if (consolePatched) return;
    consolePatched = true;
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a: unknown[]) => {
      orig.log(...a);
      emit('info', a);
    };
    console.warn = (...a: unknown[]) => {
      orig.warn(...a);
      emit('warn', a);
    };
    console.error = (...a: unknown[]) => {
      orig.error(...a);
      emit('error', a);
    };
  }

  return {
    debug(...args) {
      emit('debug', args);
    },
    info(...args) {
      emit('info', args);
    },
    warn(...args) {
      emit('warn', args);
    },
    error(...args) {
      emit('error', args);
    },
    request(input) {
      emit(input.errored ? 'error' : 'info', [formatRequestMessage(input)], input.requestId);
    },
    setLevel(l) {
      level = l;
    },
    getLevel() {
      return level;
    },
    getHistory,
    clear: clearBuffer,
    onBroadcast(h) {
      broadcastHandlers.push(h);
    },
    installConsolePatch,
    async shutdown() {
      flushBroadcast();
      /* v8 ignore next 3 */
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    },
  };
}

/** Process-wide singleton. Daemon startup calls `log.setLevel(...)` followed
 *  by `log.installConsolePatch()` before any subsystem logs. */
export const log: Logger = createLogger();
