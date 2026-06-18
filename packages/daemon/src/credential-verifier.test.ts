import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync } from 'fs';
import type { ClaudeCodeCredentials, OAuthAccount } from '@sentinel/shared';
import { verifyStartupActiveAccount, healDriftedRows, sentinelKey } from './credential-verifier.js';
import { getDb, closeDb, upsertAccount, listAccounts } from './db.js';
import type { ProfileResult } from './oauth.js';

const TEST_DB = join(tmpdir(), `sentinel-verifier-test-${Date.now()}.db`);

function makeCreds(accessToken: string): ClaudeCodeCredentials {
  return {
    accessToken,
    refreshToken: 'rt-' + accessToken,
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:profile'],
  };
}

function makeProfile(over: Partial<ProfileResult> = {}): ProfileResult {
  return {
    email: 'user@example.com',
    displayName: 'User',
    accountUuid: 'acct-1',
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_5x',
    orgUuid: 'org-personal',
    orgName: "user@example.com's Organization",
    organizationRole: 'admin',
    workspaceRole: null,
    hasExtraUsageEnabled: false,
    ...over,
  };
}

const baseActive: OAuthAccount = {
  accountUuid: 'acct-1',
  emailAddress: 'user@example.com',
  organizationUuid: 'org-team',
  hasExtraUsageEnabled: false,
  billingType: 'stripe_subscription',
  accountCreatedAt: '2025-01-01T00:00:00Z',
  subscriptionCreatedAt: '2025-01-01T00:00:00Z',
  displayName: 'User',
  organizationRole: 'admin',
  workspaceRole: null,
  organizationName: 'Team Org',
};

describe('verifyStartupActiveAccount', () => {
  it('returns null when there is no active account', async () => {
    const result = await verifyStartupActiveAccount(null, makeCreds('tok'), {
      readCredentials: () => null,
      profileFetcher: async () => makeProfile(),
    });
    expect(result).toBeNull();
  });

  it('returns null when there are no credentials to verify', async () => {
    const result = await verifyStartupActiveAccount(baseActive, null, {
      readCredentials: () => null,
      profileFetcher: async () => makeProfile(),
    });
    expect(result).toBeNull();
  });

  it('returns null when the profile fetch throws (transient failure)', async () => {
    const result = await verifyStartupActiveAccount(baseActive, makeCreds('tok'), {
      readCredentials: () => null,
      profileFetcher: async () => {
        throw new Error('network down');
      },
    });
    expect(result).toBeNull();
  });

  it('returns null when profile returns an empty orgUuid', async () => {
    const result = await verifyStartupActiveAccount(baseActive, makeCreds('tok'), {
      readCredentials: () => null,
      profileFetcher: async () => makeProfile({ orgUuid: '', accountUuid: '' }),
    });
    expect(result).toBeNull();
  });

  it('returns drifted=false when profile matches the claimed orgUuid', async () => {
    const result = await verifyStartupActiveAccount(baseActive, makeCreds('tok'), {
      readCredentials: () => null,
      profileFetcher: async () => makeProfile({ orgUuid: 'org-team', accountUuid: 'acct-1' }),
    });
    expect(result).not.toBeNull();
    expect(result?.drifted).toBe(false);
    expect(result?.startupKey).toBe('org-team');
    expect(result?.activeAccount).toBe(baseActive);
  });

  it('realigns to the token scope when profile disagrees with ~/.claude.json', async () => {
    // Reproduces the user's reported regression: ~/.claude.json claims
    // Intevity (org-team) but the captured Claude Code token is actually
    // scoped to the personal org. Startup should seed for the PERSONAL org,
    // not create a phantom Intevity row.
    const logs: string[] = [];
    const result = await verifyStartupActiveAccount(baseActive, makeCreds('tok'), {
      readCredentials: () => null,
      profileFetcher: async () =>
        makeProfile({
          orgUuid: 'org-personal',
          accountUuid: 'acct-1',
          orgName: "user@example.com's Organization",
          workspaceRole: null,
        }),
      log: (m) => logs.push(m),
    });
    expect(result?.drifted).toBe(true);
    expect(result?.startupKey).toBe('org-personal');
    expect(result?.activeAccount.organizationUuid).toBe('org-personal');
    expect(result?.activeAccount.organizationName).toBe("user@example.com's Organization");
    expect(logs.some((m) => m.includes('Credential drift'))).toBe(true);
  });

  it('preserves the original workspaceRole when the profile does not provide one', async () => {
    const teamActive: OAuthAccount = { ...baseActive, workspaceRole: 'admin' };
    const result = await verifyStartupActiveAccount(teamActive, makeCreds('tok'), {
      readCredentials: () => null,
      profileFetcher: async () =>
        makeProfile({ orgUuid: 'org-other', accountUuid: 'acct-1', workspaceRole: null }),
    });
    expect(result?.drifted).toBe(true);
    expect(result?.activeAccount.workspaceRole).toBe('admin');
  });

  it('copies a non-null workspaceRole from the profile on drift', async () => {
    const result = await verifyStartupActiveAccount(baseActive, makeCreds('tok'), {
      readCredentials: () => null,
      profileFetcher: async () =>
        makeProfile({ orgUuid: 'org-other', accountUuid: 'acct-1', workspaceRole: 'member' }),
    });
    expect(result?.activeAccount.workspaceRole).toBe('member');
  });

  it('falls back to the previous organizationName when the profile omits it', async () => {
    const result = await verifyStartupActiveAccount(baseActive, makeCreds('tok'), {
      readCredentials: () => null,
      profileFetcher: async () =>
        makeProfile({ orgUuid: 'org-other', accountUuid: 'acct-1', orgName: '' }),
    });
    expect(result?.drifted).toBe(true);
    expect(result?.activeAccount.organizationName).toBe('Team Org');
  });

  it('treats a missing claimed orgUuid as a drift when profile reports one', async () => {
    const ghost: OAuthAccount = { ...baseActive, organizationUuid: '' };
    const result = await verifyStartupActiveAccount(ghost, makeCreds('tok'), {
      readCredentials: () => null,
      profileFetcher: async () => makeProfile({ orgUuid: 'org-real', accountUuid: 'acct-1' }),
    });
    expect(result?.drifted).toBe(true);
    expect(result?.startupKey).toBe('org-real');
  });
});

