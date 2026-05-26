/**
 * Daemon-side rewrite of `~/.claude/settings.json` to restore Sentinel's
 * OTEL env block. TS twin of the Rust `activate_sentinel` Tauri command
 * (`packages/app/src-tauri/src/settings_patch.rs`) — same eight managed
 * keys, same atomic write semantics, but invoked over IPC from the
 * Metrics-tab "Re-patch" / "Promote" actions.
 *
 * The Rust path still owns first-run activation because the daemon
 * isn't guaranteed to be up at that point. This module owns recovery.
 *
 * Differences from the Rust path worth noting:
 *  - Uses random-suffix temp files to avoid races when Rust and TS both
 *    write the same file (e.g. user clicks Deactivate from the header
 *    menu while a daemon re-patch is in flight).
 *  - Strips `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` and
 *    `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` — per the OTEL spec these win
 *    over the base endpoint, so leaving them in place would silently
 *    route the relevant signal away from Sentinel even after re-patch.
 */
import { promises as fs } from 'fs';
import { randomBytes } from 'crypto';
import { dirname } from 'path';
import { SENTINEL_OTEL_ENV_VARS, OTEL_SIGNAL_ENDPOINT_KEYS } from './claude-otel-config.js';

/** Write Sentinel's eight managed OTEL env vars into `settingsPath`,
 *  preserving every other top-level key and every unrelated `env.*`
 *  entry. Strips the two signal-specific endpoint overrides so the
 *  base endpoint actually wins.
 *
 *  Atomic via `temp + rename`. The temp file uses a random suffix so
 *  parallel writers (Rust activate/deactivate vs daemon re-patch) can't
 *  collide on the same temp path.
 *
 *  Returns the parsed settings object that was written so the caller
 *  can compute the post-patch hash for echo-suppression. */
export async function repatchClaudeOtelSettings(
  settingsPath: string,
): Promise<Record<string, unknown>> {
  const current = await readSettingsObject(settingsPath);

  // Preserve all top-level keys; only mutate `env`.
  const envEntry = current['env'];
  const env: Record<string, unknown> =
    envEntry && typeof envEntry === 'object' && !Array.isArray(envEntry)
      ? { ...(envEntry as Record<string, unknown>) }
      : {};

  for (const [k, v] of Object.entries(SENTINEL_OTEL_ENV_VARS)) {
    env[k] = v;
  }
  for (const k of OTEL_SIGNAL_ENDPOINT_KEYS) {
    delete env[k];
  }

  current['env'] = env;

  await writeSettingsAtomic(settingsPath, current);
  return current;
}

async function readSettingsObject(p: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    // Corrupt JSON: don't propagate the parse error; treat as empty so
    // the user can recover by re-patching. The original file is about
    // to be replaced anyway.
    return {};
  }
}

async function writeSettingsAtomic(p: string, obj: Record<string, unknown>): Promise<void> {
  const json = `${JSON.stringify(obj, null, 2)}\n`;
  const dir = dirname(p);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${p}.tmp-${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, json, 'utf8');
  await fs.rename(tmp, p);
}
