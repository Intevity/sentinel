import { describe, it, expect } from 'vitest';
import { measureToolDefinitions } from './mcp-definition-cost.js';

/** Serialized byte length of a tool entry exactly as the implementation
 *  counts it, so expected values fail loudly if the counting rule drifts. */
const bytesOf = (tool: unknown): number => Buffer.byteLength(JSON.stringify(tool), 'utf8');

describe('measureToolDefinitions', () => {
  it('partitions a mixed tools[] into per-server and native buckets with exact bytes', () => {
    const bash = { name: 'Bash', description: 'Run a command', input_schema: { type: 'object' } };
    const read = { name: 'Read', description: 'Read a file', input_schema: { type: 'object' } };
    const ghSearch = {
      name: 'mcp__github__search_code',
      description: 'Search code across GitHub',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } },
    };
    const ghIssues = {
      name: 'mcp__github__list_issues',
      description: 'List issues',
      input_schema: { type: 'object' },
    };
    const mongoFind = {
      name: 'mcp__mongodb-mcp-server__find',
      description: 'Run a find query',
      input_schema: { type: 'object' },
    };
    const body = { model: 'claude-opus-4-8', tools: [bash, read, ghSearch, ghIssues, mongoFind] };

    const m = measureToolDefinitions(body);

    expect(m.nativeBytes).toBe(bytesOf(bash) + bytesOf(read));
    expect(m.nativeToolCount).toBe(2);
    expect(m.totalToolBytes).toBe(
      bytesOf(bash) + bytesOf(read) + bytesOf(ghSearch) + bytesOf(ghIssues) + bytesOf(mongoFind),
    );

    const gh = m.perServer.get('github');
    expect(gh).toEqual({
      defBytes: bytesOf(ghSearch) + bytesOf(ghIssues),
      toolCount: 2,
      toolNames: ['mcp__github__search_code', 'mcp__github__list_issues'],
    });
    const mongo = m.perServer.get('mongodb-mcp-server');
    expect(mongo).toEqual({
      defBytes: bytesOf(mongoFind),
      toolCount: 1,
      toolNames: ['mcp__mongodb-mcp-server__find'],
    });
    expect([...m.perServer.keys()].sort()).toEqual(['github', 'mongodb-mcp-server']);
  });

  it('splits the server on the FIRST __ pair so tool names containing __ attribute correctly', () => {
    const tool = {
      name: 'mcp__team-memory__sync__now',
      description: 'd',
      input_schema: { type: 'object' },
    };
    const m = measureToolDefinitions({ tools: [tool] });
    expect([...m.perServer.keys()]).toEqual(['team-memory']);
    expect(m.perServer.get('team-memory')?.toolNames).toEqual(['mcp__team-memory__sync__now']);
  });

  it('attributes a server-only name (no second __ pair) to the whole suffix', () => {
    const tool = { name: 'mcp__solo', description: 'd', input_schema: { type: 'object' } };
    const m = measureToolDefinitions({ tools: [tool] });
    expect([...m.perServer.keys()]).toEqual(['solo']);
    expect(m.perServer.get('solo')?.defBytes).toBe(bytesOf(tool));
  });

  it('counts multibyte description characters as bytes, not chars', () => {
    const tool = { name: 'mcp__s__t', description: 'émoji ✓', input_schema: { type: 'object' } };
    const m = measureToolDefinitions({ tools: [tool] });
    // JSON.stringify keeps the raw UTF-8 chars; é is 2 bytes, ✓ is 3.
    expect(m.perServer.get('s')?.defBytes).toBe(bytesOf(tool));
    expect(bytesOf(tool)).toBeGreaterThan(JSON.stringify(tool).length);
  });

  it('returns the empty measurement for bodies without a usable tools array', () => {
    for (const body of [
      null,
      undefined,
      'string',
      42,
      {},
      { tools: undefined },
      { tools: null },
      { tools: 'not-an-array' },
      { tools: [] },
    ]) {
      const m = measureToolDefinitions(body);
      expect(m.perServer.size).toBe(0);
      expect(m.nativeBytes).toBe(0);
      expect(m.nativeToolCount).toBe(0);
      expect(m.totalToolBytes).toBe(0);
    }
  });

  it('skips non-object tool entries and entries with a non-string name (counted native)', () => {
    const valid = { name: 'mcp__s__t', input_schema: { type: 'object' } };
    const nameless = { input_schema: { type: 'object' } };
    const m = measureToolDefinitions({ tools: [null, 'junk', 7, nameless, valid] });
    // null/'junk'/7 are skipped entirely; the nameless object is native.
    expect(m.nativeBytes).toBe(bytesOf(nameless));
    expect(m.nativeToolCount).toBe(1);
    expect(m.perServer.get('s')?.defBytes).toBe(bytesOf(valid));
    expect(m.totalToolBytes).toBe(bytesOf(nameless) + bytesOf(valid));
  });
});