describe('healDriftedRows', () => {
  beforeEach(() => {
    getDb(TEST_DB);
  });

  afterEach(() => {
    closeDb();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  function seedRow(id: string, orgUuid: string, orgName: string, email = 'user@example.com'): void {
    upsertAccount(getDb(TEST_DB), {
      id,
      accountUuid: 'acct-1',
      email,
      displayName: 'User',
      orgUuid,
      orgName,
      planType: 'max',
      isActive: false,
      createdAt: Date.now(),
      color: null,
    });
  }

  it('does nothing when there are no rows', async () => {
    const count = await healDriftedRows(getDb(TEST_DB), {
      readCredentials: () => null,
      profileFetcher: async () => makeProfile(),
    });
    expect(count).toBe(0);
  });

  it('skips rows with no stored credentials', async () => {
    seedRow('org-a', 'org-a', 'A');
    const count = await healDriftedRows(getDb(TEST_DB), {
      readCredentials: () => null,
      profileFetcher: async () => makeProfile({ orgUuid: 'org-b' }),
    });
    expect(count).toBe(0);
    const rows = listAccounts(getDb(TEST_DB));
    expect(rows).toHaveLength(1);
  });

  it('keeps a row whose credential profile matches its orgUuid', async () => {
    seedRow('org-a', 'org-a', 'Org A');
    const count = await healDriftedRows(getDb(TEST_DB), {
      readCredentials: () => makeCreds('tok-a'),
      profileFetcher: async () => makeProfile({ orgUuid: 'org-a' }),
    });
    expect(count).toBe(0);
    const rows = listAccounts(getDb(TEST_DB));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('org-a');
  });

  it('soft-removes a row whose stored credential is scoped to a different org', async () => {
    // Reproduces the duplicate-Max regression: an "Intevity" row seeded from
    // ~/.claude.json holds a personal-scoped token. listAccounts filters out
    // rows with removed != 0, so after the heal the stale row disappears
    // from the UI while the other (legit) row survives.
    seedRow('org-intevity', 'org-intevity', 'Intevity');
    seedRow('org-personal', 'org-personal', "user's Org");
    const logs: string[] = [];
    const count = await healDriftedRows(getDb(TEST_DB), {
      readCredentials: (id) => makeCreds('tok-' + id),
      profileFetcher: async (tok) => {
        // Both stored tokens (mimicking the user's real state) return the
        // personal org when queried.
        void tok;
        return makeProfile({ orgUuid: 'org-personal', accountUuid: 'acct-1' });
      },
      log: (m) => logs.push(m),
    });
    expect(count).toBe(1);
    const rows = listAccounts(getDb(TEST_DB));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('org-personal');
    expect(logs.some((m) => m.includes('org-intevity'))).toBe(true);
  });

  it('continues when the profile fetcher throws for one row', async () => {
    seedRow('org-a', 'org-a', 'Org A');
    seedRow('org-b', 'org-b', 'Org B');
    let calls = 0;
    const count = await healDriftedRows(getDb(TEST_DB), {
      readCredentials: (id) => makeCreds('tok-' + id),
      profileFetcher: async (tok) => {
        calls += 1;
        if (tok === 'tok-org-a') throw new Error('network');
        return makeProfile({ orgUuid: 'org-other' });
      },
    });
    expect(calls).toBe(2);
    expect(count).toBe(1);
    const rows = listAccounts(getDb(TEST_DB));
    // a kept (verification failed — no action), b soft-removed (drift confirmed)
    expect(rows.map((r) => r.id).sort()).toEqual(['org-a']);
  });

  it('skips rows when the profile returns an empty orgUuid', async () => {
    seedRow('org-a', 'org-a', 'Org A');
    const count = await healDriftedRows(getDb(TEST_DB), {
      readCredentials: () => makeCreds('tok'),
      profileFetcher: async () => makeProfile({ orgUuid: '' }),
    });
    expect(count).toBe(0);
    const rows = listAccounts(getDb(TEST_DB));
    expect(rows).toHaveLength(1);
  });
});

describe('sentinelKey', () => {
  it('returns orgUuid when present', () => {
    expect(sentinelKey('org-1', 'acct-1')).toBe('org-1');
  });

  it('falls back to accountUuid when orgUuid is empty', () => {
    expect(sentinelKey('', 'acct-1')).toBe('acct-1');
  });
});
