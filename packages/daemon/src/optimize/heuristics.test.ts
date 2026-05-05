import { describe, it, expect } from 'vitest';
import {
  shortTurnAfterLargeRead,
  repeatReadSameFile,
  repeatReadAcrossSessions,
  explorationGlobGrepWithoutEdit,
  bashLogParse,
  testRunnerNoise,
  diffPrePass,
  webFetchOversized,
  testFailureInvestigation,
  depTraceGrepReadChain,
  verboseResponseFormatting,
  readEditBurst,
  multiSmallReadSession,
  bashLoopSession,
  depTraceBashGrepChain,
  runAllHeuristics,
} from './heuristics.js';
import type { ToolCallRow } from '../db.js';

/** A reference clock pinned to the row factory's default `ts`. Used so
 *  shortTurnAfterLargeRead's grace-period check is deterministic in
 *  tests that don't care about the grace-period boundary. */
const NOW = 1_700_000_000_000;

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
    const out = shortTurnAfterLargeRead(
      [
        row({
          id: 1,
          toolName: 'Read',
          filePath: '/big.log',
          responseSizeBytes: 50_000,
          wasQuotedInLaterTurn: false,
        }),
      ],
      NOW,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('file-explorer');
    expect(out[0]?.pattern).toBe('short_turn_after_large_read');
  });

  it('does not fire when wasQuotedInLaterTurn=null and within grace window', () => {
    const out = shortTurnAfterLargeRead(
      [
        row({
          ts: NOW,
          toolName: 'Read',
          responseSizeBytes: 50_000,
          wasQuotedInLaterTurn: null,
        }),
      ],
      NOW + 1000, // 1s after the read — well inside the 5min grace window
    );
    expect(out).toHaveLength(0);
  });

  it('fires when wasQuotedInLaterTurn=null and past the grace window', () => {
    // The proxy backfills was_quoted_in_later_turn on the next request
    // in the session. Sessions that end without a follow-up leave the
    // column NULL forever — we wait 5min, then assume not-quoted.
    const out = shortTurnAfterLargeRead(
      [
        row({
          id: 42,
          ts: NOW,
          toolName: 'Read',
          filePath: '/big.log',
          responseSizeBytes: 50_000,
          wasQuotedInLaterTurn: null,
        }),
      ],
      NOW + 6 * 60_000, // 6 minutes after — past the 5min grace
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.sourceToolCallIds).toEqual([42]);
  });

  it('does not fire when wasQuotedInLaterTurn=true', () => {
    const out = shortTurnAfterLargeRead(
      [row({ toolName: 'Read', responseSizeBytes: 50_000, wasQuotedInLaterTurn: true })],
      NOW,
    );
    expect(out).toHaveLength(0);
  });

  it('does not fire when wasQuotedInLaterTurn=true even past grace', () => {
    // Confirmed-quoted always wins, regardless of how much time elapses.
    const out = shortTurnAfterLargeRead(
      [
        row({
          ts: NOW,
          toolName: 'Read',
          responseSizeBytes: 50_000,
          wasQuotedInLaterTurn: true,
        }),
      ],
      NOW + 60 * 60_000,
    );
    expect(out).toHaveLength(0);
  });

  it('does not fire on small reads', () => {
    const out = shortTurnAfterLargeRead(
      [row({ toolName: 'Read', responseSizeBytes: 1000, wasQuotedInLaterTurn: false })],
      NOW,
    );
    expect(out).toHaveLength(0);
  });

  it('does not fire on denied tool calls', () => {
    const out = shortTurnAfterLargeRead(
      [
        row({
          toolName: 'Read',
          responseSizeBytes: 50_000,
          wasQuotedInLaterTurn: false,
          denied: true,
        }),
      ],
      NOW,
    );
    expect(out).toHaveLength(0);
  });
});

