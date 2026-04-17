import type { RateLimitWindow } from '@claude-sentinel/shared';

/**
 * In-memory store for rate limit windows parsed from anthropic-ratelimit-* response headers.
 * Keyed by accountId; each account holds a map of window name → latest snapshot.
 *
 * Subscription plan header format (utilization-based):
 *   anthropic-ratelimit-unified-5h-status:       "allowed"
 *   anthropic-ratelimit-unified-5h-utilization:  "0.33"   (fraction 0–1)
 *   anthropic-ratelimit-unified-5h-reset:        "1776362400"  (Unix seconds)
 *
 * API-key plan header format (count-based):
 *   anthropic-ratelimit-tokens-limit:     "40000"
 *   anthropic-ratelimit-tokens-remaining: "39000"
 *   anthropic-ratelimit-tokens-reset:     "1776362400"
 */
export class RateLimitStore {
  private readonly data = new Map<string, Map<string, RateLimitWindow>>();
  private readonly updateCallbacks: Array<(accountId: string, windows: RateLimitWindow[]) => void> = [];

  /**
   * Register a callback invoked whenever new rate-limit data arrives from API headers.
   * Not called during loadAccount (DB restore), only on live header updates.
   */
  onUpdate(cb: (accountId: string, windows: RateLimitWindow[]) => void): void {
    this.updateCallbacks.push(cb);
  }

  /**
   * Bulk-load persisted windows into the store (e.g. from SQLite on startup).
   * Does NOT fire onUpdate callbacks.
   */
  loadAccount(accountId: string, windows: RateLimitWindow[]): void {
    if (!this.data.has(accountId)) this.data.set(accountId, new Map());
    const accountMap = this.data.get(accountId)!;
    for (const w of windows) {
      accountMap.set(w.name, w);
    }
  }

  /**
   * Parse anthropic-ratelimit-* headers from an API response and merge into the store.
   */
  update(accountId: string, headers: Record<string, string | string[] | undefined>): void {
    const now = Date.now();
    const windowUpdates = new Map<string, Partial<RateLimitWindow> & { name: string }>();

    for (const [key, val] of Object.entries(headers)) {
      const m = key.match(/^anthropic-ratelimit-(.+)-(limit|remaining|reset|utilization|status)$/i);
      if (!m) continue;
      const name = m[1]!;
      const field = m[2]!.toLowerCase();
      if (!windowUpdates.has(name)) windowUpdates.set(name, { name, lastUpdated: now });
      const w = windowUpdates.get(name)!;
      const str = Array.isArray(val) ? val[0] : val;
      if (field === 'limit')       w.limit       = str != null ? parseInt(str, 10) : null;
      if (field === 'remaining')   w.remaining   = str != null ? parseInt(str, 10) : null;
      if (field === 'reset')       w.reset       = str != null ? parseInt(str, 10) : null;
      if (field === 'utilization') w.utilization = str != null ? parseFloat(str) : null;
      if (field === 'status')      w.status      = str ?? null;
    }

    if (windowUpdates.size === 0) return;

    if (!this.data.has(accountId)) this.data.set(accountId, new Map());
    const accountMap = this.data.get(accountId)!;

    for (const [name, update] of windowUpdates) {
      const existing = accountMap.get(name) ?? {
        name,
        status: null,
        utilization: null,
        limit: null,
        remaining: null,
        reset: null,
        lastUpdated: now,
      };
      accountMap.set(name, { ...existing, ...update } as RateLimitWindow);
    }

    // Notify persistence / broadcast callbacks with the merged windows
    const updated = [...windowUpdates.keys()].map((n) => accountMap.get(n)!);
    for (const cb of this.updateCallbacks) {
      cb(accountId, updated);
    }
  }

  /**
   * Return all rate limit windows for the given accountId.
   */
  getAll(accountId: string): RateLimitWindow[] {
    return [...(this.data.get(accountId)?.values() ?? [])];
  }

  /**
   * Snapshot every account's rate-limit windows. Used by the Accounts tab to
   * render a small 5h utilization indicator on each non-active account pill
   * without having to switch to the account first.
   */
  getAllByAccount(): Record<string, RateLimitWindow[]> {
    const out: Record<string, RateLimitWindow[]> = {};
    for (const [accountId, windows] of this.data) {
      out[accountId] = [...windows.values()];
    }
    return out;
  }

  /**
   * Forget every window stored for an account. Used on account switch so
   * the UI never flashes stale utilization data while the fresh-headers
   * probe is still in flight. The probe's response will repopulate this
   * account's entry via the normal update() path.
   */
  clearAccount(accountId: string): void {
    this.data.delete(accountId);
  }
}
