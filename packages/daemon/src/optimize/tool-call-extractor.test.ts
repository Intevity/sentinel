import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { unlinkSync } from 'fs';
import Database from 'better-sqlite3';
import {
  createToolCallExtractor,
  extractFilePath,
  applyToolResultBackfill,
  nextRequestSeqForSession,
  _resetSessionSeqsForTest,
  MAX_TOOL_INPUT_BYTES,
} from './tool-call-extractor.js';
import { getDb, closeDb, listRecentToolCalls, findToolCallByToolUseId } from '../db.js';

const TMP_DB_PATH = `/tmp/sentinel-tcex-test-${process.pid}-${Date.now()}.db`;

function frame(eventType: string, payload: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function startBlock(index: number, toolUseId: string, toolName: string): string {
  return frame('content_block_start', {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id: toolUseId, name: toolName, input: {} },
  });
}
function deltaBlock(index: number, partial: string): string {
  return frame('content_block_delta', {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partial },
  });
}
function stopBlock(index: number): string {
  return frame('content_block_stop', { type: 'content_block_stop', index });
}

describe('extractFilePath', () => {
  it('returns null for JSON null literal (not an object)', () => {
    expect(extractFilePath('null')).toBeNull();
  });
  it('returns null for JSON array (not an object)', () => {
    expect(extractFilePath('[1,2,3]')).toBeNull();
  });
  it('reads `path` field', () => {
    expect(extractFilePath('{"path":"/etc/passwd"}')).toBe('/etc/passwd');
  });
  it('reads `file_path` field', () => {
    expect(extractFilePath('{"file_path":"/var/log/system.log"}')).toBe('/var/log/system.log');
  });
  it('reads `pattern` field for Grep/Glob', () => {
    expect(extractFilePath('{"pattern":"src/**/*.ts"}')).toBe('src/**/*.ts');
  });
  it('returns null when no recognized field present', () => {
    expect(extractFilePath('{"command":"ls -la"}')).toBeNull();
  });
  it('returns null for malformed JSON', () => {
    expect(extractFilePath('{not json')).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(extractFilePath('')).toBeNull();
  });
});

