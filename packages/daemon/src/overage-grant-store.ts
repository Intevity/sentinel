import type { OverageCreditGrant } from '@claude-sentinel/shared';
import { readClaudeState } from './claude-state.js';

/**
 * In-memory mirror of `~/.claude.json:overageCreditGrantCache`. Claude Code
 * writes grant data there after every successful API round-trip; we read it
 * so the UI can display "used X of Y weekly overage" per account without
 * making our own calls to Anthropic.
 *
 * Keyed by `accountUuid` — matching how Claude Code itself keys the cache.
 * Callers translating from Sentinel ids must look up AccountInfo.accountUuid.
 *
 * This store is deliberately passive: `load()` re-reads the JSON file on
 * demand (cheap — small file, FS cache is usually hot). Wire callers to
 * invoke load() after any event that may have caused Claude Code to refresh
 * its cache: switch_account, usage probe completion, explicit IPC refresh.
 *
 * Subscribers receive a callback after every reload that actually changed
 * the observed map. No-op when the reloaded contents hash-equal the prior.
 */
export class OverageGrantStore {
  private grants: Record<string, OverageCreditGrant> = {};
  private subscribers: ((grants: Record<string, OverageCreditGrant>) => void)[] = [];
  private readonly filePath: string | undefined;

  constructor(filePath?: string) {
    this.filePath = filePath;
  }

  /**
   * Re-read the claude.json cache. Fires subscribers only if the map
   * contents actually changed (shallow equality by JSON string).
   *
   * Real Anthropic cache shape (observed in the wild):
   *   { [accountUuid]: {
   *       info: {
   *         available: number | false,
   *         eligible: number | false,
   *         granted: number | false,
   *         amount_minor_units: number | null,
   *         currency: string | null,
   *       },
   *       timestamp: number,
   *     } }
   * When the account has no overage provisioned, every field in `info` is
   * `false` / `null` and we skip the entry (the UI expects a "there's a
   * grant" binary rather than a zeroed grant).
   */
  load(): void {
    const state = this.filePath ? readClaudeState(this.filePath) : readClaudeState();
    const raw = state.overageCreditGrantCache;
    const next: Record<string, OverageCreditGrant> = {};
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) {
        if (!k || !v || typeof v !== 'object') continue;
        // Anthropic nests the actual fields under `info`; older daemon code
        // expected them flat. Support both shapes so older fixtures keep
        // working and the real-world shape parses correctly.
        const record = v as unknown as Record<string, unknown>;
        const info = (record['info'] && typeof record['info'] === 'object')
          ? record['info'] as Record<string, unknown>
          : record;
        const available = info['available'];
        const eligible = info['eligible'];
        const granted = info['granted'];
        const amountMinorUnitsRaw = info['amount_minor_units'] ?? info['amountMinorUnits'];
        const currency = info['currency'];
        // Skip entries where the grant isn't actually provisioned. Anthropic
        // uses `false` to signal "no overage on this account"; we don't
        // render those.
        if (
          typeof granted !== 'number' ||
          typeof available !== 'number' ||
          typeof eligible !== 'number'
        ) {
          continue;
        }
        next[k] = {
          available,
          eligible,
          granted,
          amountMinorUnits: typeof amountMinorUnitsRaw === 'number' ? amountMinorUnitsRaw : 0,
          currency: typeof currency === 'string' ? currency : 'USD',
        };
      }
    }
    const changed = JSON.stringify(this.grants) !== JSON.stringify(next);
    this.grants = next;
    if (changed) {
      for (const cb of this.subscribers) cb(this.grants);
    }
  }

  getAll(): Record<string, OverageCreditGrant> {
    return this.grants;
  }

  getOne(accountUuid: string): OverageCreditGrant | null {
    return this.grants[accountUuid] ?? null;
  }

  onUpdate(cb: (grants: Record<string, OverageCreditGrant>) => void): void {
    this.subscribers.push(cb);
  }
}
