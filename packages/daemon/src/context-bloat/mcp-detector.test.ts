import { describe, it, expect } from 'vitest';
import { detectMcpServers } from './mcp-detector.js';

describe('detectMcpServers', () => {
  it('returns [] for non-object inputs', () => {
    expect(detectMcpServers(null)).toEqual([]);
    expect(detectMcpServers('not an object')).toEqual([]);
    expect(detectMcpServers(undefined)).toEqual([]);
  });

  it('returns [] when there is no `projects` key', () => {
    expect(detectMcpServers({})).toEqual([]);
    expect(detectMcpServers({ projects: 'oops' })).toEqual([]);
  });

  it('emits one row per (project × enabled MCP server)', () => {
    const out = detectMcpServers({
      projects: {
        '/Users/jeff/foo': {
          mcpServers: {
            jira: { command: 'uvx' },
            github: { command: 'gh' },
          },
        },
      },
    });
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.name).sort()).toEqual(['github', 'jira']);
    expect(out.every((s) => s.enabled)).toBe(true);
    expect(out.every((s) => s.project === '/Users/jeff/foo')).toBe(true);
  });

  it('emits disabled servers with enabled=false', () => {
    const out = detectMcpServers({
      projects: {
        '/Users/jeff/foo': {
          disabledMcpServers: ['plugin:figma:figma'],
        },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('plugin:figma:figma');
    expect(out[0]?.enabled).toBe(false);
  });

  it('aggregates across multiple projects', () => {
    const out = detectMcpServers({
      projects: {
        '/a': { mcpServers: { x: {} } },
        '/b': { mcpServers: { y: {} }, disabledMcpServers: ['z'] },
      },
    });
    expect(out).toHaveLength(3);
    const byProject = new Map(out.map((s) => [s.project + '/' + s.name, s]));
    expect(byProject.get('/a/x')?.enabled).toBe(true);
    expect(byProject.get('/b/y')?.enabled).toBe(true);
    expect(byProject.get('/b/z')?.enabled).toBe(false);
  });

  it('skips malformed project entries gracefully', () => {
    const out = detectMcpServers({
      projects: {
        '/good': { mcpServers: { ok: {} } },
        '/bad': null,
        '/also-bad': 'string',
        '/empty': {},
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('ok');
  });

  it('ignores non-string entries in disabledMcpServers', () => {
    const out = detectMcpServers({
      projects: {
        '/p': { disabledMcpServers: ['ok', 42, null] as unknown[] },
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('ok');
  });
});
