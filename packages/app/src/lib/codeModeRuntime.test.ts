import { describe, it, expect } from 'vitest';
import type { CodeModeClientRuntime, CodeModeServerRuntime } from '@sentinel/shared';
import { formatDuration, summarizeServerRuntime } from './codeModeRuntime.js';

const NOW = 1_700_000_000_000;

function client(over: Partial<CodeModeClientRuntime> = {}): CodeModeClientRuntime {
  return {
    key: 'rec-1',
    connectedAt: NOW - 60_000,
    pid: 4242,
    transport: 'stdio',
    descriptor: 'uv tool uvx mcp-atlassian',
    toolCount: 24,
    lastCallAt: NOW - 30_000,
    lastCallOk: true,
    ...over,
  };
}

function entry(over: Partial<CodeModeServerRuntime> = {}): CodeModeServerRuntime {
  return {
    server: 'mcp-atlassian',
    liveProcesses: 1,
    lastError: null,
    lastErrorAt: null,
    clients: [client()],
    ...over,
  };
}

describe('formatDuration', () => {
  it('picks the largest two informative units', () => {
    expect(formatDuration(5_000)).toBe('5s');
    expect(formatDuration(90_000)).toBe('1m');
    expect(formatDuration(60 * 60_000)).toBe('1h');
    expect(formatDuration(134 * 60_000)).toBe('2h 14m');
    expect(formatDuration(48 * 60 * 60_000)).toBe('2d');
    expect(formatDuration(50 * 60 * 60_000)).toBe('2d 2h');
  });

  it('never renders a negative or non-finite duration', () => {
    expect(formatDuration(-1)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
  });
});

describe('summarizeServerRuntime', () => {
  it('says nothing for a server the daemon has never connected to', () => {
    // The bridge connects lazily, so "no entry" is idle, not broken.
    expect(summarizeServerRuntime(undefined, NOW)).toEqual({
      line: null,
      leaked: false,
      error: null,
    });
  });

  it('describes a single live connection with the pid to match against ps', () => {
    expect(summarizeServerRuntime(entry(), NOW)).toEqual({
      line: 'up 1m · pid 4242 · 24 tools · last call 30s ago',
      leaked: false,
      error: null,
    });
  });

  it('reports the count and oldest uptime when a server has several connections', () => {
    const result = summarizeServerRuntime(
      entry({
        liveProcesses: 2,
        clients: [
          client({ connectedAt: NOW - 60_000, lastCallAt: NOW - 30_000 }),
          client({ key: 'rec-2', connectedAt: NOW - 7_200_000, lastCallAt: null, pid: 99 }),
        ],
      }),
      NOW,
    );
    // No single pid or tool count: with several connections those would be
    // ambiguous, and the count already says there is more than one.
    expect(result.line).toBe('2 connections · up 2h · last call 30s ago');
    expect(result.leaked).toBe(false);
  });

  it('flags a leak when more processes are alive than connections tracked', () => {
    // The exact symptom this surface exists for: the daemon believes it holds
    // one child while the OS is running three.
    expect(summarizeServerRuntime(entry({ liveProcesses: 3 }), NOW).leaked).toBe(true);
  });

  it('surfaces the last error when nothing is connected', () => {
    expect(
      summarizeServerRuntime(
        entry({ clients: [], liveProcesses: 0, lastError: 'fetch failed', lastErrorAt: NOW }),
        NOW,
      ),
    ).toEqual({ line: null, leaked: false, error: 'fetch failed' });
  });

  it('flags orphaned processes for a server with no connection left', () => {
    const result = summarizeServerRuntime(
      entry({ clients: [], liveProcesses: 2, lastError: 'transport closed' }),
      NOW,
    );
    expect(result.leaked).toBe(true);
    expect(result.error).toBe('transport closed');
  });

  it('hides a stale error once the server is connected again', () => {
    // lastError is cleared daemon-side on success, but a row that IS connected
    // must never show one regardless.
    expect(summarizeServerRuntime(entry({ lastError: 'old failure' }), NOW).error).toBeNull();
  });

  it('omits fields the daemon could not determine', () => {
    const result = summarizeServerRuntime(
      entry({ clients: [client({ pid: null, toolCount: null, lastCallAt: null })] }),
      NOW,
    );
    expect(result.line).toBe('up 1m');
  });
});
