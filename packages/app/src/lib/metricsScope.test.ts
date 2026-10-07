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
  resolveMetricsView,
  shouldShowTelemetryBanner,
  formatPickerLabel,
  accountSecondaryLine,
  type PoolOption,
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

  it('marks BYOK as trailing so it renders below the accounts, not above them', () => {
    // The picker draws pool options and accounts as two separate groups, so
    // array order alone put "API key" directly under "All accounts" and above
    // the user's real accounts. `trailing` is what actually demotes it.
    const options = buildMetricsPoolOptions({
      accounts: TWO_ACCOUNTS,
      isAuto: true,
      poolExcludedIds: ['a-2'],
      byokHasUsage: true,
    });
    const byok = options.find((o) => o.value === BYOK_VIEW);
    expect(byok?.trailing).toBe(true);
    // The aggregate rows must stay above the accounts.
    expect(options.filter((o) => o.trailing).map((o) => o.value)).toEqual([BYOK_VIEW]);
    expect(options.filter((o) => !o.trailing).map((o) => o.value)).toEqual([ALL_VIEW, POOL_VIEW]);
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

describe('resolveMetricsView', () => {
  const withByok = buildMetricsPoolOptions({
    accounts: TWO_ACCOUNTS,
    isAuto: false,
    poolExcludedIds: [],
    byokHasUsage: true,
  });
  const withoutByok = buildMetricsPoolOptions({
    accounts: TWO_ACCOUNTS,
    isAuto: false,
    poolExcludedIds: [],
    byokHasUsage: false,
  });

  it('keeps a BYOK pick while the BYOK row is offered', () => {
    expect(resolveMetricsView(BYOK_VIEW, withByok, TWO_ACCOUNTS)).toBe(BYOK_VIEW);
  });

  it('falls back to the default scope once BYOK usage is purged', () => {
    expect(resolveMetricsView(BYOK_VIEW, withoutByok, TWO_ACCOUNTS)).toBe(ALL_VIEW);
  });

  it('restores the BYOK pick when its row comes back', () => {
    // The stored pick is never cleared, so the same input resolves to BYOK
    // again as soon as the option is offered.
    expect(resolveMetricsView(BYOK_VIEW, withoutByok, TWO_ACCOUNTS)).toBe(ALL_VIEW);
    expect(resolveMetricsView(BYOK_VIEW, withByok, TWO_ACCOUNTS)).toBe(BYOK_VIEW);
  });

  it('falls back to following the active account when no default row exists', () => {
    // One account: no "All accounts" row, so the only fallback is undefined.
    expect(resolveMetricsView(BYOK_VIEW, [], [acct('solo')])).toBeUndefined();
    expect(metricsViewToScope(resolveMetricsView(BYOK_VIEW, [], [acct('solo')]), [], [])).toEqual({
      kind: 'active',
    });
  });

  it('never resolves an undefined pick to BYOK, even when it is the only row', () => {
    const onlyByok = buildMetricsPoolOptions({
      accounts: [acct('solo')],
      isAuto: false,
      poolExcludedIds: [],
      byokHasUsage: true,
    });
    expect(onlyByok.map((o) => o.value)).toEqual([BYOK_VIEW]);
    expect(resolveMetricsView(undefined, onlyByok, [acct('solo')])).toBeUndefined();
    expect(resolveMetricsView(undefined, withByok, TWO_ACCOUNTS)).toBe(ALL_VIEW);
  });

  it('drops a pool pick once the pool row disappears (Auto turned off)', () => {
    const autoOptions = buildMetricsPoolOptions({
      accounts: [acct('a'), acct('b'), acct('c')],
      isAuto: true,
      poolExcludedIds: ['c'],
      byokHasUsage: false,
    });
    const accts = [acct('a'), acct('b'), acct('c')];
    expect(resolveMetricsView(POOL_VIEW, autoOptions, accts)).toBe(POOL_VIEW);
    expect(resolveMetricsView(POOL_VIEW, withoutByok, TWO_ACCOUNTS)).toBe(ALL_VIEW);
  });

  it('keeps an account pin only while that account is enrolled', () => {
    expect(resolveMetricsView('a-2', withoutByok, TWO_ACCOUNTS)).toBe('a-2');
    expect(resolveMetricsView('gone', withoutByok, TWO_ACCOUNTS)).toBe(ALL_VIEW);
  });
});

describe('shouldShowTelemetryBanner', () => {
  it('hides the Claude Code telemetry banner for the API-key scope only', () => {
    expect(shouldShowTelemetryBanner(metricsViewToScope(BYOK_VIEW, TWO_ACCOUNTS, []))).toBe(false);
    expect(shouldShowTelemetryBanner({ kind: 'account', id: BYOK_ACCOUNT_ID })).toBe(false);
  });

  it('keeps the banner for every other scope', () => {
    expect(shouldShowTelemetryBanner(undefined)).toBe(true);
    expect(shouldShowTelemetryBanner({ kind: 'active' })).toBe(true);
    expect(shouldShowTelemetryBanner({ kind: 'account', id: 'a-1' })).toBe(true);
    expect(shouldShowTelemetryBanner(metricsViewToScope(ALL_VIEW, TWO_ACCOUNTS, []))).toBe(true);
    expect(shouldShowTelemetryBanner(metricsViewToScope(POOL_VIEW, TWO_ACCOUNTS, []))).toBe(true);
  });
});

describe('formatPickerLabel', () => {
  const options = buildMetricsPoolOptions({
    accounts: TWO_ACCOUNTS,
    isAuto: false,
    poolExcludedIds: [],
    byokHasUsage: true,
  });

  it('shows only "API key" on the collapsed button for the BYOK scope', () => {
    expect(formatPickerLabel(BYOK_VIEW, TWO_ACCOUNTS, options)).toEqual({ primary: 'API key' });
  });

  it('keeps the explanatory secondary line on the BYOK dropdown row', () => {
    const byok = options.find((o) => o.value === BYOK_VIEW);
    expect(byok?.secondary).toBe('Direct API traffic (BYOK)');
    expect(byok?.compact).toBe(true);
  });

  it('keeps the secondary line for non-compact synthetic rows', () => {
    expect(formatPickerLabel(ALL_VIEW, TWO_ACCOUNTS, options)).toEqual({
      primary: 'All accounts',
      secondary: '2 accounts',
    });
  });

  it('falls back to a fixed label for a sentinel the caller did not list', () => {
    expect(formatPickerLabel(BYOK_VIEW, TWO_ACCOUNTS, [])).toEqual({ primary: 'API key' });
    expect(formatPickerLabel(POOL_VIEW, TWO_ACCOUNTS, [])).toEqual({
      primary: 'All accounts',
      secondary: '2 accounts',
    });
  });

  it('labels accounts by display name (or email) with org and plan', () => {
    const named = { ...acct('x'), orgName: 'Acme', planType: 'max' } as AccountInfo;
    const bare = { ...acct('y'), displayName: '' } as AccountInfo;
    const noOpts: PoolOption[] = [];
    expect(formatPickerLabel('x', [named, bare], noOpts)).toEqual({
      primary: 'x',
      secondary: 'Acme · Max',
    });
    expect(formatPickerLabel('y', [named, bare], noOpts)).toEqual({
      primary: 'y@example.com',
      secondary: undefined,
    });
    expect(formatPickerLabel('missing', [named], noOpts)).toEqual({ primary: 'Unknown' });
  });
});

describe('accountSecondaryLine', () => {
  it('joins org and plan, or returns whichever exists', () => {
    expect(
      accountSecondaryLine({ ...acct('a'), orgName: 'Acme', planType: 'pro' } as AccountInfo),
    ).toBe('Acme · Pro');
    expect(accountSecondaryLine({ ...acct('a'), orgName: 'Acme' } as AccountInfo)).toBe('Acme');
    expect(accountSecondaryLine({ ...acct('a'), planType: 'team' } as AccountInfo)).toBe('Team');
    expect(accountSecondaryLine(acct('a'))).toBeUndefined();
  });
});
