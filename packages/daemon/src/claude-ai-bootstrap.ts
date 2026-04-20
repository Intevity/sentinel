/**
 * Helpers for claude.ai's bootstrap endpoints, which return the
 * logged-in user's full membership list (every org/account they belong
 * to on a single Google/email login). We use this to solve the
 * shared-session problem: when the user signs in once, the same
 * sessionKey is valid across all of their enrolled orgs. The Sentinel
 * account registry tracks one row per org, so capturing the sessionKey
 * under only the account that triggered the login leaves the other
 * rows looking "disconnected" until the user clicks Connect on each.
 * By enumerating memberships we can mirror the key into every matching
 * Sentinel row, and on disconnect we can propagate the clear the same
 * way.
 *
 * Endpoint choice:
 *   `https://api.anthropic.com/api/bootstrap` — the obvious candidate,
 *     but in practice its response returns `memberships: []` for our
 *     sessionKey-auth'd session, so it's useless for sibling discovery.
 *     Kept as a fallback in case Anthropic changes either endpoint.
 *
 *   `https://claude.ai/edge-api/bootstrap/{orgUuid}/app_start` — the
 *     endpoint claude.ai's own app calls at start-up. Returns the full
 *     memberships array populated with org name + capabilities, which
 *     is exactly what we need. Requires knowing ONE org uuid (any
 *     membership the user has is fine; the response enumerates them
 *     all regardless of which uuid is in the path). We get that for
 *     free — `set_claude_ai_session_key` is fired from the accountId
 *     the user just connected, and our Sentinel id is the orgUuid.
 *
 *     Risk: Cloudflare bot-mitigation. Mitigated by sending the same
 *     Safari-on-macOS UA we use in the login webview and a claude.ai
 *     Referer so the request looks like an in-app XHR.
 */

const API_BASE = 'https://api.anthropic.com';
const CLAUDE_AI_BASE = 'https://claude.ai';

/**
 * Fire-and-forget GET to `/api/organizations/{uuid}/sync/settings`.
 * claude.ai responds with `Set-Cookie: lastActiveOrg=<uuid>` and a
 * JSON body describing the org's client-visible settings. We don't
 * actually need the body — the side effect (server marks this org
 * as the active one for this session) is what matters. Used by the
 * silent sibling enrollment path so subsequent claude.ai requests
 * (e.g. fetching usage for the new org) are routed correctly.
 *
 * Returns true when the server accepted the call (2xx). False on
 * any failure — callers treat that as "session state might not have
 * flipped; continue anyway, the sessionKey still auths us for every
 * org."
 */