describe('createToolCallExtractor', () => {
  let db: Database.Database;
  beforeEach(() => {
    process.env['CLAUDE_SENTINEL_TEST_DB_FILE'] = TMP_DB_PATH;
    db = getDb(TMP_DB_PATH);
    db.exec('DELETE FROM tool_calls');
    _resetSessionSeqsForTest();
  });
  afterEach(() => {
    closeDb();
    delete process.env['CLAUDE_SENTINEL_TEST_DB_FILE'];
    try {
      unlinkSync(TMP_DB_PATH);
    } catch {
      /* ignore */
    }
  });

  function makeExtractor(overrides: Record<string, unknown> = {}) {
    return createToolCallExtractor({
      db,
      accountId: 'acct-1',
      sessionId: 'sess-1',
      requestId: 'req-1',
      requestSeqInSession: 1,
      model: 'claude-opus-4-7',
      deniedToolNames: new Set(),
      nowMs: 1_700_000_000_000,
      ...overrides,
    });
  }

  it('captures a complete tool_use block and inserts a tool_calls row', () => {
    const ex = makeExtractor();
    ex.onChunk(startBlock(0, 'toolu_abc123', 'Read'));
    ex.onChunk(deltaBlock(0, '{"path":'));
    ex.onChunk(deltaBlock(0, '"/etc/hosts"}'));
    ex.onChunk(stopBlock(0));
    const collected = ex.flush();

    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      toolUseId: 'toolu_abc123',
      toolName: 'Read',
      filePath: '/etc/hosts',
    });

    const rows = listRecentToolCalls(db, { sessionId: 'sess-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      toolUseId: 'toolu_abc123',
      toolName: 'Read',
      filePath: '/etc/hosts',
      sessionId: 'sess-1',
      requestId: 'req-1',
      requestSeqInSession: 1,
      model: 'claude-opus-4-7',
      denied: false,
    });
    expect(rows[0]?.inputSizeBytes).toBeGreaterThan(0);
  });

  it('handles partial_json split across chunk boundaries', () => {
    const ex = makeExtractor();
    const full =
      startBlock(0, 'toolu_x', 'Glob') + deltaBlock(0, '{"pattern":"src/**.ts"}') + stopBlock(0);
    // Slice into 7-char chunks to exercise the partial buffer
    for (let i = 0; i < full.length; i += 7) {
      ex.onChunk(full.slice(i, i + 7));
    }
    ex.flush();
    const rows = listRecentToolCalls(db, { sessionId: 'sess-1' });
    expect(rows[0]?.filePath).toBe('src/**.ts');
  });

  it('records multiple tool_use blocks in one stream', () => {
    const ex = makeExtractor();
    ex.onChunk(startBlock(0, 'toolu_a', 'Read'));
    ex.onChunk(deltaBlock(0, '{"path":"/a"}'));
    ex.onChunk(stopBlock(0));
    ex.onChunk(startBlock(1, 'toolu_b', 'Bash'));
    ex.onChunk(deltaBlock(1, '{"command":"ls"}'));
    ex.onChunk(stopBlock(1));
    ex.flush();
    const rows = listRecentToolCalls(db, { sessionId: 'sess-1' });
    expect(rows).toHaveLength(2);
    const byTool = new Map(rows.map((r) => [r.toolName, r]));
    expect(byTool.get('Read')?.filePath).toBe('/a');
    expect(byTool.get('Bash')?.filePath).toBeNull();
  });

  it('marks denied=true for tools listed in deniedToolNames', () => {
    const ex = makeExtractor({ deniedToolNames: new Set(['Bash']) });
    ex.onChunk(startBlock(0, 'toolu_x', 'Bash'));
    ex.onChunk(deltaBlock(0, '{"command":"rm -rf /"}'));
    ex.onChunk(stopBlock(0));
    ex.flush();
    const rows = listRecentToolCalls(db, { sessionId: 'sess-1' });
    expect(rows[0]?.denied).toBe(true);
  });

  it('ignores text content blocks (only tool_use is recorded)', () => {
    const ex = makeExtractor();
    ex.onChunk(
      frame('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    );
    ex.onChunk(
      frame('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'thinking...' },
      }),
    );
    ex.onChunk(stopBlock(0));
    ex.flush();
    expect(listRecentToolCalls(db, { sessionId: 'sess-1' })).toHaveLength(0);
  });

  it('ignores malformed SSE events without throwing', () => {
    const ex = makeExtractor();
    ex.onChunk('event: bad\ndata: {not json}\n\n');
    ex.onChunk('event: bad\ndata: [DONE]\n\n');
    ex.onChunk(startBlock(0, 'toolu_z', 'Read'));
    ex.onChunk(deltaBlock(0, '{"path":"/x"}'));
    ex.onChunk(stopBlock(0));
    ex.flush();
    expect(listRecentToolCalls(db, { sessionId: 'sess-1' })).toHaveLength(1);
  });

  it('truncates oversized partial_json without crashing', () => {
    const ex = makeExtractor();
    ex.onChunk(startBlock(0, 'toolu_big', 'Bash'));
    // Push partial_json larger than MAX_TOOL_INPUT_BYTES.
    const huge = 'x'.repeat(MAX_TOOL_INPUT_BYTES + 1024);
    ex.onChunk(deltaBlock(0, `{"command":"${huge}"}`));
    ex.onChunk(stopBlock(0));
    ex.flush();
    const rows = listRecentToolCalls(db, { sessionId: 'sess-1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toolName).toBe('Bash');
    expect(rows[0]?.filePath).toBeNull();
    expect(rows[0]?.inputSizeBytes).toBeGreaterThan(MAX_TOOL_INPUT_BYTES);
  });
});

describe('createToolCallExtractor — flush error tolerance', () => {
  it('flush silently swallows insert failures (DB closed mid-stream)', () => {
    const tmpDb = new Database(':memory:');
    // Intentionally do NOT create the tool_calls table; insert will
    // throw "no such table". The extractor must not propagate.
    const ex = createToolCallExtractor({
      db: tmpDb,
      accountId: 'a',
      sessionId: null,
      requestId: 'r',
      requestSeqInSession: null,
      model: 'claude-opus-4-7',
      deniedToolNames: new Set(),
      nowMs: 0,
    });
    ex.onChunk(startBlock(0, 'toolu_x', 'Read'));
    ex.onChunk(deltaBlock(0, '{"path":"/a"}'));
    ex.onChunk(stopBlock(0));
    expect(() => ex.flush()).not.toThrow();
    tmpDb.close();
  });
});

describe('applyToolResultBackfill', () => {
  let db: Database.Database;
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    process.env['CLAUDE_SENTINEL_TEST_DB_FILE'] = TMP_DB_PATH;
    db = getDb(TMP_DB_PATH);
    db.exec('DELETE FROM tool_calls');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    closeDb();
    delete process.env['CLAUDE_SENTINEL_TEST_DB_FILE'];
    try {
      unlinkSync(TMP_DB_PATH);
    } catch {
      /* ignore */
    }
  });

  function recordToolCall(toolUseId: string, filePath: string | null = '/foo.ts'): number {
    const ex = createToolCallExtractor({
      db,
      accountId: 'acct-1',
      sessionId: 'sess-1',
      requestId: 'req-1',
      requestSeqInSession: 1,
      model: 'claude-opus-4-7',
      deniedToolNames: new Set(),
      nowMs: 1_700_000_000_000,
    });
    ex.onChunk(startBlock(0, toolUseId, 'Read'));
    if (filePath !== null) ex.onChunk(deltaBlock(0, `{"path":"${filePath}"}`));
    else ex.onChunk(deltaBlock(0, '{}'));
    ex.onChunk(stopBlock(0));
    ex.flush();
    return findToolCallByToolUseId(db, toolUseId)!.id;
  }

  it('backfills response_size_bytes from tool_result content', () => {
    recordToolCall('toolu_match');
    const requestBody = Buffer.from(
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_match',
                content: 'a'.repeat(1234),
              },
            ],
          },
        ],
      }),
    );
    applyToolResultBackfill(db, requestBody, 'sess-1');
    const row = findToolCallByToolUseId(db, 'toolu_match')!;
    expect(row.responseSizeBytes).toBe(1234);
  });

  it('handles tool_result content as an array of {text}', () => {
    recordToolCall('toolu_arr');
    const requestBody = Buffer.from(
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_arr',
                content: [
                  { type: 'text', text: 'aaa' },
                  { type: 'text', text: 'bbbbb' },
                ],
              },
            ],
          },
        ],
      }),
    );
    applyToolResultBackfill(db, requestBody, 'sess-1');
    const row = findToolCallByToolUseId(db, 'toolu_arr')!;
    expect(row.responseSizeBytes).toBe(8);
  });

  it('marks was_quoted_in_later_turn=true when file_path appears in text', () => {
    recordToolCall('toolu_q', '/src/important.ts');
    const requestBody = Buffer.from(
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_q',
                content: 'file contents',
              },
              { type: 'text', text: 'remember /src/important.ts has a bug' },
            ],
          },
        ],
      }),
    );
    applyToolResultBackfill(db, requestBody, 'sess-1');
    const row = findToolCallByToolUseId(db, 'toolu_q')!;
    expect(row.wasQuotedInLaterTurn).toBe(true);
  });

  it('marks was_quoted_in_later_turn=false when file_path is absent', () => {
    recordToolCall('toolu_nq', '/src/never-quoted.ts');
    const requestBody = Buffer.from(
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_nq',
                content: 'short',
              },
              { type: 'text', text: 'ok moving on' },
            ],
          },
        ],
      }),
    );
    applyToolResultBackfill(db, requestBody, 'sess-1');
    const row = findToolCallByToolUseId(db, 'toolu_nq')!;
    expect(row.wasQuotedInLaterTurn).toBe(false);
  });

  it('ignores malformed body without throwing', () => {
    expect(() => applyToolResultBackfill(db, Buffer.from('{not json'), null)).not.toThrow();
  });

  it('ignores body with no messages array', () => {
    expect(() => applyToolResultBackfill(db, Buffer.from('{}'), null)).not.toThrow();
    expect(() =>
      applyToolResultBackfill(db, Buffer.from('{"messages":"oops"}'), null),
    ).not.toThrow();
  });

  it('ignores body whose top-level is null', () => {
    expect(() => applyToolResultBackfill(db, Buffer.from('null'), null)).not.toThrow();
  });

  it('ignores message entries that are null or non-object', () => {
    const requestBody = Buffer.from(
      JSON.stringify({
        messages: [
          null,
          'string-message',
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'should-not-match', content: 'x' }],
          },
        ],
      }),
    );
    expect(() => applyToolResultBackfill(db, requestBody, null)).not.toThrow();
  });

  it('skips non-object content blocks (defensive)', () => {
    recordToolCall('toolu_skip');
    const requestBody = Buffer.from(
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              null,
              'string-content',
              { type: 'tool_result', tool_use_id: 'toolu_skip', content: 'data' },
            ],
          },
        ],
      }),
    );
    expect(() => applyToolResultBackfill(db, requestBody, 'sess-1')).not.toThrow();
    const row = findToolCallByToolUseId(db, 'toolu_skip')!;
    expect(row.responseSizeBytes).toBe(4);
  });

  it('skips tool_result blocks without tool_use_id', () => {
    recordToolCall('toolu_with_id');
    const requestBody = Buffer.from(
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', content: 'orphan' },
              { type: 'tool_result', tool_use_id: 123, content: 'wrong-type-id' },
              { type: 'tool_result', tool_use_id: 'toolu_with_id', content: 'real' },
            ],
          },
        ],
      }),
    );
    applyToolResultBackfill(db, requestBody, 'sess-1');
    const row = findToolCallByToolUseId(db, 'toolu_with_id')!;
    expect(row.responseSizeBytes).toBe(4);
  });

  it('handles string content on user messages (no array)', () => {
    recordToolCall('toolu_str');
    const requestBody = Buffer.from(
      JSON.stringify({
        messages: [
          { role: 'user', content: 'plain text reference to /foo.ts' },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_str', content: 'x' }],
          },
        ],
      }),
    );
    expect(() => applyToolResultBackfill(db, requestBody, 'sess-1')).not.toThrow();
  });

  it('does not overwrite an already-set response_size_bytes', () => {
    recordToolCall('toolu_set');
    const id = findToolCallByToolUseId(db, 'toolu_set')!.id;
    db.prepare('UPDATE tool_calls SET response_size_bytes = 9999 WHERE id = ?').run(id);
    const requestBody = Buffer.from(
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_set', content: 'overwrite-attempt' },
            ],
          },
        ],
      }),
    );
    applyToolResultBackfill(db, requestBody, 'sess-1');
    const row = findToolCallByToolUseId(db, 'toolu_set')!;
    expect(row.responseSizeBytes).toBe(9999);
  });

  it('emits a `[Optimize/Backfill]` diagnostic line on every pass with tool_results', () => {
    recordToolCall('toolu_diag_match');
    const requestBody = Buffer.from(
      JSON.stringify({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_diag_match', content: 'a'.repeat(100) },
              // Second tool_use_id has no matching tool_calls row — surfaces as a miss.
              { type: 'tool_result', tool_use_id: 'toolu_diag_orphan', content: 'b' },
            ],
          },
        ],
      }),
    );
    applyToolResultBackfill(db, requestBody, 'sess-1');
    const line = logSpy.mock.calls
      .map((args) => String(args[0] ?? ''))
      .find((s) => s.startsWith('[Optimize/Backfill]'));
    expect(line).toBeDefined();
    // Tool-use IDs found vs missing must both be reported.
    expect(line).toContain('tool_results=2');
    expect(line).toContain('hits=1');
    expect(line).toContain('misses=1');
    expect(line).toContain('size_backfills=1');
    // The miss prefix surfaces in the log so the user can match against
    // their tool_calls rows manually when triaging backfill gaps.
    expect(line).toContain('miss_prefixes=toolu_diag_');
  });

  it('does not log when the request has no tool_results to scan', () => {
    const requestBody = Buffer.from(
      JSON.stringify({ messages: [{ role: 'user', content: 'plain text turn' }] }),
    );
    applyToolResultBackfill(db, requestBody, 'sess-1');
    const lines = logSpy.mock.calls
      .map((args) => String(args[0] ?? ''))
      .filter((s) => s.startsWith('[Optimize/Backfill]'));
    expect(lines).toHaveLength(0);
  });
});

describe('nextRequestSeqForSession', () => {
  beforeEach(() => {
    _resetSessionSeqsForTest();
  });
  it('returns null when sessionId is null', () => {
    expect(nextRequestSeqForSession(null, 1)).toBeNull();
  });
  it('returns 1, 2, 3, ... for a session', () => {
    expect(nextRequestSeqForSession('s1', 1000)).toBe(1);
    expect(nextRequestSeqForSession('s1', 2000)).toBe(2);
    expect(nextRequestSeqForSession('s1', 3000)).toBe(3);
  });
  it('keeps separate counters per session', () => {
    expect(nextRequestSeqForSession('s1', 1000)).toBe(1);
    expect(nextRequestSeqForSession('s2', 1100)).toBe(1);
    expect(nextRequestSeqForSession('s1', 1200)).toBe(2);
  });
});
