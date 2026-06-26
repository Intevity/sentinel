/**
 * Pure mappers from Sentinel's canonical {@link IsolationPolicy} onto the two
 * enforcement targets, plus the domain validator that guards the canonical
 * boundary. Everything here is side-effect free and fully unit-tested — no I/O,
 * no platform calls — so the schema-divergence risk between the two targets is
 * pinned down by tests before any actual sandboxing runs.
 *
 *  - {@link toClaudeCodeSandboxBlock} → the `sandbox` block written into
 *    `~/.claude/settings.json` (Leg A). Verified key-for-key against
 *    https://code.claude.com/docs/en/sandboxing.
 *  - {@link toSandboxRuntimeConfig} → the config object handed to
 *    `@anthropic-ai/sandbox-runtime` (Leg B). Typed here against a local
 *    structural interface; Phase 2 swaps in the package's real
 *    `SandboxRuntimeConfig` type and the compiler confirms assignability.
 */

import type { IsolationPolicy } from '@sentinel/shared';

// ─── Domain validation ─────────────────────────────────────────────────

/** A single DNS label: 1–63 chars, alphanumeric with internal hyphens. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Validate a network allow/deny entry against the *stricter* of the two
 * targets (the package's Zod rules), so a policy that Sentinel accepts is
 * always accepted by `@anthropic-ai/sandbox-runtime` too. Accepts:
 *
 *  - the bare `*` token (deny-all / allow-all, depending on the list),
 *  - an exact hostname (`example.com`, `localhost`),
 *  - a single leading-wildcard domain `*.domain.tld` with ≥2 labels after the
 *    `*.` (so overly-broad `*.com` is rejected).
 *
 * Rejects anything carrying a protocol (`https://`), a path (`/`), a port
 * (`:8080`), interior whitespace, surrounding whitespace, or a wildcard
 * anywhere but a single leading `*.`.
 */
export function isValidSandboxDomain(pattern: unknown): pattern is string {
  if (typeof pattern !== 'string') return false;
  const p = pattern;
  if (p === '') return false;
  if (p.trim() !== p) return false; // surrounding whitespace
  if (/\s/.test(p)) return false; // interior whitespace
  if (p === '*') return true; // wildcard-all token
  if (p.includes('://') || p.includes('/')) return false; // protocol / path
  if (p.includes(':')) return false; // port (or scheme remnant)

  if (p.includes('*')) {
    if (!p.startsWith('*.')) return false; // wildcard only as a leading label
    const rest = p.slice(2);
    if (rest.includes('*')) return false; // exactly one wildcard
    const labels = rest.split('.');
    if (labels.length < 2) return false; // require *.domain.tld, reject *.com
    return labels.every((l) => DNS_LABEL.test(l));
  }

  return p.split('.').every((l) => DNS_LABEL.test(l));
}

// ─── Leg A: Claude Code settings.json `sandbox` block ──────────────────

/** One credential file entry as Claude Code writes it. `deny` is the only
 *  supported mode today; the explicit field keeps the schema forward-compatible. */
export interface ClaudeCodeCredentialFile {
  path: string;
  mode: 'deny';
}

/** One credential env-var entry as Claude Code writes it. */
export interface ClaudeCodeCredentialEnv {
  name: string;
  mode: 'deny';
}

/**
 * The literal shape of `settings.json#/sandbox` that Claude Code reads. Keys
 * verified against the Claude Code sandboxing docs. Optional keys are omitted
 * (not nulled) when the policy doesn't set them.
 */
export interface ClaudeCodeSandboxBlock {
  enabled: boolean;
  network: { allowedDomains: string[]; deniedDomains: string[] };
  filesystem: {
    allowWrite: string[];
    denyWrite: string[];
    denyRead: string[];
    allowRead: string[];
  };
  credentials: {
    files: ClaudeCodeCredentialFile[];
    envVars: ClaudeCodeCredentialEnv[];
  };
  failIfUnavailable?: boolean;
  allowUnsandboxedCommands?: boolean;
  excludedCommands?: string[];
  allowAppleEvents?: boolean;
}

