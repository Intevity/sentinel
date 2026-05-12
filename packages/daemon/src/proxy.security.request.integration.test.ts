/**
 * Migrated from `proxy.test.ts` — security scanner outbound-request
 * gating. The original tests passed a stub scanner into `createProxyServer`
 * and only verified call graph. These integration tests wire the real
 * `createSecurityScanner` against a real db + test settings, exercise the
 * real detector pipeline (AWS-access-key secret, file-read provenance),
 * and prove upstream is never hit on a block.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';

// A high-severity AWS access key that is NOT in the detector's
// KNOWN_EXAMPLE_VALUES allow set AND doesn't trip the placeholder /
// context-drop heuristics (no 4-char sequential digit/letter runs, no
// repeated chars). Hitting those heuristics would pull confidence under
// the 0.9 block floor and the test would observe 'allow' instead of
// 'block_immediate'.
const REAL_LOOKING_AWS_KEY = 'AKIAQRSTVWXYZJNOM230';

function bodyWithFileReadSecret(filePath: string, secret: string): Record<string, unknown> {
  // Mirrors Claude Code's Read → tool_result shape. The scanner follows
  // the tool_use[].input.file_path back from the tool_result to classify
  // provenance as 'file-read', which is what makes the finding blockable.
  return {
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01',
            name: 'Read',
            input: { file_path: filePath },
            index: 0,
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01',
            content: `AWS_ACCESS_KEY_ID=${secret}\nsome other line`,
          },
        ],
      },
    ],
  };
}

describe('proxy securityScanner.scanOutbound (real detector, real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  async function waitForPending(): Promise<string> {
    if (!ctx.scanner) throw new Error('scanner not enabled');
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const pending = ctx.scanner.listPending();
      if (pending.length > 0) return pending[0]!.pendingId;
    }
    throw new Error('scanner never reached pending state');
  }

  it('returns 403 and never forwards when the user denies a held high-severity secret block', async () => {
    ctx = await startProxyWithFake({
      enableSecurityScanner: true,
      settings: {
        securityScanEnabled: true,
        securityScanSecrets: true,
        securityEnforcementMode: 'block_high',
      },
    });

    const body = bodyWithFileReadSecret('/home/alice/secrets.txt', REAL_LOOKING_AWS_KEY);
    const resPromise = postThroughProxy(ctx.proxyPort, '/v1/messages', body);
    const pendingId = await waitForPending();
    // Upstream MUST NOT have been called yet — the hold pauses the proxy.
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(false);
    ctx.scanner!.resolvePending(pendingId, 'deny');

    const res = await resPromise;
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain('Blocked by Claude Sentinel');
    expect(text).toContain('AWS access key');
    // Upstream MUST NOT have seen the request after deny.
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(false);
  });

  it('forwards normally when the scanner finds nothing risky', async () => {
    ctx = await startProxyWithFake({
      enableSecurityScanner: true,
      settings: {
        securityScanEnabled: true,
        securityScanSecrets: true,
        securityEnforcementMode: 'block_high',
      },
    });

    const res = await postThroughProxy(ctx.proxyPort, '/v1/messages', {
      messages: [{ role: 'user', content: 'hello world' }],
    });
    expect(res.status).toBe(200);
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(true);
  });
});

describe('proxy securityScanner held-block approve/deny (real detector, real HTTP)', () => {
  let ctx: StartedProxy;

  afterEach(async () => {
    if (ctx) await ctx.cleanup();
  });

  async function waitForPending(): Promise<string> {
    if (!ctx.scanner) throw new Error('scanner not enabled');
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const pending = ctx.scanner.listPending();
      if (pending.length > 0) return pending[0]!.pendingId;
    }
    throw new Error('scanner never reached pending state');
  }

  it('held-block + approve forwards the buffered body upstream after the user decides', async () => {
    ctx = await startProxyWithFake({
      enableSecurityScanner: true,
      settings: {
        securityScanEnabled: true,
        securityScanSecrets: true,
        securityEnforcementMode: 'block_high',
        securityApproveHoldSec: 60,
      },
    });

    const body = bodyWithFileReadSecret('/home/alice/secrets.txt', REAL_LOOKING_AWS_KEY);
    const resPromise = postThroughProxy(ctx.proxyPort, '/v1/messages', body);

    const pendingId = await waitForPending();
    // Upstream MUST NOT have been called yet.
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(false);

    ctx.scanner!.resolvePending(pendingId, 'approve');
    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(true);
  });

  it('held-block + deny synthesizes a 403 and leaves upstream untouched', async () => {
    ctx = await startProxyWithFake({
      enableSecurityScanner: true,
      settings: {
        securityScanEnabled: true,
        securityScanSecrets: true,
        securityEnforcementMode: 'block_high',
        securityApproveHoldSec: 60,
      },
    });

    const body = bodyWithFileReadSecret('/home/alice/secrets.txt', REAL_LOOKING_AWS_KEY);
    const resPromise = postThroughProxy(ctx.proxyPort, '/v1/messages', body);

    const pendingId = await waitForPending();
    ctx.scanner!.resolvePending(pendingId, 'deny');

    const res = await resPromise;
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Blocked by Claude Sentinel');
    expect(ctx.fake.requests().some((r) => r.url.startsWith('/v1/messages'))).toBe(false);
  });
});
