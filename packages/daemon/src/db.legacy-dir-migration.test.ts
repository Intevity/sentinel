/**
 * `migrateLegacyDataDir` — one-time rename of the legacy data directory
 * `~/.claude-sentinel` → `~/.sentinel` for users upgrading across the
 * "Claude Sentinel" → "Sentinel" product rename.
 *
 * No mocks: every case runs against a real temp "home" directory passed
 * explicitly to the function, so nothing touches the developer's real home.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  chmodSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateLegacyDataDir } from './db.js';

const created: string[] = [];

function tmpHome(): string {
  const d = mkdtempSync(join(tmpdir(), 'sentinel-dirmig-'));
  created.push(d);
  return d;
}

afterEach(() => {
  for (const d of created.splice(0)) {
    try {
      chmodSync(d, 0o755); // undo the read-only case so rm can recurse
    } catch {
      /* already gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe('migrateLegacyDataDir', () => {
  it('renames ~/.claude-sentinel to ~/.sentinel, carrying its contents', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.claude-sentinel'));
    writeFileSync(join(home, '.claude-sentinel', 'sentinel.db'), 'DBDATA');

    expect(migrateLegacyDataDir(home)).toBe(true);
    expect(existsSync(join(home, '.claude-sentinel'))).toBe(false);
    expect(readFileSync(join(home, '.sentinel', 'sentinel.db'), 'utf-8')).toBe('DBDATA');
  });

  it('never clobbers an existing ~/.sentinel — no-op even when a legacy dir also exists', () => {
    // The data-loss footgun fix: if BOTH dirs exist (e.g. an old "Claude Sentinel"
    // build recreated ~/.claude-sentinel after the migration already ran), ~/.sentinel
    // is the source of truth and must be left fully intact; the stray legacy dir is
    // ignored, never set aside or promoted over the real data.
    const home = tmpHome();
    mkdirSync(join(home, '.claude-sentinel'));
    writeFileSync(join(home, '.claude-sentinel', 'sentinel.db'), 'STRAY');
    mkdirSync(join(home, '.sentinel'));
    writeFileSync(join(home, '.sentinel', 'sentinel.db'), 'REAL');

    expect(migrateLegacyDataDir(home)).toBe(false);
    expect(readFileSync(join(home, '.sentinel', 'sentinel.db'), 'utf-8')).toBe('REAL');
    expect(readdirSync(home).filter((n) => n.startsWith('.sentinel.superseded-'))).toHaveLength(0);
    expect(existsSync(join(home, '.claude-sentinel'))).toBe(true);
  });

  it('is a no-op when there is no legacy dir to migrate', () => {
    const home = tmpHome();
    expect(migrateLegacyDataDir(home)).toBe(false);
    expect(existsSync(join(home, '.sentinel'))).toBe(false);
  });

  it('returns false and leaves the legacy dir in place when the rename fails', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.claude-sentinel'));
    writeFileSync(join(home, '.claude-sentinel', 'x'), 'data');
    // Read-only home: creating ~/.sentinel inside it fails, so renameSync throws.
    chmodSync(home, 0o555);

    expect(migrateLegacyDataDir(home)).toBe(false);
    chmodSync(home, 0o755);
    expect(existsSync(join(home, '.claude-sentinel'))).toBe(true);
  });
});
