/**
 * Short-lived correlation table from Anthropic `request-id` → Sentinel
 * account key. Written by the proxy (once per upstream response that
 * carries a `request-id` header) and read by OtelReceiver when an OTEL
 * `api_request` / `api_error` event arrives with the same id.
 *
 * Needed because in round-robin mode the proxy rotates tokens per
 * /v1/messages call but Claude Code only knows about one signed-in user,
 * so its OTEL `user.account_uuid` is the same for every event. The
 * response-header request-id is the one piece of information both sides
 * observe, so it's the only honest correlation key.
 *
 * Bounded by TTL (default 5 minutes — well beyond the 5s log / 60s metric
 * OTEL export intervals) and a max-size sweep to keep memory in check if
 * OTEL is disabled and nothing ever reads the entries.
 */
export class RequestAccountMap {
  private entries = new Map<string, { accountId: string; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number = 5 * 60_000,
    private readonly maxSize: number = 5_000,
  ) {}

  set(requestId: string, accountId: string): void {
    const now = Date.now();
    this.entries.set(requestId, { accountId, expiresAt: now + this.ttlMs });
    if (this.entries.size > this.maxSize) {
      for (const [k, v] of this.entries) {
        if (v.expiresAt <= now) this.entries.delete(k);
      }
      // If the sweep didn't bring us back under, drop the oldest entries
      // by insertion order (Map preserves it) until we do.
      while (this.entries.size > this.maxSize) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
  }

  get(requestId: string): string | null {
    const hit = this.entries.get(requestId);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(requestId);
      return null;
    }
    return hit.accountId;
  }

  size(): number {
    return this.entries.size;
  }
}
