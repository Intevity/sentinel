/**
 * Unit tests for the infra allow-rule writers used to auto-allow Sentinel's own
 * read-only / loopback tools (`mcp__sentinel__retrieve`, the code-mode curl
 * endpoint) in `~/.claude/settings.json` — the only scope that covers Claude
 * Code subagents. These run even when bi-directional settings-sync is off, so
 * they must touch ONLY `permissions.allow` and preserve everything else.
 *
 * Real temp files, no fs mocks — the whole point is the on-disk shape.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureClaudeSettingsAllow, removeClaudeSettingsAllow } from './claude-sync.js';

const RETRIEVE = 'mcp__sentinel__retrieve';
const CURL = 'Bash(curl -s -X POST http://127.0.0.1:47284/code-mode/call:*)';

describe('ensureClaudeSettingsAllow / removeClaudeSettingsAllow', () => {
  let dir: string;
  let path: string;
  const read = (): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sentinel-infra-allow-'));
    path = join(dir, 'settings.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('appends entries to an existing file, preserving every other key', () => {
    writeFileSync(
      path,
      JSON.stringify({
        $schema: 'x',
        model: 'opusplan',
        permissions: { allow: ['Bash(ls)'], deny: ['Read(secret)'], defaultMode: 'acceptEdits' },
        hooks: { PreToolUse: [] },
      }),
    );

    const changed = ensureClaudeSettingsAllow([RETRIEVE, CURL], path);
    expect(changed).toBe(true);

    const after = read();
    const perms = after['permissions'] as Record<string, unknown>;
    // The new entries are appended AFTER the pre-existing one.
    expect(perms['allow']).toEqual(['Bash(ls)', RETRIEVE, CURL]);
    // Nothing else in the permissions block is disturbed.
    expect(perms['deny']).toEqual(['Read(secret)']);
    expect(perms['defaultMode']).toBe('acceptEdits');
    // Nor any other top-level key.
    expect(after['$schema']).toBe('x');
    expect(after['model']).toBe('opusplan');
    expect(after['hooks']).toEqual({ PreToolUse: [] });
  });

  it('is a no-op (returns false, file byte-identical) when every entry is already present', () => {
    writeFileSync(path, JSON.stringify({ permissions: { allow: [RETRIEVE] } }));
    const before = readFileSync(path, 'utf8');
    expect(ensureClaudeSettingsAllow([RETRIEVE], path)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('adds only the missing entries when some are already present', () => {
    writeFileSync(path, JSON.stringify({ permissions: { allow: [RETRIEVE] } }));
    expect(ensureClaudeSettingsAllow([RETRIEVE, CURL], path)).toBe(true);
    expect((read()['permissions'] as Record<string, unknown>)['allow']).toEqual([RETRIEVE, CURL]);
  });

  it('creates the file (and parent dirs) when it does not exist', () => {
    const nested = join(dir, 'a', 'b', 'settings.json');
    expect(existsSync(nested)).toBe(false);
    expect(ensureClaudeSettingsAllow([RETRIEVE], nested)).toBe(true);
    expect(
      (JSON.parse(readFileSync(nested, 'utf8'))['permissions'] as Record<string, unknown>)['allow'],
    ).toEqual([RETRIEVE]);
  });

  it('seeds permissions.allow when the file exists but has no permissions block', () => {
    writeFileSync(path, JSON.stringify({ model: 'z' }));
    expect(ensureClaudeSettingsAllow([RETRIEVE], path)).toBe(true);
    const after = read();
    expect((after['permissions'] as Record<string, unknown>)['allow']).toEqual([RETRIEVE]);
    expect(after['model']).toBe('z');
  });

  it('ignores a non-array permissions.allow and replaces it with the entries', () => {
    writeFileSync(path, JSON.stringify({ permissions: { allow: 'oops' } }));
    expect(ensureClaudeSettingsAllow([RETRIEVE], path)).toBe(true);
    expect((read()['permissions'] as Record<string, unknown>)['allow']).toEqual([RETRIEVE]);
  });

  it('returns false without writing when given no entries', () => {
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
    const before = readFileSync(path, 'utf8');
    expect(ensureClaudeSettingsAllow([], path)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('remove strips a present entry and leaves the rest intact', () => {
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['Bash(ls)', RETRIEVE, CURL] } }));
    expect(removeClaudeSettingsAllow([RETRIEVE], path)).toBe(true);
    expect((read()['permissions'] as Record<string, unknown>)['allow']).toEqual(['Bash(ls)', CURL]);
  });

  it('remove is a no-op (false) when the entry is absent', () => {
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
    const before = readFileSync(path, 'utf8');
    expect(removeClaudeSettingsAllow([RETRIEVE], path)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('remove from a missing file returns false and creates nothing', () => {
    const missing = join(dir, 'nope', 'settings.json');
    expect(removeClaudeSettingsAllow([RETRIEVE], missing)).toBe(false);
    expect(existsSync(missing)).toBe(false);
  });

  it('rethrows on a malformed (non-ENOENT) settings file', () => {
    writeFileSync(path, '{ this is not json');
    expect(() => ensureClaudeSettingsAllow([RETRIEVE], path)).toThrow();
  });
});
