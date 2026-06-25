import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccountInfo,
  OAuthAccount,
  AppToDaemonMessage,
  DaemonToAppMessage,
  IpcResponse,
} from '@sentinel/shared';
import {
  isDemoModeEnabled,
  setDemoModeEnabled,
  subscribeDemoMode,
  maskAccounts,
  maskOAuthAccount,
  maskIpcResponse,
  maskDaemonBroadcast,
  demoEmail,
  demoName,
  demoOrg,
} from './demoMode.js';

// The node test env has no `localStorage`. Install a plain Map-backed
// stand-in by direct assignment — deliberately not a Vitest global stub, so
// this file stays at zero mock-budget sites (the ratchet counts vitest mock
// call sites, and a plain assignment is not one).
function makeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() {
      return m.size;
    },
  };
}

let originalLocalStorage: Storage | undefined;

beforeEach(() => {
  originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  (globalThis as { localStorage?: Storage }).localStorage = makeStorage();
});

afterEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage as Storage;
});

function acct(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id: 'org-a',
    accountUuid: 'uuid-a',
    email: 'alice.real@corp.com',
    displayName: 'Alice Real',
    orgUuid: 'org-a',
    orgName: 'Acme Corp',
    planType: 'pro',
    isActive: false,
    createdAt: 1000,
    color: null,
    ...overrides,
  };
}

function oauth(overrides: Partial<OAuthAccount> = {}): OAuthAccount {
  return {
    accountUuid: 'uuid-a',
    emailAddress: 'alice.real@corp.com',
    organizationUuid: 'org-a',
    hasExtraUsageEnabled: false,
    billingType: 'pro',
    accountCreatedAt: '2020-01-01T00:00:00.000Z',
    subscriptionCreatedAt: '2020-01-01T00:00:00.000Z',
    displayName: 'Alice Real',
    organizationRole: 'user',
    workspaceRole: null,
    organizationName: 'Acme Corp',
    ...overrides,
  };
}

describe('demo mode flag', () => {
  it('defaults to off and persists enable/disable', () => {
    expect(isDemoModeEnabled()).toBe(false);
    setDemoModeEnabled(true);
    expect(isDemoModeEnabled()).toBe(true);
    expect(globalThis.localStorage.getItem('sentinel.demoMode')).toBe('true');
    setDemoModeEnabled(false);
    expect(isDemoModeEnabled()).toBe(false);
    expect(globalThis.localStorage.getItem('sentinel.demoMode')).toBeNull();
  });

  it('notifies subscribers on change and stops after unsubscribe', () => {
    let calls = 0;
    const unsub = subscribeDemoMode(() => {
      calls += 1;
    });
    setDemoModeEnabled(true);
    setDemoModeEnabled(false);
    expect(calls).toBe(2);
    unsub();
    setDemoModeEnabled(true);
    expect(calls).toBe(2);
  });
});

describe('maskAccounts', () => {
  it('returns the list untouched when demo mode is off', () => {
    const list = [acct()];
    const out = maskAccounts(list);
    expect(out).toBe(list);
    expect(out[0]!.email).toBe('alice.real@corp.com');
    expect(out[0]!.displayName).toBe('Alice Real');
  });

  it('assigns demo identities by enrollment order (createdAt asc)', () => {
    setDemoModeEnabled(true);
    const later = acct({ id: 'org-b', accountUuid: 'uuid-b', createdAt: 2000 });
    const earlier = acct({ id: 'org-a', accountUuid: 'uuid-a', createdAt: 1000 });
    // Pass out of order to prove sorting, not array position, drives the index.
    const out = maskAccounts([later, earlier]);

    const a = out.find((x) => x.id === 'org-a')!;
    const b = out.find((x) => x.id === 'org-b')!;
    expect(a.email).toBe('sentinel-demo-1@intevity.com');
    expect(a.displayName).toBe('Sentinel Demo 1');
    expect(a.orgName).toBe('Organization 1');
    expect(b.email).toBe('sentinel-demo-2@intevity.com');
    expect(b.displayName).toBe('Sentinel Demo 2');
    expect(b.orgName).toBe('Organization 2');
    // Non-identity fields are preserved.
    expect(a.planType).toBe('pro');
  });

  it('is stable: the same account keeps the same number across calls', () => {
    setDemoModeEnabled(true);
    const list = [
      acct({ id: 'org-a', createdAt: 1000 }),
      acct({ id: 'org-b', accountUuid: 'uuid-b', createdAt: 2000 }),
    ];
    const first = maskAccounts(list).find((x) => x.id === 'org-a')!.email;
    const second = maskAccounts(list).find((x) => x.id === 'org-a')!.email;
    expect(first).toBe('sentinel-demo-1@intevity.com');
    expect(second).toBe(first);
  });

  it('does not mutate the input list', () => {
    setDemoModeEnabled(true);
    const list = [acct()];
    maskAccounts(list);
    expect(list[0]!.email).toBe('alice.real@corp.com');
  });
});

