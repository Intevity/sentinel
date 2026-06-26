/**
 * Resolve absolute paths to the sandbox helper binaries the package ships
 * (`apply-seccomp` on Linux, `srt-win.exe` on Windows). These ELF/PE binaries
 * are executed by the sandbox at runtime, so they must live on the real
 * filesystem — they cannot run from inside a `pkg` snapshot.
 *
 * Resolution order (Linux seccomp shown; Windows mirrors it in Phase 4):
 *   1. `SENTINEL_SECCOMP_PATH` env override (ops / tests).
 *   2. Packaged sidecar: `<dir of execPath>/sandbox-bins/apply-seccomp`, copied
 *      there by `build-sidecar.mjs` and shipped beside the daemon binary.
 *   3. Dev (unbundled): return nothing — the package self-resolves the binary
 *      from its own `node_modules/.../dist/vendor`, which is on disk.
 *
 * When nothing resolves the package degrades gracefully (seccomp becomes a
 * warning, not a hard failure), matching the degrade-and-surface posture.
 *
 * Pure + fully injectable for testing; the only host access is the default
 * `existsSync`/`process` which callers override in tests.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SandboxPlatformPaths } from './policy-map.js';

export interface ResolvePlatformPathsDeps {
  /** Defaults to `process.platform`. */
  platform?: string;
  /** True when running inside a pkg-built sidecar. Defaults to `!!process.pkg`. */
  packaged?: boolean;
  /** Defaults to `process.execPath`. */
  execPath?: string;
  /** Filesystem existence check. Defaults to `fs.existsSync`. */
  exists?: (p: string) => boolean;
  /** Override for the seccomp env var. Defaults to `SENTINEL_SECCOMP_PATH`. */
  envSeccompPath?: string | undefined;
}

export function resolvePlatformPaths(deps: ResolvePlatformPathsDeps = {}): SandboxPlatformPaths {
  const platform = deps.platform ?? process.platform;
  // Only Linux needs an out-of-band helper path; macOS uses the builtin
  // sandbox-exec and Windows is handled by the bundled srt-win launcher.
  if (platform !== 'linux') return {};

  const exists = deps.exists ?? existsSync;

  const envPath =
    deps.envSeccompPath !== undefined ? deps.envSeccompPath : process.env['SENTINEL_SECCOMP_PATH'];
  if (envPath && exists(envPath)) return { seccompApplyPath: envPath };

  const packaged = deps.packaged ?? Boolean((process as unknown as { pkg?: unknown }).pkg);
  if (packaged) {
    const execPath = deps.execPath ?? process.execPath;
    const beside = join(dirname(execPath), 'sandbox-bins', 'apply-seccomp');
    if (exists(beside)) return { seccompApplyPath: beside };
  }

  // Dev / unbundled, or packaged-but-missing: let the package self-resolve or
  // degrade. No override.
  return {};
}
