/**
 * opencode provider-config management — the opencode analog of
 * `claude-desktop-config.ts`.
 *
 * opencode reads neither `~/.claude/settings.json` nor `ANTHROPIC_BASE_URL`.
 * Its Anthropic provider is pointed by a single config key:
 *
 *   provider.anthropic.options.baseURL
 *
 * in the global config at `$XDG_CONFIG_HOME/opencode/opencode.json` (or
 * `.jsonc`, or wherever `$OPENCODE_CONFIG` points).
 *
 * Three things make this different from the Claude surfaces:
 *
 * 1. **The `/v1` suffix is required.** opencode's Anthropic provider is the
 *    Vercel AI SDK, which POSTs to `${baseURL}/messages`. A base URL without
 *    `/v1` produces `/messages`, which the proxy forwards verbatim and Anthropic
 *    404s. Sentinel's own `SENTINEL_BASE_URL` deliberately has no suffix (the
 *    desktop app appends `/v1/messages` itself), so this module appends it.
 *
 * 2. **BYOK, not pooling.** Requests carry the user's own `x-api-key` and the
 *    proxy leaves that credential alone (see `isByokRequest` in proxy.ts).
 *    Sentinel is an observability and guardrail layer here, not a credential
 *    broker — pooled subscription tokens are only ever handed to clients that
 *    already identify as Claude Code.
 *
 * 3. **A plugin can silently win.** `opencode-with-claude` overwrites
 *    `provider.anthropic.options.baseURL` in its `config` hook at startup,
 *    pointing it at a local Meridian proxy. The file Sentinel writes is then
 *    dead config. That is detectable (the plugin is named in `plugin[]`), so we
 *    report `plugin-override` rather than showing a green "routed" state that
 *    is not true.
 *
 * Writes are atomic (temp + rename) and read-modify-write against a fresh read,
 * preserving every other key in the file.
 *
 * ## The JSONC problem
 *
 * opencode accepts JSON *and* JSONC. `JSON.stringify` cannot round-trip
 * comments, so rewriting a commented file would silently delete the user's
 * annotations. Rather than trust the extension — `.jsonc` files frequently
 * contain no comments at all — {@link hasJsonComments} scans the actual bytes.
 * A file with real comments is left untouched and reported as `unwritable`
 * with a snippet for the user to paste.
 */

import { promises as fs, existsSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { OpencodeConfigDetails, OpencodeConfigState } from '@sentinel/shared';
import { SENTINEL_BASE_URL, isSentinelEndpoint } from './claude-otel-config.js';

/** Base URL Sentinel writes for opencode. The `/v1` is load-bearing — see the
 *  module comment. */
export const OPENCODE_BASE_URL = `${SENTINEL_BASE_URL}/v1`;

/** Plugin names known to rewrite `provider.anthropic.options.baseURL` at
 *  runtime. Matched as a substring of each `plugin[]` entry so version-pinned
 *  (`opencode-with-claude@1.8.0`) and scoped forms both hit. */
const BASE_URL_OVERRIDING_PLUGINS: readonly string[] = ['opencode-with-claude'];

function resolveHome(): string {
  return process.env.SENTINEL_TEST_HOME ?? homedir();
}

/** opencode's global config directory. */
export function opencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(resolveHome(), '.config');
  return join(base, 'opencode');
}

/**
 * The config file Sentinel reads and writes: `$OPENCODE_CONFIG` when set, else
 * an existing `opencode.jsonc`, else `opencode.json` (the path used when
 * creating one from scratch).
 */
export function opencodeConfigPath(): string {
  const explicit = process.env.OPENCODE_CONFIG?.trim();
  if (explicit) return explicit;
  const dir = opencodeConfigDir();
  const jsonc = join(dir, 'opencode.jsonc');
  if (existsSync(jsonc)) return jsonc;
  return join(dir, 'opencode.json');
}

/**
 * True when `text` contains a real JSON comment — `//` or block form — outside
 * of a string literal. Hand-rolled rather than regex-based because the naive
 * pattern fires on every `"http://…"` in the file, which would make the common
 * case (a URL-bearing config) permanently unwritable.
 */
