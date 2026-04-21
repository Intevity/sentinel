import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchBootstrap, switchActiveOrg } from './claude-ai-bootstrap.js';

const makeResp = (body: unknown, ok = true) =>
  ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as unknown as Response;

describe('fetchBootstrap', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns null when sessionKey is empty', async () => {
    const result = await fetchBootstrap('   ');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('boom')) as unknown as typeof global.fetch;
    const result = await fetchBootstrap('key');
    expect(result).toBeNull();
  });

  it('returns null on non-ok HTTP response', async () => {
    global.fetch = vi.fn().mockResolvedValue(makeResp({}, false)) as unknown as typeof global.fetch;
    const result = await fetchBootstrap('key');
    expect(result).toBeNull();
  });

  it('returns null on JSON parse error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
    } as unknown as Response) as unknown as typeof global.fetch;
    const result = await fetchBootstrap('key');
    expect(result).toBeNull();
  });

  it('filters out orgs without the "chat" capability', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      makeResp({
        account: { email_address: 'jeff@example.com' },
        memberships: [
          {
            organization: {
              uuid: 'team-org',
              name: 'Intevity',
              capabilities: ['chat', 'raven'],
            },
          },
          {
            organization: {
              uuid: 'max-org',
              name: 'Jeff Max',
              capabilities: ['chat', 'claude_max'],
            },
          },
          {
            organization: {
              uuid: 'api-eval-org',
              name: 'API eval',
              capabilities: ['api', 'api_individual'],
            },
          },
        ],
      }),
    ) as unknown as typeof global.fetch;

    const result = await fetchBootstrap('key');
    expect(result).toEqual({
      email: 'jeff@example.com',
      accountUuid: null,
      displayName: null,
      orgUuids: ['team-org', 'max-org'],
      orgs: [
        { orgUuid: 'team-org', orgName: 'Intevity', ravenType: null },
        { orgUuid: 'max-org', orgName: 'Jeff Max', ravenType: null },
      ],
    });
  });

  it('includes orgs that lack a capabilities field (schema fallback)', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      makeResp({
        account: { email_address: 'jeff@example.com' },
        memberships: [{ organization: { uuid: 'legacy-org', name: 'Legacy' } }],
      }),
    ) as unknown as typeof global.fetch;

    const result = await fetchBootstrap('key');
    expect(result).toEqual({
      email: 'jeff@example.com',
      accountUuid: null,
      displayName: null,
      orgUuids: ['legacy-org'],
      orgs: [{ orgUuid: 'legacy-org', orgName: 'Legacy', ravenType: null }],
    });
  });

  it('handles missing account and memberships fields', async () => {
    global.fetch = vi.fn().mockResolvedValue(makeResp({})) as unknown as typeof global.fetch;
    const result = await fetchBootstrap('key');
    expect(result).toEqual({
      email: null,
      accountUuid: null,
      displayName: null,
      orgUuids: [],
      orgs: [],
    });
  });

  it('sends both sessionKey and sessionKeyLC cookies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResp({ memberships: [] }));
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await fetchBootstrap('secret-key');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.anthropic.com/api/bootstrap',
      expect.objectContaining({
        headers: expect.objectContaining({
          Cookie: 'sessionKeyLC=secret-key; sessionKey=secret-key',
        }),
      }),
    );
  });

  it('skips memberships with blank uuid', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      makeResp({
        memberships: [
          { organization: { uuid: '', capabilities: ['chat'] } },
          { organization: { uuid: 'good', capabilities: ['chat'] } },
        ],
      }),
    ) as unknown as typeof global.fetch;

    const result = await fetchBootstrap('key');
    expect(result?.orgUuids).toEqual(['good']);
  });

  it('uses the edge-api URL when orgUuidHint is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResp({
        account: { email_address: 'jeff@example.com' },
        memberships: [
          { organization: { uuid: 'team', name: 'Intevity', capabilities: ['chat'] } },
          { organization: { uuid: 'max', name: 'Max', capabilities: ['chat'] } },
        ],
      }),
    );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const result = await fetchBootstrap('k', 'team');
    expect(result?.orgs).toHaveLength(2);

    const call = fetchMock.mock.calls[0]!;
    const url = call[0] as string;
    const init = call[1] as { headers: Record<string, string> };
    expect(url).toBe(
      'https://claude.ai/edge-api/bootstrap/team/app_start' +
        '?statsig_hashing_algorithm=djb2&growthbook_format=sdk&include_system_prompts=false',
    );
    expect(init.headers.Referer).toBe('https://claude.ai/');
    expect(init.headers['User-Agent']).toMatch(/Safari/);
  });

  it('reads memberships from account.memberships (edge-api shape)', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      makeResp({
        account: {
          email_address: 'jeff@example.com',
          memberships: [
            { organization: { uuid: 'team', name: 'Intevity', capabilities: ['chat'] } },
            { organization: { uuid: 'max', name: 'Max', capabilities: ['chat', 'claude_max'] } },
            { organization: { uuid: 'api', name: 'API', capabilities: ['api', 'api_individual'] } },
          ],
        },
      }),
    ) as unknown as typeof global.fetch;

    const result = await fetchBootstrap('k', 'team');
    expect(result?.orgs).toEqual([
      { orgUuid: 'team', orgName: 'Intevity', ravenType: null },
      { orgUuid: 'max', orgName: 'Max', ravenType: null },
    ]);
  });

  it('falls back to /api/bootstrap when edge-api fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResp({}, false))
      .mockResolvedValueOnce(
        makeResp({
          account: { email_address: 'jeff@example.com' },
          memberships: [{ organization: { uuid: 'fallback', name: 'FB', capabilities: ['chat'] } }],
        }),
      );
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const result = await fetchBootstrap('k', 'hint');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = fetchMock.mock.calls[1]![0] as string;
    expect(secondUrl).toBe('https://api.anthropic.com/api/bootstrap');
    expect(result?.orgUuids).toEqual(['fallback']);
  });

  it('edge-api: returns null on network error and falls back to /api/bootstrap', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(
        makeResp({
          account: { email_address: 'jeff@example.com' },
          memberships: [{ organization: { uuid: 'fb', name: 'FB', capabilities: ['chat'] } }],
        }),
      );
    global.fetch = fetchMock as unknown as typeof global.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await fetchBootstrap('k', 'hint');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result?.orgUuids).toEqual(['fb']);
    warnSpy.mockRestore();
  });

  it('edge-api + api-bootstrap: log `String(e)` branch when fetch rejects with a non-Error', async () => {
    const fetchMock = vi
      .fn()
      // edge-api: reject with a raw string (not an Error) — hits the
      // String(e) branch of the ternary in the catch handler.
      .mockRejectedValueOnce('raw-edge-throw')
      // api-bootstrap fallback: also reject with a non-Error to hit the
      // same branch in fetchApiBootstrap's catch.
      .mockRejectedValueOnce({ weird: 'obj' });
    global.fetch = fetchMock as unknown as typeof global.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await fetchBootstrap('k', 'hint');
    warnSpy.mockRestore();
    expect(result).toBeNull();
  });

  it('api-bootstrap: log `String(e)` branch on json() parse rejection with non-Error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw 'raw-parse-throw';
      },
    } as unknown as Response) as unknown as typeof global.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await fetchBootstrap('k');
    warnSpy.mockRestore();
    expect(result).toBeNull();
  });

  it('edge-api: accepts an org with ravenType set on the membership', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        JSON.stringify({
          account: {
            email_address: 'x@y.z',
            memberships: [
              {
                organization: {
                  uuid: 'org-m',
                  name: 'M',
                  capabilities: ['chat'],
                  raven_type: 'claude_max',
                },
              },
            ],
          },
        }),
    } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof global.fetch;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await fetchBootstrap('k', 'hint');
    logSpy.mockRestore();
    expect(result?.orgs).toEqual([{ orgUuid: 'org-m', orgName: 'M', ravenType: 'claude_max' }]);
  });

  it('edge-api: returns null when resp.text() fails during non-ok diagnosis and then falls back', async () => {
    const failingResp = {
      ok: false,
      status: 500,
      statusText: 'ISE',
      text: async () => {
        throw new Error('read failed');
      },
    } as unknown as Response;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(failingResp)
      .mockResolvedValueOnce(makeResp({ memberships: [] }));
    global.fetch = fetchMock as unknown as typeof global.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await fetchBootstrap('k', 'hint');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).not.toBeNull();
    warnSpy.mockRestore();
  });

  it('edge-api: returns null on JSON parse failure and then falls back to /api/bootstrap', async () => {
    const badJsonResp = {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => 'not-json{',
    } as unknown as Response;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(badJsonResp)
      .mockResolvedValueOnce(
        makeResp({
          memberships: [{ organization: { uuid: 'z', name: 'z', capabilities: ['chat'] } }],
        }),
      );
    global.fetch = fetchMock as unknown as typeof global.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await fetchBootstrap('k', 'hint');
    expect(result?.orgUuids).toEqual(['z']);
    warnSpy.mockRestore();
  });

  it('edge-api: logs snippet when the body returns zero memberships at both levels', async () => {
    // Returns an ok response with a body that parses but contains no
    // memberships — exercises the `topCount === 0 && nestedCount === 0`
    // snippet-logging branch.
    const emptyResp = {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ account: { email_address: 'x@y.z' } }),
    } as unknown as Response;
    global.fetch = vi.fn().mockResolvedValue(emptyResp) as unknown as typeof global.fetch;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await fetchBootstrap('k', 'hint');
    logSpy.mockRestore();
    expect(result).toEqual({
      email: 'x@y.z',
      accountUuid: null,
      displayName: null,
      orgUuids: [],
      orgs: [],
    });
  });

  it('api-bootstrap: returns null on json() parse error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new Error('bad');
      },
    } as unknown as Response) as unknown as typeof global.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await fetchBootstrap('k');
    warnSpy.mockRestore();
    expect(result).toBeNull();
  });
});

