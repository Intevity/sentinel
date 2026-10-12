/**
 * The add-time API key check, against the fake's real `/v1/models` listener.
 * Each verdict decides what the Add Account form shows, so every refusal the
 * API documents is driven here: a dead key (401), a forbidden one (403), an
 * identity-linked key that needs a workspace (400), an unknown workspace
 * (404), and the "couldn't tell" cases that must not block an offline add.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeAnthropic, type FakeAnthropic } from '@sentinel/test-harness';
import { verifyApiKey } from './api-key-verifier.js';

const KEY = `sk-ant-usr01-${'v'.repeat(95)}`;

describe('verifyApiKey (real HTTP, fake API)', () => {
  let fake: FakeAnthropic;
  let previousUpstream: string | undefined;

  beforeAll(async () => {
    fake = await startFakeAnthropic();
    fake.registerToken(KEY);
    previousUpstream = process.env.ANTHROPIC_UPSTREAM_URL;
    process.env.ANTHROPIC_UPSTREAM_URL = fake.origin;
  });

  afterAll(async () => {
    await fake.close();
    if (previousUpstream === undefined) delete process.env.ANTHROPIC_UPSTREAM_URL;
    else process.env.ANTHROPIC_UPSTREAM_URL = previousUpstream;
  });

  beforeEach(() => fake.resetRequests());

  it('accepts a working key, sending it the way the API reads a key', async () => {
    expect(await verifyApiKey(KEY, 'wrkspc_01Abc')).toEqual({ status: 'valid' });

    const [hit] = fake.requests();
    expect(hit!.method).toBe('GET');
    expect(hit!.url).toBe('/v1/models?limit=1');
    expect(hit!.headers['x-api-key']).toBe(KEY);
    expect(hit!.headers['anthropic-version']).toBe('2023-06-01');
    expect(hit!.headers['anthropic-workspace-id']).toBe('wrkspc_01Abc');
    expect(hit!.headers['authorization']).toBeUndefined();
  });

  it('sends no workspace header when none was given', async () => {
    await verifyApiKey(KEY);
    expect(fake.requests()[0]!.headers['anthropic-workspace-id']).toBeUndefined();
  });

  it('refuses a key Anthropic rejects (401)', async () => {
    const verdict = await verifyApiKey(`sk-ant-api03-${'x'.repeat(95)}`);
    expect(verdict).toEqual({
      status: 'invalid',
      error:
        'Anthropic rejected this API key. Check that it was copied in full and has not been disabled, deleted, or expired.',
    });
  });

  it("refuses a forbidden key, quoting the API's reason when it gives one (403)", async () => {
    fake.queueResponse('/v1/models', {
      status: 403,
      body: { type: 'error', error: { type: 'permission_error', message: 'Key is disabled' } },
    });
    expect(await verifyApiKey(KEY)).toEqual({
      status: 'invalid',
      error: 'This API key is not allowed to use the Claude API: Key is disabled',
    });

    fake.queueResponse('/v1/models', { status: 403, body: 'not json' });
    expect(await verifyApiKey(KEY)).toEqual({
      status: 'invalid',
      error: 'This API key is not allowed to use the Claude API.',
    });
  });

  it('asks for a workspace when an identity-linked key needs one (400)', async () => {
    const workspaceRequired = {
      status: 400,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            'anthropic-workspace-id is required when authenticating with an identity-linked API key; send the id of the workspace this request acts in.',
        },
      },
    };
    fake.queueResponse('/v1/models', workspaceRequired);
    expect(await verifyApiKey(KEY)).toEqual({
      status: 'invalid',
      error:
        'This key works in more than one workspace. Enter the workspace ID (wrkspc_…) it should use, from the Workspaces page in the Claude Console.',
    });

    fake.queueResponse('/v1/models', {
      status: 400,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'anthropic-workspace-id header must be a valid workspace ID.',
        },
      },
    });
    expect(await verifyApiKey(KEY, 'wrkspc_bogus')).toEqual({
      status: 'invalid',
      error: 'That workspace ID is not valid.',
    });
  });

  it('refuses a workspace the key cannot reach (404)', async () => {
    fake.queueResponse('/v1/models', {
      status: 404,
      body: { type: 'error', error: { type: 'not_found_error', message: 'Workspace not found.' } },
    });
    expect(await verifyApiKey(KEY, 'wrkspc_01Other')).toEqual({
      status: 'invalid',
      error: 'Workspace not found, or this key has no access to it.',
    });
  });

  it('leaves the key unverified when the answer proves nothing about it', async () => {
    fake.queueResponse('/v1/models', {
      status: 529,
      body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    });
    expect(await verifyApiKey(KEY)).toEqual({
      status: 'unverified',
      detail: 'HTTP 529: Overloaded',
    });

    // A 404 with no workspace in play is not a statement about the key.
    fake.queueResponse('/v1/models', { status: 404, body: {} });
    expect(await verifyApiKey(KEY)).toEqual({ status: 'unverified', detail: 'HTTP 404' });
  });

  it('leaves the key unverified when Anthropic cannot be reached', async () => {
    const down = await startFakeAnthropic();
    const origin = down.origin;
    await down.close();
    process.env.ANTHROPIC_UPSTREAM_URL = origin;
    try {
      const verdict = await verifyApiKey(KEY);
      expect(verdict.status).toBe('unverified');
      expect(verdict.status === 'unverified' && verdict.detail).toMatch(/ECONNREFUSED/);
    } finally {
      process.env.ANTHROPIC_UPSTREAM_URL = fake.origin;
    }
  });
});