export function hasJsonComments(text: string): boolean {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) return true;
  }
  return false;
}

/** Strip comments so a JSONC file can be parsed. Only called after
 *  {@link hasJsonComments}; kept separate so reads tolerate comments even
 *  though writes refuse them. */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

interface OpencodeConfig {
  provider?: Record<string, { options?: Record<string, unknown> } & Record<string, unknown>>;
  plugin?: unknown;
  [k: string]: unknown;
}

/** Parse the config at `path`. Returns an empty object when the file is absent
 *  and null when it exists but cannot be parsed (malformed — never clobber it). */
function readConfig(path: string): { config: OpencodeConfig | null; raw: string | null } {
  if (!existsSync(path)) return { config: {}, raw: null };
  const raw = readFileSync(path, 'utf8');
  try {
    return { config: JSON.parse(stripJsonComments(raw)) as OpencodeConfig, raw };
  } catch {
    return { config: null, raw };
  }
}

/** `plugin[]` entries that rewrite the base URL at runtime. */
function findOverridingPlugins(config: OpencodeConfig): string[] {
  const plugins = config.plugin;
  if (!Array.isArray(plugins)) return [];
  return plugins
    .filter((p): p is string => typeof p === 'string')
    .filter((p) => BASE_URL_OVERRIDING_PLUGINS.some((known) => p.includes(known)));
}

function readBaseUrl(config: OpencodeConfig): string | null {
  const options = config.provider?.['anthropic']?.options;
  const url = options?.['baseURL'];
  return typeof url === 'string' && url.length > 0 ? url : null;
}

/**
 * True when `url` points at Sentinel **and** carries the `/v1` path.
 *
 * `isSentinelEndpoint` matches on protocol, host, and port only — by design,
 * since the desktop gateway appends its own path. Reusing it alone here reports
 * a bare `http://127.0.0.1:47284` as routed, but the AI SDK appends `/messages`
 * to it and Anthropic 404s the resulting `/messages`. That state has to read as
 * not-yet-routed so the card offers Enable and the write repairs the URL —
 * anything else is a green light on a config that cannot work.
 */
function isRoutedBaseUrl(url: string | null): boolean {
  if (!isSentinelEndpoint(url)) return false;
  try {
    return new URL(url as string).pathname.replace(/\/+$/, '') === '/v1';
  } catch {
    /* v8 ignore next 2 -- isSentinelEndpoint already parsed this URL */
    return false;
  }
}

/** The block a user pastes when Sentinel cannot write the file itself. */
export function manualConfigSnippet(): string {
  return JSON.stringify(
    { provider: { anthropic: { options: { baseURL: OPENCODE_BASE_URL } } } },
    null,
    2,
  );
}

/** Classify a parsed config. Pure — the branch table is unit-tested directly
 *  rather than through the filesystem. */
export function classifyOpencodeConfig(
  config: OpencodeConfig | null,
  raw: string | null,
): { state: OpencodeConfigState; baseUrl: string | null; overridingPlugins: string[] } {
  // Unparseable: treat as unwritable so we surface a snippet instead of
  // overwriting something we do not understand.
  if (!config) return { state: 'unwritable', baseUrl: null, overridingPlugins: [] };

  const baseUrl = readBaseUrl(config);
  const overridingPlugins = findOverridingPlugins(config);
  const routed = isRoutedBaseUrl(baseUrl);

  // A plugin override outranks everything: whatever the file says, it is not
  // what opencode will use.
  if (overridingPlugins.length > 0) return { state: 'plugin-override', baseUrl, overridingPlugins };
  if (raw !== null && hasJsonComments(raw)) {
    // Comments we cannot preserve. Already-routed still reads as active —
    // there is nothing to write, so nothing to warn about.
    return {
      state: routed ? 'active' : 'unwritable',
      baseUrl,
      overridingPlugins,
    };
  }
  if (routed) return { state: 'active', baseUrl, overridingPlugins };
  if (baseUrl !== null) return { state: 'foreign-base-url', baseUrl, overridingPlugins };
  return { state: 'inactive', baseUrl, overridingPlugins };
}

