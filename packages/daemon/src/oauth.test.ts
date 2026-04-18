import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { refreshAccessToken, REFRESH_TOKEN_EXPIRED } from './oauth.js';

describe('refreshAccessToken', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Suppress the console.log/warn emitted by the module.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('POSTs grant_type=refresh_token and parses the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token:  'new-access',
        refresh_token: 'new-refresh',
        expires_in:    3600,
        scope:         'user:profile',
        token_type:    'Bearer',
      }),
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const tokens = await refreshAccessToken('old-refresh');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] ?? [];
    const url = call[0] as string;
    const opts = call[1] as RequestInit | undefined;
    expect(url).toBe('https://platform.claude.com/v1/oauth/token');
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.grant_type).toBe('refresh_token');
    expect(body.refresh_token).toBe('old-refresh');
    expect(body.client_id).toBeTruthy();
    expect(tokens.access_token).toBe('new-access');
    expect(tokens.refresh_token).toBe('new-refresh');
  });

  it('throws REFRESH_TOKEN_EXPIRED on 401', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'invalid_grant',
    }) as unknown as typeof global.fetch;

    await expect(refreshAccessToken('expired')).rejects.toThrow(REFRESH_TOKEN_EXPIRED);
  });

  it('throws REFRESH_TOKEN_EXPIRED on 400', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => 'revoked',
    }) as unknown as typeof global.fetch;

    await expect(refreshAccessToken('revoked')).rejects.toThrow(REFRESH_TOKEN_EXPIRED);
  });

  it('throws a generic error on 5xx with the response body', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => 'maintenance',
    }) as unknown as typeof global.fetch;

    await expect(refreshAccessToken('any')).rejects.toThrow(/503.*maintenance/);
  });

  it('tolerates text() itself failing by using statusText', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: async () => { throw new Error('boom'); },
    }) as unknown as typeof global.fetch;

    await expect(refreshAccessToken('any')).rejects.toThrow(/500.*Server Error/);
  });
});