/**
 * Project the canonical policy onto Claude Code's `sandbox` settings block.
 * Pure structural transform — the caller (the Leg A sync engine) decides
 * whether to write the block at all based on `enabled`/`syncToClaudeCode`.
 */
export function toClaudeCodeSandboxBlock(policy: IsolationPolicy): ClaudeCodeSandboxBlock {
  const block: ClaudeCodeSandboxBlock = {
    enabled: policy.enabled,
    network: {
      allowedDomains: [...policy.network.allowedDomains],
      deniedDomains: [...policy.network.deniedDomains],
    },
    filesystem: {
      allowWrite: [...policy.filesystem.allowWrite],
      denyWrite: [...policy.filesystem.denyWrite],
      denyRead: [...policy.filesystem.denyRead],
      allowRead: [...policy.filesystem.allowRead],
    },
    credentials: {
      files: policy.credentials.files.map((path) => ({ path, mode: 'deny' as const })),
      envVars: policy.credentials.envVars.map((name) => ({ name, mode: 'deny' as const })),
    },
  };

  const cc = policy.claudeCode;
  if (cc) {
    if (cc.failIfUnavailable !== undefined) block.failIfUnavailable = cc.failIfUnavailable;
    if (cc.allowUnsandboxedCommands !== undefined) {
      block.allowUnsandboxedCommands = cc.allowUnsandboxedCommands;
    }
    if (cc.excludedCommands !== undefined) block.excludedCommands = [...cc.excludedCommands];
    if (cc.allowAppleEvents !== undefined) block.allowAppleEvents = cc.allowAppleEvents;
  }

  return block;
}

/**
 * The canonical *content* parsed back out of a `settings.json#/sandbox` block
 * during a pull (Leg A, file → Sentinel). Deliberately excludes the three
 * Sentinel-only control flags (`syncToClaudeCode`, `enforceCodeMode`, and the
 * master `enabled`): those live only in Sentinel and must not be driven by a
 * hand-edit to Claude Code's file, so the pull merges only content. The
 * sandbox's own `enabled` is surfaced separately as {@link claudeCodeEnabled}
 * for status/diagnostics without touching Sentinel's master switch.
 */
export interface ParsedSandboxContent {
  /** The file's `sandbox.enabled` value, for reference only — NOT merged into
   *  the policy's master switch. */
  claudeCodeEnabled: boolean;
  network: { allowedDomains: string[]; deniedDomains: string[] };
  filesystem: {
    allowWrite: string[];
    denyWrite: string[];
    denyRead: string[];
    allowRead: string[];
  };
  credentials: { files: string[]; envVars: string[] };
  /** Present only when the file carries at least one recognized passthrough key. */
  claudeCode?: NonNullable<IsolationPolicy['claudeCode']>;
}

/** Keep only non-empty trimmed strings from an arbitrary array value. */
function cleanStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t !== '') out.push(t);
    }
  }
  return out;
}

/** Pull credential entries (objects `{path}` / `{name}`, or bare strings) into
 *  the canonical flat string list, dropping malformed entries. */
function cleanCredentialEntries(raw: unknown, key: 'path' | 'name'): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    let s: unknown;
    if (typeof v === 'string') s = v;
    else if (v && typeof v === 'object') s = (v as Record<string, unknown>)[key];
    if (typeof s === 'string') {
      const t = s.trim();
      if (t !== '') out.push(t);
    }
  }
  return out;
}

/**
 * Parse a raw `settings.json#/sandbox` block (untrusted JSON) into canonical
 * content. Defensive: filters invalid domains with {@link isValidSandboxDomain},
 * trims strings, tolerates both object and bare-string credential entries, and
 * never throws — a missing or malformed block yields empty content.
 */
