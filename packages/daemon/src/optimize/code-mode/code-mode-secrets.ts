/**
 * Storage helpers for a bridged MCP server's own secrets.
 *
 * A migrated `mcpServers` entry routinely carries API tokens in `env`
 * (`JIRA_PERSONAL_TOKEN`, `MDB_MCP_API_CLIENT_SECRET`, …) or in HTTP `headers`
 * (`Authorization`). Those two objects are held in the OS keychain, parallel to
 * OAuth tokens and the OTEL ingestion key; only non-secret config (`command`,
 * `args`, `type`, `url`) stays in `~/.sentinel/settings.json`. Tests route
 * through `SENTINEL_TEST_KEYCHAIN_FILE` automatically — these helpers don't
 * need to know about the test seam.
 *
 * Whole objects are the secret unit, deliberately: key-name heuristics
 * (`*_TOKEN`, `*_SECRET`) miss novel names, and a bridged server's env is
 * small enough that storing all of it costs nothing. The non-secret keys that
 * ride along (`JIRA_URL`, `CONFLUENCE_USERNAME`) are harmless in the keychain,
 * whereas one missed token would not be.
 *
 * One slot per migration record — two scopes of the same server can hold
 * different credentials, so they cannot share a slot. The account key is
 * generated once by `newSecretRef()` and persisted on the record, so changing
 * the derivation later cannot orphan an existing slot.
 *
 * There is no pre-rename `Claude Sentinel-code-mode-secrets` service: this
 * store is newer than the rename, so the plain (non-migrating) blob helpers
 * are the correct ones to use here.
 */

import { createHash } from 'node:crypto';
import type { CodeModeMigration, McpInstallScope } from '@sentinel/shared';
import { readCredentialBlob, writeCredentialBlob, deleteCredentialBlob } from '../../accounts.js';
import { sanitizePathSegment } from './workspace-gen.js';

const SECRETS_SERVICE = 'Sentinel-code-mode-secrets';

/** The secret half of an `mcpServers` entry. Both halves are optional — an
 *  entry may carry env only (stdio), headers only (HTTP), or neither. */
export interface EntrySecrets {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/** Identity of a migration record, for deriving its keychain slot. */
export interface SecretSlotRef {
  server: string;
  scope: McpInstallScope;
  directory: string | null;
}

/**
 * Derive a keychain account key for a migration record: a readable server
 * prefix plus a hash of the full identity. The prefix makes
 * `security dump-keychain` output diagnosable; the hash keeps the key unique
 * per scope+directory and free of characters that would need escaping when the
 * macOS helper shells out to `security`.
 *
 * Call once at migration time and persist the result as `secretRef`; always
 * read by the persisted value rather than re-deriving.
 */
export function newSecretRef(ref: SecretSlotRef): string {
  const h = createHash('sha256')
    .update(`${ref.server}\n${ref.scope}\n${ref.directory ?? ''}`)
    .digest('hex')
    .slice(0, 32);
  return `${sanitizePathSegment(ref.server).slice(0, 40)}-${h}`;
}

/** Keep only string-valued keys — the shape `StdioClientTransport` and the
 *  fetch headers init both require. Mirrors the filter `buildTransport`
 *  applies, so what we store is what will actually be spawned. */
function stringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Split an `mcpServers` entry into the part that stays in settings.json and
 * the part that belongs in the keychain. `nonSecret` is a shallow copy with
 * `env`/`headers` deleted, so the caller can persist it directly.
 */
export function splitEntrySecrets(entry: unknown): {
  nonSecret: unknown;
  secrets: EntrySecrets;
  secretKeys: string[];
} {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { nonSecret: entry, secrets: {}, secretKeys: [] };
  }
  const e = { ...(entry as Record<string, unknown>) };
  const env = stringRecord(e['env']);
  const headers = stringRecord(e['headers']);
  delete e['env'];
  delete e['headers'];
  const secrets: EntrySecrets = {};
  if (env) secrets.env = env;
  if (headers) secrets.headers = headers;
  return { nonSecret: e, secrets, secretKeys: describeSecretKeys(secrets) };
}

/** Flatten an `EntrySecrets` into `env.NAME` / `headers.NAME` field names, the
 *  addressing scheme the credentials IPC and UI use. Sorted for stable
 *  rendering and stable test assertions. */
export function describeSecretKeys(secrets: EntrySecrets): string[] {
  const keys = [
    ...Object.keys(secrets.env ?? {}).map((k) => `env.${k}`),
    ...Object.keys(secrets.headers ?? {}).map((k) => `headers.${k}`),
  ];
  return keys.sort((a, b) => a.localeCompare(b));
}

