import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync } from 'fs';
import Database from 'better-sqlite3';
import { estimateTokensFromBytes } from '@sentinel/shared';
import { getDb, closeDb, insertToolCall } from '../db.js';
import { estimateMcpCosts } from './mcp-cost-estimator.js';

const TMP_DB = `/tmp/sentinel-mcp-cost-${process.pid}-${Date.now()}.db`;

describe('estimateMcpCosts', () => {
  let db: Database.Database;

  beforeEach(() => {
    process.env['SENTINEL_TEST_DB_FILE'] = TMP_DB;
    db = getDb(TMP_DB);
    db.exec('DELETE FROM tool_calls');
  });
  afterEach(() => {
    closeDb();
    delete process.env['SENTINEL_TEST_DB_FILE'];
    try {
      unlinkSync(TMP_DB);
    } catch {
      /* ignore */
    }
  });

  function seedCall(toolName: string, inBytes: number, outBytes: number, ts?: number): void {
    insertToolCall(db, {
      ts: ts ?? Date.now(),
      accountId: 'a1',
      sessionId: 's1',
      requestId: `r-${Math.random()}`,
      requestSeqInSession: 1,
      toolUseId: `tu-${Math.random()}`,
      toolName,
      filePath: null,
      inputSizeBytes: inBytes,
      responseSizeBytes: outBytes,
      denied: false,
      model: 'claude-opus-4-7',
    });
  }

  it('returns [] when no MCP-prefixed tool calls exist', () => {
    seedCall('Read', 100, 1000);
    seedCall('Edit', 50, 200);
    expect(estimateMcpCosts(db)).toEqual([]);
  });

  it('attributes calls by the server segment of mcp__<server>__<tool>', () => {
    seedCall('mcp__github__pull_request_read', 100, 4_000);
    seedCall('mcp__github__list_pull_requests', 200, 8_000);
    seedCall('mcp__atlassian__jira_search', 50, 2_000);
    const out = estimateMcpCosts(db);
    expect(out).toHaveLength(2);
    const gh = out.find((s) => s.server === 'github');
    const atl = out.find((s) => s.server === 'atlassian');
    expect(gh?.callCount).toBe(2);
    expect(gh?.bytesIn).toBe(300);
    expect(gh?.bytesOut).toBe(12_000);
    expect(gh?.estimatedTokens).toBe(estimateTokensFromBytes(12_300));
    expect(atl?.callCount).toBe(1);
  });

  it('sorts by estimatedTokens desc', () => {
    seedCall('mcp__small__t', 10, 40);
    seedCall('mcp__big__t', 1000, 100_000);
    const out = estimateMcpCosts(db);
    expect(out[0]?.server).toBe('big');
    expect(out[1]?.server).toBe('small');
  });

  it('treats null sizes as 0 bytes', () => {
    insertToolCall(db, {
      ts: Date.now(),
      accountId: 'a1',
      sessionId: 's1',
      requestId: 'r-null',
      requestSeqInSession: 1,
      toolUseId: 'tu-null',
      toolName: 'mcp__foo__t',
      filePath: null,
      inputSizeBytes: 0,
      responseSizeBytes: null, // null response is allowed in schema
      denied: false,
      model: 'claude-opus-4-7',
    });
    const out = estimateMcpCosts(db);
    expect(out[0]?.bytesOut).toBe(0);
  });

  it('ignores rows older than the 7-day window', () => {
    const now = Date.now();
    seedCall('mcp__recent__t', 100, 4_000, now - 1_000);
    seedCall('mcp__old__t', 1000, 100_000, now - 10 * 24 * 60 * 60 * 1000);
    const out = estimateMcpCosts(db, now);
    expect(out).toHaveLength(1);
    expect(out[0]?.server).toBe('recent');
  });

  it('handles MCP tool names with no inner __ separator', () => {
    // mcp__<server>__<tool> is the canonical shape, but a malformed tool
    // name like `mcp__legacy` (missing the second segment) shouldn't
    // crash the estimator. Treat the whole stripped name as the server.
    seedCall('mcp__legacy', 10, 40);
    const out = estimateMcpCosts(db);
    expect(out[0]?.server).toBe('legacy');
  });
});
