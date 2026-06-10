import { describe, it, expect } from 'vitest';
import { CaptureHealthTracker, composeCaptureHealth } from './capture-health.js';
import { SENTINEL_BASE_URL } from './claude-otel-config.js';

describe('CaptureHealthTracker', () => {
  it('reports ok when real proxy traffic flows alongside OTEL activity', () => {
    const t = new CaptureHealthTracker({ windowMs: 1000, minOtelSignal: 3 });
    const now = 10_000;
    for (let i = 0; i < 5; i++) t.recordOtelApiRequest(now);
    t.recordRealProxyRequest(now);
    expect(t.snapshot(now)).toEqual({
      state: 'ok',
      windowMs: 1000,
      otelApiRequests: 5,
      realProxyRequests: 1,
    });
  });

  it('reports proxy-bypassed when OTEL shows activity but no proxy traffic', () => {
    const t = new CaptureHealthTracker({ windowMs: 1000, minOtelSignal: 3 });
    const now = 10_000;
    for (let i = 0; i < 3; i++) t.recordOtelApiRequest(now);
    expect(t.snapshot(now)).toEqual({
      state: 'proxy-bypassed',
      windowMs: 1000,
      otelApiRequests: 3,
      realProxyRequests: 0,
    });
  });

  it('stays ok below the OTEL signal threshold (no false alarm on a quiet install)', () => {
    const t = new CaptureHealthTracker({ windowMs: 1000, minOtelSignal: 3 });
    t.recordOtelApiRequest(10_000);
    t.recordOtelApiRequest(10_000);
    expect(t.snapshot(10_000).state).toBe('ok'); // 2 < 3
  });

  it('prunes events older than the window from both counters', () => {
    const t = new CaptureHealthTracker({ windowMs: 1000, minOtelSignal: 3 });
    for (let i = 0; i < 4; i++) t.recordOtelApiRequest(0);
    t.recordRealProxyRequest(0);
    expect(t.snapshot(0).otelApiRequests).toBe(4);
    // Advance past the window: every recorded event falls out → counts reset.
    expect(t.snapshot(2000)).toEqual({
      state: 'ok',
      windowMs: 1000,
      otelApiRequests: 0,
      realProxyRequests: 0,
    });
  });

  it('a fresh real proxy request inside the window clears a prior bypass', () => {
    const t = new CaptureHealthTracker({ windowMs: 10_000, minOtelSignal: 3 });
    for (let i = 0; i < 3; i++) t.recordOtelApiRequest(1000);
    expect(t.snapshot(1000).state).toBe('proxy-bypassed');
    t.recordRealProxyRequest(1500);
    expect(t.snapshot(1500).state).toBe('ok');
  });

  it('defaults to a 10-minute window and a signal threshold of 3', () => {
    const t = new CaptureHealthTracker();
    expect(t.snapshot(0).windowMs).toBe(10 * 60 * 1000);
    t.recordOtelApiRequest(0);
    t.recordOtelApiRequest(0);
    expect(t.snapshot(0).state).toBe('ok'); // 2 < default 3
    t.recordOtelApiRequest(0);
    expect(t.snapshot(0).state).toBe('proxy-bypassed');
  });
});

describe('composeCaptureHealth', () => {
  const bypassed = {
    state: 'proxy-bypassed' as const,
    windowMs: 600_000,
    otelApiRequests: 5,
    realProxyRequests: 0,
  };

  it('flags settingsBaseUrlRoutesToSentinel true for the loopback proxy URL', () => {
    const h = composeCaptureHealth(bypassed, SENTINEL_BASE_URL);
    expect(h).toEqual({
      ...bypassed,
      settingsBaseUrl: SENTINEL_BASE_URL,
      settingsBaseUrlRoutesToSentinel: true,
    });
  });

  it('treats the legacy localhost form as routing to Sentinel', () => {
    const h = composeCaptureHealth(bypassed, 'http://localhost:47284');
    expect(h.settingsBaseUrlRoutesToSentinel).toBe(true);
  });

  it('flags a foreign base URL as not routing to Sentinel', () => {
    const h = composeCaptureHealth(bypassed, 'https://api.anthropic.com');
    expect(h.settingsBaseUrl).toBe('https://api.anthropic.com');
    expect(h.settingsBaseUrlRoutesToSentinel).toBe(false);
  });

  it('flags an absent base URL as not routing to Sentinel', () => {
    const h = composeCaptureHealth(bypassed, null);
    expect(h.settingsBaseUrl).toBeNull();
    expect(h.settingsBaseUrlRoutesToSentinel).toBe(false);
  });
});