export async function switchActiveOrg(
  sessionKey: string,
  orgUuid: string,
): Promise<boolean> {
  const trimmedKey = sessionKey.trim();
  if (!trimmedKey || !orgUuid) return false;
  const url = `${CLAUDE_AI_BASE}/api/organizations/${encodeURIComponent(orgUuid)}/sync/settings`;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Cookie': `sessionKey=${trimmedKey}; sessionKeyLC=${trimmedKey}; lastActiveOrg=${orgUuid}`,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
          '(KHTML, like Gecko) Version/18.0 Safari/605.1.15',
        'Referer': 'https://claude.ai/',
        'Accept': '*/*',
        'anthropic-client-platform': 'web_claude_ai',
        'anthropic-client-version': '1.0.0',
      },
    });
    console.log(`[SwitchActiveOrg] ${orgUuid} → ${resp.status}`);
    return resp.ok;
  } catch (e) {
    console.warn('[SwitchActiveOrg] failed:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

// Mirrors LOGIN_WEBVIEW_UA in claude_ai_login.rs. Must stay a real
// Safari UA — Cloudflare's rules on claude.ai flag anything else.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/18.0 Safari/605.1.15';

/** Raw shape of the bootstrap response we care about. Two endpoints
 *  return different structures:
 *
 *  - `api.anthropic.com/api/bootstrap` → memberships at the top level
 *  - `claude.ai/edge-api/bootstrap/{org}/app_start` → memberships
 *    nested under `account.memberships`
 *
 *  We declare both locations as optional and let the parser fall back
 *  to whichever is populated. Anthropic returns many more fields on
 *  both endpoints; we only extract what's needed for mirroring so
 *  additions won't break us. */
interface BootstrapMembership {
  organization?: {
    uuid?: string | null;
    name?: string | null;
    capabilities?: string[] | null;
    /** claude.ai's internal plan marker: "team", "claude_max",
     *  "claude_pro", etc. Used to seed Sentinel's planType when we
     *  enroll a sibling without ever running OAuth. */
    raven_type?: string | null;
  } | null;
}

interface BootstrapResponse {
  account?: {
    email_address?: string | null;
    uuid?: string | null;
    display_name?: string | null;
    full_name?: string | null;
    memberships?: BootstrapMembership[] | null;
  } | null;
  memberships?: BootstrapMembership[] | null;
}

export interface BootstrapOrg {
  orgUuid: string;
  /** Display name from claude.ai, e.g. "Intevity" or
   *  "jeff.wooden@intevity.com's Organization". May be empty when the
   *  response schema changes. */
  orgName: string;
  /** claude.ai's raven_type for this org ("team", "claude_max",
   *  "claude_pro", …). Null when the field isn't on the response —
   *  callers fall back to whatever plan-derivation they already had. */
  ravenType: string | null;
}

export interface BootstrapResult {
  /** Email associated with this sessionKey. Used as the grouping key
   *  in the Settings UI so accounts that share a login render
   *  together. */
  email: string | null;
  /** Account UUID (the user's identity, distinct from org uuids).
   *  Comes from `account.uuid` in the edge-api response. */
  accountUuid: string | null;
  /** Claude.ai's `display_name` for the user (e.g. "Jeff"). Null when
   *  the bootstrap response doesn't include it. */
  displayName: string | null;
  /** Every org UUID this session can access. Sentinel accounts whose
   *  `orgUuid` matches one of these should share the same sessionKey
   *  in keychain. Backwards-compat alias for `orgs.map(o => o.orgUuid)`. */
  orgUuids: string[];
  /** Full org list (uuid + name) for chat-capable memberships. Used by
   *  callers that need to show the user a human-readable list of
   *  siblings (e.g. "you also have accounts at Intevity and Jeff's Max
   *  Org — want to add them?"). */
  orgs: BootstrapOrg[];
}

/**
 * Fetch memberships for the given sessionKey. Returns null on any
 * failure (network, auth_expired, parse) — callers should treat that
 * as "no mirroring, just apply the write/delete to the single account
 * we already know about." This keeps the primary Connect/Disconnect
 * path working even when the bootstrap endpoint is flaky or the
 * server has rolled out a schema change we don't yet handle.
 *
 * When `orgUuidHint` is provided (any org the user is a member of —
 * typically the account they just added), we prefer
 * `claude.ai/edge-api/bootstrap/{orgUuidHint}/app_start` since it
 * actually returns the memberships list for chat-capable orgs. Falls
 * back to `/api/bootstrap` on api.anthropic.com when no hint is
 * available or the edge-api request fails.
 */
export async function fetchBootstrap(
  sessionKey: string,
  orgUuidHint?: string,
): Promise<BootstrapResult | null> {
  const trimmed = sessionKey.trim();
  if (!trimmed) {
    console.log('[Bootstrap] sessionKey is blank, skipping fetch');
    return null;
  }

  // Preferred path: claude.ai edge-api. Enumerates every chat-capable
  // membership, which is what we need.
  if (orgUuidHint) {
    const edge = await fetchEdgeApi(trimmed, orgUuidHint);
    if (edge) return edge;
    console.log('[Bootstrap] edge-api returned null, falling back to api.anthropic.com/api/bootstrap');
  }

  // Fallback: api.anthropic.com. In practice returns memberships=0 for
  // our auth, but kept so single-org scenarios still get an email back
  // and in case Anthropic swaps which endpoint includes memberships.
  return fetchApiBootstrap(trimmed);
}

async function fetchEdgeApi(
  sessionKey: string,
  orgUuidHint: string,
): Promise<BootstrapResult | null> {
  const url =
    `${CLAUDE_AI_BASE}/edge-api/bootstrap/${encodeURIComponent(orgUuidHint)}/app_start` +
    `?statsig_hashing_algorithm=djb2&growthbook_format=sdk&include_system_prompts=false`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Cookie': `sessionKeyLC=${sessionKey}; sessionKey=${sessionKey}`,
        'User-Agent': BROWSER_UA,
        'Referer': 'https://claude.ai/',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'anthropic-client-platform': 'web_claude_ai',
        'anthropic-client-version': '1.0.0',
      },
    });
  } catch (e) {
    console.warn('[Bootstrap/edge] fetch error:', e instanceof Error ? e.message : String(e));
    return null;
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.warn(
      `[Bootstrap/edge] non-ok response: ${resp.status} ${resp.statusText} body=${body.slice(0, 200)}`,
    );
    return null;
  }

  // Capture as text first so we can dump the raw body for diagnosis
  // when the shape isn't what we expect. Keeping it cheap: we only
  // log the top-level keys + a bounded snippet, never the full body
  // (which contains auth tokens for analytics SDKs).
  const text = await resp.text();
  let raw: BootstrapResponse;
  try {
    raw = JSON.parse(text) as BootstrapResponse;
  } catch (e) {
    console.warn('[Bootstrap/edge] JSON parse error:', e instanceof Error ? e.message : String(e));
    return null;
  }
  const topLevelKeys = Object.keys(raw as Record<string, unknown>);
  const topCount = raw.memberships?.length ?? 0;
  const nestedCount = raw.account?.memberships?.length ?? 0;
  console.log(
    `[Bootstrap/edge] fetched: email=${raw.account?.email_address ?? '?'} memberships(top)=${topCount} memberships(account)=${nestedCount} topKeys=[${topLevelKeys.join(',')}]`,
  );
  if (topCount === 0 && nestedCount === 0) {
    // Body snippet (first 500 chars) so we can see where the org list
    // is actually living when both expected keys are empty.
    console.log(`[Bootstrap/edge] snippet: ${text.slice(0, 500)}`);
  }
  return parseBootstrapResponse(raw);
}

