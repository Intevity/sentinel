import { describe, it, expect } from 'vitest';
import {
  shortTurnAfterLargeRead,
  repeatReadSameFile,
  explorationGlobGrepWithoutEdit,
  bashLogParse,
  testRunnerNoise,
  diffPrePass,
  runAllHeuristics,
} from './heuristics.js';
import type { ToolCallRow } from '../db.js';

function row(overrides: Partial<ToolCallRow>): ToolCallRow {
  return {
    id: overrides.id ?? Math.floor(Math.random() * 1e6),
    ts: 1_700_000_000_000,
    accountId: 'a1',
    sessionId: 's1',
    requestId: 'r1',
    requestSeqInSession: 1,
    toolUseId: null,
    toolName: 'Read',
    filePath: null,
    inputSizeBytes: 100,
    responseSizeBytes: null,
    wasQuotedInLaterTurn: null,
    denied: false,
    model: 'claude-opus-4-7',
    attributedInputTokens: null,
    attributedCachedTokens: null,
    ...overrides,
  };
}

describe('shortTurnAfterLargeRead', () => {
  it('fires on a Read >32KB whose file_path was not quoted later', () => {
    const out = shortTurnAfterLargeRead([
      row({
        id: 1,
        toolName: 'Read',
        filePath: '/big.log',
        responseSizeBytes: 50_000,
        wasQuotedInLaterTurn: false,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('file-explorer');
    expect(out[0]?.pattern).toBe('short_turn_after_large_read');
  });

  it('does not fire when wasQuotedInLaterTurn=null (not yet evaluated)', () => {
    const out = shortTurnAfterLargeRead([
      row({ toolName: 'Read', responseSizeBytes: 50_000, wasQuotedInLaterTurn: null }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire when wasQuotedInLaterTurn=true', () => {
    const out = shortTurnAfterLargeRead([
      row({ toolName: 'Read', responseSizeBytes: 50_000, wasQuotedInLaterTurn: true }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire on small reads', () => {
    const out = shortTurnAfterLargeRead([
      row({ toolName: 'Read', responseSizeBytes: 1000, wasQuotedInLaterTurn: false }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire on denied tool calls', () => {
    const out = shortTurnAfterLargeRead([
      row({
        toolName: 'Read',
        responseSizeBytes: 50_000,
        wasQuotedInLaterTurn: false,
        denied: true,
      }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe('repeatReadSameFile', () => {
  it('fires when same file is read 3+ times in one session', () => {
    const out = repeatReadSameFile([
      row({ id: 1, toolName: 'Read', filePath: '/foo.ts', responseSizeBytes: 1000 }),
      row({ id: 2, toolName: 'Read', filePath: '/foo.ts', responseSizeBytes: 1000 }),
      row({ id: 3, toolName: 'Read', filePath: '/foo.ts', responseSizeBytes: 1000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.sourceToolCallIds).toEqual([1, 2, 3]);
  });

  it('does not fire below the threshold', () => {
    const out = repeatReadSameFile([
      row({ toolName: 'Read', filePath: '/a.ts' }),
      row({ toolName: 'Read', filePath: '/a.ts' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not count denied reads', () => {
    const out = repeatReadSameFile([
      row({ toolName: 'Read', filePath: '/a.ts' }),
      row({ toolName: 'Read', filePath: '/a.ts' }),
      row({ toolName: 'Read', filePath: '/a.ts', denied: true }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('aggregates response_size_bytes across reads (treating null as 0)', () => {
    const out = repeatReadSameFile([
      row({ id: 1, toolName: 'Read', filePath: '/a.ts', responseSizeBytes: 1000 }),
      row({ id: 2, toolName: 'Read', filePath: '/a.ts', responseSizeBytes: null }),
      row({ id: 3, toolName: 'Read', filePath: '/a.ts', responseSizeBytes: 500 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.totalResponseBytes).toBe(1500);
  });

  it('does not fire on null file_path', () => {
    const out = repeatReadSameFile([
      row({ toolName: 'Read', filePath: null }),
      row({ toolName: 'Read', filePath: null }),
      row({ toolName: 'Read', filePath: null }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe('explorationGlobGrepWithoutEdit', () => {
  it('fires when 5+ Glob/Grep precede no Edit', () => {
    const out = explorationGlobGrepWithoutEdit([
      row({ toolName: 'Glob' }),
      row({ toolName: 'Grep' }),
      row({ toolName: 'Glob' }),
      row({ toolName: 'Grep' }),
      row({ toolName: 'Grep' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('repo-mapper');
  });

  it('truncates at the first Edit when 5+ Glob/Grep precede it', () => {
    const out = explorationGlobGrepWithoutEdit([
      row({ toolName: 'Glob' }),
      row({ toolName: 'Glob' }),
      row({ toolName: 'Glob' }),
      row({ toolName: 'Glob' }),
      row({ toolName: 'Glob' }),
      row({ toolName: 'Edit' }),
      row({ toolName: 'Glob' }), // shouldn't be counted
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.sourceToolCallIds).toHaveLength(5);
  });

  it('does not fire below the threshold', () => {
    const out = explorationGlobGrepWithoutEdit([
      row({ toolName: 'Glob' }),
      row({ toolName: 'Grep' }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe('bashLogParse', () => {
  it('fires on a Bash result ≥ 16KB', () => {
    const out = bashLogParse([row({ toolName: 'Bash', responseSizeBytes: 20_000 })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('log-analyzer');
  });

  it('does not fire below the threshold', () => {
    const out = bashLogParse([row({ toolName: 'Bash', responseSizeBytes: 5_000 })]);
    expect(out).toHaveLength(0);
  });

  it('skips test runners (handled by testRunnerNoise)', () => {
    const out = bashLogParse([
      row({ toolName: 'Bash', responseSizeBytes: 20_000, filePath: 'pnpm test' }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe('testRunnerNoise', () => {
  it('fires on a noisy npm test', () => {
    const out = testRunnerNoise([
      row({ toolName: 'Bash', responseSizeBytes: 50_000, filePath: 'npm test --watchAll' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('test-runner-parser');
  });

  it('does not fire on non-test bash commands', () => {
    const out = testRunnerNoise([
      row({ toolName: 'Bash', responseSizeBytes: 50_000, filePath: 'ls -la' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire below the size threshold', () => {
    const out = testRunnerNoise([
      row({ toolName: 'Bash', responseSizeBytes: 5_000, filePath: 'pnpm test' }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe('diffPrePass', () => {
  it('fires when ≥ 2 Read+Edit pairs exist on distinct files', () => {
    const out = diffPrePass([
      row({ toolName: 'Read', filePath: '/a.ts' }),
      row({ toolName: 'Edit', filePath: '/a.ts' }),
      row({ toolName: 'Read', filePath: '/b.ts' }),
      row({ toolName: 'Edit', filePath: '/b.ts' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('diff-pre-pass');
  });

  it('does not fire on a single edited file', () => {
    const out = diffPrePass([
      row({ toolName: 'Read', filePath: '/only.ts' }),
      row({ toolName: 'Edit', filePath: '/only.ts' }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe('heuristics — null response_size_bytes branches', () => {
  it('shortTurnAfterLargeRead skips rows without response_size_bytes', () => {
    const out = shortTurnAfterLargeRead([
      row({ toolName: 'Read', responseSizeBytes: null, wasQuotedInLaterTurn: false }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('bashLogParse skips rows without response_size_bytes', () => {
    const out = bashLogParse([row({ toolName: 'Bash', responseSizeBytes: null })]);
    expect(out).toHaveLength(0);
  });

  it('testRunnerNoise skips rows without response_size_bytes', () => {
    const out = testRunnerNoise([
      row({ toolName: 'Bash', responseSizeBytes: null, filePath: 'pnpm test' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('testRunnerNoise handles null file_path (no command captured)', () => {
    const out = testRunnerNoise([
      row({ toolName: 'Bash', responseSizeBytes: 50_000, filePath: null }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('bashLogParse skips denied bash calls', () => {
    const out = bashLogParse([row({ toolName: 'Bash', responseSizeBytes: 50_000, denied: true })]);
    expect(out).toHaveLength(0);
  });

  it('testRunnerNoise skips denied bash calls', () => {
    const out = testRunnerNoise([
      row({ toolName: 'Bash', responseSizeBytes: 50_000, filePath: 'pnpm test', denied: true }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('diffPrePass skips when fewer than 2 reads of edited files', () => {
    // Two distinct edited files but only one matching read — pattern
    // doesn't fire.
    const out = diffPrePass([
      row({ toolName: 'Read', filePath: '/a.ts' }),
      row({ toolName: 'Edit', filePath: '/a.ts' }),
      row({ toolName: 'Edit', filePath: '/b.ts' }), // no read for /b.ts
    ]);
    expect(out).toHaveLength(0);
  });

  it('diffPrePass ignores denied edits', () => {
    const out = diffPrePass([
      row({ toolName: 'Read', filePath: '/a.ts' }),
      row({ toolName: 'Edit', filePath: '/a.ts', denied: true }),
      row({ toolName: 'Read', filePath: '/b.ts' }),
      row({ toolName: 'Edit', filePath: '/b.ts', denied: true }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe('runAllHeuristics', () => {
  it('combines opportunities from every heuristic', () => {
    const out = runAllHeuristics([
      row({
        id: 1,
        toolName: 'Read',
        filePath: '/big.log',
        responseSizeBytes: 50_000,
        wasQuotedInLaterTurn: false,
      }),
      row({
        toolName: 'Bash',
        responseSizeBytes: 60_000,
        filePath: 'pnpm test',
      }),
    ]);
    const patterns = out.map((o) => o.pattern).sort();
    expect(patterns).toContain('short_turn_after_large_read');
    expect(patterns).toContain('test_runner_noise');
  });

  it('returns [] for an empty session', () => {
    expect(runAllHeuristics([])).toEqual([]);
  });
});
