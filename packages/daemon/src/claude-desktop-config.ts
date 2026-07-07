/**
 * Claude **Desktop** app gateway-config management — the desktop analog of
 * `otel-settings-patch.ts` + `otel-settings-drift.ts`.
 *
 * The Claude Desktop app (Chat / Cowork / Code) routes ALL inference through a
 * custom gateway when a per-user "configLibrary" config is applied. Unlike the
 * CLI it does NOT read `~/.claude/settings.json` or env vars — it reads a
 * separate per-user directory:
 *
 *   macOS   ~/Library/Application Support/Claude-3p/configLibrary/
 *   Windows %LOCALAPPDATA%\Claude-3p\configLibrary\
 *   Linux   ~/.config/Claude-3p/configLibrary/
 *
 * Two native-JSON files:
 *   <uuid>.json  flat: { inferenceProvider, inferenceGatewayBaseUrl,
 *                        inferenceGatewayApiKey, inferenceGatewayAuthScheme }
 *   _meta.json   { appliedId, entries: [{ id, name }] }
 *
 * The app appends `/v1/messages` and `/v1/models` to `inferenceGatewayBaseUrl`,
 * so the base URL MUST NOT include `/v1` — `SENTINEL_BASE_URL` is exactly
 * right. The dummy api key is overwritten per `/v1/messages` request by the
 * proxy's `tokenProvider`, so desktop inherits pool rotation and the dummy
 * never reaches Anthropic.
 *
 * All writes are atomic (temp + rename with a random suffix) and read-modify-
 * write against a fresh read, so Sentinel and the app switching configs
 * in-app don't clobber each other. Sentinel owns exactly one entry, identified
 * by the id recorded in `settings.claudeDesktopConfigId` (fallback: entry name
 * === `Sentinel`); every other entry/field is preserved verbatim.
 */
import { promises as fs } from 'fs';
import { randomBytes, randomUUID, createHash } from 'crypto';
import { homedir } from 'os';
import { join, dirname } from 'path';
import type { ClaudeDesktopDriftDetails } from '@sentinel/shared';
import { SENTINEL_BASE_URL, isSentinelEndpoint } from './claude-otel-config.js';

/** Stable name Sentinel gives its configLibrary entry — the fallback key for
 *  recognizing our own entry when `settings.claudeDesktopConfigId` is unset
 *  (e.g. a config authored by an older Sentinel, or manual recovery). */
export const SENTINEL_DESKTOP_ENTRY_NAME = 'Sentinel';

/** Dummy bearer the desktop app sends to the local gateway. The proxy
 *  overwrites `Authorization` per `/v1/messages` request with the real
 *  rotating pool token, so this value never reaches Anthropic. Non-empty
 *  because the app requires a credential for a static-key gateway config. */
export const DESKTOP_GATEWAY_DUMMY_KEY = 'sentinel-local-proxy';

interface DesktopGatewayConfig {
  inferenceProvider: string;
  inferenceGatewayBaseUrl: string;
  inferenceGatewayApiKey: string;
  inferenceGatewayAuthScheme: string;
  [k: string]: unknown;
}

interface DesktopMetaEntry {
  id: string;
  name?: string;
  [k: string]: unknown;
}

interface DesktopMeta {
  appliedId: string;
  entries: DesktopMetaEntry[];
  [k: string]: unknown;
}

/** Pure resolver for the `Claude-3p` base dir (parent of `configLibrary`),
 *  mirroring the desktop app's own resolver. Exported and parameterized so
 *  the Windows/Linux branches — unreachable on the macOS CI runner — are
 *  still covered by table-style tests rather than `v8 ignore`. Windows →
 *  `%LOCALAPPDATA%\Claude-3p`; macOS → `~/Library/Application Support/Claude-3p`;
 *  Linux/other → `$XDG_CONFIG_HOME|~/.config` + `/Claude-3p`. */
export function resolveDesktopUserDataBase(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    return local && local.length > 0
      ? join(local, 'Claude-3p')
      : join(home, 'AppData', 'Local', 'Claude-3p');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Claude-3p');
  }
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(home, '.config'), 'Claude-3p');
}

/** configLibrary dir for the Claude Desktop app. Honors
 *  `SENTINEL_TEST_CLAUDE_DESKTOP_DIR` (which points at the configLibrary dir
 *  itself) for tests. */
export function desktopConfigLibraryDir(): string {
  const override = process.env.SENTINEL_TEST_CLAUDE_DESKTOP_DIR;
  if (override) return override;
  return join(
    resolveDesktopUserDataBase(process.platform, process.env, homedir()),
    'configLibrary',
  );
}

const metaPath = (): string => join(desktopConfigLibraryDir(), '_meta.json');
const configPath = (id: string): string => join(desktopConfigLibraryDir(), `${id}.json`);

async function readJson<T>(p: string): Promise<T | null> {
  let text: string;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
    return null;
  } catch {
    // Corrupt JSON: treat as absent; the caller re-applies to recover.
    return null;
  }
}

async function writeJsonAtomic(p: string, obj: unknown): Promise<void> {
  const json = `${JSON.stringify(obj, null, 2)}\n`;
  await fs.mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, json, 'utf8');
  await fs.rename(tmp, p);
}

function normalizeEntries(meta: DesktopMeta | null): DesktopMetaEntry[] {
  if (!meta || !Array.isArray(meta.entries)) return [];
  return meta.entries.filter(
    (e): e is DesktopMetaEntry => !!e && typeof e === 'object' && typeof e.id === 'string',
  );
}

/** Pure: classify a meta + applied-config pair into a drift snapshot.
 *  Exposed for table-style unit testing. */
