/**
 * Atomic writes into files the user owns (dotfiles Sentinel edits in place:
 * opencode's config, `~/.claude/CLAUDE.md`, opencode's `AGENTS.md`).
 *
 * A plain temp-file + rename is atomic, but `rename` replaces the *directory
 * entry*: when that entry is a symlink (a dotfiles repo linked into place is
 * the common case) the link is swapped for a regular file and the repo copy
 * silently stops receiving changes. It also creates the file with the process
 * umask, dropping a mode the user chose (a `0600` config holding an API key
 * becomes world-readable).
 *
 * {@link writeFileAtomicPreserving} resolves the link and writes beside the
 * real file, then carries the original mode across.
 */

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';

/**
 * The path a write to `path` should land on: the fully resolved target when
 * `path` is (or passes through) a symlink, the link's target when the link
 * dangles (so creating it keeps the link), else `path` itself.
 */
export async function resolveWriteTarget(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    // Missing file, or a dangling link. readlink tells the two apart: it
    // fails (EINVAL / ENOENT) for anything that is not a symlink.
    try {
      return resolve(dirname(path), await fs.readlink(path));
    } catch {
      return path;
    }
  }
}

/** Atomically replace the contents of `path`, following symlinks and keeping
 *  the existing file mode. Creates parent directories as needed. */
export async function writeFileAtomicPreserving(path: string, content: string): Promise<void> {
  const target = await resolveWriteTarget(path);
  await fs.mkdir(dirname(target), { recursive: true });
  let mode: number | null = null;
  try {
    mode = (await fs.stat(target)).mode & 0o7777;
  } catch {
    // New file: the default mode is right.
  }
  const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    // chmod, not writeFile's `mode` option: that one is filtered by the umask.
    if (mode !== null) await fs.chmod(tmp, mode);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
