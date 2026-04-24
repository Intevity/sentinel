import { describe, expect, it } from 'vitest';
import { rewriteCacheControlTtl } from './rewriter.js';
import { parseCacheControlMarkers } from './parser.js';

function buf(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj), 'utf-8');
}

function parse(b: Buffer): Record<string, unknown> {
  return JSON.parse(b.toString('utf-8')) as Record<string, unknown>;
}

describe('rewriteCacheControlTtl', () => {
  it('returns the original buffer for malformed JSON', () => {
    const b = Buffer.from('{not json');
    expect(rewriteCacheControlTtl(b, '1h')).toBe(b);
  });

  it('returns the original buffer for non-object bodies', () => {
    const b = Buffer.from('null');
    expect(rewriteCacheControlTtl(b, '1h')).toBe(b);
  });

  it('returns the original buffer when no cache_control blocks exist', () => {
    const b = buf({ messages: [{ role: 'user', content: 'hi' }] });
    expect(rewriteCacheControlTtl(b, '1h')).toBe(b);
  });

  it('returns the original buffer when every block already has the target ttl', () => {
    const b = buf({
      system: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    });
    expect(rewriteCacheControlTtl(b, '1h')).toBe(b);
  });

  it('sets ttl on a root cache_control block', () => {
    const b = buf({ cache_control: { type: 'ephemeral' } });
    const out = rewriteCacheControlTtl(b, '1h');
    expect(out).not.toBe(b);
    expect(parse(out)['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('sets ttl on system[] blocks', () => {
    const b = buf({
      system: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'c', cache_control: { type: 'ephemeral', ttl: '5m' } },
      ],
    });
    const out = rewriteCacheControlTtl(b, '1h');
    const parsed = parse(out);
    expect(parseCacheControlMarkers(out)).toEqual({ markers5m: 0, markers1h: 2 });
    // Non-cc fields preserved.
    const system = parsed['system'] as Array<Record<string, unknown>>;
    expect(system[0]).toEqual({ type: 'text', text: 'a' });
    expect(system[1]!['text']).toBe('b');
  });

  it('sets ttl on tools[] blocks', () => {
    const b = buf({
      tools: [
        { name: 'foo' },
        { name: 'bar', cache_control: { type: 'ephemeral' } },
        { name: 'baz', cache_control: { type: 'ephemeral', ttl: '5m' } },
      ],
    });
    const out = rewriteCacheControlTtl(b, '1h');
    expect(parseCacheControlMarkers(out)).toEqual({ markers5m: 0, markers1h: 2 });
    const tools = parse(out)['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ name: 'foo' });
    expect(tools[1]!['name']).toBe('bar');
  });

  it('sets ttl on messages[].content[] blocks', () => {
    const b = buf({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'plain' },
            { type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'another', cache_control: { type: 'ephemeral', ttl: '5m' } },
          ],
        },
      ],
    });
    const out = rewriteCacheControlTtl(b, '1h');
    expect(parseCacheControlMarkers(out)).toEqual({ markers5m: 0, markers1h: 2 });
  });

  it('leaves non-ephemeral types alone', () => {
    const b = buf({
      system: [{ type: 'text', text: 'x', cache_control: { type: 'persistent' } }],
    });
    expect(rewriteCacheControlTtl(b, '1h')).toBe(b);
  });

  it('rewrites to 5m as well', () => {
    const b = buf({ cache_control: { type: 'ephemeral', ttl: '1h' } });
    const out = rewriteCacheControlTtl(b, '5m');
    expect(parse(out)['cache_control']).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('is idempotent when re-run with the same target ttl', () => {
    const once = rewriteCacheControlTtl(buf({ cache_control: { type: 'ephemeral' } }), '1h');
    const twice = rewriteCacheControlTtl(once, '1h');
    expect(twice).toBe(once);
  });

  it('ignores non-object message entries and non-array content', () => {
    const b = buf({
      messages: [
        null,
        'weird',
        { role: 'user', content: 'plain string content' },
        { role: 'user', content: [{ type: 'text', cache_control: { type: 'ephemeral' } }] },
      ],
    });
    const out = rewriteCacheControlTtl(b, '1h');
    expect(parseCacheControlMarkers(out)).toEqual({ markers5m: 0, markers1h: 1 });
  });

  it('ignores non-object entries in system[] and tools[]', () => {
    const b = buf({
      system: [null, 'weird', { type: 'text', cache_control: { type: 'ephemeral' } }],
      tools: [null, 42, { name: 'ok', cache_control: { type: 'ephemeral' } }],
    });
    const out = rewriteCacheControlTtl(b, '1h');
    expect(parseCacheControlMarkers(out)).toEqual({ markers5m: 0, markers1h: 2 });
  });

  it('preserves sibling fields on a block that gets mutated', () => {
    const b = buf({
      system: [
        {
          type: 'text',
          text: 'long prefix',
          citations: [{ url: 'http://a' }],
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
    const out = rewriteCacheControlTtl(b, '1h');
    const block = (parse(out)['system'] as Array<Record<string, unknown>>)[0]!;
    expect(block['type']).toBe('text');
    expect(block['text']).toBe('long prefix');
    expect(block['citations']).toEqual([{ url: 'http://a' }]);
    expect(block['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});
