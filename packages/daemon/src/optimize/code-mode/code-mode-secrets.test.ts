import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import type { CodeModeMigration } from '@sentinel/shared';
import {
  newSecretRef,
  splitEntrySecrets,
  describeSecretKeys,
  readCodeModeSecrets,
  writeCodeModeSecrets,
  deleteCodeModeSecrets,
  hydrateEntry,
  hasInlineSecrets,
  migrateInlineSecretsToKeychain,
  buildStashFields,
  readEntrySecrets,
  lookupSecretField,
  applySecretChanges,
  mergeEntrySecrets,
  selectMigrationForCwd,
  migrationKey,
} from './code-mode-secrets.js';

const STDIO_ENTRY = {
  command: 'uvx',
  args: ['mcp-atlassian'],
  env: { JIRA_URL: 'https://jira.example.com', JIRA_PERSONAL_TOKEN: 'tok-old' },
};
const HTTP_ENTRY = {
  type: 'http',
  url: 'https://api.example.com/mcp/',
  headers: { Authorization: 'Bearer ghp_old' },
};

function migration(over: Partial<CodeModeMigration> = {}): CodeModeMigration {
  return {
    server: 'mcp-atlassian',
    scope: 'local',
    directory: '/repo/a',
    originalEntry: STDIO_ENTRY,
    migratedAt: 1,
    ...over,
  };
}

