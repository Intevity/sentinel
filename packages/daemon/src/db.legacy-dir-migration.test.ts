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

  it('promotes the legacy data when a shell ~/.sentinel already exists, preserving the shell as a backup', () => {
    // Reproduces the real data-loss trigger: a stray/empty ~/.sentinel (e.g.
    // created by a test run's logger) must NOT strand the legacy data.
    const home = tmpHome();
    mkdirSync(join(home, '.claude-sentinel'));
    writeFileSync(join(home, '.claude-sentinel', 'sentinel.db'), 'REALDATA');
    mkdirSync(join(home, '.sentinel'));
    writeFileSync(join(home, '.sentinel', 'daemon.log'), 'shell-log');

    expect(migrateLegacyDataDir(home)).toBe(true);
    // The legacy data is now the live dir; the legacy path is gone.
    expect(existsSync(join(home, '.claude-sentinel'))).toBe(false);
    expect(readFileSync(join(home, '.sentinel', 'sentinel.db'), 'utf-8')).toBe('REALDATA');
    // The prior shell was set aside (non-destructive), not deleted.
    const backups = readdirSync(home).filter((n) => n.startsWith('.sentinel.superseded-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(home, backups[0]!, 'daemon.log'), 'utf-8')).toBe('shell-log');
  });

  it('returns false and leaves both dirs intact when the shell cannot be set aside', () => {
    const home = tmpHome();
    mkdirSync(join(home, '.claude-sentinel'));
    writeFileSync(join(home, '.claude-sentinel', 'sentinel.db'), 'REALDATA');
    mkdirSync(join(home, '.sentinel'));
    chmodSync(home, 0o555); // read-only home: the backup dir cannot be created

    expect(migrateLegacyDataDir(home)).toBe(false);
    chmodSync(home, 0o755);
    expect(existsSync(join(home, '.claude-sentinel', 'sentinel.db'))).toBe(true);
    expect(existsSync(join(home, '.sentinel'))).toBe(true);
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
