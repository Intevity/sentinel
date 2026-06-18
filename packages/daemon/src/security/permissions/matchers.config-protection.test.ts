/**
 * Sprint 2 anti-tamper: preset rules that deny tool-based writes to
 * Claude Code config (settings.json + CLAUDE.md) and to the entirety of
 * Sentinel's state dir. Tests are pure-string evaluation against
 * `matchPath`; the higher-level evaluator integration lives in
 * `evaluator.test.ts`.
 *
 * Scope of these rules (matches `SHARED_CONFIG_PROTECTION_RULES` in
 * `packages/app/src/lib/securityPresets.ts`):
 *
 *   - Write|Edit|MultiEdit on `~/.claude/settings.json`
 *   - Write|Edit|MultiEdit on `~/.claude/CLAUDE.md`
 *   - Write|Edit|MultiEdit on anything under `~/.sentinel/**`
 *
 * The first two are intentionally narrow — `~/.claude/plans/`,
 * `~/.claude/projects/`, and `~/.claude/todos/` are legitimate
 * workspace dirs Claude Code writes to constantly during plan-mode
 * and session bookkeeping. A blanket `~/.claude/**` deny would break
 * those flows.
 */

import { describe, it, expect } from 'vitest';
import { homedir } from 'os';
import { matchPath } from './matchers.js';

const HOME = homedir();

describe('matchPath: ~/.claude/settings.json protection', () => {
  it('matches ~/.claude/settings.json via tilde input', () => {
    expect(
      matchPath('~/.claude/settings.json', { file_path: `${HOME}/.claude/settings.json` }),
    ).toBe(true);
  });

  it('matches the absolute-path equivalent (homedir-prefixed)', () => {
    expect(
      matchPath('~/.claude/settings.json', { file_path: `${HOME}/.claude/settings.json` }),
    ).toBe(true);
  });

  it('does NOT match ~/.claude/plans/foo.md (workspace dir, must remain writable)', () => {
    expect(
      matchPath('~/.claude/settings.json', { file_path: `${HOME}/.claude/plans/foo.md` }),
    ).toBe(false);
  });

  it('does NOT match ~/.claudish/settings.json (suffix-confusion guard)', () => {
    expect(
      matchPath('~/.claude/settings.json', { file_path: `${HOME}/.claudish/settings.json` }),
    ).toBe(false);
  });

  it('does NOT match a project-local settings.json', () => {
    expect(
      matchPath('~/.claude/settings.json', { file_path: `${HOME}/work/myapp/settings.json` }),
    ).toBe(false);
  });

  it('matches via path-traversal collapse: ~/foo/../.claude/settings.json', () => {
    expect(
      matchPath('~/.claude/settings.json', {
        file_path: `${HOME}/foo/../.claude/settings.json`,
      }),
    ).toBe(true);
  });
});

describe('matchPath: ~/.claude/CLAUDE.md protection', () => {
  it('matches the user-level CLAUDE.md', () => {
    expect(matchPath('~/.claude/CLAUDE.md', { file_path: `${HOME}/.claude/CLAUDE.md` })).toBe(true);
  });

  it('does NOT match a project-level CLAUDE.md', () => {
    expect(matchPath('~/.claude/CLAUDE.md', { file_path: `${HOME}/work/myapp/CLAUDE.md` })).toBe(
      false,
    );
  });

  it('does NOT match ~/.claude/projects/<dir>/CLAUDE.md', () => {
    // Per-project Claude Code memory lives under projects/, not at the
    // top-level CLAUDE.md.
    expect(
      matchPath('~/.claude/CLAUDE.md', {
        file_path: `${HOME}/.claude/projects/work-myapp/CLAUDE.md`,
      }),
    ).toBe(false);
  });
});

describe('matchPath: ~/.sentinel/** broad protection', () => {
  it('matches settings.json under the Sentinel state dir', () => {
    expect(
      matchPath('~/.sentinel/**', { file_path: `${HOME}/.sentinel/settings.json` }),
    ).toBe(true);
  });

  it('matches the daemon log under the Sentinel state dir', () => {
    expect(
      matchPath('~/.sentinel/**', { file_path: `${HOME}/.sentinel/daemon.log` }),
    ).toBe(true);
  });

  it('matches a deeply-nested file under the Sentinel state dir', () => {
    expect(
      matchPath('~/.sentinel/**', { file_path: `${HOME}/.sentinel/runtime/x/y` }),
    ).toBe(true);
  });

  it('does NOT match ~/.sentinelish/x (suffix-confusion guard)', () => {
    expect(
      matchPath('~/.sentinel/**', { file_path: `${HOME}/.sentinelish/foo.txt` }),
    ).toBe(false);
  });

  it('does NOT match ~/.claude/anything (different dir)', () => {
    expect(matchPath('~/.sentinel/**', { file_path: `${HOME}/.claude/settings.json` })).toBe(
      false,
    );
  });
});