export function fromClaudeCodeSandboxBlock(raw: unknown): ParsedSandboxContent {
  const content: ParsedSandboxContent = {
    claudeCodeEnabled: false,
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
    credentials: { files: [], envVars: [] },
  };
  if (!raw || typeof raw !== 'object') return content;
  const o = raw as Record<string, unknown>;

  if (typeof o['enabled'] === 'boolean') content.claudeCodeEnabled = o['enabled'];

  const net = o['network'];
  if (net && typeof net === 'object') {
    const n = net as Record<string, unknown>;
    content.network.allowedDomains = cleanStringArray(n['allowedDomains']).filter(
      isValidSandboxDomain,
    );
    content.network.deniedDomains = cleanStringArray(n['deniedDomains']).filter(
      isValidSandboxDomain,
    );
  }

  const fs = o['filesystem'];
  if (fs && typeof fs === 'object') {
    const f = fs as Record<string, unknown>;
    content.filesystem.allowWrite = cleanStringArray(f['allowWrite']);
    content.filesystem.denyWrite = cleanStringArray(f['denyWrite']);
    content.filesystem.denyRead = cleanStringArray(f['denyRead']);
    content.filesystem.allowRead = cleanStringArray(f['allowRead']);
  }

  const cred = o['credentials'];
  if (cred && typeof cred === 'object') {
    const c = cred as Record<string, unknown>;
    content.credentials.files = cleanCredentialEntries(c['files'], 'path');
    content.credentials.envVars = cleanCredentialEntries(c['envVars'], 'name');
  }

  const passthrough: NonNullable<IsolationPolicy['claudeCode']> = {};
  if (typeof o['failIfUnavailable'] === 'boolean')
    passthrough.failIfUnavailable = o['failIfUnavailable'];
  if (typeof o['allowUnsandboxedCommands'] === 'boolean') {
    passthrough.allowUnsandboxedCommands = o['allowUnsandboxedCommands'];
  }
  if (Array.isArray(o['excludedCommands'])) {
    passthrough.excludedCommands = cleanStringArray(o['excludedCommands']);
  }
  if (typeof o['allowAppleEvents'] === 'boolean')
    passthrough.allowAppleEvents = o['allowAppleEvents'];
  if (Object.keys(passthrough).length > 0) content.claudeCode = passthrough;

  return content;
}

/** Union two string lists, preserving order (existing entries first, then new
 *  ones not already present). Stable and dedup-safe. */
function unionList(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const x of incoming) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/**
 * Reduce a pulled file block into the canonical policy during Leg A sync.
 *
 * The three control flags (`enabled`, `syncToClaudeCode`, `enforceCodeMode`)
 * are Sentinel-owned and ALWAYS preserved from `current` — a hand-edit to the
 * file never flips Sentinel's master switch or leg toggles. Only content is
 * reconciled:
 *
 *  - **`import`** (file wins): replace content with the file's. Safe in steady
 *    state because Sentinel always pushes a *complete* block, so the file is
 *    the full picture; external add/remove edits propagate exactly.
 *  - **`merge`** (union): combine file + policy content so neither side loses
 *    entries. This is the safe first-enable default — it can't wipe content the
 *    user configured in Sentinel before turning sync on.
 */
export function applyPulledSandboxContent(
  current: IsolationPolicy,
  parsed: ParsedSandboxContent,
  mode: 'merge' | 'import',
): IsolationPolicy {
  const next: IsolationPolicy = {
    enabled: current.enabled,
    syncToClaudeCode: current.syncToClaudeCode,
    enforceCodeMode: current.enforceCodeMode,
    network:
      mode === 'import'
        ? {
            allowedDomains: [...parsed.network.allowedDomains],
            deniedDomains: [...parsed.network.deniedDomains],
          }
        : {
            allowedDomains: unionList(
              current.network.allowedDomains,
              parsed.network.allowedDomains,
            ),
            deniedDomains: unionList(current.network.deniedDomains, parsed.network.deniedDomains),
          },
    filesystem:
      mode === 'import'
        ? {
            allowWrite: [...parsed.filesystem.allowWrite],
            denyWrite: [...parsed.filesystem.denyWrite],
            denyRead: [...parsed.filesystem.denyRead],
            allowRead: [...parsed.filesystem.allowRead],
          }
        : {
            allowWrite: unionList(current.filesystem.allowWrite, parsed.filesystem.allowWrite),
            denyWrite: unionList(current.filesystem.denyWrite, parsed.filesystem.denyWrite),
            denyRead: unionList(current.filesystem.denyRead, parsed.filesystem.denyRead),
            allowRead: unionList(current.filesystem.allowRead, parsed.filesystem.allowRead),
          },
    credentials:
      mode === 'import'
        ? { files: [...parsed.credentials.files], envVars: [...parsed.credentials.envVars] }
        : {
            files: unionList(current.credentials.files, parsed.credentials.files),
            envVars: unionList(current.credentials.envVars, parsed.credentials.envVars),
          },
  };

  // Passthrough: file wins per-key when present. In import mode the file is
  // authoritative, so the parsed passthrough (or its absence) replaces current.
  // In merge mode we layer the file's keys over the existing ones.
  if (mode === 'import') {
    if (parsed.claudeCode) next.claudeCode = { ...parsed.claudeCode };
  } else {
    const combined = { ...current.claudeCode, ...parsed.claudeCode };
    if (Object.keys(combined).length > 0) next.claudeCode = combined;
  }

  return next;
}

