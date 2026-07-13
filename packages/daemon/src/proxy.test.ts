/**
 * Unit tests for pure functions exported from `./proxy.js` plus a single
 * smoke test that `createProxyServer` returns a live `http.Server`.
 *
 * Every test that used to exercise the proxy's request/response pipeline
 * by mocking the https module has been migrated to integration tests that
 * run the real `createProxyServer` against the fake Anthropic listener
 * from `@sentinel/test-harness`. See proxy.*.integration.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createProxyServer,
  DAEMON_PORT,
  ANTHROPIC_HOST,
  summarizeOverageHeaders,
  extractRequestModel,
  isFableModel,
} from './proxy.js';
import type { IpcServer } from './ipc.js';

function makeMockDb(): Database.Database {
  return {
    prepare: vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ lastInsertRowid: 1 }),
    }),
  } as unknown as Database.Database;
}

function makeMockIpc(): IpcServer {
  return {
    broadcast: vi.fn(),
    onMessage: vi.fn(),
    start: vi.fn(),
    close: vi.fn(),
    connectedClients: 0,
  } as unknown as IpcServer;
}

describe('proxy constants', () => {
  it('DAEMON_PORT is 47284', () => {
    expect(DAEMON_PORT).toBe(47284);
  });

  it('ANTHROPIC_HOST is api.anthropic.com', () => {
    expect(ANTHROPIC_HOST).toBe('api.anthropic.com');
  });
});

describe('summarizeOverageHeaders', () => {
  it('returns null when no tracked headers are present', () => {
    expect(summarizeOverageHeaders({ 'content-type': 'application/json' })).toBeNull();
  });

  it('renders the subset of tracked headers that are present', () => {
    const out = summarizeOverageHeaders({
      'anthropic-ratelimit-unified-overage-status': 'allowed',
      'anthropic-ratelimit-unified-overage-in-use': 'true',
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
    });
    expect(out).toContain('overage-status=allowed');
    expect(out).toContain('overage-in-use=true');
    expect(out).toContain('5h-util=0.42');
  });

  it('handles array header values (takes first element)', () => {
    const out = summarizeOverageHeaders({
      'anthropic-ratelimit-unified-overage-in-use': ['true', 'ignored'],
    });
    expect(out).toBe('overage-in-use=true');
  });

  it('treats empty array as missing', () => {
    expect(
      summarizeOverageHeaders({ 'anthropic-ratelimit-unified-overage-in-use': [] }),
    ).toBeNull();
  });
});

describe('createProxyServer', () => {
  it('returns an HTTP server instance', () => {
    const server = createProxyServer(
      { db: makeMockDb(), ipcServer: makeMockIpc() },
      vi.fn().mockResolvedValue(undefined),
    );
    expect(server).toBeDefined();
    expect(typeof server.listen).toBe('function');
    server.close();
  });
});

describe('extractRequestModel', () => {
  it('returns the model string for a well-formed body', () => {
    const body = Buffer.from(JSON.stringify({ model: 'claude-sonnet-4-6', messages: [] }));
    expect(extractRequestModel(body)).toBe('claude-sonnet-4-6');
  });

  it('returns null for an empty body', () => {
    expect(extractRequestModel(Buffer.alloc(0))).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(extractRequestModel(Buffer.from('{ not json'))).toBeNull();
  });

  it('returns null when the model field is missing', () => {
    expect(extractRequestModel(Buffer.from(JSON.stringify({ messages: [] })))).toBeNull();
  });

  it('returns null when the model field is not a string', () => {
    expect(extractRequestModel(Buffer.from(JSON.stringify({ model: 42 })))).toBeNull();
  });

  it('returns null for an empty-string model', () => {
    expect(extractRequestModel(Buffer.from(JSON.stringify({ model: '' })))).toBeNull();
  });
});

describe('isFableModel', () => {
  it.each([
    ['claude-fable-5', true],
    ['claude-fable-4-5', true],
    ['CLAUDE-FABLE-5-x', true],
    ['claude-opus-4-7', false],
    ['claude-sonnet-4-6', false],
    ['claude-haiku-4-5', false],
    [null, false],
    ['', false],
  ])('isFableModel(%j) === %s', (input, expected) => {
    expect(isFableModel(input)).toBe(expected);
  });
});