export function readCodeModeSecrets(secretRef: string): EntrySecrets {
  const blob = readCredentialBlob(SECRETS_SERVICE, secretRef);
  if (blob === null || blob.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    // A corrupt slot is indistinguishable from an absent one to the caller:
    // the server will fail to authenticate and the credentials dialog is the
    // fix either way. Returning {} beats throwing on every connect attempt.
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const p = parsed as Record<string, unknown>;
  const env = stringRecord(p['env']);
  const headers = stringRecord(p['headers']);
  const out: EntrySecrets = {};
  if (env) out.env = env;
  if (headers) out.headers = headers;
  return out;
}

export function writeCodeModeSecrets(secretRef: string, secrets: EntrySecrets): void {
  writeCredentialBlob(SECRETS_SERVICE, secretRef, JSON.stringify(secrets));
}

export function deleteCodeModeSecrets(secretRef: string): void {
  deleteCredentialBlob(SECRETS_SERVICE, secretRef);
}

/**
 * Reconstitute the full `mcpServers` entry for a migration record: the
 * non-secret config from settings plus the keychain blob merged back in.
 *
 * This is the inverse of `splitEntrySecrets` and MUST be used at every point
 * the entry is consumed — connecting a bridged client and restoring the native
 * entry on revert. Using `originalEntry` directly would spawn or restore a
 * server with no credentials at all.
 *
 * Records predating the keychain split (no `secretRef`) still carry their
 * secrets inline, so they pass through unchanged.
 */
export function hydrateEntry(record: CodeModeMigration): unknown {
  const base = record.originalEntry;
  if (!record.secretRef) return base;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return base;
  const secrets = readCodeModeSecrets(record.secretRef);
  const out = { ...(base as Record<string, unknown>) };
  if (secrets.env) out['env'] = secrets.env;
  if (secrets.headers) out['headers'] = secrets.headers;
  return out;
}

/**
 * A record's current secrets, wherever they live: the keychain slot once the
 * split has happened, or still inline in `originalEntry` if it hasn't. The
 * credentials flow reads through this so it works identically on a record the
 * startup migration hasn't reached yet.
 */
export function readEntrySecrets(record: CodeModeMigration): EntrySecrets {
  if (record.secretRef) return readCodeModeSecrets(record.secretRef);
  return splitEntrySecrets(record.originalEntry).secrets;
}

/** Stable identity of a migration record, used as a client-cache key for
 *  records that have no `secretRef` (an entry carrying no secrets at all never
 *  gets a keychain slot). Never used as a keychain account name. */
export function migrationKey(record: CodeModeMigration): string {
  return `${record.server}\n${record.scope}\n${record.directory ?? ''}`;
}

/** True when `dir` is `parent` or lives beneath it. Segment-aware, so `/a/bc`
 *  is not treated as being inside `/a/b`. */
function isWithin(parent: string, dir: string): boolean {
  if (dir === parent) return true;
  const base = parent.endsWith('/') ? parent : `${parent}/`;
  return dir.startsWith(base);
}

/**
 * Pick which migration record's credentials a call should use.
 *
 * Scopes of the same server can hold DIFFERENT credentials, so this cannot just
 * take the first match — which is what it did before, silently serving one
 * project's token to every other project. Order:
 *
 *   1. the most specific `local`/`project` record whose directory contains
 *      `cwd` (longest directory wins, so a nested project beats its parent);
 *   2. the `user`-scope record, which by definition applies everywhere;
 *   3. the remaining records by directory, sorted — arbitrary but STABLE, so
 *      behaviour doesn't depend on settings-array order.
 *
 * `cwd` is optional because bridge callers may not send it; steps 2 and 3 are
 * what make the no-cwd case deterministic instead of order-dependent.
 */
export function selectMigrationForCwd(
  records: CodeModeMigration[],
  server: string,
  cwd?: string,
): CodeModeMigration | undefined {
  const mine = records.filter((m) => m.server === server);
  if (mine.length <= 1) return mine[0];
  if (cwd) {
    const containing = mine
      .filter((m): m is CodeModeMigration & { directory: string } => m.directory !== null)
      .filter((m) => isWithin(m.directory, cwd))
      .sort((a, b) => b.directory.length - a.directory.length);
    if (containing[0]) return containing[0];
  }
  const userScoped = mine.find((m) => m.scope === 'user');
  if (userScoped) return userScoped;
  return [...mine].sort((a, b) => (a.directory ?? '').localeCompare(b.directory ?? ''))[0];
}

/** Split an `env.NAME` / `headers.NAME` field name into its two parts, or null
 *  when the name doesn't address a supported section. */
function parseField(key: string): { section: 'env' | 'headers'; name: string } | null {
  const dot = key.indexOf('.');
  if (dot <= 0) return null;
  const section = key.slice(0, dot);
  const name = key.slice(dot + 1);
  if (name.length === 0) return null;
  if (section !== 'env' && section !== 'headers') return null;
  return { section, name };
}

/** Current value of one `env.NAME` / `headers.NAME` field, or undefined when
 *  the field name is unsupported or the field isn't set. */
export function lookupSecretField(secrets: EntrySecrets, key: string): string | undefined {
  const field = parseField(key);
  if (!field) return undefined;
  return secrets[field.section]?.[field.name];
}

/**
 * Apply a sparse set of field edits, returning a new `EntrySecrets`. Fields
 * absent from `changes` keep their current values — that is what lets the UI
 * submit only what the user actually typed. A `null` value deletes the field.
 *
 * Unsupported field names are ignored rather than throwing: they cannot be
 * produced by our own UI, and a malformed key is not worth failing an otherwise
 * valid credential update over.
 */
export function applySecretChanges(
  secrets: EntrySecrets,
  changes: Record<string, string | null>,
): EntrySecrets {
  const env = { ...(secrets.env ?? {}) };
  const headers = { ...(secrets.headers ?? {}) };
  for (const [key, value] of Object.entries(changes)) {
    const field = parseField(key);
    if (!field) continue;
    const target = field.section === 'env' ? env : headers;
    if (value === null) delete target[field.name];
    else target[field.name] = value;
  }
  const out: EntrySecrets = {};
  if (Object.keys(env).length > 0) out.env = env;
  if (Object.keys(headers).length > 0) out.headers = headers;
  return out;
}

/** Merge secrets back onto a non-secret entry skeleton, producing a spawnable
 *  `mcpServers` entry. The connect-time counterpart of `splitEntrySecrets`,
 *  used to build a candidate entry for verification before anything is saved. */
export function mergeEntrySecrets(nonSecret: unknown, secrets: EntrySecrets): unknown {
  if (!nonSecret || typeof nonSecret !== 'object' || Array.isArray(nonSecret)) return nonSecret;
  const out = { ...(nonSecret as Record<string, unknown>) };
  delete out['env'];
  delete out['headers'];
  if (secrets.env) out['env'] = secrets.env;
  if (secrets.headers) out['headers'] = secrets.headers;
  return out;
}

/**
 * True when a record still holds its secrets inline in settings.json — i.e.
 * the startup migration has not moved it yet, or a previous attempt failed.
 */
export function hasInlineSecrets(record: CodeModeMigration): boolean {
  if (record.secretRef) return false;
  const e = record.originalEntry;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const o = e as Record<string, unknown>;
  return stringRecord(o['env']) !== undefined || stringRecord(o['headers']) !== undefined;
}

/**
 * Build the persisted half of a stash for an entry just removed from the
 * config, moving its secrets to the keychain.
 *
 * Ordering matters here: the caller has ALREADY deleted the native entry by the
 * time it has an entry to stash, so a keychain write that throws must not
 * propagate — that would leave the server removed from the user's config with
 * nothing recorded and no way back. Instead we fall back to the pre-keychain
 * shape (secrets inline in the record), which is complete, restorable, and gets
 * picked up by `migrateInlineSecretsToKeychain` on a later start.
 */
export function buildStashFields(
  ref: SecretSlotRef,
  originalEntry: unknown,
): Pick<CodeModeMigration, 'originalEntry' | 'secretRef' | 'secretKeys'> {
  const { nonSecret, secrets, secretKeys } = splitEntrySecrets(originalEntry);
  if (secretKeys.length === 0) return { originalEntry: nonSecret };
  const secretRef = newSecretRef(ref);
  try {
    writeCodeModeSecrets(secretRef, secrets);
  } catch (err) {
    console.error(
      `[CodeMode] Could not store '${ref.server}' (${ref.scope}) secrets in the keychain; ` +
        `keeping them in settings.json so the entry stays restorable:`,
      err,
    );
    return { originalEntry };
  }
  return { originalEntry: nonSecret, secretRef, secretKeys };
}

/**
 * Move any record's inline `env`/`headers` into the keychain, returning the
 * rewritten list and how many records changed. Pure with respect to settings —
 * the caller persists the result.
 *
 * Per-record and idempotent: `secretRef` presence is the marker, so there is
 * no global migration flag to get out of sync, and a record that fails to
 * write is simply retried on the next daemon start.
 *
 * Failure policy: if the keychain write throws, the record is left EXACTLY as
 * it was, secrets still inline. Stripping them on a failed write would destroy
 * the user's only copy — the native config entry was deleted at bridge time.
 */
export function migrateInlineSecretsToKeychain(records: CodeModeMigration[]): {
  records: CodeModeMigration[];
  migrated: number;
  failed: number;
} {
  let migrated = 0;
  let failed = 0;
  const out = records.map((record) => {
    if (!hasInlineSecrets(record)) return record;
    const { nonSecret, secrets, secretKeys } = splitEntrySecrets(record.originalEntry);
    const secretRef = newSecretRef(record);
    try {
      writeCodeModeSecrets(secretRef, secrets);
    } catch (err) {
      failed++;
      console.error(
        `[CodeMode] Could not move '${record.server}' (${record.scope}) secrets to the keychain; ` +
          `leaving them in settings.json and retrying next start:`,
        err,
      );
      return record;
    }
    migrated++;
    return { ...record, originalEntry: nonSecret, secretRef, secretKeys };
  });
  return { records: out, migrated, failed };
}
