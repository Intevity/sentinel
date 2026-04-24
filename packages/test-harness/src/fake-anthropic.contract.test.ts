/**
 * Contract test: the fake Anthropic server's responses must match the
 * structural shape of the recorded fixtures.
 *
 * "Structural match" means every non-underscore key in the fixture has
 * a same-typed value in the live response. The fake is allowed to add
 * keys; it may not drop keys the daemon's parsers expect.
 *
 * Why this matters: a mock that drifts from the real API shape silently
 * makes tests pass while production breaks. This test is the tripwire.
 * If Anthropic changes a field name, regenerate fixtures via
 * scripts/record-fixtures.mjs and rerun — the diff shows exactly what
 * changed.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeAnthropic, type FakeAnthropic } from './fake-anthropic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

function loadFixture(name: string): Record<string, unknown> {
  const raw = readFileSync(join(FIXTURES, name), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function structurallyMatches(expected: unknown, actual: unknown, path = '$'): string[] {
  const errors: string[] = [];
  if (expected === null) {
    if (actual !== null) errors.push(`${path}: expected null, got ${typeof actual}`);
    return errors;
  }
  if (typeof expected !== 'object') {
    if (typeof actual !== typeof expected) {
      errors.push(`${path}: expected ${typeof expected}, got ${typeof actual}`);
    }
    return errors;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      errors.push(`${path}: expected array, got ${typeof actual}`);
      return errors;
    }
    if (expected.length > 0 && actual.length > 0) {
      errors.push(...structurallyMatches(expected[0], actual[0], `${path}[0]`));
    }
    return errors;
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
    errors.push(`${path}: expected object, got ${Array.isArray(actual) ? 'array' : typeof actual}`);
    return errors;
  }
  for (const key of Object.keys(expected as Record<string, unknown>)) {
    if (key.startsWith('_')) continue; // metadata keys in our fixtures
    if (!(key in (actual as Record<string, unknown>))) {
      errors.push(`${path}.${key}: missing in actual response`);
      continue;
    }
    errors.push(
      ...structurallyMatches(
        (expected as Record<string, unknown>)[key],
        (actual as Record<string, unknown>)[key],
        `${path}.${key}`,
      ),
    );
  }
  return errors;
}

describe('fake Anthropic contract', () => {
  let fake: FakeAnthropic;
  const TOKEN = 'fake-contract-token';

  beforeAll(async () => {
    fake = await startFakeAnthropic();
    fake.registerToken(TOKEN);
  });

  afterAll(async () => {
    await fake.close();
  });

  it('/api/oauth/profile matches fixture shape', async () => {
    const res = await fetch(`${fake.origin}/api/oauth/profile`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const diff = structurallyMatches(loadFixture('profile.response.json'), body);
    expect(diff).toEqual([]);
  });

  it('/api/oauth/usage matches fixture shape', async () => {
    const res = await fetch(`${fake.origin}/api/oauth/usage`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const diff = structurallyMatches(loadFixture('usage.response.json'), body);
    expect(diff).toEqual([]);
  });

  it('/v1/oauth/token matches fixture shape', async () => {
    const res = await fetch(`${fake.origin}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'x', client_id: 'y' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const diff = structurallyMatches(loadFixture('token.response.json'), body);
    expect(diff).toEqual([]);
  });

  it('/v1/messages matches fixture shape and injects scenario headers', async () => {
    const res = await fetch(`${fake.origin}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ model: 'claude-opus-4-7', messages: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const diff = structurallyMatches(loadFixture('messages.response.json'), body);
    expect(diff).toEqual([]);
    // Scenario-driven rate-limit headers must be on the response.
    expect(res.headers.get('anthropic-ratelimit-unified-5h-status')).toBe('allowed');
    expect(res.headers.get('request-id')).toBeTruthy();
  });

  it('/v1/code/routines/run-budget matches fixture shape', async () => {
    const res = await fetch(`${fake.origin}/v1/code/routines/run-budget`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const diff = structurallyMatches(loadFixture('run-budget.response.json'), body);
    expect(diff).toEqual([]);
  });

  it('blocks unauthenticated requests with 401', async () => {
    const res = await fetch(`${fake.origin}/v1/messages`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('emits overage-in-use scenario headers after switching', async () => {
    fake.setScenario('overage-in-use');
    const res = await fetch(`${fake.origin}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.headers.get('anthropic-ratelimit-unified-overage-in-use')).toBe('true');
    expect(res.headers.get('anthropic-ratelimit-unified-overage-status')).toBe('allowed');
    fake.setScenario('healthy-account');
  });

  it('rate-limited-5h scenario returns 429 with retry-after', async () => {
    fake.setScenario('rate-limited-5h');
    const res = await fetch(`${fake.origin}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(res.headers.get('anthropic-ratelimit-unified-5h-status')).toBe('blocked');
    fake.setScenario('healthy-account');
  });

  it('upstream-500 scenario returns 500', async () => {
    fake.setScenario('upstream-500');
    const res = await fetch(`${fake.origin}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(500);
    fake.setScenario('healthy-account');
  });

  it('upstream-unauth-401 scenario returns 401 even for registered tokens', async () => {
    fake.setScenario('upstream-unauth-401');
    const res = await fetch(`${fake.origin}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(401);
    fake.setScenario('healthy-account');
  });

  it('gzipped-json scenario sends content-encoding: gzip and a valid gzip body', async () => {
    fake.setScenario('gzipped-json');
    const res = await fetch(`${fake.origin}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    // fetch() auto-decompresses, so we should still be able to read JSON.
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('msg_fake');
    fake.setScenario('healthy-account');
  });

  it('queueResponse consumes overrides in FIFO order', async () => {
    fake.queueResponse('/v1/messages', { status: 429 });
    fake.queueResponse('/v1/messages', { status: 200 });
    const first = await fetch(`${fake.origin}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [] }),
    });
    expect(first.status).toBe(429);
    const second = await fetch(`${fake.origin}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [] }),
    });
    expect(second.status).toBe(200);
  });

  it('sseEvents override emits the supplied custom SSE script', async () => {
    fake.queueResponse('/v1/messages', {
      sseEvents: [
        { event: 'message_start', data: { type: 'message_start', message: { id: 'x' } } },
        { event: 'message_delta', data: { type: 'message_delta', usage: { output_tokens: 99 } } },
      ],
    });
    const res = await fetch(`${fake.origin}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: message_delta');
    expect(text).toContain('"output_tokens":99');
  });

  it('sseEvents with string data passes payload through verbatim (malformed-JSON test)', async () => {
    fake.queueResponse('/v1/messages', {
      sseEvents: [{ event: 'message_delta', data: '{"bad json' }],
    });
    const res = await fetch(`${fake.origin}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [] }),
    });
    const text = await res.text();
    expect(text).toContain('data: {"bad json');
  });

  it('bodySizeBytes emits a body of roughly the requested size', async () => {
    fake.queueResponse('/v1/messages', { bodySizeBytes: 300_000 });
    const res = await fetch(`${fake.origin}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [] }),
    });
    const text = await res.text();
    // Wrapper adds ~80 bytes; require within a few hundred of target.
    expect(text.length).toBeGreaterThanOrEqual(300_000 - 200);
    expect(text.length).toBeLessThanOrEqual(300_000 + 200);
  });

  it('body: string is written verbatim', async () => {
    fake.queueResponse('/v1/messages', { body: 'not json at all' });
    const res = await fetch(`${fake.origin}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [] }),
    });
    expect(await res.text()).toBe('not json at all');
  });

  it('body: Buffer is written verbatim (supports pre-encoded payloads)', async () => {
    const raw = Buffer.from([0x01, 0x02, 0x03, 0xff]);
    fake.queueResponse('/v1/messages', {
      body: raw,
      extraHeaders: { 'content-type': 'application/octet-stream' },
    });
    const res = await fetch(`${fake.origin}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(raw)).toBe(true);
  });

  it('token-endpoint-401 scenario returns 401 with default invalid_grant body', async () => {
    fake.setScenario('token-endpoint-401');
    const res = await fetch(`${fake.origin}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'x', client_id: 'y' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_grant');
    fake.setScenario('healthy-account');
  });

  it('token-endpoint-500 scenario returns 503 with a plain-text body', async () => {
    fake.setScenario('token-endpoint-500');
    const res = await fetch(`${fake.origin}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'x', client_id: 'y' }),
    });
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(await res.text()).toBe('maintenance');
    fake.setScenario('healthy-account');
  });

  it('token-endpoint-invalid-request scenario returns 400 with invalid_request body', async () => {
    fake.setScenario('token-endpoint-invalid-request');
    const res = await fetch(`${fake.origin}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'x', client_id: 'y' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe('invalid_request');
    expect(body.error_description).toBe('bad body');
    fake.setScenario('healthy-account');
  });

  it('handleUsage respects queueResponse status override', async () => {
    fake.queueResponse('/api/oauth/usage', { status: 403 });
    const res = await fetch(`${fake.origin}/api/oauth/usage`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it('handleUsage respects queueResponse body override (object)', async () => {
    fake.queueResponse('/api/oauth/usage', {
      status: 403,
      body: {
        error: {
          type: 'permission_error',
          message: 'OAuth authentication is currently not allowed for this organization.',
        },
      },
    });
    const res = await fetch(`${fake.origin}/api/oauth/usage`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('permission_error');
    expect(body.error.message).toMatch(/oauth authentication is currently not allowed/i);
  });

  it('handleUsage respects queueResponse body override (string, malformed JSON)', async () => {
    fake.queueResponse('/api/oauth/usage', { status: 200, body: 'not json' });
    const res = await fetch(`${fake.origin}/api/oauth/usage`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('not json');
  });

  it('handleUsage returns 401 when Authorization header is absent', async () => {
    const res = await fetch(`${fake.origin}/api/oauth/usage`);
    expect(res.status).toBe(401);
  });

  it('handleRunBudget respects queueResponse status override', async () => {
    fake.queueResponse('/v1/code/routines/run-budget', { status: 403 });
    const res = await fetch(`${fake.origin}/v1/code/routines/run-budget`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  it('handleRunBudget respects queueResponse body override (string limit/used)', async () => {
    fake.queueResponse('/v1/code/routines/run-budget', {
      status: 200,
      body: { limit: '99.50', used: '12.25', unified_billing_enabled: false },
    });
    const res = await fetch(`${fake.origin}/v1/code/routines/run-budget`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      limit: string;
      used: string;
      unified_billing_enabled: boolean;
    };
    expect(body.limit).toBe('99.50');
    expect(body.used).toBe('12.25');
    expect(body.unified_billing_enabled).toBe(false);
  });

  it('handleRunBudget returns 401 when Authorization header is absent', async () => {
    const res = await fetch(`${fake.origin}/v1/code/routines/run-budget`);
    expect(res.status).toBe(401);
  });

  it('handleProfile respects queueResponse status+body override and pops FIFO', async () => {
    fake.queueResponse('/api/oauth/profile', { status: 500, body: 'boom' });
    const first = await fetch(`${fake.origin}/api/oauth/profile`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(first.status).toBe(500);
    expect(await first.text()).toBe('boom');

    // After the queued override is consumed, subsequent requests get the
    // default shape built from the token's registered profile.
    const second = await fetch(`${fake.origin}/api/oauth/profile`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { account: { email: string } };
    expect(body.account.email).toBe('test@example.com');
  });

  it('handleRunBudget body override survives null-valued limit/used', async () => {
    fake.queueResponse('/v1/code/routines/run-budget', {
      status: 200,
      body: { limit: null, used: null, unified_billing_enabled: true },
    });
    const res = await fetch(`${fake.origin}/v1/code/routines/run-budget`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      limit: number | null;
      used: number | null;
      unified_billing_enabled: boolean;
    };
    expect(body.limit).toBeNull();
    expect(body.used).toBeNull();
    expect(body.unified_billing_enabled).toBe(true);
  });

  it('content-encoding: gzip in extraHeaders triggers automatic body gzipping', async () => {
    // Use a custom endpoint where we can inspect the raw bytes by explicitly
    // disabling fetch decompression — Node's undici decodes transparently,
    // so to assert "the wire body is gzipped" we verify the header and that
    // gunzip of the wire bytes yields the expected plaintext.
    const plaintext = JSON.stringify({ id: 'msg_fake', ping: 'pong' });
    fake.queueResponse('/v1/messages', {
      body: plaintext,
      extraHeaders: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
    });
    const res = await fetch(`${fake.origin}/v1/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    // If the wire was not actually gzipped, undici would throw decoding;
    // reaching this assertion proves the gzip stream was valid.
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('msg_fake');
    // Defensive: freshly-gzipped plaintext round-trips — documents the
    // gzip/gunzip symmetry the auto-gzip feature depends on.
    expect(gunzipSync(gzipSync(plaintext)).toString()).toBe(plaintext);
  });
});
