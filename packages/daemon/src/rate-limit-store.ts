import type { RateLimitWindow, ClaudeAiUsageSnapshot } from '@claude-sentinel/shared';

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
 *
 * Overage uses an extra boolean header emitted only while the response
 * drew from the overage budget:
 *   anthropic-ratelimit-unified-overage-in-use: "true"
 */
/** A claude.ai-synced reset within this many seconds of the stored
 *  header-derived reset is the same window reported with source jitter,
 *  not a rollover — the stored value wins so downstream consumers (alert
 *  dedup, the earliest-reset rotator) see one stable boundary per window. */
const SYNC_RESET_DRIFT_TOLERANCE_SEC = 120;

export class RateLimitStore {
  private readonly data = new Map<string, Map<string, RateLimitWindow>>();
  private readonly updateCallbacks: Array<(accountId: string, windows: RateLimitWindow[]) => void> =
    [];

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
      const m = key.match(
        /^anthropic-ratelimit-(.+)-(limit|remaining|reset|utilization|status|in-use)$/i,
      );
      if (!m) continue;
      const name = m[1]!;
      const field = m[2]!.toLowerCase();
      if (!windowUpdates.has(name)) windowUpdates.set(name, { name, lastUpdated: now });
      const w = windowUpdates.get(name)!;
      const str = Array.isArray(val) ? val[0] : val;
      if (field === 'limit') w.limit = str != null ? parseInt(str, 10) : null;
      if (field === 'remaining') w.remaining = str != null ? parseInt(str, 10) : null;
      if (field === 'reset') w.reset = str != null ? parseInt(str, 10) : null;
      if (field === 'utilization') w.utilization = str != null ? parseFloat(str) : null;
      if (field === 'status') w.status = str ?? null;
      if (field === 'in-use')
        w.inUse = str != null ? str.toLowerCase() === 'true' || str === '1' : null;
    }

    // Anthropic only emits `unified-overage-in-use` while the response is
    // actively drawing from overage. When any other overage window header is
    // present without it, that means overage is NOT in use — without this
    // coercion the in-memory `inUse` would stay `true` across responses.
    const overageUpdate = windowUpdates.get('unified-overage');
    if (overageUpdate !== undefined && overageUpdate.inUse === undefined) {
      overageUpdate.inUse = false;
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
        inUse: null,
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

  /**
   * Populate rate-limit windows from a ClaudeAiUsageSnapshot. Used to bootstrap
   * data for accounts that have no OAuth token and can't be probed via the
   * api.anthropic.com path (notably silent-sibling team enrollments: they
   * carry a shared sessionKey for claude.ai but no OAuth access token).
   *
   * Freshness rule: the snapshot's `fetchedAt` is compared against each
   * existing window's `lastUpdated`. Claude.ai data is only applied when it
   * is newer than the existing window — so live header updates (captured on
   * every proxy request, typically seconds old) beat the 5-minute-polled
   * claude.ai snapshot when both sources are available. Missing windows are
   * always populated.
   *
   * Fires `onUpdate` callbacks for each window actually written so the DB
   * persistence + spend tracker + overage cache reload stay in sync.
   *
   * Returns the number of windows that were added or refreshed.
   */
  syncFromClaudeAiSnapshot(accountId: string, snapshot: ClaudeAiUsageSnapshot): number {
    const capturedAt = snapshot.fetchedAt || Date.now();

    const toUnixSeconds = (iso: string | null): number | null => {
      if (!iso) return null;
      const ms = Date.parse(iso);
      return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
    };

    // claude.ai doesn't expose the status enum, infer from utilization.
    const statusFor = (util: number | null): string => {
      if (util == null) return 'allowed';
      if (util >= 1) return 'blocked';
      if (util >= 0.9) return 'allowed_warning';
      return 'allowed';
    };

    if (!this.data.has(accountId)) this.data.set(accountId, new Map());
    const accountMap = this.data.get(accountId)!;
    const upserts: RateLimitWindow[] = [];

    const maybeSync = (
      name: string,
      util: number | null,
      resetIso: string | null,
      inUse: boolean | null,
    ): void => {
      if (util == null && resetIso == null) return;
      const existing = accountMap.get(name);
      const existingAt = existing?.lastUpdated ?? 0;
      if (existing && existingAt >= capturedAt) return;
      const w: RateLimitWindow = {
        name,
        status: statusFor(util),
        utilization: util,
        limit: null,
        remaining: null,
        reset: toUnixSeconds(resetIso),
        inUse,
        lastUpdated: capturedAt,
      };
      // Merge onto existing so sync doesn't wipe fields only the header
      // path captures. Specifically: claude.ai occasionally returns null
      // for fiveHourResetsAt and always passes null for inUse — without
      // this guard, a sync would null-out a reset Anthropic's header just
      // set, causing alert dedup (which keys on resetTs) to break and
      // re-fire the alert every time the header and sync alternate.
      //
      // When both sources have a reset for the SAME window, keep the
      // existing (header-derived, epoch-exact) value: claude.ai's ISO
      // timestamp can disagree by seconds, and letting it through made
      // the token rotator's earliest-reset comparison see a phantom
      // ordering change and re-target traffic. Only adopt the synced
      // value when it names a genuinely different window (rollover).
      const sameWindow =
        w.reset != null &&
        existing?.reset != null &&
        Math.abs(w.reset - existing.reset) <= SYNC_RESET_DRIFT_TOLERANCE_SEC;
      const merged: RateLimitWindow = existing
        ? {
            ...existing,
            ...w,
            reset: sameWindow ? existing.reset : (w.reset ?? existing.reset ?? null),
            inUse: w.inUse ?? existing.inUse ?? null,
          }
        : w;
      accountMap.set(name, merged);
      upserts.push(merged);
    };

    maybeSync('unified-5h', snapshot.fiveHourUtilization, snapshot.fiveHourResetsAt, null);
    maybeSync('unified-7d', snapshot.sevenDayUtilization, snapshot.sevenDayResetsAt, null);
    maybeSync(
      'unified-7d_sonnet',
      snapshot.sevenDaySonnetUtilization,
      snapshot.sevenDaySonnetResetsAt,
      null,
    );
    if (snapshot.extraUsage?.isEnabled) {
      const util = snapshot.extraUsage.utilizationPct / 100;
      maybeSync('unified-overage', util, null, false);
    }

    if (upserts.length > 0) {
      for (const cb of this.updateCallbacks) {
        cb(accountId, upserts);
      }
    }
    return upserts.length;
  }
}
