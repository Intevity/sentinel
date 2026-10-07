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
 * Four things make this different from the Claude surfaces:
 *
 * 1. **The `/v1` suffix is required.** opencode's Anthropic provider is the
 *    Vercel AI SDK, which POSTs to `${baseURL}/messages`. A base URL without
 *    `/v1` produces `/messages`, which the proxy forwards verbatim and Anthropic
 *    404s. Sentinel's own `SENTINEL_BASE_URL` deliberately has no suffix (the
 *    desktop app appends `/v1/messages` itself), so this module appends it.
 *
 * 2. **Two credential paths.** With an API key, requests carry the user's own
 *    `x-api-key` and the proxy leaves that credential alone (see
 *    `isByokRequest` in proxy.ts). With the `opencode-claude-auth` plugin,
 *    requests present Claude Code's identity with the user's Claude OAuth
 *    token, and the proxy serves them from the account pool exactly as it does
 *    Claude Code. This module only points the base URL; which path a request
 *    takes is decided per request by the proxy.
 *
 * 3. **A plugin can silently win.** `opencode-with-claude` overwrites
 *    `provider.anthropic.options.baseURL` in its `config` hook at startup,
 *    pointing it at a local Meridian proxy. The file Sentinel writes is then
 *    dead config. That is detectable (the plugin is named in `plugin[]`), so we
 *    report `plugin-override` rather than showing a green "routed" state that
 *    is not true.
 *
 * 4. **The user may already have a base URL.** A corporate gateway, say.
 *    Enable replaces it, so the replaced value is saved in Sentinel-owned state
 *    (`~/.sentinel/opencode-state.json`, keyed by config path) — never inside
 *    the opencode config, whose schema rejects unknown keys — and Disable puts
 *    it back.
 *
 * Writes are atomic (temp + rename), follow a symlinked config to its target,
 * keep the file mode, and are read-modify-write against a fresh read,
 * preserving every other key in the file.
 *
 * ## The JSONC problem
 *
 * opencode accepts JSON *and* JSONC. `JSON.stringify` cannot round-trip
 * comments, so rewriting a commented file would silently delete the user's
 * annotations. Rather than trust the extension — `.jsonc` files frequently
 * contain no comments at all — {@link hasJsonComments} scans the actual bytes.
 * A file with real comments is left untouched and reported as `unwritable`
 * with a snippet for the user to paste. Trailing commas, the other JSONC
 * extension, carry no user content, so they are tolerated on read and simply
 * not reproduced on write.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type {
  OpencodeConfigDetails,
  OpencodeConfigState,
  OpencodeUnwritableReason,
} from '@sentinel/shared';
import { DAEMON_PORT, getDaemonPort } from './proxy.js';
import { writeFileAtomicPreserving } from './fs-atomic.js';

/** Base URL Sentinel writes for opencode: the loopback address on the port the
 *  daemon's proxy actually listens on, plus the load-bearing `/v1` (see the
 *  module comment). A function, not a constant, so it tracks
 *  `SENTINEL_TEST_DAEMON_PORT` the way every other daemon URL does. */
export function opencodeBaseUrl(): string {
  return `http://127.0.0.1:${getDaemonPort()}/v1`;
}

/** Plugin names known to rewrite `provider.anthropic.options.baseURL` at
 *  runtime. Matched as a substring of each `plugin[]` entry so version-pinned
 *  (`opencode-with-claude@1.8.0`) and scoped forms both hit. */
const BASE_URL_OVERRIDING_PLUGINS: readonly string[] = ['opencode-with-claude'];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

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
 *
 * Note that this is resolved in the *daemon's* environment, which the GUI app
 * launches — a variable exported only from a shell rc file is not in it. The
 * card always shows this path so a mismatch is visible.
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

/**
 * Reduce JSONC to JSON: drop comments, and drop a comma whose next significant
 * character closes an object or array (a trailing comma). String-aware, so a
 * `//` or `,}` inside a value is left alone. Kept separate from
 * {@link hasJsonComments} so reads tolerate comments even though writes refuse
 * them.
 */
export function jsoncToJson(text: string): string {
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
    if (ch === ',' && closesAfter(text, i + 1)) continue;
    out += ch;
  }
  return out;
}

/** Whether the next significant character from `start` (skipping whitespace
 *  and comments) is `}` or `]`. */
function closesAfter(text: string, start: number): boolean {
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      return ch === '}' || ch === ']';
    }
  }
  return false;
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
    const parsed = JSON.parse(jsoncToJson(raw)) as unknown;
    // A bare string or array is valid JSON but not a config we can edit.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { config: null, raw };
    }
    return { config: parsed as OpencodeConfig, raw };
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