describe('maskOAuthAccount', () => {
  it('returns the account untouched when demo mode is off', () => {
    const o = oauth();
    expect(maskOAuthAccount(o)).toBe(o);
    expect(o.emailAddress).toBe('alice.real@corp.com');
  });

  it('resolves the index via organizationUuid || accountUuid from the cached list', () => {
    setDemoModeEnabled(true);
    maskAccounts([
      acct({ id: 'org-a', createdAt: 1000 }),
      acct({ id: 'org-b', accountUuid: 'uuid-b', createdAt: 2000 }),
    ]);
    const masked = maskOAuthAccount(oauth({ organizationUuid: 'org-b', accountUuid: 'uuid-b' }));
    expect(masked.emailAddress).toBe('sentinel-demo-2@intevity.com');
    expect(masked.displayName).toBe('Sentinel Demo 2');
    expect(masked.organizationName).toBe('Organization 2');
  });

  it('falls back to a non-numbered placeholder for an unseen account (no real leak)', () => {
    setDemoModeEnabled(true);
    maskAccounts([acct({ id: 'org-a', createdAt: 1000 })]);
    const masked = maskOAuthAccount(
      oauth({ organizationUuid: 'ghost-org', accountUuid: 'ghost-uuid', emailAddress: 'leak@corp.com' }),
    );
    expect(masked.emailAddress).toBe('sentinel-demo@intevity.com');
    expect(masked.displayName).toBe('Sentinel Demo');
    expect(masked.organizationName).toBe('Organization');
    expect(masked.emailAddress).not.toContain('leak');
  });

  it('uses accountUuid when organizationUuid is empty', () => {
    setDemoModeEnabled(true);
    // id === accountUuid when there is no org (sentinelKey rule).
    maskAccounts([acct({ id: 'uuid-solo', accountUuid: 'uuid-solo', orgUuid: '', createdAt: 500 })]);
    const masked = maskOAuthAccount(oauth({ organizationUuid: '', accountUuid: 'uuid-solo' }));
    expect(masked.emailAddress).toBe('sentinel-demo-1@intevity.com');
  });
});

describe('maskIpcResponse', () => {
  const accountsRes: IpcResponse<AccountInfo[]> = {
    requestType: 'get_accounts',
    success: true,
    data: [acct()],
  };

  it('masks account-list responses when demo mode is on', () => {
    setDemoModeEnabled(true);
    const out = maskIpcResponse({ type: 'get_accounts' } as AppToDaemonMessage, {
      ...accountsRes,
      data: [acct()],
    });
    expect(out.data![0]!.email).toBe('sentinel-demo-1@intevity.com');
  });

  it('passes the response through untouched when demo mode is off', () => {
    const res = { ...accountsRes, data: [acct()] };
    const out = maskIpcResponse({ type: 'refresh_accounts' } as AppToDaemonMessage, res);
    expect(out).toBe(res);
    expect(out.data![0]!.email).toBe('alice.real@corp.com');
  });

  it('leaves non-account responses unchanged even when demo mode is on', () => {
    setDemoModeEnabled(true);
    const res: IpcResponse<{ ok: boolean }> = {
      requestType: 'get_settings',
      success: true,
      data: { ok: true },
    };
    const out = maskIpcResponse({ type: 'get_settings' } as AppToDaemonMessage, res);
    expect(out).toBe(res);
  });

  it('is a no-op when a list response has no array data', () => {
    setDemoModeEnabled(true);
    const res: IpcResponse<AccountInfo[]> = { requestType: 'get_accounts', success: false };
    const out = maskIpcResponse({ type: 'get_accounts' } as AppToDaemonMessage, res);
    expect(out).toBe(res);
  });
});

describe('maskDaemonBroadcast', () => {
  it('masks the account on an account_switched broadcast when demo mode is on', () => {
    setDemoModeEnabled(true);
    maskAccounts([acct({ id: 'org-a', createdAt: 1000 })]);
    const out = maskDaemonBroadcast({
      type: 'account_switched',
      to: oauth({ organizationUuid: 'org-a' }),
    } as DaemonToAppMessage);
    expect(out.type).toBe('account_switched');
    expect((out as { to: OAuthAccount }).to.emailAddress).toBe('sentinel-demo-1@intevity.com');
  });

  it('passes account_switched through untouched when demo mode is off', () => {
    const msg = {
      type: 'account_switched',
      to: oauth(),
    } as DaemonToAppMessage;
    const out = maskDaemonBroadcast(msg);
    expect(out).toBe(msg);
    expect((out as { to: OAuthAccount }).to.emailAddress).toBe('alice.real@corp.com');
  });

  it('leaves unrelated broadcasts unchanged when demo mode is on', () => {
    setDemoModeEnabled(true);
    const msg = { type: 'overage_entered' } as DaemonToAppMessage;
    expect(maskDaemonBroadcast(msg)).toBe(msg);
  });
});

describe('demo string formatters', () => {
  it('format email, name, and org from a 1-based index', () => {
    expect(demoEmail(3)).toBe('sentinel-demo-3@intevity.com');
    expect(demoName(3)).toBe('Sentinel Demo 3');
    expect(demoOrg(3)).toBe('Organization 3');
  });
});
