import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { startProxyWithFake, postThroughProxy, type StartedProxy } from './proxy.test-helpers.js';
import { CompressionStatsStore } from './optimize/compress/compression-stats-db.js';

const ESC = '\x1b';

interface UpstreamBody {
  model: string;
  messages: Array<{
    role: string;
    content: Array<Record<string, unknown>>;
  }>;
}

/** A /v1/messages body with one assistant tool_use and one user tool_result
 *  carrying ANSI-laden content plus a cache_control marker. */
function messagesBody(toolResultText: string): UpstreamBody {
  return {
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: toolResultText,
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
  };
}

function tmpStorePath(): string {
  return join(tmpdir(), `sentinel-comp-int-${randomUUID()}.db`);
}

describe('proxy tool_result compression (integration)', () => {
  let started: StartedProxy | null = null;
  let store: CompressionStatsStore | null = null;
  let storePath: string | null = null;

  afterEach(async () => {
    if (started) await started.cleanup();
    if (store) store.close();
    if (storePath) {
      for (const s of ['', '-wal', '-shm']) {
        if (existsSync(storePath + s)) rmSync(storePath + s);
      }
    }
    started = null;
    store = null;
    storePath = null;
  });

  async function start(settings: Record<string, unknown>): Promise<void> {
    storePath = tmpStorePath();
    store = new CompressionStatsStore({ dbPath: storePath });
    started = await startProxyWithFake({ settings, compressionStore: store });
  }

  it('compresses the outbound body, fixes content-length, and preserves cache_control', async () => {
    await start({ compressionEnabled: true, compressionLevel: 'conservative' });
    const noisy = `${ESC}[32mbuild ok${ESC}[0m\n${'log line\n'.repeat(40)}`;
    const res = await postThroughProxy(started!.proxyPort, '/v1/messages', messagesBody(noisy));
    await res.text();
    expect(res.status).toBe(200);

    const reqs = started!.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    const upstream = reqs[reqs.length - 1]!;
    const parsed = JSON.parse(upstream.body) as UpstreamBody;
    const toolResult = parsed.messages[1]!.content[0]!;

    // ANSI was stripped on the wire.
    expect(String(toolResult['content'])).not.toContain(ESC);
    // cache_control survived byte-for-byte.
    expect(toolResult['cache_control']).toEqual({ type: 'ephemeral' });
    // Content-Length matches the actual (compressed) body the fake received.
    expect(Number(upstream.headers['content-length'])).toBe(Buffer.byteLength(upstream.body));

    // A stats row was recorded for the routed account.
    const m = store!.getCompressionMetrics(0);
    expect(m.totals.requestsCompressed).toBe(1);
    expect(m.totals.estTokensSaved).toBeGreaterThan(0);
    expect(m.byTool.find((t) => t.tool === 'Bash')).toBeTruthy();
  });

  it('reversible mode persists the elided original for the id embedded in the body', async () => {
    await start({
      compressionEnabled: true,
      compressionLevel: 'moderate',
      compressionRetrievalEnabled: true,
    });
    const bigLog = Array.from({ length: 500 }, (_, i) => `log line ${i}`).join('\n');
    const res = await postThroughProxy(started!.proxyPort, '/v1/messages', messagesBody(bigLog));
    await res.text();
    expect(res.status).toBe(200);

    const reqs = started!.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    const parsed = JSON.parse(reqs[reqs.length - 1]!.body) as UpstreamBody;
    const content = String(parsed.messages[1]!.content[0]!['content']);
    const id = /id="([0-9a-f]{16})"/.exec(content)?.[1];
    expect(id).toBeTruthy();
    // The proxy persisted the elided original under that id; retrieve returns it.
    const retrieved = store!.getRetrieval(id!);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.originalText).toContain('log line 200');
    // ...which is no longer in the (truncated) body that went upstream.
    expect(content).not.toContain('log line 200');
  });

  it('samples a large JSON array on the wire and persists the original for retrieval', async () => {
    await start({
      compressionEnabled: true,
      compressionLevel: 'aggressive',
      compressionRetrievalEnabled: true,
    });
    const arrayText = JSON.stringify(
      Array.from({ length: 60 }, (_, i) => ({ id: i, name: `item-${i}` })),
    );
    const res = await postThroughProxy(started!.proxyPort, '/v1/messages', messagesBody(arrayText));
    await res.text();
    expect(res.status).toBe(200);

    const reqs = started!.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    const parsed = JSON.parse(reqs[reqs.length - 1]!.body) as UpstreamBody;
    const content = String(parsed.messages[1]!.content[0]!['content']);
    expect(content).toContain('_sentinelSample');
    expect(content).not.toContain('item-30'); // a dropped middle item
    // The retrieval id lives in the sampled object's `note` field.
    const note = (JSON.parse(content) as { _sentinelSample: { note: string } })._sentinelSample
      .note;
    const id = /id="([0-9a-f]{16})"/.exec(note)?.[1];
    expect(id).toBeTruthy();
    // Retrieval restores the exact original array byte-for-byte.
    expect(store!.getRetrieval(id!)?.originalText).toBe(arrayText);
  });

  it('folds a duplicate tool_result on the wire and keeps the original retrievable', async () => {
    await start({
      compressionEnabled: true,
      compressionLevel: 'moderate',
      compressionRetrievalEnabled: true,
    });
    const big = `payload ${'data '.repeat(300)}`;
    const body: UpstreamBody = {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: big }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: big }] },
      ],
    };
    const res = await postThroughProxy(started!.proxyPort, '/v1/messages', body);
    await res.text();
    expect(res.status).toBe(200);

    const reqs = started!.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    const parsed = JSON.parse(reqs[reqs.length - 1]!.body) as UpstreamBody;
    const anchor = String(parsed.messages[1]!.content[0]!['content']);
    const folded = String(parsed.messages[3]!.content[0]!['content']);
    expect(anchor).toBe(big); // first occurrence rides in full
    expect(folded).toContain('identical to an earlier tool result');
    const id = /id="([0-9a-f]{16})"/.exec(folded)?.[1];
    expect(store!.getRetrieval(id!)?.originalText).toBe(big);
  });

  it('measures potential (aggressive dry-run) without changing the body when compression is off', async () => {
    // capture is on by default; compression off → measurement-only.
    await start({ compressionEnabled: false });
    const bigLog = `${ESC}[32mok${ESC}[0m\n${Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')}`;
    const res = await postThroughProxy(started!.proxyPort, '/v1/messages', messagesBody(bigLog));
    await res.text();

    const reqs = started!.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    const parsed = JSON.parse(reqs[reqs.length - 1]!.body) as UpstreamBody;
    // Body forwarded untouched (ANSI still present, no truncation marker).
    expect(String(parsed.messages[1]!.content[0]!['content'])).toContain(ESC);
    expect(reqs[reqs.length - 1]!.body).not.toContain('elided by Sentinel');

    const m = store!.getCompressionMetrics(0);
    expect(m.totals.requestsCompressed).toBe(0);
    expect(m.totals.requestsSkipped).toBe(0); // measure-only is not a skip
    expect(m.totals.estTokensPotential).toBeGreaterThan(0); // "turn it on to save this"
  });

  it('measures additional potential when on at a tier below aggressive', async () => {
    await start({ compressionEnabled: true, compressionLevel: 'conservative' });
    const bigLog = `${ESC}[33mwarn${ESC}[0m\n${Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')}`;
    const res = await postThroughProxy(started!.proxyPort, '/v1/messages', messagesBody(bigLog));
    await res.text();

    const m = store!.getCompressionMetrics(0);
    // Conservative stripped ANSI (realized); aggressive would also truncate.
    expect(m.totals.requestsCompressed).toBe(1);
    expect(m.totals.estTokensSaved).toBeGreaterThan(0);
    expect(m.totals.estTokensPotential).toBeGreaterThan(0);
  });

  it('records no potential when already at the aggressive tier', async () => {
    await start({ compressionEnabled: true, compressionLevel: 'aggressive' });
    const bigLog = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const res = await postThroughProxy(started!.proxyPort, '/v1/messages', messagesBody(bigLog));
    await res.text();

    const m = store!.getCompressionMetrics(0);
    expect(m.totals.requestsCompressed).toBe(1);
    expect(m.totals.estTokensPotential).toBe(0);
  });

  it('forwards the body unchanged when compression is disabled', async () => {
    await start({ compressionEnabled: false });
    const noisy = `${ESC}[31mred${ESC}[0m output`;
    const res = await postThroughProxy(started!.proxyPort, '/v1/messages', messagesBody(noisy));
    await res.text();

    const reqs = started!.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    const parsed = JSON.parse(reqs[reqs.length - 1]!.body) as UpstreamBody;
    const toolResult = parsed.messages[1]!.content[0]!;
    // Still contains ANSI -> not compressed.
    expect(String(toolResult['content'])).toContain(ESC);
    // No rows recorded at all.
    expect(store!.getCompressionMetrics(0).totals.requestsCompressed).toBe(0);
    expect(store!.getCompressionMetrics(0).totals.requestsSkipped).toBe(0);
  });

  it('never compresses probe requests', async () => {
    await start({ compressionEnabled: true, compressionLevel: 'aggressive' });
    const noisy = `${ESC}[36mprobe${ESC}[0m`;
    const res = await postThroughProxy(started!.proxyPort, '/v1/messages', messagesBody(noisy), {
      headers: { 'User-Agent': 'sentinel-probe/1.0' },
    });
    await res.text();

    const reqs = started!.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    const parsed = JSON.parse(reqs[reqs.length - 1]!.body) as UpstreamBody;
    expect(String(parsed.messages[1]!.content[0]!['content'])).toContain(ESC);
    // Probe requests are never recorded.
    expect(store!.getCompressionMetrics(0).totals.requestsCompressed).toBe(0);
  });

  it('records an oversized skip without altering the body', async () => {
    await start({
      compressionEnabled: true,
      compressionLevel: 'conservative',
      compressionMaxBodyKb: 16,
    });
    // Build a body just over 16 KB so the size cap trips.
    const noisy = `${ESC}[33mwarn${ESC}[0m\n${'x'.repeat(20 * 1024)}`;
    const res = await postThroughProxy(started!.proxyPort, '/v1/messages', messagesBody(noisy));
    await res.text();

    const reqs = started!.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    const parsed = JSON.parse(reqs[reqs.length - 1]!.body) as UpstreamBody;
    // Oversized -> forwarded unchanged (ANSI still present).
    expect(String(parsed.messages[1]!.content[0]!['content'])).toContain(ESC);
    const m = store!.getCompressionMetrics(0);
    expect(m.totals.requestsCompressed).toBe(0);
    expect(m.errors.find((e) => e.skipReason === 'oversized')?.count).toBe(1);
  });
});