/** Parse `url` as an http loopback URL, or null. */
function parseLoopback(url: string | null): URL | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname.toLowerCase()) ? u : null;
  } catch {
    return null;
  }
}

/**
 * True when `url` is one Sentinel wrote (or would have): http loopback on the
 * daemon's actual port, or on the default port an older Sentinel always used.
 * Path-agnostic — this is the ownership test for Disable, so a hand-written
 * URL missing `/v1` is still ours to clean up.
 */
function isSentinelOrigin(url: string | null): boolean {
  const u = parseLoopback(url);
  if (!u) return false;
  const port = Number(u.port);
  return port === getDaemonPort() || port === DAEMON_PORT;
}

/**
 * True when `url` routes opencode through *this* daemon: loopback, the port the
 * proxy actually listens on, **and** the `/v1` path.
 *
 * Origin alone is not enough: a bare `http://127.0.0.1:47284` gets `/messages`
 * appended by the AI SDK and Anthropic 404s it. That state has to read as
 * not-yet-routed so the card offers Enable and the write repairs the URL —
 * anything else is a green light on a config that cannot work.
 */
function isRoutedBaseUrl(url: string | null): boolean {
  const u = parseLoopback(url);
  if (!u || Number(u.port) !== getDaemonPort()) return false;
  return u.pathname.replace(/\/+$/, '') === '/v1';
}

/** The block a user pastes when Sentinel cannot write the file itself. */
export function manualConfigSnippet(): string {
  return JSON.stringify(
    { provider: { anthropic: { options: { baseURL: opencodeBaseUrl() } } } },
    null,
    2,
  );
}

/** Classify a parsed config. Pure — the branch table is unit-tested directly
 *  rather than through the filesystem. */
export function classifyOpencodeConfig(
  config: OpencodeConfig | null,
  raw: string | null,
): {
  state: OpencodeConfigState;
  baseUrl: string | null;
  overridingPlugins: string[];
  unwritableReason: OpencodeUnwritableReason | null;
} {
  // Unparseable: treat as unwritable so we surface a snippet instead of
  // overwriting something we do not understand.
  if (!config) {
    return {
      state: 'unwritable',
      baseUrl: null,
      overridingPlugins: [],
      unwritableReason: 'unparseable',
    };
  }

  const baseUrl = readBaseUrl(config);
  const overridingPlugins = findOverridingPlugins(config);
  const routed = isRoutedBaseUrl(baseUrl);
  const base = { baseUrl, overridingPlugins, unwritableReason: null };

  // A plugin override outranks everything: whatever the file says, it is not
  // what opencode will use.
  if (overridingPlugins.length > 0) return { ...base, state: 'plugin-override' };
  if (raw !== null && hasJsonComments(raw)) {
    // Comments we cannot preserve. Already-routed still reads as active —
    // there is nothing to write, so nothing to warn about.
    return routed
      ? { ...base, state: 'active' }
      : { ...base, state: 'unwritable', unwritableReason: 'comments' };
  }
  if (routed) return { ...base, state: 'active' };
  if (baseUrl !== null) return { ...base, state: 'foreign-base-url' };
  return { ...base, state: 'inactive' };
}

// ---------------------------------------------------------------------------
// Saved base URLs (Sentinel-owned state)
// ---------------------------------------------------------------------------

/** Where Sentinel remembers the base URL each config had before Enable. Keyed
 *  by config path so a different `$OPENCODE_CONFIG` never inherits another
 *  file's value. */
export function opencodeStatePath(): string {
  return join(resolveHome(), '.sentinel', 'opencode-state.json');
}

interface OpencodeState {
  previousBaseUrls: Record<string, string>;
}

/** Read the saved state. A missing or corrupt file reads as empty: losing a
 *  saved URL degrades Disable to "remove ours", it never blocks it. */
function readState(): OpencodeState {
  try {
    const parsed = JSON.parse(readFileSync(opencodeStatePath(), 'utf8')) as {
      previousBaseUrls?: unknown;
    };
    const urls = parsed.previousBaseUrls;
    if (typeof urls !== 'object' || urls === null || Array.isArray(urls)) {
      return { previousBaseUrls: {} };
    }
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(urls)) if (typeof v === 'string') clean[k] = v;
    return { previousBaseUrls: clean };
  } catch {
    return { previousBaseUrls: {} };
  }
}

