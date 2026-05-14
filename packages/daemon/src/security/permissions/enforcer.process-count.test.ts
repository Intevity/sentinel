import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for {@link countClaudeCodeProcesses}.
 *
 * Bug history:
 *  1. `pgrep -cf` (Linux-only flag) silently failed on macOS, causing
 *     pruning to be skipped and stale sessions to accumulate up to the
 *     4 h hard timeout. Fixed by switching to `pgrep -f` and counting
 *     PID lines locally.
 *  2. The npm-package-path pattern (`@anthropic-ai/claude-code`) missed
 *     the Claude desktop bundled binary, which presents as command
 *     name `claude` with no npm path in argv. Fixed by also running
 *     `pgrep -x claude` and unioning the two PID sets.
 *
 * These tests pin:
 *  - the union behaviour across the two probes;
 *  - dedup when a PID matches both patterns;
 *  - "no match" mapped to 0 so pruning still drains stale sessions;
 *  - real failures returning null so callers skip pruning that round.
 *
 * Mock-budget note: this file mocks `child_process` (2 sites — one
 * module mock plus one stub fn) because the function under test shells
 * out to a system binary via `promisify(exec)`. The integration test
 * in enforcer.test.ts exercises the prune flow via the `countProcesses`
 * dep override, but the parsing / error-classification branches inside
 * `countClaudeCodeProcesses` are where the original bug lived and only
 * exist when the real subprocess plumbing runs. No other seam reaches
 * them, so the module mock is the minimum-cost way to pin the fix.
 */

type ExecCb = (
  err: (Error & { code?: number; stdout?: string }) | null,
  stdio: { stdout: string; stderr: string },
) => void;

const mockExec = vi.fn<(cmd: string, opts: object, cb: ExecCb) => void>();

vi.mock('child_process', () => ({
  exec: (cmd: string, opts: object, cb: ExecCb) => mockExec(cmd, opts, cb),
}));

const { countClaudeCodeProcesses } = await import('./enforcer.js');

/** Helper: dispatch on the pgrep command shape so each probe can be
 *  stubbed independently. */
function pgrepStub(byName: string, byArgv: string): void {
  mockExec.mockImplementation((cmd, _opts, cb) => {
    const out = cmd.includes('-x') ? byName : byArgv;
    if (out === '__error__') {
      const err = new Error('boom') as Error & { code?: number; stdout?: string };
      err.code = 2;
      err.stdout = '';
      cb(err, { stdout: '', stderr: 'usage: pgrep [-Lfilnoqvx]…' });
      return;
    }
    if (out === '__nomatch__') {
      const err = new Error('no matches') as Error & { code?: number; stdout?: string };
      err.code = 1;
      err.stdout = '';
      cb(err, { stdout: '', stderr: '' });
      return;
    }
    cb(null, { stdout: out, stderr: '' });
  });
}

describe('countClaudeCodeProcesses', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    mockExec.mockReset();
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('unions PIDs from `pgrep -x claude` and `pgrep -f @anthropic-ai/claude-code`', async () => {
    // Two probes, distinct PIDs in each — the union is the count.
    pgrepStub('11111\n22222\n', '33333\n44444\n');
    expect(await countClaudeCodeProcesses()).toBe(4);
  });

  it('dedupes PIDs that match both probes (npm install with cmd-name = claude)', async () => {
    // 22222 appears in both — counted once.
    pgrepStub('11111\n22222\n', '22222\n33333\n');
    expect(await countClaudeCodeProcesses()).toBe(3);
  });

  it('ignores blank / non-numeric lines', async () => {
    pgrepStub('11111\n\nnot-a-pid\n22222\n', '');
    expect(await countClaudeCodeProcesses()).toBe(2);
  });

  it('treats "no matches" on either probe as zero, not null', async () => {
    // Critical regression: the prior implementation conflated
    // "no matches" with "scan failed" and skipped pruning, leaving
    // stale sessions in place forever on macOS.
    pgrepStub('__nomatch__', '__nomatch__');
    expect(await countClaudeCodeProcesses()).toBe(0);
  });

  it('counts one probe when the other has no matches', async () => {
    pgrepStub('99999\n', '__nomatch__');
    expect(await countClaudeCodeProcesses()).toBe(1);
  });

  it('returns null when EITHER probe fails for real (timeout, usage error, ENOENT)', async () => {
    pgrepStub('11111\n', '__error__');
    expect(await countClaudeCodeProcesses()).toBeNull();
    pgrepStub('__error__', '11111\n');
    expect(await countClaudeCodeProcesses()).toBeNull();
  });

  it('uses pgrep -x and pgrep -f (never -c) on darwin', async () => {
    pgrepStub('1\n', '2\n');
    await countClaudeCodeProcesses();
    const cmds = mockExec.mock.calls.map((c) => c[0] ?? '');
    expect(cmds.some((c) => /pgrep\s+-x/.test(c) && /claude/.test(c))).toBe(true);
    expect(cmds.some((c) => /pgrep\s+-f/.test(c) && /@anthropic-ai\/claude-code/.test(c))).toBe(
      true,
    );
    for (const c of cmds) expect(c).not.toMatch(/pgrep\s+-\w*c\W/);
  });

  it('runs the same two-probe shape on linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    pgrepStub('1\n2\n', '3\n');
    expect(await countClaudeCodeProcesses()).toBe(3);
    const cmds = mockExec.mock.calls.map((c) => c[0] ?? '');
    expect(cmds.some((c) => /pgrep\s+-x/.test(c))).toBe(true);
    expect(cmds.some((c) => /pgrep\s+-f/.test(c))).toBe(true);
  });

  it('uses PowerShell with a union filter on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mockExec.mockImplementation((_cmd, _opts, cb) => cb(null, { stdout: '4\n', stderr: '' }));
    expect(await countClaudeCodeProcesses()).toBe(4);
    const cmd = mockExec.mock.calls[0]?.[0] ?? '';
    expect(cmd).toContain('powershell');
    expect(cmd).toContain('Win32_Process');
    // Filter must include both the bundled-binary name and the npm path.
    expect(cmd).toContain('claude.exe');
    expect(cmd).toContain('@anthropic-ai/claude-code');
  });

  it('returns null when PowerShell output cannot be parsed', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mockExec.mockImplementation((_cmd, _opts, cb) =>
      cb(null, { stdout: 'not-a-number\n', stderr: '' }),
    );
    expect(await countClaudeCodeProcesses()).toBeNull();
  });
});
