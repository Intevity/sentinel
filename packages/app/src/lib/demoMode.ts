/**
 * Demo mode — a hidden, dev-build-only toggle that masks every account's
 * on-screen email, display name, and organization name so the app can be
 * screen-recorded for marketing without exposing the real identity behind the
 * accounts (Anthropic's default org name is "<email>'s Organization", which
 * would otherwise leak the email).
 *
 * IMPORTANT: this is **display-only, in the React webview**. It never touches
 * the daemon — switching, metrics, the proxy, alerts, and ~/.claude.json all
 * keep using the real emails. The masking happens at the IPC boundary
 * (`lib/ipc.ts`) on the way to the screen, so no individual component needs to
 * know about it. The enabled flag lives in `localStorage`, not the daemon
 * `Settings` object, so the daemon is never modified.
 *
 * Numbering: each account gets a stable 1-based index, assigned by enrollment
 * order (`createdAt` ascending, `id` as tiebreak), rendered as
 * `sentinel-demo-<N>@intevity.com` / `Sentinel Demo <N>` / `Organization <N>`.
 */
import type {
  AccountInfo,
  OAuthAccount,
  AppToDaemonMessage,
  DaemonToAppMessage,
  IpcResponse,
} from '@sentinel/shared';

const DEMO_MODE_STORAGE_KEY = 'sentinel.demoMode';
const DEMO_DOMAIN = 'intevity.com';

/** Demo email for a 1-based account index, e.g. `sentinel-demo-1@intevity.com`. */
export function demoEmail(n: number): string {
  return `sentinel-demo-${n}@${DEMO_DOMAIN}`;
}

/** Demo display name for a 1-based account index, e.g. `Sentinel Demo 1`. */
export function demoName(n: number): string {
  return `Sentinel Demo ${n}`;
}

/** Demo organization name for a 1-based account index, e.g. `Organization 1`.
 *  Anthropic's default org name is "<email>'s Organization", which would leak
 *  the real email, so it is masked alongside the email and display name. */
export function demoOrg(n: number): string {
  return `Organization ${n}`;
}

// Used only in the brief race where an `account_switched` broadcast arrives for
// an account the index map hasn't seen yet (no list fetch since it was added).
// A non-numbered placeholder guarantees the real identity can never leak; the
// next `get_accounts` refresh assigns the real number.
const FALLBACK_EMAIL = `sentinel-demo@${DEMO_DOMAIN}`;
const FALLBACK_NAME = 'Sentinel Demo';
const FALLBACK_ORG = 'Organization';

// IPC response types whose `data` is an `AccountInfo[]` we should mask.
const MASKED_LIST_TYPES = new Set<AppToDaemonMessage['type']>([
  'get_accounts',
  'refresh_accounts',
  'get_removed_accounts',
]);

const listeners = new Set<() => void>();

/** Whether demo mode is currently on. Reads `localStorage` each call (cheap) so
 *  it can't go stale relative to the toggle. */
export function isDemoModeEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(DEMO_MODE_STORAGE_KEY) === 'true';
  } catch {
    // Private-mode / disabled storage — treat as off.
    return false;
  }
}

/** Flip demo mode and notify subscribers (the account hooks refetch so the UI
 *  re-renders masked/unmasked immediately, no restart). */
export function setDemoModeEnabled(enabled: boolean): void {
  try {
    if (enabled) {
      globalThis.localStorage?.setItem(DEMO_MODE_STORAGE_KEY, 'true');
    } else {
      globalThis.localStorage?.removeItem(DEMO_MODE_STORAGE_KEY);
    }
  } catch {
    // Storage write failed — still notify so this session reflects the change.
  }
  for (const cb of listeners) cb();
}

/** Subscribe to enable/disable changes. Returns an unsubscribe function. */
export function subscribeDemoMode(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Stable `account id -> 1-based index`, rebuilt whenever a full account list
// passes through `maskAccounts`. `AccountInfo.id` is `orgUuid || accountUuid`
// (sentinelKey), which is the same key `maskOAuthAccount` derives below.
let indexById = new Map<string, number>();

function rebuildIndex(accounts: AccountInfo[]): void {
  const sorted = [...accounts].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const next = new Map<string, number>();
  sorted.forEach((a, i) => next.set(a.id, i + 1));
  indexById = next;
}

/** Mask a full account list (and refresh the stable index map). Returns the
 *  input untouched when demo mode is off. */
export function maskAccounts(accounts: AccountInfo[]): AccountInfo[] {
  if (!isDemoModeEnabled()) return accounts;
  rebuildIndex(accounts);
  return accounts.map((a) => {
    const n = indexById.get(a.id);
    return n === undefined
      ? a
      : { ...a, email: demoEmail(n), displayName: demoName(n), orgName: demoOrg(n) };
  });
}

/** Mask a single active-account record (header, avatars). Resolves the index
 *  via `organizationUuid || accountUuid` against the map built by the last
 *  `maskAccounts`; unknown ids fall back to a non-numbered placeholder so no
 *  real email leaks. Returns the input untouched when demo mode is off. */
export function maskOAuthAccount(account: OAuthAccount): OAuthAccount {
  if (!isDemoModeEnabled()) return account;
  const key = account.organizationUuid || account.accountUuid;
  const n = indexById.get(key);
  return {
    ...account,
    emailAddress: n === undefined ? FALLBACK_EMAIL : demoEmail(n),
    displayName: n === undefined ? FALLBACK_NAME : demoName(n),
    organizationName: n === undefined ? FALLBACK_ORG : demoOrg(n),
  };
}

/** Mask account emails/names on an IPC response on its way to the UI. Only the
 *  account-list responses are touched; everything else passes through. */
export function maskIpcResponse<T>(
  message: AppToDaemonMessage,
  response: IpcResponse<T>,
): IpcResponse<T> {
  if (!isDemoModeEnabled()) return response;
  if (MASKED_LIST_TYPES.has(message.type) && Array.isArray(response.data)) {
    return { ...response, data: maskAccounts(response.data as AccountInfo[]) as unknown as T };
  }
  return response;
}

/** Mask account emails/names on a daemon broadcast on its way to the UI. Only
 *  `account_switched` carries an account; everything else passes through. */
export function maskDaemonBroadcast(msg: DaemonToAppMessage): DaemonToAppMessage {
  if (!isDemoModeEnabled()) return msg;
  if (msg.type === 'account_switched') {
    return { ...msg, to: maskOAuthAccount(msg.to) };
  }
  return msg;
}
