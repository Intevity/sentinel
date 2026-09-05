import type { AccountInfo } from '@sentinel/shared';
import { BYOK_ACCOUNT_ID } from '@sentinel/shared';

/** Sentinel value used in place of an accountId when the user picks the
 *  Auto-switching pool view (Usage + Metrics tabs). */
export const POOL_VIEW = '__pool__';

/** Sentinel value for the "All accounts (everything)" cross-account rollup
 *  on the Metrics tab. Unlike `POOL_VIEW`, this ignores pool exclusions —
 *  it's a true total across every enrolled account. */
export const ALL_VIEW = '__all__';

/** Sentinel value for the bring-your-own-key scope on the Metrics tab —
 *  proxy traffic that arrived with the client's own API key, attributed to
 *  the reserved `BYOK_ACCOUNT_ID` rather than any enrolled account. Never a
 *  default view: it only appears when BYOK usage exists, and every fallback
 *  chain skips it. */
export const BYOK_VIEW = '__byok__';

export type PickerValue = string | typeof POOL_VIEW | typeof ALL_VIEW | typeof BYOK_VIEW;

/** A synthetic non-account row the picker renders alongside the real accounts
 *  (pool/all aggregates, the BYOK scope). Callers pass whichever rows they
 *  want surfaced; the picker does not infer membership.
 *
 *  `trailing` moves the row BELOW the account list instead of above it. The
 *  picker renders pool options and accounts as two separate groups, so being
 *  last in this array is not the same as being last on screen — a secondary
 *  scope has to say so explicitly or it lands above the user's own accounts. */
export interface PoolOption {
  value: typeof POOL_VIEW | typeof ALL_VIEW | typeof BYOK_VIEW;
  primary: string;
  secondary: string;
  trailing?: boolean;
}

/** Describes which accounts a metrics rollup should cover.
 *  - `active`: follow whatever Claude Code currently has bound
 *  - `account`: pin to a specific account key — an enrolled account's
 *    sentinel key, or the reserved `BYOK_ACCOUNT_ID`
 *  - `pool`: aggregate across the Auto-switching pool (enrolled minus exclusions)
 *  - `all`: aggregate across every enrolled account, ignoring exclusions
 *
 *  Pool membership is computed at the call site (App.tsx) and passed in as
 *  `accountIds` so the daemon never has to know what "pool" means. */
export type MetricsScope =
  | { kind: 'active' }
  | { kind: 'account'; id: string }
  | { kind: 'pool'; label: string; accountIds: string[] }
  | { kind: 'all'; label: string; accountIds: string[] };

/** First option that is safe to land on implicitly. BYOK is opt-in only —
 *  a user who never picked it should never find their Metrics tab scoped to
 *  API-key traffic just because it was the only synthetic row present. */
export function firstDefaultOption(poolOptions: readonly PoolOption[]): PoolOption | undefined {
  return poolOptions.find((o) => o.value !== BYOK_VIEW);
}

/**
 * Build the synthetic rows for the Metrics tab's scope picker.
 *
 * - "All accounts" (ignoring exclusions) whenever ≥2 accounts are enrolled.
 * - The Auto pool row when Auto switching is active AND the pool differs from
 *   the full account list (otherwise the two rows would be duplicates).
 * - "API key" (BYOK) last, and only when BYOK usage actually exists — the row
 *   earns its place with data, and appending it last keeps it out of the
 *   implicit-default slot (see {@link firstDefaultOption}). It is also marked
 *   `trailing` so it renders below the real accounts: BYOK is an opt-in
 *   secondary scope and must not outrank the accounts the user actually uses.
 */
export function buildMetricsPoolOptions(opts: {
  accounts: readonly AccountInfo[];
  isAuto: boolean;
  poolExcludedIds: readonly string[];
  byokHasUsage: boolean;
}): PoolOption[] {
  const { accounts, isAuto, poolExcludedIds, byokHasUsage } = opts;
  const poolMemberCount = accounts.length - poolExcludedIds.length;
  const options: PoolOption[] = [];
  if (accounts.length > 1) {
    options.push({
      value: ALL_VIEW,
      primary: 'All accounts',
      secondary: `${accounts.length} accounts`,
    });
  }
  if (isAuto && poolMemberCount > 0 && poolMemberCount < accounts.length) {
    options.push({
      value: POOL_VIEW,
      primary: 'All accounts (pool)',
      secondary: `Auto pool · ${poolMemberCount} members`,
    });
  }
  if (byokHasUsage) {
    options.push({
      value: BYOK_VIEW,
      primary: 'API key',
      secondary: 'Direct API traffic (BYOK)',
      trailing: true,
    });
  }
  return options;
}

/**
 * Translate the Metrics picker's value into a concrete scope for
 * `get_metrics_summary`:
 *   - ALL_VIEW   → every enrolled account, ignoring pool exclusions
 *   - POOL_VIEW  → enrolled accounts minus the Auto-pool exclusions
 *   - BYOK_VIEW  → the reserved BYOK attribution key (API-key traffic);
 *                  deliberately NOT part of "All accounts", which stays an
 *                  enrolled-accounts total
 *   - string id  → single-account pin
 *   - undefined  → follow the active account
 */
export function metricsViewToScope(
  view: PickerValue | undefined,
  accounts: readonly AccountInfo[],
  poolExcludedIds: readonly string[],
): MetricsScope {
  if (view === ALL_VIEW) {
    return {
      kind: 'all',
      label: 'All accounts',
      accountIds: accounts.map((a) => a.id),
    };
  }
  if (view === POOL_VIEW) {
    const excluded = new Set(poolExcludedIds);
    return {
      kind: 'pool',
      label: 'Pool',
      accountIds: accounts.filter((a) => !excluded.has(a.id)).map((a) => a.id),
    };
  }
  if (view === BYOK_VIEW) {
    return { kind: 'account', id: BYOK_ACCOUNT_ID };
  }
  if (typeof view === 'string' && view.length > 0) {
    return { kind: 'account', id: view };
  }
  return { kind: 'active' };
}
