/**
 * Metrics scope-picker logic. The load-bearing behaviors: the BYOK row earns
 * its place with data (never shown without usage), always renders last, and
 * can never become the implicit default view — a user who never picked the
 * API-key scope must never land on it.
 */

import { describe, it, expect } from 'vitest';
import type { AccountInfo } from '@sentinel/shared';
import { BYOK_ACCOUNT_ID } from '@sentinel/shared';
import {
  POOL_VIEW,
  ALL_VIEW,
  BYOK_VIEW,
  firstDefaultOption,
  buildMetricsPoolOptions,
  metricsViewToScope,
} from './metricsScope.js';

function acct(id: string): AccountInfo {
  return {
    id,
    email: `${id}@example.com`,
    displayName: id,
    accountUuid: id,
    orgUuid: null,
    orgName: null,
    planType: null,
    isActive: false,
    removed: false,
    color: null,
  } as unknown as AccountInfo;
}

const TWO_ACCOUNTS = [acct('a-1'), acct('a-2')];

describe('buildMetricsPoolOptions', () => {
  it('omits the BYOK row when no BYOK usage exists', () => {
    const options = buildMetricsPoolOptions({
      accounts: TWO_ACCOUNTS,
      isAuto: false,
      poolExcludedIds: [],
      byokHasUsage: false,
    });
    expect(options.map((o) => o.value)).toEqual([ALL_VIEW]);
  });

  it('appends the BYOK row last, after all/pool rows', () => {
    const options = buildMetricsPoolOptions({
      accounts: TWO_ACCOUNTS,
      isAuto: true,
      poolExcludedIds: ['a-2'],
      byokHasUsage: true,
    });
    expect(options.map((o) => o.value)).toEqual([ALL_VIEW, POOL_VIEW, BYOK_VIEW]);
    expect(options[2]!.primary).toBe('API key');
  });

  it('keeps existing all/pool gating: single account, no auto → only BYOK when it has usage', () => {
    const options = buildMetricsPoolOptions({
      accounts: [acct('solo')],
      isAuto: false,
      poolExcludedIds: [],
      byokHasUsage: true,
    });
    expect(options.map((o) => o.value)).toEqual([BYOK_VIEW]);
  });

  it('suppresses the pool row when the pool equals the full account list', () => {
    const options = buildMetricsPoolOptions({
      accounts: TWO_ACCOUNTS,
      isAuto: true,
      poolExcludedIds: [],
      byokHasUsage: false,
    });
    expect(options.map((o) => o.value)).toEqual([ALL_VIEW]);
  });
});

describe('firstDefaultOption', () => {
  it('skips the BYOK row so it can never become the implicit default', () => {
    const options = buildMetricsPoolOptions({
      accounts: TWO_ACCOUNTS,
      isAuto: false,
      poolExcludedIds: [],
      byokHasUsage: true,
    });
    expect(firstDefaultOption(options)?.value).toBe(ALL_VIEW);
  });

  it('returns undefined when BYOK is the only row (falls through to the active account)', () => {
    const options = buildMetricsPoolOptions({
      accounts: [acct('solo')],
      isAuto: false,
      poolExcludedIds: [],
      byokHasUsage: true,
    });
    expect(options).toHaveLength(1);
    expect(firstDefaultOption(options)).toBeUndefined();
  });
});

describe('metricsViewToScope', () => {
  it('maps BYOK_VIEW to an account scope pinned to the reserved BYOK key', () => {
    expect(metricsViewToScope(BYOK_VIEW, TWO_ACCOUNTS, [])).toEqual({
      kind: 'account',
      id: BYOK_ACCOUNT_ID,
    });
  });

  it('keeps "All accounts" an enrolled-accounts total — BYOK is not a member', () => {
    const scope = metricsViewToScope(ALL_VIEW, TWO_ACCOUNTS, []);
    expect(scope).toEqual({ kind: 'all', label: 'All accounts', accountIds: ['a-1', 'a-2'] });
  });

  it('pool scope excludes the excluded ids', () => {
    expect(metricsViewToScope(POOL_VIEW, TWO_ACCOUNTS, ['a-2'])).toEqual({
      kind: 'pool',
      label: 'Pool',
      accountIds: ['a-1'],
    });
  });

  it('a bare account id pins that account; undefined follows the active account', () => {
    expect(metricsViewToScope('a-2', TWO_ACCOUNTS, [])).toEqual({ kind: 'account', id: 'a-2' });
    expect(metricsViewToScope(undefined, TWO_ACCOUNTS, [])).toEqual({ kind: 'active' });
  });
});