describe('repeatReadAcrossSessions', () => {
  it('fires when same file is read 5+ times across 2+ sessions', () => {
    const out = repeatReadAcrossSessions([
      row({ id: 1, toolName: 'Read', filePath: '/db.ts', sessionId: 's1' }),
      row({ id: 2, toolName: 'Read', filePath: '/db.ts', sessionId: 's1' }),
      row({ id: 3, toolName: 'Read', filePath: '/db.ts', sessionId: 's2' }),
      row({ id: 4, toolName: 'Read', filePath: '/db.ts', sessionId: 's2' }),
      row({ id: 5, toolName: 'Read', filePath: '/db.ts', sessionId: 's3' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('file-explorer');
    expect(out[0]?.pattern).toBe('repeat_read_cross_session');
    expect(out[0]?.sourceToolCallIds).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not fire when all reads are within a single session', () => {
    // Per-session repeats are picked up by repeatReadSameFile; this
    // heuristic is specifically for cross-session signal.
    const out = repeatReadAcrossSessions([
      row({ toolName: 'Read', filePath: '/db.ts', sessionId: 's1' }),
      row({ toolName: 'Read', filePath: '/db.ts', sessionId: 's1' }),
      row({ toolName: 'Read', filePath: '/db.ts', sessionId: 's1' }),
      row({ toolName: 'Read', filePath: '/db.ts', sessionId: 's1' }),
      row({ toolName: 'Read', filePath: '/db.ts', sessionId: 's1' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire below the cross-session threshold', () => {
    const out = repeatReadAcrossSessions([
      row({ toolName: 'Read', filePath: '/db.ts', sessionId: 's1' }),
      row({ toolName: 'Read', filePath: '/db.ts', sessionId: 's2' }),
      row({ toolName: 'Read', filePath: '/db.ts', sessionId: 's3' }),
      row({ toolName: 'Read', filePath: '/db.ts', sessionId: 's4' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('skips denied reads and null file paths', () => {
    const out = repeatReadAcrossSessions([
      row({ toolName: 'Read', filePath: '/db.ts', sessionId: 's1', denied: true }),
      row({ toolName: 'Read', filePath: '/db.ts', sessionId: 's2', denied: true }),
      row({ toolName: 'Read', filePath: null, sessionId: 's3' }),
      row({ toolName: 'Read', filePath: null, sessionId: 's4' }),
      row({ toolName: 'Read', filePath: '/db.ts', sessionId: 's5' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('skips non-Read tools', () => {
    const out = repeatReadAcrossSessions([
      row({ toolName: 'Bash', filePath: '/db.ts', sessionId: 's1' }),
      row({ toolName: 'Bash', filePath: '/db.ts', sessionId: 's2' }),
      row({ toolName: 'Bash', filePath: '/db.ts', sessionId: 's3' }),
      row({ toolName: 'Bash', filePath: '/db.ts', sessionId: 's4' }),
      row({ toolName: 'Bash', filePath: '/db.ts', sessionId: 's5' }),
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

describe('webFetchOversized', () => {
  it('fires on a WebFetch with response ≥ 16KB', () => {
    const out = webFetchOversized([
      row({ id: 7, toolName: 'WebFetch', responseSizeBytes: 20_000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('web-fetcher');
    expect(out[0]?.pattern).toBe('web_fetch_oversized');
    expect(out[0]?.sourceToolCallIds).toEqual([7]);
  });

  it('fires on WebSearch the same way it fires on WebFetch', () => {
    const out = webFetchOversized([row({ toolName: 'WebSearch', responseSizeBytes: 50_000 })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('web-fetcher');
  });

  it('does not fire below the size threshold', () => {
    const out = webFetchOversized([row({ toolName: 'WebFetch', responseSizeBytes: 1_000 })]);
    expect(out).toHaveLength(0);
  });

  it('does not fire when responseSizeBytes is null', () => {
    const out = webFetchOversized([row({ toolName: 'WebFetch', responseSizeBytes: null })]);
    expect(out).toHaveLength(0);
  });

  it('does not fire on denied web calls', () => {
    const out = webFetchOversized([
      row({ toolName: 'WebFetch', responseSizeBytes: 50_000, denied: true }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire on non-web tools', () => {
    const out = webFetchOversized([row({ toolName: 'Read', responseSizeBytes: 50_000 })]);
    expect(out).toHaveLength(0);
  });
});

describe('testFailureInvestigation', () => {
  const T0 = 1_700_000_000_000;

  it('fires when a test runner Bash is followed by ≥ 3 Read/Grep within 60s', () => {
    const out = testFailureInvestigation([
      row({ id: 1, ts: T0, toolName: 'Bash', filePath: 'pnpm test', responseSizeBytes: 5_000 }),
      row({ id: 2, ts: T0 + 5_000, toolName: 'Read', filePath: '/test.ts' }),
      row({ id: 3, ts: T0 + 10_000, toolName: 'Read', filePath: '/asserter.ts' }),
      row({ id: 4, ts: T0 + 15_000, toolName: 'Grep', filePath: 'failingFn' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('test-failure-investigator');
    expect(out[0]?.pattern).toBe('test_failure_investigation');
    expect(out[0]?.sourceToolCallIds).toEqual([1, 2, 3, 4]);
  });

  it('does not fire when follow-ups are outside the 60s window', () => {
    const out = testFailureInvestigation([
      row({ id: 1, ts: T0, toolName: 'Bash', filePath: 'pnpm test' }),
      row({ id: 2, ts: T0 + 90_000, toolName: 'Read', filePath: '/test.ts' }),
      row({ id: 3, ts: T0 + 95_000, toolName: 'Read', filePath: '/a.ts' }),
      row({ id: 4, ts: T0 + 100_000, toolName: 'Read', filePath: '/b.ts' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire on non-test Bash commands', () => {
    const out = testFailureInvestigation([
      row({ id: 1, ts: T0, toolName: 'Bash', filePath: 'ls -la' }),
      row({ id: 2, ts: T0 + 1_000, toolName: 'Read', filePath: '/a.ts' }),
      row({ id: 3, ts: T0 + 2_000, toolName: 'Read', filePath: '/b.ts' }),
      row({ id: 4, ts: T0 + 3_000, toolName: 'Read', filePath: '/c.ts' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire when fewer than 3 follow-ups', () => {
    const out = testFailureInvestigation([
      row({ id: 1, ts: T0, toolName: 'Bash', filePath: 'pnpm test' }),
      row({ id: 2, ts: T0 + 5_000, toolName: 'Read', filePath: '/a.ts' }),
      row({ id: 3, ts: T0 + 10_000, toolName: 'Read', filePath: '/b.ts' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire on denied test bash calls', () => {
    const out = testFailureInvestigation([
      row({ id: 1, ts: T0, toolName: 'Bash', filePath: 'pnpm test', denied: true }),
      row({ id: 2, ts: T0 + 5_000, toolName: 'Read', filePath: '/a.ts' }),
      row({ id: 3, ts: T0 + 6_000, toolName: 'Read', filePath: '/b.ts' }),
      row({ id: 4, ts: T0 + 7_000, toolName: 'Read', filePath: '/c.ts' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('skips denied follow-up reads when counting toward the threshold', () => {
    const out = testFailureInvestigation([
      row({ id: 1, ts: T0, toolName: 'Bash', filePath: 'pytest' }),
      row({ id: 2, ts: T0 + 1_000, toolName: 'Read', filePath: '/a.ts' }),
      row({ id: 3, ts: T0 + 2_000, toolName: 'Read', filePath: '/b.ts', denied: true }),
      row({ id: 4, ts: T0 + 3_000, toolName: 'Read', filePath: '/c.ts', denied: true }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe('depTraceGrepReadChain', () => {
  const T0 = 1_700_000_000_000;

  it('fires when same Grep pattern repeats 3+ times with 4+ distinct interleaved Reads', () => {
    const out = depTraceGrepReadChain([
      row({ id: 1, ts: T0, toolName: 'Grep', filePath: 'computeSavings' }),
      row({ id: 2, ts: T0 + 100, toolName: 'Read', filePath: '/a.ts' }),
      row({ id: 3, ts: T0 + 200, toolName: 'Read', filePath: '/b.ts' }),
      row({ id: 4, ts: T0 + 300, toolName: 'Grep', filePath: 'computeSavings' }),
      row({ id: 5, ts: T0 + 400, toolName: 'Read', filePath: '/c.ts' }),
      row({ id: 6, ts: T0 + 500, toolName: 'Read', filePath: '/d.ts' }),
      row({ id: 7, ts: T0 + 600, toolName: 'Grep', filePath: 'computeSavings' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('dep-tracer');
    expect(out[0]?.pattern).toBe('dep_trace_grep_read_chain');
  });

  it('does not fire when the Greps are the same pattern but no Reads interleave', () => {
    const out = depTraceGrepReadChain([
      row({ id: 1, ts: T0, toolName: 'Grep', filePath: 'foo' }),
      row({ id: 2, ts: T0 + 100, toolName: 'Grep', filePath: 'foo' }),
      row({ id: 3, ts: T0 + 200, toolName: 'Grep', filePath: 'foo' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire when each Grep uses a different pattern (general search, not refactor)', () => {
    const out = depTraceGrepReadChain([
      row({ id: 1, ts: T0, toolName: 'Grep', filePath: 'foo' }),
      row({ id: 2, ts: T0 + 100, toolName: 'Read', filePath: '/a.ts' }),
      row({ id: 3, ts: T0 + 200, toolName: 'Grep', filePath: 'bar' }),
      row({ id: 4, ts: T0 + 300, toolName: 'Read', filePath: '/b.ts' }),
      row({ id: 5, ts: T0 + 400, toolName: 'Grep', filePath: 'baz' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('counts only distinct Read filePaths toward the interleave threshold', () => {
    // Same file read 4 times between greps — only 1 distinct path, not 4.
    const out = depTraceGrepReadChain([
      row({ id: 1, ts: T0, toolName: 'Grep', filePath: 'sym' }),
      row({ id: 2, ts: T0 + 100, toolName: 'Read', filePath: '/x.ts' }),
      row({ id: 3, ts: T0 + 200, toolName: 'Read', filePath: '/x.ts' }),
      row({ id: 4, ts: T0 + 300, toolName: 'Grep', filePath: 'sym' }),
      row({ id: 5, ts: T0 + 400, toolName: 'Read', filePath: '/x.ts' }),
      row({ id: 6, ts: T0 + 500, toolName: 'Read', filePath: '/x.ts' }),
      row({ id: 7, ts: T0 + 600, toolName: 'Grep', filePath: 'sym' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('skips denied greps and null patterns', () => {
    const out = depTraceGrepReadChain([
      row({ id: 1, ts: T0, toolName: 'Grep', filePath: 'sym', denied: true }),
      row({ id: 2, ts: T0 + 100, toolName: 'Grep', filePath: null }),
      row({ id: 3, ts: T0 + 200, toolName: 'Grep', filePath: 'sym' }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe('verboseResponseFormatting', () => {
  it('fires on a Write ≥ 4KB after prior tool outputs ≥ 16KB total', () => {
    const out = verboseResponseFormatting([
      row({ id: 1, toolName: 'Read', filePath: '/a.ts', responseSizeBytes: 10_000 }),
      row({ id: 2, toolName: 'Bash', filePath: 'cat /var/log/x.log', responseSizeBytes: 10_000 }),
      row({ id: 3, toolName: 'Write', filePath: '/REPORT.md', inputSizeBytes: 6_000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('output-formatter');
    expect(out[0]?.pattern).toBe('verbose_response_formatting');
    expect(out[0]?.sourceToolCallIds).toEqual([3]);
  });

  it('does not fire when the Write is too small', () => {
    const out = verboseResponseFormatting([
      row({ toolName: 'Read', responseSizeBytes: 50_000 }),
      row({ toolName: 'Write', inputSizeBytes: 500 }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire when prior tool outputs are below the byte floor', () => {
    const out = verboseResponseFormatting([
      row({ toolName: 'Read', responseSizeBytes: 1_000 }),
      row({ toolName: 'Write', inputSizeBytes: 6_000 }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire when the Write comes before the prior reads (chronologically)', () => {
    // Heuristic walks rows in order; "prior" is rows.slice(0, i).
    const out = verboseResponseFormatting([
      row({ toolName: 'Write', inputSizeBytes: 6_000 }),
      row({ toolName: 'Read', responseSizeBytes: 50_000 }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire on denied writes', () => {
    const out = verboseResponseFormatting([
      row({ toolName: 'Read', responseSizeBytes: 50_000 }),
      row({ toolName: 'Write', inputSizeBytes: 6_000, denied: true }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe('readEditBurst', () => {
  function makeBurst(
    reads: number,
    edits: number,
    distinctPaths: number,
  ): ReturnType<typeof row>[] {
    const out: ReturnType<typeof row>[] = [];
    for (let i = 0; i < reads; i++) {
      out.push(row({ id: 1000 + i, toolName: 'Read', filePath: `/r${i % distinctPaths}.ts` }));
    }
    for (let i = 0; i < edits; i++) {
      out.push(row({ id: 2000 + i, toolName: 'Edit', filePath: `/r${i % distinctPaths}.ts` }));
    }
    return out;
  }

  it('fires when reads ≥ 10 AND edits ≥ 10 AND ≥ 2 distinct edited paths', () => {
    const out = readEditBurst(makeBurst(10, 10, 3));
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('patch-applier');
    expect(out[0]?.pattern).toBe('read_edit_burst');
  });

  it('counts MultiEdit and Write toward the edit threshold', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) =>
        row({ id: 100 + i, toolName: 'Read', filePath: `/r${i}.ts` }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        row({ id: 200 + i, toolName: 'Edit', filePath: `/a.ts` }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        row({ id: 300 + i, toolName: 'MultiEdit', filePath: `/b.ts` }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        row({ id: 400 + i, toolName: 'Write', filePath: `/c.ts` }),
      ),
    ];
    const out = readEditBurst(rows);
    expect(out).toHaveLength(1);
  });

  it('does not fire below the read threshold', () => {
    const out = readEditBurst(makeBurst(5, 10, 3));
    expect(out).toHaveLength(0);
  });

  it('does not fire below the edit threshold', () => {
    const out = readEditBurst(makeBurst(10, 5, 3));
    expect(out).toHaveLength(0);
  });

  it('does not fire when all edits target a single file (diffPrePass territory)', () => {
    const out = readEditBurst(makeBurst(10, 10, 1));
    expect(out).toHaveLength(0);
  });

  it('does not count denied reads or edits', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) =>
        row({ id: 500 + i, toolName: 'Read', filePath: `/r${i}.ts`, denied: true }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        row({ id: 600 + i, toolName: 'Edit', filePath: `/r${i % 3}.ts`, denied: true }),
      ),
    ];
    expect(readEditBurst(rows)).toHaveLength(0);
  });
});

describe('multiSmallReadSession', () => {
  function makeReads(count: number, distinctPaths: number, sizeBytes: number) {
    return Array.from({ length: count }, (_, i) =>
      row({
        id: 5000 + i,
        toolName: 'Read',
        filePath: `/p${i % distinctPaths}.ts`,
        responseSizeBytes: sizeBytes,
      }),
    );
  }

  it('fires when ≥ 15 small Reads cover ≥ 8 distinct paths with avg ≤ 8KB', () => {
    const out = multiSmallReadSession(makeReads(15, 8, 4_000));
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('bulk-reader');
    expect(out[0]?.pattern).toBe('multi_small_read_session');
  });

  it('does not fire below the read-count threshold', () => {
    const out = multiSmallReadSession(makeReads(10, 8, 4_000));
    expect(out).toHaveLength(0);
  });

  it('does not fire when avg response size exceeds 8KB', () => {
    const out = multiSmallReadSession(makeReads(15, 8, 12_000));
    expect(out).toHaveLength(0);
  });

  it('does not fire below the distinct-paths threshold (single-file repeats are file-explorer territory)', () => {
    const out = multiSmallReadSession(makeReads(20, 3, 4_000));
    expect(out).toHaveLength(0);
  });

  it('skips denied reads when counting toward the threshold', () => {
    const reads = makeReads(15, 8, 4_000).map((r) => ({ ...r, denied: true }));
    expect(multiSmallReadSession(reads)).toHaveLength(0);
  });

  it('does not fire on Bash or Edit traffic', () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ id: 6000 + i, toolName: 'Bash', filePath: `cmd${i}`, responseSizeBytes: 1_000 }),
    );
    expect(multiSmallReadSession(rows)).toHaveLength(0);
  });
});

describe('bashLoopSession', () => {
  function makeBash(count: number, sizeBytes: number) {
    return Array.from({ length: count }, (_, i) =>
      row({
        id: 7000 + i,
        toolName: 'Bash',
        filePath: `git status ${i}`,
        responseSizeBytes: sizeBytes,
      }),
    );
  }

  it('fires when ≥ 60 small Bash calls accumulate ≥ 50KB total', () => {
    const out = bashLoopSession(makeBash(60, 1_000));
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('bash-loop-summarizer');
    expect(out[0]?.pattern).toBe('bash_loop_session');
  });

  it('does not fire below the call-count threshold', () => {
    const out = bashLoopSession(makeBash(30, 2_000));
    expect(out).toHaveLength(0);
  });

  it('does not fire when total bytes are below 50KB even with high call count', () => {
    const out = bashLoopSession(makeBash(60, 200));
    expect(out).toHaveLength(0);
  });

  it('does not fire when avg response is too large (log-analyzer territory)', () => {
    const out = bashLoopSession(makeBash(60, 4_000));
    expect(out).toHaveLength(0);
  });

  it('skips denied Bash calls when counting toward the threshold', () => {
    const rows = makeBash(60, 1_000).map((r) => ({ ...r, denied: true }));
    expect(bashLoopSession(rows)).toHaveLength(0);
  });
});

describe('depTraceBashGrepChain', () => {
  const T0 = 1_700_000_000_000;

  it('fires when a Bash grep -r is followed by 4+ distinct Reads in 60s', () => {
    const out = depTraceBashGrepChain([
      row({ id: 1, ts: T0, toolName: 'Bash', filePath: 'grep -r computeSavings src/' }),
      row({ id: 2, ts: T0 + 1_000, toolName: 'Read', filePath: '/a.ts' }),
      row({ id: 3, ts: T0 + 2_000, toolName: 'Read', filePath: '/b.ts' }),
      row({ id: 4, ts: T0 + 3_000, toolName: 'Read', filePath: '/c.ts' }),
      row({ id: 5, ts: T0 + 4_000, toolName: 'Read', filePath: '/d.ts' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('dep-tracer');
    expect(out[0]?.pattern).toBe('dep_trace_bash_grep_chain');
  });

  it('matches `rg ` invocation', () => {
    const out = depTraceBashGrepChain([
      row({ id: 1, ts: T0, toolName: 'Bash', filePath: 'rg foo src/' }),
      row({ id: 2, ts: T0 + 1_000, toolName: 'Read', filePath: '/a.ts' }),
      row({ id: 3, ts: T0 + 2_000, toolName: 'Read', filePath: '/b.ts' }),
      row({ id: 4, ts: T0 + 3_000, toolName: 'Read', filePath: '/c.ts' }),
      row({ id: 5, ts: T0 + 4_000, toolName: 'Read', filePath: '/d.ts' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('does not fire on a non-grep Bash command', () => {
    const out = depTraceBashGrepChain([
      row({ id: 1, ts: T0, toolName: 'Bash', filePath: 'ls -la' }),
      row({ id: 2, ts: T0 + 1_000, toolName: 'Read', filePath: '/a.ts' }),
      row({ id: 3, ts: T0 + 2_000, toolName: 'Read', filePath: '/b.ts' }),
      row({ id: 4, ts: T0 + 3_000, toolName: 'Read', filePath: '/c.ts' }),
      row({ id: 5, ts: T0 + 4_000, toolName: 'Read', filePath: '/d.ts' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire when fewer than 4 distinct Read paths follow', () => {
    const out = depTraceBashGrepChain([
      row({ id: 1, ts: T0, toolName: 'Bash', filePath: 'grep -r foo' }),
      row({ id: 2, ts: T0 + 1_000, toolName: 'Read', filePath: '/a.ts' }),
      row({ id: 3, ts: T0 + 2_000, toolName: 'Read', filePath: '/a.ts' }),
      row({ id: 4, ts: T0 + 3_000, toolName: 'Read', filePath: '/b.ts' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire when follow-ups are outside the 60s window', () => {
    const out = depTraceBashGrepChain([
      row({ id: 1, ts: T0, toolName: 'Bash', filePath: 'grep -r foo' }),
      row({ id: 2, ts: T0 + 90_000, toolName: 'Read', filePath: '/a.ts' }),
      row({ id: 3, ts: T0 + 95_000, toolName: 'Read', filePath: '/b.ts' }),
      row({ id: 4, ts: T0 + 100_000, toolName: 'Read', filePath: '/c.ts' }),
      row({ id: 5, ts: T0 + 105_000, toolName: 'Read', filePath: '/d.ts' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('does not fire on a denied Bash grep', () => {
    const out = depTraceBashGrepChain([
      row({ id: 1, ts: T0, toolName: 'Bash', filePath: 'grep -r foo', denied: true }),
      row({ id: 2, ts: T0 + 1_000, toolName: 'Read', filePath: '/a.ts' }),
      row({ id: 3, ts: T0 + 2_000, toolName: 'Read', filePath: '/b.ts' }),
      row({ id: 4, ts: T0 + 3_000, toolName: 'Read', filePath: '/c.ts' }),
      row({ id: 5, ts: T0 + 4_000, toolName: 'Read', filePath: '/d.ts' }),
    ]);
    expect(out).toHaveLength(0);
  });
});

describe('testRunnerNoise threshold tuning (16KB)', () => {
  it('fires at the new 16KB floor (lowered from 32KB to match real test output sizes)', () => {
    const out = testRunnerNoise([
      row({ toolName: 'Bash', responseSizeBytes: 18_000, filePath: 'pnpm test' }),
    ]);
    expect(out).toHaveLength(1);
  });
});

describe('testRunnerNoise — post-extractor-fix', () => {
  // Regression test: before the extractor was fixed to probe the
  // `command` field, all Bash tool_calls had file_path = null and this
  // heuristic could never fire on real traffic. The unit test passed
  // because tests synthesize ToolCallRow directly with filePath set.
  // Now that extractFilePath probes `command`, the in-memory test path
  // and the real ingest path produce the same row shape.
  it('matches a real Bash row with the command captured into file_path', () => {
    const out = testRunnerNoise([
      row({ toolName: 'Bash', filePath: 'pnpm test', responseSizeBytes: 50_000 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.curatedId).toBe('test-runner-parser');
  });
});

describe('heuristics — null response_size_bytes branches', () => {
  it('shortTurnAfterLargeRead skips rows without response_size_bytes', () => {
    const out = shortTurnAfterLargeRead(
      [row({ toolName: 'Read', responseSizeBytes: null, wasQuotedInLaterTurn: false })],
      NOW,
    );
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
    const out = runAllHeuristics(
      [
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
      ],
      NOW,
    );
    const patterns = out.map((o) => o.pattern).sort();
    expect(patterns).toContain('short_turn_after_large_read');
    expect(patterns).toContain('test_runner_noise');
  });

  it('returns [] for an empty session', () => {
    expect(runAllHeuristics([], NOW)).toEqual([]);
  });

  it('combines new heuristics: web_fetch_oversized, dep_trace_grep_read_chain, verbose_response_formatting', () => {
    const T = 1_700_000_000_000;
    const out = runAllHeuristics(
      [
        row({ id: 1, ts: T, toolName: 'WebFetch', responseSizeBytes: 30_000 }),
        // Refactor pattern: same Grep pattern, distinct interleaved Reads.
        row({ id: 2, ts: T + 100, toolName: 'Grep', filePath: 'foo' }),
        row({ id: 3, ts: T + 200, toolName: 'Read', filePath: '/a.ts' }),
        row({ id: 4, ts: T + 300, toolName: 'Read', filePath: '/b.ts' }),
        row({ id: 5, ts: T + 400, toolName: 'Read', filePath: '/c.ts' }),
        row({ id: 6, ts: T + 500, toolName: 'Read', filePath: '/d.ts' }),
        row({ id: 7, ts: T + 600, toolName: 'Grep', filePath: 'foo' }),
        row({ id: 8, ts: T + 700, toolName: 'Grep', filePath: 'foo' }),
      ],
      T,
    );
    const patterns = new Set(out.map((o) => o.pattern));
    expect(patterns.has('web_fetch_oversized')).toBe(true);
    expect(patterns.has('dep_trace_grep_read_chain')).toBe(true);
  });

  it('combines test_failure_investigation when a test runner is followed by Read/Grep', () => {
    const T = 1_700_000_000_000;
    const out = runAllHeuristics(
      [
        row({ id: 1, ts: T, toolName: 'Bash', filePath: 'pnpm test', responseSizeBytes: 5_000 }),
        row({ id: 2, ts: T + 1_000, toolName: 'Read', filePath: '/a.ts' }),
        row({ id: 3, ts: T + 2_000, toolName: 'Read', filePath: '/b.ts' }),
        row({ id: 4, ts: T + 3_000, toolName: 'Grep', filePath: 'sym' }),
      ],
      T,
    );
    const patterns = new Set(out.map((o) => o.pattern));
    expect(patterns.has('test_failure_investigation')).toBe(true);
  });

  it('combines read_edit_burst when a session shows heavy multi-file Read/Edit traffic', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) =>
        row({ id: 700 + i, toolName: 'Read', filePath: `/r${i % 3}.ts` }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        row({ id: 800 + i, toolName: 'Edit', filePath: `/r${i % 3}.ts` }),
      ),
    ];
    const out = runAllHeuristics(rows, NOW);
    const patterns = new Set(out.map((o) => o.pattern));
    expect(patterns.has('read_edit_burst')).toBe(true);
  });

  it('combines multi_small_read_session and bash_loop_session', () => {
    const reads = Array.from({ length: 15 }, (_, i) =>
      row({
        id: 9000 + i,
        toolName: 'Read',
        filePath: `/p${i % 8}.ts`,
        responseSizeBytes: 4_000,
      }),
    );
    const bashes = Array.from({ length: 60 }, (_, i) =>
      row({
        id: 9100 + i,
        toolName: 'Bash',
        filePath: `git status ${i}`,
        responseSizeBytes: 1_000,
      }),
    );
    const out = runAllHeuristics([...reads, ...bashes], NOW);
    const patterns = new Set(out.map((o) => o.pattern));
    expect(patterns.has('multi_small_read_session')).toBe(true);
    expect(patterns.has('bash_loop_session')).toBe(true);
  });

  it('combines dep_trace_bash_grep_chain when a Bash grep is followed by distinct Reads', () => {
    const T = 1_700_000_000_000;
    const out = runAllHeuristics(
      [
        row({ id: 1, ts: T, toolName: 'Bash', filePath: 'grep -r foo src/' }),
        row({ id: 2, ts: T + 1_000, toolName: 'Read', filePath: '/a.ts' }),
        row({ id: 3, ts: T + 2_000, toolName: 'Read', filePath: '/b.ts' }),
        row({ id: 4, ts: T + 3_000, toolName: 'Read', filePath: '/c.ts' }),
        row({ id: 5, ts: T + 4_000, toolName: 'Read', filePath: '/d.ts' }),
      ],
      T,
    );
    const patterns = new Set(out.map((o) => o.pattern));
    expect(patterns.has('dep_trace_bash_grep_chain')).toBe(true);
  });

  it('does not include cross-session patterns (those run at the analyzer level)', () => {
    // repeat_read_cross_session is invoked by the analyzer separately
    // because it needs the full lookback window, not a per-session
    // slice. runAllHeuristics must not double-emit it.
    const out = runAllHeuristics(
      [
        row({ toolName: 'Read', filePath: '/x.ts', sessionId: 's1' }),
        row({ toolName: 'Read', filePath: '/x.ts', sessionId: 's2' }),
        row({ toolName: 'Read', filePath: '/x.ts', sessionId: 's3' }),
        row({ toolName: 'Read', filePath: '/x.ts', sessionId: 's4' }),
        row({ toolName: 'Read', filePath: '/x.ts', sessionId: 's5' }),
      ],
      NOW,
    );
    const patterns = new Set(out.map((o) => o.pattern));
    expect(patterns.has('repeat_read_cross_session')).toBe(false);
  });
});
