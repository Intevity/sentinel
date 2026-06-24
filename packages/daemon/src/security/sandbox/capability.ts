/**
 * Sandbox capability detection for Leg B (code-mode enforcement).
 *
 * The decision core {@link computeCapability} is pure and fully unit-tested for
 * every platform by passing a {@link SandboxProbe}. Only the thin probe that
 * gathers the raw booleans ({@link probeSandbox}) touches the host, so the
 * platform-specific I/O is the only part carrying a justified `v8 ignore`.
 *
 * Per the degrade-and-surface posture: macOS/Linux with deps present → `full`;
 * Windows (the package is network-only there) → `network-only`; missing deps or
 * an unsupported platform → `unavailable` (the caller then runs children
 * unsandboxed and surfaces the reason rather than blocking them).
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { SandboxCapability, SandboxDependency, SandboxStatus } from '@sentinel/shared';

/** Raw host-dependency presence flags. Gathered by {@link probeSandbox}. */
export interface SandboxProbe {
  /** macOS: `/usr/bin/sandbox-exec` (Seatbelt) is present. */
  sandboxExec: boolean;
  /** macOS: ripgrep is available (used by the sandbox for file search). */
  ripgrep: boolean;
  /** Linux: `bubblewrap` (bwrap) is on PATH. */
  bubblewrap: boolean;
  /** Linux: `socat` is on PATH. */
  socat: boolean;
  /** Linux: the prebuilt seccomp helper is available (Unix-socket blocking). */
  seccomp: boolean;
  /** Windows: the bundled `srt-win.exe` is present. */
  srtWin: boolean;
}

/**
 * Pure decision: map a probe + platform onto the effective sandbox capability,
 * the human-readable reasons for anything less than `full`, and the per-dep
 * presence list the UI shows. Never throws; never touches the host.
 */
export function computeCapability(platform: string, probe: SandboxProbe): SandboxStatus {
  const reasons: string[] = [];
  let capability: SandboxCapability;
  let dependencies: SandboxDependency[];

  if (platform === 'darwin') {
    dependencies = [
      { name: 'sandbox-exec', present: probe.sandboxExec },
      { name: 'ripgrep', present: probe.ripgrep },
    ];
    if (!probe.sandboxExec) {
      capability = 'unavailable';
      reasons.push('macOS sandbox-exec (Seatbelt) was not found.');
    } else {
      capability = 'full';
      if (!probe.ripgrep) {
        reasons.push('ripgrep was not found — some search-heavy commands may fail in the sandbox.');
      }
    }
  } else if (platform === 'linux') {
    dependencies = [
      { name: 'bubblewrap', present: probe.bubblewrap },
      { name: 'socat', present: probe.socat },
      { name: 'seccomp', present: probe.seccomp },
    ];
    if (!probe.bubblewrap || !probe.socat) {
      capability = 'unavailable';
      const missing = [
        !probe.bubblewrap ? 'bubblewrap' : null,
        !probe.socat ? 'socat' : null,
      ].filter((x): x is string => x !== null);
      reasons.push(`Install ${missing.join(' and ')} to enable the Linux sandbox.`);
    } else {
      capability = 'full';
      if (!probe.seccomp) {
        reasons.push('seccomp filter unavailable — Unix-socket blocking is disabled.');
      }
    }
  } else if (platform === 'win32') {
    dependencies = [{ name: 'srt-win', present: probe.srtWin }];
    if (!probe.srtWin) {
      capability = 'unavailable';
      reasons.push('Windows sandbox helper (srt-win.exe) was not found.');
    } else {
      capability = 'network-only';
      reasons.push('Windows supports network isolation only — no filesystem isolation.');
    }
  } else {
    dependencies = [];
    capability = 'unavailable';
    reasons.push(`Sandboxing is not supported on platform "${platform}".`);
  }

  return { platform, capability, reasons, dependencies };
}

/** True if `cmd` resolves on PATH (best-effort, never throws). */
/* v8 ignore start -- thin host probe: spawns `command -v`, platform/env-dependent, not reproducible in CI */
function onPath(cmd: string): boolean {
  try {
    execFileSync('command', ['-v', cmd], { stdio: 'ignore', shell: '/bin/sh' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gather the raw host-dependency flags for the current platform. Thin I/O layer
 * over {@link computeCapability}; the decision logic lives there. Never throws.
 */
export function probeSandbox(platform: string = process.platform): SandboxProbe {
  const base: SandboxProbe = {
    sandboxExec: false,
    ripgrep: false,
    bubblewrap: false,
    socat: false,
    seccomp: false,
    srtWin: false,
  };
  try {
    if (platform === 'darwin') {
      base.sandboxExec = existsSync('/usr/bin/sandbox-exec');
      base.ripgrep = onPath('rg');
    } else if (platform === 'linux') {
      base.bubblewrap = onPath('bwrap');
      base.socat = onPath('socat');
      // The seccomp helper ships inside the package; treat presence of bwrap as
      // the gating dep and report seccomp via the package check when wired.
      base.seccomp = true;
    } else if (platform === 'win32') {
      // Windows is network-only (no filesystem isolation). Packaged builds ship
      // srt-win.exe beside the daemon (build-sidecar copies it); in dev the
      // package resolves its own bundled copy, so treat it as present. The
      // first-run elevation flow (installWindowsSandbox) is a Tauri/Rust UAC
      // step that must be implemented + verified on a Windows host.
      const packaged = Boolean((process as unknown as { pkg?: unknown }).pkg);
      base.srtWin = packaged
        ? existsSync(join(dirname(process.execPath), 'sandbox-bins', 'srt-win.exe'))
        : true;
    }
  } catch {
    /* best-effort */
  }
  return base;
}
/* v8 ignore stop */