describe('code-mode-secrets', () => {
  let keychainPath: string;
  let prev: string | undefined;

  beforeEach(() => {
    keychainPath = join(tmpdir(), `sentinel-kc-${randomUUID()}.json`);
    prev = process.env.SENTINEL_TEST_KEYCHAIN_FILE;
    process.env.SENTINEL_TEST_KEYCHAIN_FILE = keychainPath;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.SENTINEL_TEST_KEYCHAIN_FILE;
    else process.env.SENTINEL_TEST_KEYCHAIN_FILE = prev;
    if (existsSync(keychainPath)) rmSync(keychainPath);
  });

  describe('newSecretRef', () => {
    it('is stable for the same record and distinct per scope+directory', () => {
      const a = newSecretRef({ server: 'x', scope: 'local', directory: '/repo/a' });
      expect(newSecretRef({ server: 'x', scope: 'local', directory: '/repo/a' })).toBe(a);
      expect(newSecretRef({ server: 'x', scope: 'local', directory: '/repo/b' })).not.toBe(a);
      expect(newSecretRef({ server: 'x', scope: 'user', directory: null })).not.toBe(a);
      expect(newSecretRef({ server: 'y', scope: 'local', directory: '/repo/a' })).not.toBe(a);
    });

    it('keeps a readable server prefix and shell-safe characters only', () => {
      const ref = newSecretRef({ server: 'mcp@atlassian!', scope: 'user', directory: null });
      expect(ref.startsWith('mcp_atlassian_')).toBe(true);
      expect(ref).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('splitEntrySecrets', () => {
    it('strips env off a stdio entry and reports its field names', () => {
      const { nonSecret, secrets, secretKeys } = splitEntrySecrets(STDIO_ENTRY);
      expect(nonSecret).toEqual({ command: 'uvx', args: ['mcp-atlassian'] });
      expect(secrets.env).toEqual(STDIO_ENTRY.env);
      expect(secretKeys).toEqual(['env.JIRA_PERSONAL_TOKEN', 'env.JIRA_URL']);
    });

    it('strips headers off an http entry', () => {
      const { nonSecret, secrets, secretKeys } = splitEntrySecrets(HTTP_ENTRY);
      expect(nonSecret).toEqual({ type: 'http', url: 'https://api.example.com/mcp/' });
      expect(secrets.headers).toEqual({ Authorization: 'Bearer ghp_old' });
      expect(secretKeys).toEqual(['headers.Authorization']);
    });

    it('drops non-string values rather than storing them', () => {
      const { secrets } = splitEntrySecrets({ command: 'x', env: { A: 'a', B: 5, C: null } });
      expect(secrets.env).toEqual({ A: 'a' });
    });

    it('leaves an entry with no secrets untouched', () => {
      const entry = { command: 'x', args: ['y'] };
      const { nonSecret, secrets, secretKeys } = splitEntrySecrets(entry);
      expect(nonSecret).toEqual(entry);
      expect(secrets).toEqual({});
      expect(secretKeys).toEqual([]);
    });

    it('passes through non-object entries', () => {
      expect(splitEntrySecrets(null).nonSecret).toBeNull();
      expect(splitEntrySecrets('nope').nonSecret).toBe('nope');
    });
  });

  describe('keychain round-trip', () => {
    it('writes, reads back, and deletes a blob', () => {
      const ref = newSecretRef({ server: 's', scope: 'user', directory: null });
      writeCodeModeSecrets(ref, { env: { A: 'a' }, headers: { H: 'h' } });
      expect(readCodeModeSecrets(ref)).toEqual({ env: { A: 'a' }, headers: { H: 'h' } });
      deleteCodeModeSecrets(ref);
      expect(readCodeModeSecrets(ref)).toEqual({});
    });

    it('returns {} for an absent slot instead of throwing', () => {
      expect(readCodeModeSecrets('never-written')).toEqual({});
    });

    it('returns {} for a corrupt slot so connect fails loudly, not the read', () => {
      writeFileSync(
        keychainPath,
        JSON.stringify({ 'Sentinel-code-mode-secrets': { bad: 'not json{' } }),
      );
      expect(readCodeModeSecrets('bad')).toEqual({});
    });
  });

  describe('hydrateEntry', () => {
    it('reassembles a byte-identical entry from the keychain half', () => {
      const { nonSecret, secrets } = splitEntrySecrets(STDIO_ENTRY);
      const ref = newSecretRef({ server: 'mcp-atlassian', scope: 'local', directory: '/repo/a' });
      writeCodeModeSecrets(ref, secrets);
      const record = migration({ originalEntry: nonSecret, secretRef: ref });
      expect(hydrateEntry(record)).toEqual(STDIO_ENTRY);
    });

    it('passes an un-migrated record through with its inline secrets', () => {
      expect(hydrateEntry(migration())).toEqual(STDIO_ENTRY);
    });

    it('yields an entry with no credentials when the slot is missing', () => {
      const { nonSecret } = splitEntrySecrets(STDIO_ENTRY);
      const record = migration({ originalEntry: nonSecret, secretRef: 'gone' });
      expect(hydrateEntry(record)).toEqual({ command: 'uvx', args: ['mcp-atlassian'] });
    });
  });

  describe('hasInlineSecrets', () => {
    it('is true only for a record with inline env/headers and no secretRef', () => {
      expect(hasInlineSecrets(migration())).toBe(true);
      expect(hasInlineSecrets(migration({ secretRef: 'r' }))).toBe(false);
      expect(hasInlineSecrets(migration({ originalEntry: { command: 'x' } }))).toBe(false);
      expect(hasInlineSecrets(migration({ originalEntry: null }))).toBe(false);
    });
  });

  describe('migrateInlineSecretsToKeychain', () => {
    it('moves secrets to the keychain, strips them, and stays hydratable', () => {
      const { records, migrated, failed } = migrateInlineSecretsToKeychain([migration()]);
      expect({ migrated, failed }).toEqual({ migrated: 1, failed: 0 });
      const rec = records[0]!;
      expect(rec.secretRef).toBe(
        newSecretRef({ server: 'mcp-atlassian', scope: 'local', directory: '/repo/a' }),
      );
      expect(rec.secretKeys).toEqual(['env.JIRA_PERSONAL_TOKEN', 'env.JIRA_URL']);
      expect(rec.originalEntry).toEqual({ command: 'uvx', args: ['mcp-atlassian'] });
      // The token is out of settings but still reachable.
      expect(JSON.stringify(rec.originalEntry)).not.toContain('tok-old');
      expect(hydrateEntry(rec)).toEqual(STDIO_ENTRY);
    });

    it('is idempotent — a second pass migrates nothing', () => {
      const first = migrateInlineSecretsToKeychain([migration()]);
      const second = migrateInlineSecretsToKeychain(first.records);
      expect(second.migrated).toBe(0);
      expect(second.records[0]).toEqual(first.records[0]);
    });

    it('leaves a record untouched when the keychain write fails', () => {
      // An unwritable keychain file is the closest real analogue of a locked
      // or full secret store. The record must keep its inline secrets: the
      // native config entry is already gone, so this is the only copy.
      writeFileSync(keychainPath, '{}');
      chmodSync(keychainPath, 0o400);
      try {
        const { records, migrated, failed } = migrateInlineSecretsToKeychain([migration()]);
        expect({ migrated, failed }).toEqual({ migrated: 0, failed: 1 });
        expect(records[0]!.secretRef).toBeUndefined();
        expect(records[0]!.originalEntry).toEqual(STDIO_ENTRY);
        // Still recoverable — this is the whole point of the failure policy.
        expect(readEntrySecrets(records[0]!).env?.['JIRA_PERSONAL_TOKEN']).toBe('tok-old');
      } finally {
        chmodSync(keychainPath, 0o600);
      }
    });

    it('does not create a slot for a record that carries no secrets', () => {
      const { records, migrated } = migrateInlineSecretsToKeychain([
        migration({ originalEntry: { command: 'x' } }),
      ]);
      expect(migrated).toBe(0);
      expect(records[0]!.secretRef).toBeUndefined();
      expect(existsSync(keychainPath)).toBe(false);
    });
  });

  describe('field addressing', () => {
    const secrets = { env: { A: 'a' }, headers: { H: 'h' } };

    it('looks up env and headers fields', () => {
      expect(lookupSecretField(secrets, 'env.A')).toBe('a');
      expect(lookupSecretField(secrets, 'headers.H')).toBe('h');
    });

    it('returns undefined for unknown or malformed names', () => {
      expect(lookupSecretField(secrets, 'env.MISSING')).toBeUndefined();
      expect(lookupSecretField(secrets, 'bogus.A')).toBeUndefined();
      expect(lookupSecretField(secrets, 'noDot')).toBeUndefined();
      expect(lookupSecretField(secrets, 'env.')).toBeUndefined();
      expect(lookupSecretField(secrets, '.A')).toBeUndefined();
    });

    it('describeSecretKeys sorts both sections together', () => {
      expect(describeSecretKeys({ env: { B: 'b', A: 'a' }, headers: { C: 'c' } })).toEqual([
        'env.A',
        'env.B',
        'headers.C',
      ]);
    });
  });

  describe('applySecretChanges', () => {
    it('changes only the listed field and leaves the rest alone', () => {
      const out = applySecretChanges(
        { env: { JIRA_URL: 'u', JIRA_PERSONAL_TOKEN: 'tok-old' } },
        { 'env.JIRA_PERSONAL_TOKEN': 'tok-new' },
      );
      expect(out.env).toEqual({ JIRA_URL: 'u', JIRA_PERSONAL_TOKEN: 'tok-new' });
    });

    it('deletes a field on null and adds a new one', () => {
      const out = applySecretChanges(
        { env: { A: 'a', B: 'b' } },
        { 'env.A': null, 'headers.New': 'v' },
      );
      expect(out.env).toEqual({ B: 'b' });
      expect(out.headers).toEqual({ New: 'v' });
    });

    it('omits a section that ends up empty', () => {
      expect(applySecretChanges({ env: { A: 'a' } }, { 'env.A': null })).toEqual({});
    });

    it('ignores malformed keys rather than failing the whole update', () => {
      expect(applySecretChanges({ env: { A: 'a' } }, { nope: 'x' }).env).toEqual({ A: 'a' });
    });
  });

  describe('mergeEntrySecrets', () => {
    it('is the inverse of splitEntrySecrets', () => {
      const { nonSecret, secrets } = splitEntrySecrets(HTTP_ENTRY);
      expect(mergeEntrySecrets(nonSecret, secrets)).toEqual(HTTP_ENTRY);
    });

    it('replaces any stale inline secrets rather than merging into them', () => {
      const merged = mergeEntrySecrets(STDIO_ENTRY, { env: { ONLY: 'new' } }) as {
        env: Record<string, string>;
      };
      expect(merged.env).toEqual({ ONLY: 'new' });
    });

    it('passes through non-object skeletons', () => {
      expect(mergeEntrySecrets(null, { env: { A: 'a' } })).toBeNull();
    });
  });

  describe('selectMigrationForCwd', () => {
    const user = migration({ scope: 'user', directory: null, originalEntry: { command: 'u' } });
    const parent = migration({ directory: '/repo', originalEntry: { command: 'p' } });
    const nested = migration({ directory: '/repo/pkg', originalEntry: { command: 'n' } });
    const other = migration({ directory: '/elsewhere', originalEntry: { command: 'o' } });

    it('prefers the deepest directory containing cwd', () => {
      const got = selectMigrationForCwd([parent, nested, other], 'mcp-atlassian', '/repo/pkg/src');
      expect(got?.directory).toBe('/repo/pkg');
    });

    it('matches on path segments, not string prefixes', () => {
      const sibling = migration({ directory: '/repo/pk', originalEntry: { command: 's' } });
      const got = selectMigrationForCwd([sibling, nested], 'mcp-atlassian', '/repo/pkg');
      expect(got?.directory).toBe('/repo/pkg');
    });

    it('falls back to user scope when no directory contains cwd', () => {
      expect(selectMigrationForCwd([other, user], 'mcp-atlassian', '/tmp/x')?.scope).toBe('user');
    });

    it('is deterministic without a cwd — sorted, not array order', () => {
      const forward = selectMigrationForCwd([other, parent, nested], 'mcp-atlassian');
      const reversed = selectMigrationForCwd([nested, parent, other], 'mcp-atlassian');
      expect(forward?.directory).toBe('/elsewhere');
      expect(reversed?.directory).toBe('/elsewhere');
    });

    it('ignores records for other servers', () => {
      const mine = migration({ directory: '/repo', server: 'mine' });
      expect(selectMigrationForCwd([mine, parent], 'mine', '/repo')?.server).toBe('mine');
    });

    it('returns undefined when the server has no records', () => {
      expect(selectMigrationForCwd([parent], 'absent')).toBeUndefined();
    });
  });

  describe('readEntrySecrets', () => {
    it('prefers the keychain slot over any stale inline copy', () => {
      const ref = newSecretRef({ server: 'mcp-atlassian', scope: 'local', directory: '/repo/a' });
      writeCodeModeSecrets(ref, { env: { JIRA_PERSONAL_TOKEN: 'tok-new' } });
      // originalEntry still carries the OLD token; the slot must win.
      const record = migration({ secretRef: ref });
      expect(readEntrySecrets(record).env).toEqual({ JIRA_PERSONAL_TOKEN: 'tok-new' });
    });
  });

  describe('migrationKey', () => {
    it('distinguishes scopes and directories of one server', () => {
      expect(migrationKey(migration())).not.toBe(migrationKey(migration({ directory: '/repo/b' })));
      expect(migrationKey(migration())).not.toBe(
        migrationKey(migration({ scope: 'user', directory: null })),
      );
    });
  });

  describe('secret hygiene', () => {
    it('never leaves a token in the settings-bound half of a migrated record', () => {
      const { records } = migrateInlineSecretsToKeychain([
        migration(),
        migration({ scope: 'user', directory: null, originalEntry: HTTP_ENTRY }),
      ]);
      const settingsShaped = JSON.stringify(
        records.map((r) => ({ ...r, originalEntry: r.originalEntry })),
      );
      expect(settingsShaped).not.toContain('tok-old');
      expect(settingsShaped).not.toContain('ghp_old');
      // ...and the keychain file is where they went.
      const kc = readFileSync(keychainPath, 'utf-8');
      expect(kc).toContain('tok-old');
      expect(kc).toContain('ghp_old');
    });
  });
  describe('buildStashFields', () => {
    it('moves secrets to the keychain and keeps the record hydratable', () => {
      const ref = { server: 'mcp-atlassian', scope: 'local' as const, directory: '/repo/a' };
      const fields = buildStashFields(ref, STDIO_ENTRY);
      expect(fields.originalEntry).toEqual({ command: 'uvx', args: ['mcp-atlassian'] });
      expect(fields.secretKeys).toEqual(['env.JIRA_PERSONAL_TOKEN', 'env.JIRA_URL']);
      expect(hydrateEntry(migration({ ...fields }))).toEqual(STDIO_ENTRY);
    });

    it('omits a keychain slot for an entry with no secrets', () => {
      const fields = buildStashFields(
        { server: 's', scope: 'user', directory: null },
        { command: 'x' },
      );
      expect(fields).toEqual({ originalEntry: { command: 'x' } });
    });

    it('falls back to inline secrets instead of throwing when the keychain write fails', () => {
      // The caller has already deleted the native config entry by this point,
      // so throwing would leave the server gone with nothing recorded. The
      // record must come back complete and restorable.
      writeFileSync(keychainPath, '{}');
      chmodSync(keychainPath, 0o400);
      try {
        const fields = buildStashFields(
          { server: 'mcp-atlassian', scope: 'user', directory: null },
          STDIO_ENTRY,
        );
        expect(fields.secretRef).toBeUndefined();
        expect(fields.originalEntry).toEqual(STDIO_ENTRY);
        expect(hydrateEntry(migration({ ...fields }))).toEqual(STDIO_ENTRY);
      } finally {
        chmodSync(keychainPath, 0o600);
      }
    });
  });
});
