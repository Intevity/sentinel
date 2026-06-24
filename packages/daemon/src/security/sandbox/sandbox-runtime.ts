/**
 * Leg B runtime: wraps Sentinel's own code-mode MCP stdio children in the
 * Anthropic sandbox. Owns the `SandboxManager` lifecycle (initialize / reset on
 * policy change) and produces a sandboxed `{command, args, env}` for the MCP
 * client manager to spawn.
 *
 * The `SandboxManager` is injected (`deps.manager`, defaulting to the real
 * package export) so the wrapper logic — when to enforce, config mapping, the
 * argv/env round-trip, degrade-to-null — is testable with a fake manager
 * without invoking the real OS sandbox. Per the degrade posture,
 * {@link SandboxRuntime.wrapStdioCommand} returns `null` (run unsandboxed)
 * whenever the platform can't enforce or the policy is off, never throwing.
 */

import { SandboxManager as RealSandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { IsolationPolicy, SandboxStatus } from '@sentinel/shared';
import { toSandboxRuntimeConfig, type SandboxPlatformPaths } from './policy-map.js';
import { computeCapability, probeSandbox, type SandboxProbe } from './capability.js';

/** The structural subset of the package's `ISandboxManager` we depend on. The
 *  real `SandboxManager` satisfies it; tests pass a fake. */
export interface SandboxManagerLike {
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  wrapWithSandboxArgv(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
  ): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  reset(): Promise<void>;
}

export interface SandboxRuntimeDeps {
  /** Read the current canonical policy. */
  getPolicy: () => IsolationPolicy;
  /** Injected sandbox manager. Defaults to the real package singleton. */
  manager?: SandboxManagerLike;
  /** Platform override (defaults to process.platform). */
  platform?: string;
  /** Host-dependency probe override (defaults to {@link probeSandbox}). */
  probe?: () => SandboxProbe;
  /** Resolved absolute paths to bundled helper binaries (Phase 3/4). */
  platformPaths?: SandboxPlatformPaths;
}

export interface SandboxRuntime {
  /** Reconcile the manager with the current policy + capability. Initializes
   *  when enforcement should be on and the platform supports it; resets when it
   *  shouldn't. Idempotent — a no-op when the effective config is unchanged. */
  refresh(): Promise<void>;
  /** Produce a sandboxed spawn for a stdio MCP child, or `null` to run it
   *  unsandboxed (policy off, platform unavailable, or an error — degrade). */
  wrapStdioCommand(
    command: string,
    args: string[],
    env: Record<string, string>,
  ): Promise<{ command: string; args: string[]; env: Record<string, string> } | null>;
  /** Current capability/status for the UI. */
  getStatus(): SandboxStatus;
  /** Tear down the manager (daemon shutdown). */
  reset(): Promise<void>;
}

/** POSIX-quote a single argument so a token with spaces/quotes/globs survives
 *  the round-trip through the sandbox manager's shell-command input. */
function shQuote(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_\-./:=@%+,]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Reconstruct a shell command line from a command + argv. */
export function toShellLine(command: string, args: string[]): string {
  return [command, ...args].map(shQuote).join(' ');
}

export function createSandboxRuntime(deps: SandboxRuntimeDeps): SandboxRuntime {
  const manager: SandboxManagerLike = deps.manager ?? (RealSandboxManager as SandboxManagerLike);
  const platform = deps.platform ?? process.platform;
  const probe = deps.probe ?? (() => probeSandbox(platform));
  const platformPaths = deps.platformPaths ?? {};

  let active = false;
  let lastConfigHash: string | null = null;

  const getStatus = (): SandboxStatus => computeCapability(platform, probe());

  const refresh = async (): Promise<void> => {
    const policy = deps.getPolicy();
    const status = computeCapability(platform, probe());
    const shouldEnforce =
      policy.enabled && policy.enforceCodeMode && status.capability !== 'unavailable';

    if (!shouldEnforce) {
      if (active) {
        await manager.reset();
        active = false;
        lastConfigHash = null;
      }
      return;
    }

    const config: SandboxRuntimeConfig = toSandboxRuntimeConfig(policy, platformPaths);
    const hash = JSON.stringify(config);
    if (active && hash === lastConfigHash) return;
    await manager.initialize(config);
    active = true;
    lastConfigHash = hash;
  };

  const wrapStdioCommand = async (
    command: string,
    args: string[],
    env: Record<string, string>,
  ): Promise<{ command: string; args: string[]; env: Record<string, string> } | null> => {
    if (!active) return null;
    try {
      const { argv, env: sbEnv } = await manager.wrapWithSandboxArgv(toShellLine(command, args));
      const head = argv[0];
      if (head === undefined) return null;
      const mergedEnv: Record<string, string> = { ...env };
      for (const [k, v] of Object.entries(sbEnv)) {
        if (typeof v === 'string') mergedEnv[k] = v;
      }
      return { command: head, args: argv.slice(1), env: mergedEnv };
    } catch (err) {
      // Degrade: never block the child on a wrap failure.
      console.error('[Sandbox] wrapStdioCommand failed; running child unsandboxed:', err);
      return null;
    }
  };

  const reset = async (): Promise<void> => {
    if (active) {
      await manager.reset();
      active = false;
      lastConfigHash = null;
    }
  };

  return { refresh, wrapStdioCommand, getStatus, reset };
}