/** Current state of opencode's provider config. Never throws. */
export function inspectOpencodeConfig(): OpencodeConfigDetails {
  const configPath = opencodeConfigPath();
  let parsed: { config: OpencodeConfig | null; raw: string | null };
  try {
    parsed = readConfig(configPath);
  } catch {
    /* v8 ignore next 2 -- unreadable-but-present file needs fs fault injection */
    parsed = { config: null, raw: null };
  }
  const { state, baseUrl, overridingPlugins } = classifyOpencodeConfig(parsed.config, parsed.raw);
  return {
    state,
    configPath,
    baseUrl,
    overridingPlugins,
    manualSnippet: state === 'unwritable' ? manualConfigSnippet() : null,
  };
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, path);
}

/**
 * Point opencode's Anthropic provider at Sentinel, preserving every other key.
 * Refuses (returning the `unwritable` inspection unchanged) when the file
 * carries comments or cannot be parsed.
 */
export async function activateOpencode(): Promise<OpencodeConfigDetails> {
  const configPath = opencodeConfigPath();
  const { config, raw } = readConfig(configPath);
  if (!config || (raw !== null && hasJsonComments(raw))) return inspectOpencodeConfig();

  const provider = { ...(config.provider ?? {}) };
  const anthropic = { ...(provider['anthropic'] ?? {}) };
  anthropic.options = { ...(anthropic.options ?? {}), baseURL: OPENCODE_BASE_URL };
  provider['anthropic'] = anthropic;

  await writeFileAtomic(configPath, `${JSON.stringify({ ...config, provider }, null, 2)}\n`);
  return inspectOpencodeConfig();
}

/**
 * Remove Sentinel's base URL, leaving a foreign one alone. Prunes the objects
 * it emptied so deactivation restores the file to its prior shape rather than
 * leaving `{"provider":{"anthropic":{"options":{}}}}` behind.
 */
export async function deactivateOpencode(): Promise<OpencodeConfigDetails> {
  const configPath = opencodeConfigPath();
  const { config, raw } = readConfig(configPath);
  if (!config || raw === null || hasJsonComments(raw)) return inspectOpencodeConfig();
  // Deactivation still keys on host+port so a Sentinel URL missing `/v1`
  // (written by hand, or by an older Sentinel) is ours to clean up.
  if (!isSentinelEndpoint(readBaseUrl(config))) return inspectOpencodeConfig();

  const provider = { ...(config.provider ?? {}) };
  const anthropic = { ...(provider['anthropic'] ?? {}) };
  const options = { ...(anthropic.options ?? {}) };
  delete options['baseURL'];

  if (Object.keys(options).length > 0) anthropic.options = options;
  else delete anthropic.options;

  if (Object.keys(anthropic).length > 0) provider['anthropic'] = anthropic;
  else delete provider['anthropic'];

  const next: OpencodeConfig = { ...config };
  if (Object.keys(provider).length > 0) next.provider = provider;
  else delete next.provider;

  await writeFileAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return inspectOpencodeConfig();
}

/** Filesystem markers indicating opencode is installed. Pure + parameterized so
 *  the non-macOS branches stay table-testable, matching
 *  `resolveDesktopInstallMarkers`. */
export function resolveOpencodeInstallMarkers(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  const xdg = env.XDG_CONFIG_HOME;
  const configBase = xdg && xdg.length > 0 ? xdg : join(home, '.config');
  const markers = [join(configBase, 'opencode'), join(home, '.opencode')];
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) markers.push(join(localAppData, 'opencode'));
    return markers;
  }
  const xdgData = env.XDG_DATA_HOME;
  const dataBase = xdgData && xdgData.length > 0 ? xdgData : join(home, '.local', 'share');
  markers.push(join(dataBase, 'opencode'));
  return markers;
}