async function fetchApiBootstrap(sessionKey: string): Promise<BootstrapResult | null> {
  let resp: Response;
  try {
    resp = await fetch(`${API_BASE}/api/bootstrap`, {
      method: 'GET',
      headers: {
        'Cookie': `sessionKeyLC=${sessionKey}; sessionKey=${sessionKey}`,
        'anthropic-client-platform': 'web_claude_ai',
        'anthropic-client-version': '1.0.0',
        'Accept': 'application/json',
      },
    });
  } catch (e) {
    console.warn('[Bootstrap/api] fetch error:', e instanceof Error ? e.message : String(e));
    return null;
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.warn(
      `[Bootstrap/api] non-ok response: ${resp.status} ${resp.statusText} body=${body.slice(0, 200)}`,
    );
    return null;
  }

  let raw: BootstrapResponse;
  try {
    raw = (await resp.json()) as BootstrapResponse;
  } catch (e) {
    console.warn('[Bootstrap/api] JSON parse error:', e instanceof Error ? e.message : String(e));
    return null;
  }
  console.log(
    `[Bootstrap/api] fetched: email=${raw.account?.email_address ?? '?'} memberships=${raw.memberships?.length ?? 0}`,
  );
  return parseBootstrapResponse(raw);
}

function parseBootstrapResponse(raw: BootstrapResponse): BootstrapResult {
  const email = raw.account?.email_address ?? null;
  // Memberships live at different levels depending on endpoint:
  //   /api/bootstrap  → raw.memberships
  //   edge-api/app_start → raw.account.memberships
  // Prefer whichever is non-empty.
  const rawMemberships =
    (raw.memberships && raw.memberships.length > 0
      ? raw.memberships
      : raw.account?.memberships) ?? [];

  // Filter to orgs that actually support claude.ai chat. Anthropic
  // auto-creates an API-evaluation workspace when a user first signs
  // into console.anthropic.com; it shows up in memberships but has
  // `capabilities: ["api", "api_individual"]` with no "chat" entry.
  // claude.ai's own UI hides these from the org switcher, and Sentinel
  // should too — otherwise mirroring writes sessionKey into a row the
  // user can't actually use and the auto-enroll prompt creates dead
  // accounts.
  //
  // Safety: if `capabilities` is missing from the response (older
  // schema, or Anthropic stops returning it), we include the org. This
  // preserves today's behavior rather than silently dropping every org
  // on a schema shift.
  const orgs: BootstrapOrg[] = rawMemberships
    .filter((m) => {
      const caps = m.organization?.capabilities;
      if (!Array.isArray(caps)) return true;
      return caps.includes('chat');
    })
    .map((m) => ({
      orgUuid: m.organization?.uuid ?? '',
      orgName: m.organization?.name ?? '',
      ravenType: m.organization?.raven_type ?? null,
    }))
    .filter((o) => o.orgUuid.length > 0);

  const accountUuid = raw.account?.uuid ?? null;
  const displayName = raw.account?.display_name ?? raw.account?.full_name ?? null;

  return { email, accountUuid, displayName, orgUuids: orgs.map((o) => o.orgUuid), orgs };
}
