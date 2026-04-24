/**
 * Migrated from `proxy.test.ts` — Sentinel-side pause short-circuits.
 * These tests don't hit upstream at all; they exercise the 503 + Retry-After
 * dispatch in `createProxyServer` when the selected account is paused.
 * Using the real fake upstream lets us assert that NO request reached it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  startProxyWithFake,
  postThroughProxy,
  getThroughProxy,
  type StartedProxy,
} from './proxy.test-helpers.js';

describe('proxy pause short-circuits (real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  it('returns 503 + budget Retry-After when the active account is paused (budget reason is the default)', async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 600; // 10 min from now
    ctx = await startProxyWithFake({
      accounts: [{ id: 'paused-acct', email: 'paused@example.com', token: 'tok' }],
      tokens: ['tok'],
      getPausedAccountIds: () => new Set(['paused-acct']),
      getSessionResetAt: () => resetSec,
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(503);
    const retry = Number(res.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(600);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('sentinel_budget_paused');
    // Upstream must NOT have been hit.
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(false);
  });

  it('weekly-rate-limit pause uses the 7d reset for Retry-After and the weekly error type', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    ctx = await startProxyWithFake({
      accounts: [{ id: 'paused-acct', email: 'paused@example.com', token: 'tok' }],
      tokens: ['tok'],
      getPausedAccountIds: () => new Set(['paused-acct']),
      getPauseReason: () => 'sentinel_weekly_rate_limit',
      getSessionResetAt: () => nowSec + 600, // 10 min — must NOT be used
      getWeeklyResetAt: () => nowSec + 48 * 3600,
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(503);
    const retry = Number(res.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(600);
    expect(retry).toBeLessThanOrEqual(48 * 3600);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('sentinel_weekly_rate_limit_paused');
    expect(body.error.message).toContain('weekly (7-day) rate limit');
  });

  it('weekly pause short-circuits a non-messages path too', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    ctx = await startProxyWithFake({
      accounts: [{ id: 'paused-acct', email: 'paused@example.com', token: 'tok' }],
      tokens: ['tok'],
      getPausedAccountIds: () => new Set(['paused-acct']),
      getPauseReason: () => 'sentinel_weekly_rate_limit',
      getSessionResetAt: () => null,
      getWeeklyResetAt: () => nowSec + 24 * 3600,
    });

    const res = await getThroughProxy(ctx.proxyPort, '/v1/models');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('sentinel_weekly_rate_limit_paused');
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/models'))).toBe(false);
  });

  it('weekly pause falls back to the 5h reset when no 7d reset is known', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    ctx = await startProxyWithFake({
      accounts: [{ id: 'paused-acct', email: 'paused@example.com', token: 'tok' }],
      tokens: ['tok'],
      getPausedAccountIds: () => new Set(['paused-acct']),
      getPauseReason: () => 'sentinel_weekly_rate_limit',
      getSessionResetAt: () => nowSec + 400,
      getWeeklyResetAt: () => null,
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(503);
    const retry = Number(res.headers.get('retry-after'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(400);
  });

  it('falls back to 300s Retry-After when no reset timestamps are known', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'paused-acct', email: 'paused@example.com', token: 'tok' }],
      tokens: ['tok'],
      getPausedAccountIds: () => new Set(['paused-acct']),
      getSessionResetAt: () => null,
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', { messages: [] });
    expect(res.status).toBe(503);
    expect(Number(res.headers.get('retry-after'))).toBe(300);
  });

  it('does not short-circuit /health when paused (no credential selection happens)', async () => {
    ctx = await startProxyWithFake({
      accounts: [{ id: 'paused-acct', email: 'paused@example.com', token: 'tok' }],
      tokens: ['tok'],
      getPausedAccountIds: () => new Set(['paused-acct']),
      getSessionResetAt: () => null,
    });

    const res = await getThroughProxy(ctx.proxyPort, '/health');
    expect(res.status).toBe(200);
  });
});