describe('proxy compression cache stability (integration)', () => {
  let started: StartedProxy | null = null;
  let store: CompressionStatsStore | null = null;
  let storePath: string | null = null;

  afterEach(async () => {
    if (started) await started.cleanup();
    if (store) store.close();
    if (storePath) {
      for (const s of ['', '-wal', '-shm']) {
        if (existsSync(storePath + s)) rmSync(storePath + s);
      }
    }
    started = null;
    store = null;
    storePath = null;
  });

  it('compresses a replayed tool_result to identical bytes across turns', async () => {
    storePath = tmpStorePath();
    store = new CompressionStatsStore({ dbPath: storePath });
    started = await startProxyWithFake({
      settings: { compressionEnabled: true, compressionLevel: 'aggressive' },
      compressionStore: store,
    });

    const originalA = `${ESC}[32mok${ESC}[0m\n${Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')}`;

    // Turn N: history = [tool_use A, tool_result A].
    const turnN = messagesBody(originalA);
    await (await postThroughProxy(started.proxyPort, '/v1/messages', turnN)).text();

    // Turn N+1: Claude Code replays the ORIGINAL tool_result A verbatim and
    // appends a new turn. Compression must reproduce the same bytes for A.
    const turnN1: UpstreamBody = {
      model: 'claude-sonnet-4-6',
      messages: [
        ...turnN.messages,
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_2', name: 'Read', input: {} }] },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'second result' }],
        },
      ],
    };
    await (await postThroughProxy(started.proxyPort, '/v1/messages', turnN1)).text();

    const reqs = started.fake.requests().filter((r) => r.url.startsWith('/v1/messages'));
    expect(reqs.length).toBe(2);
    const bodyN = JSON.parse(reqs[0]!.body) as UpstreamBody;
    const bodyN1 = JSON.parse(reqs[1]!.body) as UpstreamBody;

    const aFromN = bodyN.messages[1]!.content[0]!['content'];
    const aFromN1 = bodyN1.messages[1]!.content[0]!['content'];
    // The replayed A compresses to byte-identical content -> stable cache prefix.
    expect(aFromN1).toBe(aFromN);
    expect(String(aFromN)).not.toContain(ESC);
  });
});
