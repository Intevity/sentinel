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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeAnthropic, type FakeAnthropic } from './fake-anthropic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

function loadFixture(name: string): Record<string, unknown> {
  const raw = readFileSync(join(FIXTURES, name), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function structurallyMatches(
  expected: unknown,
  actual: unknown,
  path = '$',
): string[] {
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
});
