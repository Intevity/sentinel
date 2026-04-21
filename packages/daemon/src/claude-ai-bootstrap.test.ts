import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchBootstrap } from './claude-ai-bootstrap.js';

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
        memberships: [
          { organization: { uuid: 'legacy-org', name: 'Legacy' } },
        ],
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
          { organization: { uuid: 'max',  name: 'Max',      capabilities: ['chat'] } },
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
            { organization: { uuid: 'max',  name: 'Max',      capabilities: ['chat', 'claude_max'] } },
            { organization: { uuid: 'api',  name: 'API',      capabilities: ['api', 'api_individual'] } },
          ],
        },
      }),
    ) as unknown as typeof global.fetch;

    const result = await fetchBootstrap('k', 'team');
    expect(result?.orgs).toEqual([
      { orgUuid: 'team', orgName: 'Intevity', ravenType: null },
      { orgUuid: 'max',  orgName: 'Max',      ravenType: null },
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
});
