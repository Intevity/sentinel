import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEntry } from '@claude-sentinel/shared';

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

// Set up the Vite-injected version global before importing the module
// under test — bugReport.ts reads it at call time, but tests exercise
// buildBody/buildIssueUrl which run synchronously with whatever is on
// globalThis when the function executes.
vi.stubGlobal('__APP_VERSION__', 'v-test-1.0.0');

import { buildBody, buildIssueUrl, buildTitle, openBugReport } from './bugReport.js';
import { openUrl } from '@tauri-apps/plugin-opener';

function makeLog(seq: number, level: LogEntry['level'], message: string, tag: string | null = null): LogEntry {
  return { seq, timestamp: 1_700_000_000_000 + seq * 1000, level, message, tag };
}

describe('buildTitle', () => {
  it('uses [bug] prefix for manual reports', () => {
    expect(buildTitle({ source: 'manual' })).toBe('[bug] ');
  });

  it('uses [crash] prefix + first line for error-boundary reports', () => {
    expect(
      buildTitle({
        source: 'error-boundary',
        error: { message: 'TypeError: x is not a function\n    at foo' },
      }),
    ).toBe('[crash] TypeError: x is not a function');
  });

  it('uses [daemon] prefix + tag + first line for daemon-error reports', () => {
    expect(
      buildTitle({
        source: 'daemon-error',
        daemonErrors: [makeLog(1, 'error', 'Token refresh failed: 401', 'OAuth')],
      }),
    ).toBe('[daemon] [OAuth] Token refresh failed: 401');
  });

  it('picks the most recent entry when multiple daemon errors are present', () => {
    expect(
      buildTitle({
        source: 'daemon-error',
        daemonErrors: [
          makeLog(1, 'error', 'Older error', 'A'),
          makeLog(2, 'error', 'Newer error', 'B'),
        ],
      }),
    ).toBe('[daemon] [B] Newer error');
  });

  it('falls back to [bug] when daemon-error has no entries', () => {
    expect(buildTitle({ source: 'daemon-error', daemonErrors: [] })).toBe('[bug] ');
  });

  it('handles daemon entries without a tag', () => {
    expect(
      buildTitle({ source: 'daemon-error', daemonErrors: [makeLog(1, 'error', 'raw message')] }),
    ).toBe('[daemon] raw message');
  });

  it('truncates very long error messages in crash titles', () => {
    const long = 'X'.repeat(500);
    const title = buildTitle({ source: 'error-boundary', error: { message: long } });
    expect(title.length).toBeLessThanOrEqual('[crash] '.length + 120);
  });
});

describe('buildBody', () => {
  it('includes the environment block', () => {
    const body = buildBody({ source: 'manual' });
    expect(body).toContain('## Environment');
    expect(body).toContain('Claude Sentinel: v-test-1.0.0');
  });

  it('includes the Steps / Expected / Actual scaffolding', () => {
    const body = buildBody({ source: 'manual' });
    expect(body).toContain('## Steps to reproduce');
    expect(body).toContain('## Expected behavior');
    expect(body).toContain('## Actual behavior');
  });

  it('includes daemon errors in a collapsible block when present', () => {
    const body = buildBody({
      source: 'daemon-error',
      daemonErrors: [makeLog(1, 'error', 'Token refresh failed', 'OAuth')],
    });
    expect(body).toContain('Recent daemon errors');
    expect(body).toContain('ERROR [OAuth] Token refresh failed');
  });

  it('includes error + stack + component stack for error-boundary reports', () => {
    const body = buildBody({
      source: 'error-boundary',
      error: {
        message: 'Cannot read properties of null',
        stack: 'Error: Cannot read...\n    at Component (App.tsx:42)',
        componentStack: '\n    at Component\n    at App',
      },
    });
    expect(body).toContain('UI error & stack');
    expect(body).toContain('Cannot read properties of null');
    expect(body).toContain('at Component (App.tsx:42)');
    expect(body).toContain('Component stack:');
  });

  it('stays under the 6000 char cap when given very long logs', () => {
    // 30 entries of 500 chars each = 15000+ chars — forces log truncation.
    const entries: LogEntry[] = Array.from({ length: 30 }, (_, i) =>
      makeLog(i + 1, 'error', 'X'.repeat(500), 'Load'),
    );
    const body = buildBody({ source: 'daemon-error', daemonErrors: entries });
    expect(body.length).toBeLessThanOrEqual(6000);
    // Tail is preserved — last entry should appear.
    expect(body).toContain('truncated');
  });

  it('truncates a massive stack trace when logs alone cannot shrink enough', () => {
    const huge = 'S'.repeat(20_000);
    const body = buildBody({
      source: 'error-boundary',
      error: { message: 'boom', stack: huge },
    });
    expect(body.length).toBeLessThanOrEqual(6000);
    expect(body).toContain('truncated');
  });

  it('omits log section when daemonErrors is empty', () => {
    const body = buildBody({ source: 'manual', daemonErrors: [] });
    expect(body).not.toContain('Recent daemon errors');
  });

  it('omits stack section when error is not provided', () => {
    const body = buildBody({ source: 'manual' });
    expect(body).not.toContain('UI error & stack');
  });

  it('uses the crash intro comment for error-boundary reports', () => {
    const body = buildBody({ source: 'error-boundary', error: { message: 'boom' } });
    expect(body).toContain('hit a render error');
  });

  it('uses the daemon intro comment for daemon-error reports', () => {
    const body = buildBody({
      source: 'daemon-error',
      daemonErrors: [makeLog(1, 'error', 'oops')],
    });
    expect(body).toContain('Recent daemon errors were detected');
  });
});

describe('buildIssueUrl', () => {
  it('targets the Intevity/claude-sentinel repo', () => {
    const url = buildIssueUrl({ source: 'manual' });
    expect(url.startsWith('https://github.com/Intevity/claude-sentinel/issues/new?')).toBe(true);
  });

  it('encodes title, body, and bug label as query params', () => {
    const url = buildIssueUrl({ source: 'manual' });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('title')).toBe('[bug] ');
    expect(parsed.searchParams.get('labels')).toBe('bug');
    expect(parsed.searchParams.get('body')).toContain('Steps to reproduce');
  });

  it('produces a URL under ~8KB even with large inputs', () => {
    const entries: LogEntry[] = Array.from({ length: 30 }, (_, i) =>
      makeLog(i + 1, 'error', 'X'.repeat(500), 'Load'),
    );
    const url = buildIssueUrl({
      source: 'error-boundary',
      error: { message: 'boom', stack: 'S'.repeat(10_000) },
      daemonErrors: entries,
    });
    expect(url.length).toBeLessThan(8192);
  });
});

describe('openBugReport', () => {
  beforeEach(() => {
    vi.mocked(openUrl).mockClear();
  });

  it('opens the built GitHub issue URL via the Tauri opener plugin', async () => {
    await openBugReport({ source: 'manual' });
    expect(openUrl).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(openUrl).mock.calls[0]![0];
    expect(arg).toContain('github.com/Intevity/claude-sentinel/issues/new');
  });
});