// ─── Leg B: @anthropic-ai/sandbox-runtime config ───────────────────────

/** Resolved absolute paths to the host/bundled sandbox helper binaries,
 *  injected by the daemon at runtime (Phase 2/3). All optional — the package
 *  falls back to PATH lookup for any omitted entry. */
export interface SandboxPlatformPaths {
  bwrapPath?: string;
  socatPath?: string;
  seccompApplyPath?: string;
  ripgrepCommand?: string;
}

/**
 * Local structural mirror of the subset of `@anthropic-ai/sandbox-runtime`'s
 * `SandboxRuntimeConfig` that Sentinel produces. Phase 2 replaces the return
 * annotation of {@link toSandboxRuntimeConfig} with the package's real type so
 * the compiler verifies this stays assignable.
 */
export interface SandboxRuntimeConfigLike {
  network: { allowedDomains: string[]; deniedDomains: string[] };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  credentials?: {
    files: ClaudeCodeCredentialFile[];
    envVars: ClaudeCodeCredentialEnv[];
  };
  bwrapPath?: string;
  socatPath?: string;
  seccomp?: { applyPath: string };
  ripgrep?: { command: string };
}

/**
 * Project the canonical policy onto the package's runtime config. Shares the
 * network/filesystem/credentials core with Leg A but drops the Claude-Code-only
 * passthrough and injects the resolved platform helper-binary paths. The
 * `enabled`/`enforceCodeMode` gating is the caller's concern — by the time this
 * runs, the daemon has already decided to sandbox.
 */
export function toSandboxRuntimeConfig(
  policy: IsolationPolicy,
  platformPaths: SandboxPlatformPaths = {},
): SandboxRuntimeConfigLike {
  const config: SandboxRuntimeConfigLike = {
    network: {
      allowedDomains: [...policy.network.allowedDomains],
      deniedDomains: [...policy.network.deniedDomains],
    },
    filesystem: {
      denyRead: [...policy.filesystem.denyRead],
      allowRead: [...policy.filesystem.allowRead],
      allowWrite: [...policy.filesystem.allowWrite],
      denyWrite: [...policy.filesystem.denyWrite],
    },
  };

  if (policy.credentials.files.length > 0 || policy.credentials.envVars.length > 0) {
    config.credentials = {
      files: policy.credentials.files.map((path) => ({ path, mode: 'deny' as const })),
      envVars: policy.credentials.envVars.map((name) => ({ name, mode: 'deny' as const })),
    };
  }

  if (platformPaths.bwrapPath !== undefined) config.bwrapPath = platformPaths.bwrapPath;
  if (platformPaths.socatPath !== undefined) config.socatPath = platformPaths.socatPath;
  if (platformPaths.seccompApplyPath !== undefined) {
    config.seccomp = { applyPath: platformPaths.seccompApplyPath };
  }
  if (platformPaths.ripgrepCommand !== undefined) {
    config.ripgrep = { command: platformPaths.ripgrepCommand };
  }

  return config;
}
