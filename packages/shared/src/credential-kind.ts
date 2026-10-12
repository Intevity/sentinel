/**
 * Telling Anthropic credentials apart by prefix.
 *
 * Sentinel stores two kinds of account credential:
 *
 *   - a Claude subscription token, minted by `claude setup-token`
 *     (`sk-ant-oat01-…`). It authenticates as `Authorization: Bearer` and its
 *     usage counts against the subscription's 5-hour and weekly limits.
 *   - an Anthropic API key from the Claude Console. It authenticates as
 *     `x-api-key` and bills to the organization's API credits. A legacy
 *     workspace key reads `sk-ant-api03-…`; a personal or service-account key
 *     (identity-linked, acting as its owner) reads `sk-ant-usr…`.
 *
 * Classification is a denylist rather than an allowlist on purpose. Anthropic
 * documents keys only as starting with `sk-ant-`, and service-account keys have
 * no published prefix at all. Tools that recognised only `sk-ant-api` sent the
 * newer `sk-ant-usr` keys as OAuth tokens and got misleading billing errors
 * back. What is NOT an API key is known and stable, so that is what is listed.
 */

/** Prefixes of `sk-ant-` secrets that are not inference API keys. */
const NON_API_KEY_PREFIXES: ReadonlyArray<{ prefix: string; error: string }> = [
  {
    prefix: 'sk-ant-oat',
    error:
      'That is a Claude subscription token, not an API key. Choose "Claude subscription" to add it.',
  },
  { prefix: 'sk-ant-ort', error: 'That is an OAuth refresh token, not an API key.' },
  { prefix: 'sk-ant-sid', error: 'That is a claude.ai session key, not an API key.' },
  {
    prefix: 'sk-ant-admin',
    error:
      'Admin API keys manage an organization and cannot send messages. Create a standard API key in the Claude Console.',
  },
];

/** Shortest secret accepted as an API key. Real keys run past 100 characters;
 *  the floor only catches a paste that lost most of the key. */
const MIN_API_KEY_LENGTH = 40;

/** True when `token` is an Anthropic API key rather than a subscription token
 *  or another kind of `sk-ant-` secret. Decides how the proxy authenticates a
 *  request (`x-api-key` instead of `Authorization: Bearer`) and that the
 *  credential has no claude.ai subscription usage to read. */
export function isApiKeyCredential(token: string): boolean {
  if (!token.startsWith('sk-ant-')) return false;
  return !NON_API_KEY_PREFIXES.some(({ prefix }) => token.startsWith(prefix));
}

export type ApiKeyInputResult = { ok: true; apiKey: string } | { ok: false; error: string };

/** Validate an API key the user pasted into the Add Account form. Trims the
 *  surrounding whitespace a copy usually carries; returns the key to store, or
 *  the reason it can't be one. Shared by the form (instant feedback) and the
 *  daemon (which must not trust the form). */
export function validateApiKeyInput(raw: string): ApiKeyInputResult {
  const apiKey = raw.trim();
  if (!apiKey) return { ok: false, error: 'Paste an API key.' };
  if (/\s/.test(apiKey)) {
    return { ok: false, error: 'API keys contain no spaces or line breaks. Copy it again.' };
  }
  if (!apiKey.startsWith('sk-ant-')) {
    return { ok: false, error: 'Anthropic API keys start with sk-ant-.' };
  }
  const nonKey = NON_API_KEY_PREFIXES.find(({ prefix }) => apiKey.startsWith(prefix));
  if (nonKey) return { ok: false, error: nonKey.error };
  if (apiKey.length < MIN_API_KEY_LENGTH || !/^sk-ant-[A-Za-z0-9_-]+$/.test(apiKey)) {
    return { ok: false, error: 'That API key looks incomplete. Copy it again in full.' };
  }
  return { ok: true, apiKey };
}

export type WorkspaceIdInputResult =
  | { ok: true; workspaceId: string | undefined }
  | { ok: false; error: string };

/** Validate the optional workspace ID. An identity-linked key that works in
 *  more than one workspace must name the one each request acts in, through the
 *  `anthropic-workspace-id` header; without it the API answers 400. Empty
 *  means "not needed" (a single-workspace or legacy workspace key). */
export function validateWorkspaceIdInput(raw: string | undefined): WorkspaceIdInputResult {
  const workspaceId = raw?.trim() ?? '';
  if (!workspaceId) return { ok: true, workspaceId: undefined };
  if (!/^wrkspc_[A-Za-z0-9_-]+$/.test(workspaceId)) {
    return { ok: false, error: 'Workspace IDs look like wrkspc_01AbC…' };
  }
  return { ok: true, workspaceId };
}
