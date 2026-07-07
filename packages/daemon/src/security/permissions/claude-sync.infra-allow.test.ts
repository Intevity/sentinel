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
import {
  ensureClaudeSettingsAllow,
  removeClaudeSettingsAllow,
  ensureClaudeSettingsPreToolUseHook,
  removeClaudeSettingsPreToolUseHook,
} from './claude-sync.js';

const RETRIEVE = 'mcp__sentinel__retrieve';
const CURL = 'Bash(curl -s -X POST http://127.0.0.1:47284/code-mode/call:*)';
const HOOK_CMD =
  'echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\'';
/** The exact PreToolUse entry the writer produces for RETRIEVE + HOOK_CMD. */
const OUR_ENTRY = { matcher: RETRIEVE, hooks: [{ type: 'command', command: HOOK_CMD }] };

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

describe('ensureClaudeSettingsPreToolUseHook / removeClaudeSettingsPreToolUseHook', () => {
  let dir: string;
  let path: string;
  const read = (): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'));
  const preToolUse = (): unknown[] =>
    (read()['hooks'] as Record<string, unknown>)['PreToolUse'] as unknown[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sentinel-infra-hook-'));
    path = join(dir, 'settings.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('adds exactly the Sentinel entry and preserves every other key', () => {
    writeFileSync(
      path,
      JSON.stringify({
        model: 'opusplan',
        permissions: { allow: [RETRIEVE], deny: [], ask: [] },
      }),
    );
    expect(ensureClaudeSettingsPreToolUseHook(RETRIEVE, HOOK_CMD, path)).toBe(true);
    const after = read();
    expect((after['hooks'] as Record<string, unknown>)['PreToolUse']).toEqual([OUR_ENTRY]);
    // The command carries a permissionDecision:"allow" — the load-bearing bit.
    const cmd = (preToolUse()[0] as Record<string, unknown>)['hooks'] as Record<string, unknown>[];
    expect(cmd[0]!['command']).toContain('"permissionDecision":"allow"');
    // Nothing else touched.
    expect(after['model']).toBe('opusplan');
    expect(after['permissions']).toEqual({ allow: [RETRIEVE], deny: [], ask: [] });
  });

  it('preserves other PreToolUse matchers and other hook events', () => {
    const otherEntry = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] };
    const postToolUse = [{ matcher: 'Write', hooks: [{ type: 'command', command: 'fmt' }] }];
    writeFileSync(
      path,
      JSON.stringify({ hooks: { PreToolUse: [otherEntry], PostToolUse: postToolUse } }),
    );
    expect(ensureClaudeSettingsPreToolUseHook(RETRIEVE, HOOK_CMD, path)).toBe(true);
    const hooks = read()['hooks'] as Record<string, unknown>;
    // Our entry appended after the user's; the user's entry untouched.
    expect(hooks['PreToolUse']).toEqual([otherEntry, OUR_ENTRY]);
    expect(hooks['PostToolUse']).toEqual(postToolUse);
  });

  it('is a no-op (returns false, byte-identical) when already present verbatim', () => {
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [OUR_ENTRY] } }));
    const before = readFileSync(path, 'utf8');
    expect(ensureClaudeSettingsPreToolUseHook(RETRIEVE, HOOK_CMD, path)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('replaces a stale Sentinel entry when the command changed', () => {
    const stale = { matcher: RETRIEVE, hooks: [{ type: 'command', command: 'echo OLD' }] };
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [stale] } }));
    expect(ensureClaudeSettingsPreToolUseHook(RETRIEVE, HOOK_CMD, path)).toBe(true);
    expect(preToolUse()).toEqual([OUR_ENTRY]);
  });

  it('creates the file (and parent dirs) when it does not exist', () => {
    const nested = join(dir, 'a', 'b', 'settings.json');
    expect(ensureClaudeSettingsPreToolUseHook(RETRIEVE, HOOK_CMD, nested)).toBe(true);
    const hooks = JSON.parse(readFileSync(nested, 'utf8'))['hooks'] as Record<string, unknown>;
    expect(hooks['PreToolUse']).toEqual([OUR_ENTRY]);
  });

  it('remove strips only the Sentinel entry, keeping others', () => {
    const otherEntry = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] };
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [otherEntry, OUR_ENTRY] } }));
    expect(removeClaudeSettingsPreToolUseHook(RETRIEVE, path)).toBe(true);
    expect(preToolUse()).toEqual([otherEntry]);
  });

  it('remove drops the empty hooks key entirely when we were the only entry', () => {
    writeFileSync(path, JSON.stringify({ model: 'z', hooks: { PreToolUse: [OUR_ENTRY] } }));
    expect(removeClaudeSettingsPreToolUseHook(RETRIEVE, path)).toBe(true);
    const after = read();
    expect('hooks' in after).toBe(false); // file returns to its hook-free shape
    expect(after['model']).toBe('z');
  });

  it('remove empties PreToolUse but keeps hooks when other events remain', () => {
    const postToolUse = [{ matcher: 'Write', hooks: [{ type: 'command', command: 'fmt' }] }];
    writeFileSync(
      path,
      JSON.stringify({ hooks: { PreToolUse: [OUR_ENTRY], PostToolUse: postToolUse } }),
    );
    expect(removeClaudeSettingsPreToolUseHook(RETRIEVE, path)).toBe(true);
    const hooks = read()['hooks'] as Record<string, unknown>;
    expect('PreToolUse' in hooks).toBe(false); // emptied → key dropped
    expect(hooks['PostToolUse']).toEqual(postToolUse); // sibling event preserved
  });

  it('remove is a no-op (false) when our entry is absent', () => {
    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [] } }));
    const before = readFileSync(path, 'utf8');
    expect(removeClaudeSettingsPreToolUseHook(RETRIEVE, path)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('remove from a missing file returns false and creates nothing', () => {
    const missing = join(dir, 'nope', 'settings.json');
    expect(removeClaudeSettingsPreToolUseHook(RETRIEVE, missing)).toBe(false);
    expect(existsSync(missing)).toBe(false);
  });

  it('rethrows on a malformed (non-ENOENT) settings file', () => {
    writeFileSync(path, '{ not json');
    expect(() => ensureClaudeSettingsPreToolUseHook(RETRIEVE, HOOK_CMD, path)).toThrow();
  });
});
