/**
 * Fetches the per-user "run budget" for a Team-plan member via
 * `/v1/code/routines/run-budget`. Team admins can configure a
 * personal usage cap for each member; this endpoint returns that cap
 * (`limit`) plus the member's spend-to-date (`used`) in dollars.
 *
 * Why this matters for Sentinel: the existing
 * `/api/organizations/{org}/usage` endpoint returns
 * `extra_usage.used_credits`, which is the **team-wide** total across
 * every member — useful for a team admin, misleading for an individual
 * member reading Sentinel's UI as "my usage". The run-budget endpoint
 * gives us the per-user figure so we can show the right number.
 *
 * Availability:
 *   - Team plans: 200 with JSON (even when an admin hasn't configured
 *     a personal budget — `limit` comes back as a string or null).
 *   - Max / Pro (individual) plans: 403 / 404 — endpoint doesn't apply.
 *     Caller treats null return as "no per-user data, fall back to
 *     org-level figures."
 *
 * Host quirk: claude.ai fronts this behind Cloudflare's bot-detection
 * (403 on server-to-server requests). Only api.anthropic.com works
 * for daemon traffic, same as the `/api/organizations/{org}/usage`
 * endpoint.
 */

const BASE_URL = 'https://api.anthropic.com';

interface RawRunBudgetResponse {
  limit?: string | number | null;
  used?: string | number | null;
  unified_billing_enabled?: boolean | null;
  [k: string]: unknown;
}

export interface RunBudget {
  /** Per-user cap in dollars. Null when an admin hasn't configured a
   *  personal budget for this member. */
  limitUsd: number | null;
  /** Member's personal spend in dollars. Null when the response didn't
   *  include a figure (very rare — defensive). */
  usedUsd: number | null;
  /** Whether the org has unified billing enabled. Surfaced mostly for
   *  future UI hints; Sentinel doesn't gate on it today. */
  unifiedBillingEnabled: boolean;
}

/** Parse a run-budget response's `limit`/`used` field, which the API
 *  returns as a STRING even though it's a numeric dollar amount
 *  (observed in live traffic from the Claude web client). Accept both
 *  string and number forms so a rollout to numeric doesn't break us. */
function parseDollarField(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch the per-user run-budget for an org. Returns null on any
 * failure so the caller can uniformly degrade to the team-wide
 * `used_credits` figure — this endpoint is a nice-to-have and
 * shouldn't block the primary usage render.
 */
export async function fetchRunBudget(
  orgUuid: string,
  sessionKey: string,
): Promise<RunBudget | null> {
  const trimmed = sessionKey.trim();
  if (!trimmed || !orgUuid) return null;

  let resp: Response;
  try {
    resp = await fetch(`${BASE_URL}/v1/code/routines/run-budget`, {
      method: 'GET',
      headers: {
        'Cookie': `sessionKeyLC=${trimmed}; sessionKey=${trimmed}`,
        // Beta header gating + org routing header are both required
        // (confirmed via live-captured curl from claude.ai/settings/usage).
        'anthropic-beta': 'ccr-triggers-2026-01-30',
        'anthropic-client-platform': 'web_claude_ai',
        'anthropic-client-version': '1.0.0',
        'anthropic-version': '2023-06-01',
        'x-organization-uuid': orgUuid,
        'Accept': '*/*',
      },
    });
  } catch {
    return null;
  }

  // 403/404 are the expected "this endpoint doesn't apply to your
  // plan" responses (Max/Pro individual). 401 means auth_expired —
  // also a graceful-null case here, since the primary usage path has
  // its own auth_expired surfacing.
  if (!resp.ok) return null;

  let raw: RawRunBudgetResponse;
  try {
    raw = (await resp.json()) as RawRunBudgetResponse;
  } catch {
    return null;
  }

  return {
    limitUsd: parseDollarField(raw.limit),
    usedUsd: parseDollarField(raw.used),
    unifiedBillingEnabled: raw.unified_billing_enabled === true,
  };
}