async function writeState(state: OpencodeState): Promise<void> {
  await writeFileAtomicPreserving(opencodeStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

/** The base URL saved for `configPath`, or null. */
export function savedPreviousBaseUrl(configPath: string): string | null {
  return readState().previousBaseUrls[configPath] ?? null;
}

async function setSavedPreviousBaseUrl(configPath: string, url: string | null): Promise<void> {
  const state = readState();
  if (url === null) {
    if (!(configPath in state.previousBaseUrls)) return;
    delete state.previousBaseUrls[configPath];
  } else {
    if (state.previousBaseUrls[configPath] === url) return;
    state.previousBaseUrls[configPath] = url;
  }
  await writeState(state);
}

// ---------------------------------------------------------------------------
// Inspect / activate / deactivate
// ---------------------------------------------------------------------------

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
  const { state, baseUrl, overridingPlugins, unwritableReason } = classifyOpencodeConfig(
    parsed.config,
    parsed.raw,
  );
  const previous = savedPreviousBaseUrl(configPath);
  return {
    state,
    configPath,
    baseUrl,
    overridingPlugins,
    manualSnippet: state === 'unwritable' ? manualConfigSnippet() : null,
    unwritableReason,
    // Only meaningful while the file still points at Sentinel; a stale entry
    // for a config the user since repointed is not something Disable restores.
    previousBaseUrl: isSentinelOrigin(baseUrl) ? previous : null,
  };
}

function withBaseUrl(config: OpencodeConfig, url: string | null): OpencodeConfig {
  const provider = { ...(config.provider ?? {}) };
  const anthropic = { ...(provider['anthropic'] ?? {}) };
  const options = { ...(anthropic.options ?? {}) };
  if (url === null) delete options['baseURL'];
  else options['baseURL'] = url;

  // Prune the objects a removal emptied so Disable restores the file to its
  // prior shape rather than leaving `{"provider":{"anthropic":{"options":{}}}}`.
  if (Object.keys(options).length > 0) anthropic.options = options;
  else delete anthropic.options;

  if (Object.keys(anthropic).length > 0) provider['anthropic'] = anthropic;
  else delete provider['anthropic'];

  const next: OpencodeConfig = { ...config };
  if (Object.keys(provider).length > 0) next.provider = provider;
  else delete next.provider;
  return next;
}

/** True when the file must not be rewritten: unparseable, or real comments. */
function refusesWrite(config: OpencodeConfig | null, raw: string | null): boolean {
  return !config || (raw !== null && hasJsonComments(raw));
}

/**
 * Point opencode's Anthropic provider at Sentinel, preserving every other key.
 * A base URL of the user's own that this replaces is saved first, so
 * {@link deactivateOpencode} can put it back. Refuses (returning the
 * `unwritable` inspection unchanged) when the file carries comments or cannot
 * be parsed.
 */
export async function activateOpencode(): Promise<OpencodeConfigDetails> {
  const configPath = opencodeConfigPath();
  const { config, raw } = readConfig(configPath);
  if (refusesWrite(config, raw)) return inspectOpencodeConfig();

  const current = readBaseUrl(config as OpencodeConfig);
  // Save before writing: a crash between the two leaves an extra saved URL
  // (harmless), never a replaced URL with no copy.
  if (current === null) {
    // Nothing to restore; drop any stale entry so Disable cannot resurrect a
    // URL the user removed by hand since the last Enable.
    await setSavedPreviousBaseUrl(configPath, null);
  } else if (!isSentinelOrigin(current)) {
    await setSavedPreviousBaseUrl(configPath, current);
  }
  // A Sentinel URL already in place (re-Enable, or repairing a missing `/v1`)
  // keeps whatever was saved when it was first written.

  await writeFileAtomicPreserving(
    configPath,
    `${JSON.stringify(withBaseUrl(config as OpencodeConfig, opencodeBaseUrl()), null, 2)}\n`,
  );
  return inspectOpencodeConfig();
}

/**
 * Take Sentinel's base URL out: restore the user's own when Enable saved one,
 * else remove the key and prune what that emptied. A foreign base URL is left
 * alone — it is not ours to touch.
 */
export async function deactivateOpencode(): Promise<OpencodeConfigDetails> {
  const configPath = opencodeConfigPath();
  const { config, raw } = readConfig(configPath);
  if (raw === null || refusesWrite(config, raw)) return inspectOpencodeConfig();
  if (!isSentinelOrigin(readBaseUrl(config as OpencodeConfig))) return inspectOpencodeConfig();

  const previous = savedPreviousBaseUrl(configPath);
  await writeFileAtomicPreserving(
    configPath,
    `${JSON.stringify(withBaseUrl(config as OpencodeConfig, previous), null, 2)}\n`,
  );
  await setSavedPreviousBaseUrl(configPath, null);
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
