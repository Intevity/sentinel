/**
 * Check an Anthropic API key before Sentinel stores it.
 *
 * `GET /v1/models` is the cheapest request that proves a key: it bills
 * nothing, needs no model or prompt, and answers with the same authentication
 * and workspace errors a `/v1/messages` call would. Doing it at add time turns
 * a mistyped key, or an identity-linked key that needs a workspace, into a
 * message in the Add Account form instead of a 401 on the user's next prompt.
 */

import { getAnthropicOrigin } from './hosts.js';
import { sentinelRequest } from './http-identity.js';

/** The add form is waiting on this answer, and the app gives an IPC request
 *  10 s in all. A slower check stores the key unverified rather than failing
 *  the add. */
const VERIFY_TIMEOUT_MS = 6_000;

export type ApiKeyVerdict =
  /** Anthropic accepted the key (and workspace, when one was given). */
  | { status: 'valid' }
  /** Anthropic refused it. `error` is shown to the user; don't store. */
  | { status: 'invalid'; error: string }
  /** No definitive answer (network failure, timeout, 429, 5xx). The key may
   *  well be fine, so the caller stores it and the first request decides. */
  | { status: 'unverified'; detail: string };

/** The `error.message` of an Anthropic error body, if it has one. */
function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const msg = parsed.error?.message;
    return typeof msg === 'string' ? msg : '';
  } catch {
    return '';
  }
}

export async function verifyApiKey(apiKey: string, workspaceId?: string): Promise<ApiKeyVerdict> {
  let res;
  try {
    res = await sentinelRequest(`${getAnthropicOrigin()}/v1/models?limit=1`, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        ...(workspaceId ? { 'anthropic-workspace-id': workspaceId } : {}),
      },
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
  } catch (err) {
    return { status: 'unverified', detail: err instanceof Error ? err.message : String(err) };
  }

  if (res.status >= 200 && res.status < 300) return { status: 'valid' };

  const message = errorMessage(res.body);
  if (res.status === 401) {
    return {
      status: 'invalid',
      error:
        'Anthropic rejected this API key. Check that it was copied in full and has not been disabled, deleted, or expired.',
    };
  }
  if (res.status === 403) {
    return {
      status: 'invalid',
      error: `This API key is not allowed to use the Claude API${message ? `: ${message}` : '.'}`,
    };
  }
  if (res.status === 400 && /anthropic-workspace-id/i.test(message)) {
    return {
      status: 'invalid',
      error: workspaceId
        ? 'That workspace ID is not valid.'
        : 'This key works in more than one workspace. Enter the workspace ID (wrkspc_…) it should use, from the Workspaces page in the Claude Console.',
    };
  }
  if (res.status === 404 && workspaceId) {
    return {
      status: 'invalid',
      error: 'Workspace not found, or this key has no access to it.',
    };
  }
  return { status: 'unverified', detail: `HTTP ${res.status}${message ? `: ${message}` : ''}` };
}