describe('switchActiveOrg', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns false for blank sessionKey', async () => {
    expect(await switchActiveOrg('   ', 'org-1')).toBe(false);
  });

  it('returns false when orgUuid is blank', async () => {
    expect(await switchActiveOrg('key', '')).toBe(false);
  });

  it('returns true on a 2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof global.fetch;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ok = await switchActiveOrg('key', 'org-1');
    logSpy.mockRestore();
    expect(ok).toBe(true);
    // URL should target the sync/settings endpoint.
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toContain('/api/organizations/org-1/sync/settings');
    const init = call[1] as { headers: Record<string, string> };
    expect(init.headers.Cookie).toContain('sessionKey=key');
    expect(init.headers.Cookie).toContain('lastActiveOrg=org-1');
  });

  it('returns false on a non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
    } as unknown as Response) as unknown as typeof global.fetch;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ok = await switchActiveOrg('key', 'org-1');
    logSpy.mockRestore();
    expect(ok).toBe(false);
  });

  it('returns false when fetch throws (network error)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('econn')) as unknown as typeof global.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ok = await switchActiveOrg('key', 'org-1');
    warnSpy.mockRestore();
    expect(ok).toBe(false);
  });

  it('returns false when fetch throws a non-Error value', async () => {
    // Exercises the String(e) branch inside the catch.
    global.fetch = vi.fn().mockRejectedValue('raw-string-throw') as unknown as typeof global.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ok = await switchActiveOrg('key', 'org-1');
    warnSpy.mockRestore();
    expect(ok).toBe(false);
  });
});