export function classifyDesktopConfig(
  meta: DesktopMeta | null,
  applied: DesktopGatewayConfig | null,
): ClaudeDesktopDriftDetails {
  if (!meta) {
    return { state: 'not-installed', appliedId: null, appliedBaseUrl: null, appliedProvider: null };
  }
  const appliedId =
    typeof meta.appliedId === 'string' && meta.appliedId.length > 0 ? meta.appliedId : null;
  if (!appliedId || !applied) {
    return { state: 'inactive', appliedId, appliedBaseUrl: null, appliedProvider: null };
  }
  const provider = typeof applied.inferenceProvider === 'string' ? applied.inferenceProvider : null;
  const baseUrl =
    typeof applied.inferenceGatewayBaseUrl === 'string' ? applied.inferenceGatewayBaseUrl : null;
  if (provider === 'gateway' && isSentinelEndpoint(baseUrl)) {
    return { state: 'active', appliedId, appliedBaseUrl: baseUrl, appliedProvider: provider };
  }
  if (provider === 'gateway' && baseUrl) {
    return {
      state: 'foreign-gateway',
      appliedId,
      appliedBaseUrl: baseUrl,
      appliedProvider: provider,
    };
  }
  return { state: 'inactive', appliedId, appliedBaseUrl: baseUrl, appliedProvider: provider };
}

/** Read the desktop configLibrary and report whether Sentinel's gateway is
 *  the applied config. The only I/O in this module's read path. */
export async function inspectDesktopConfig(): Promise<ClaudeDesktopDriftDetails> {
  const meta = await readJson<DesktopMeta>(metaPath());
  let applied: DesktopGatewayConfig | null = null;
  const appliedId =
    meta && typeof meta.appliedId === 'string' && meta.appliedId.length > 0 ? meta.appliedId : null;
  if (appliedId) applied = await readJson<DesktopGatewayConfig>(configPath(appliedId));
  return classifyDesktopConfig(meta, applied);
}

/** Canonical hash of a drift snapshot — used by the watcher for
 *  echo-suppression of our own writes (mirrors `canonHashManagedEnv`). */
export function canonHashDesktopDrift(details: ClaudeDesktopDriftDetails): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        state: details.state,
        appliedId: details.appliedId,
        appliedBaseUrl: details.appliedBaseUrl,
        appliedProvider: details.appliedProvider,
      }),
    )
    .digest('hex');
}

export interface ActivateDesktopResult {
  details: ClaudeDesktopDriftDetails;
  /** The id of the entry Sentinel wrote — persist to
   *  `settings.claudeDesktopConfigId` so later update/remove targets it. */
  configId: string;
}

/** Write (or update) Sentinel's gateway config and set it as the applied
 *  config, preserving every other 3p entry/field. `existingId` is
 *  `settings.claudeDesktopConfigId` — reused when present so re-activation is
 *  idempotent; otherwise an existing `Sentinel`-named entry is reused, else a
 *  fresh uuid is minted. Read-modify-write against a fresh read; atomic. */
export async function activateDesktop(existingId: string | null): Promise<ActivateDesktopResult> {
  const meta = (await readJson<DesktopMeta>(metaPath())) ?? { appliedId: '', entries: [] };
  const entries = normalizeEntries(meta);

  let id = existingId && existingId.length > 0 ? existingId : null;
  if (!id) {
    const byName = entries.find((e) => e.name === SENTINEL_DESKTOP_ENTRY_NAME);
    id = byName ? byName.id : randomUUID();
  }

  const config: DesktopGatewayConfig = {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: SENTINEL_BASE_URL,
    inferenceGatewayApiKey: DESKTOP_GATEWAY_DUMMY_KEY,
    inferenceGatewayAuthScheme: 'bearer',
  };
  await writeJsonAtomic(configPath(id), config);

  const others = entries.filter((e) => e.id !== id);
  const nextMeta: DesktopMeta = {
    ...meta,
    appliedId: id,
    entries: [...others, { id, name: SENTINEL_DESKTOP_ENTRY_NAME }],
  };
  await writeJsonAtomic(metaPath(), nextMeta);

  return { details: classifyDesktopConfig(nextMeta, config), configId: id };
}

/** Remove Sentinel's entry (its `<id>.json` + meta entry), preserving every
 *  other 3p config. If `appliedId` pointed at us it is repointed to a
 *  remaining entry or cleared — never left dangling (the app's own resolver
 *  requires `appliedId` to be a valid id present in `entries`, or empty). */
export async function deactivateDesktop(ourId: string | null): Promise<ClaudeDesktopDriftDetails> {
  const meta = await readJson<DesktopMeta>(metaPath());
  if (!meta) {
    return { state: 'not-installed', appliedId: null, appliedBaseUrl: null, appliedProvider: null };
  }
  const entries = normalizeEntries(meta);

  const ours = new Set<string>();
  if (ourId && ourId.length > 0) ours.add(ourId);
  for (const e of entries) if (e.name === SENTINEL_DESKTOP_ENTRY_NAME) ours.add(e.id);

  const remaining = entries.filter((e) => !ours.has(e.id));
  for (const id of ours) {
    await fs.rm(configPath(id), { force: true }).catch(() => {});
  }

  let appliedId = typeof meta.appliedId === 'string' ? meta.appliedId : '';
  if (ours.has(appliedId)) {
    appliedId = remaining.length > 0 ? (remaining[0] as DesktopMetaEntry).id : '';
  }
  const nextMeta: DesktopMeta = { ...meta, appliedId, entries: remaining };
  await writeJsonAtomic(metaPath(), nextMeta);

  let applied: DesktopGatewayConfig | null = null;
  if (appliedId) applied = await readJson<DesktopGatewayConfig>(configPath(appliedId));
  return classifyDesktopConfig(nextMeta, applied);
}
