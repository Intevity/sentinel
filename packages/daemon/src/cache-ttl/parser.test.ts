import { describe, expect, it } from 'vitest';
import { extractUsageFromJson, parseCacheControlMarkers, SseUsageExtractor } from './parser.js';

function buf(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj), 'utf-8');
}

describe('parseCacheControlMarkers', () => {
  it('returns zeros for an empty body', () => {
    expect(parseCacheControlMarkers(buf({}))).toEqual({ markers5m: 0, markers1h: 0 });
  });

  it('returns zeros for malformed JSON', () => {
    expect(parseCacheControlMarkers(Buffer.from('{not json'))).toEqual({
      markers5m: 0,
      markers1h: 0,
    });
  });

  it('returns zeros for non-object bodies', () => {
    expect(parseCacheControlMarkers(Buffer.from('null'))).toEqual({ markers5m: 0, markers1h: 0 });
    expect(parseCacheControlMarkers(Buffer.from('"hi"'))).toEqual({ markers5m: 0, markers1h: 0 });
  });

  it('counts a top-level ephemeral marker as 5m', () => {
    expect(parseCacheControlMarkers(buf({ cache_control: { type: 'ephemeral' } }))).toEqual({
      markers5m: 1,
      markers1h: 0,
    });
  });

  it('counts a top-level 1h marker as 1h', () => {
    expect(
      parseCacheControlMarkers(buf({ cache_control: { type: 'ephemeral', ttl: '1h' } })),
    ).toEqual({ markers5m: 0, markers1h: 1 });
  });

  it('ignores non-ephemeral types', () => {
    expect(parseCacheControlMarkers(buf({ cache_control: { type: 'persistent' } }))).toEqual({
      markers5m: 0,
      markers1h: 0,
    });
  });

  it('counts markers across system array blocks', () => {
    expect(
      parseCacheControlMarkers(
        buf({
          system: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'c', cache_control: { type: 'ephemeral', ttl: '1h' } },
          ],
        }),
      ),
    ).toEqual({ markers5m: 1, markers1h: 1 });
  });

  it('counts markers on tool definitions', () => {
    expect(
      parseCacheControlMarkers(
        buf({
          tools: [
            { name: 'foo' },
            { name: 'bar', cache_control: { type: 'ephemeral' } },
            { name: 'baz', cache_control: { type: 'ephemeral', ttl: '1h' } },
          ],
        }),
      ),
    ).toEqual({ markers5m: 1, markers1h: 1 });
  });

  it('counts markers inside message content blocks', () => {
    expect(
      parseCacheControlMarkers(
        buf({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'a' },
                { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
              ],
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'c', cache_control: { type: 'ephemeral', ttl: '1h' } },
              ],
            },
          ],
        }),
      ),
    ).toEqual({ markers5m: 1, markers1h: 1 });
  });

  it('skips messages whose content is a bare string', () => {
    expect(
      parseCacheControlMarkers(buf({ messages: [{ role: 'user', content: 'hello' }] })),
    ).toEqual({ markers5m: 0, markers1h: 0 });
  });

  it('handles nulls and non-objects within arrays gracefully', () => {
    expect(
      parseCacheControlMarkers(
        buf({
          system: [null, 'string', 42],
          tools: [null, 'string', 42],
          messages: [null, { role: 'user', content: [null, 'x', { type: 'text' }] }],
        }),
      ),
    ).toEqual({ markers5m: 0, markers1h: 0 });
  });

  it('treats ttl:"5m" explicitly as 5m', () => {
    expect(
      parseCacheControlMarkers(buf({ cache_control: { type: 'ephemeral', ttl: '5m' } })),
    ).toEqual({ markers5m: 1, markers1h: 0 });
  });

  it('accumulates across every surface', () => {
    expect(
      parseCacheControlMarkers(
        buf({
          cache_control: { type: 'ephemeral' },
          system: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }],
          tools: [{ name: 't', cache_control: { type: 'ephemeral' } }],
          messages: [
            {
              role: 'user',
              content: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }],
            },
          ],
        }),
      ),
    ).toEqual({ markers5m: 2, markers1h: 2 });
  });
});

describe('extractUsageFromJson', () => {
  it('returns null on unparseable bodies', () => {
    expect(extractUsageFromJson(Buffer.from('{bad'))).toBeNull();
  });

  it('returns null when usage is absent', () => {
    expect(extractUsageFromJson(buf({ model: 'claude-sonnet-4-6' }))).toBeNull();
  });

  it('returns null on non-object bodies', () => {
    expect(extractUsageFromJson(Buffer.from('null'))).toBeNull();
    expect(extractUsageFromJson(Buffer.from('123'))).toBeNull();
  });

  it('extracts per-TTL creation tokens + read tokens', () => {
    const r = extractUsageFromJson(
      buf({
        model: 'claude-opus-4-7',
        usage: {
          input_tokens: 5,
          cache_creation: {
            ephemeral_5m_input_tokens: 100,
            ephemeral_1h_input_tokens: 200,
          },
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 42,
          output_tokens: 0,
        },
      }),
    );
    expect(r).toEqual({
      model: 'claude-opus-4-7',
      cacheCreate5m: 100,
      cacheCreate1h: 200,
      cacheRead: 42,
      inputTokens: 5,
    });
  });

  it('falls back to aggregate cache_creation_input_tokens as 5m when cache_creation is missing', () => {
    const r = extractUsageFromJson(
      buf({
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 77,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      }),
    );
    expect(r).toEqual({
      model: 'claude-sonnet-4-6',
      cacheCreate5m: 77,
      cacheCreate1h: 0,
      cacheRead: 0,
      inputTokens: 0,
    });
  });

  it('coerces missing numeric fields to zero', () => {
    const r = extractUsageFromJson(
      buf({
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 'nope' },
      }),
    );
    expect(r).toEqual({
      model: 'claude-sonnet-4-6',
      cacheCreate5m: 0,
      cacheCreate1h: 0,
      cacheRead: 0,
      inputTokens: 0,
    });
  });

  it('returns null model when the field is missing', () => {
    const r = extractUsageFromJson(
      buf({
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 0 },
      }),
    );
    expect(r?.model).toBeNull();
  });
});

describe('SseUsageExtractor', () => {
  function feed(x: SseUsageExtractor, ...chunks: string[]): void {
    for (const c of chunks) x.onChunk(c);
  }

  it('returns null before any usage arrives', () => {
    const x = new SseUsageExtractor();
    feed(x, 'event: ping\n', 'data: {"type":"ping"}\n\n');
    expect(x.getResult()).toBeNull();
  });

  it('captures baseline usage from message_start', () => {
    const x = new SseUsageExtractor();
    feed(
      x,
      'event: message_start\n',
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          model: 'claude-opus-4-7',
          usage: {
            input_tokens: 5,
            cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
            cache_read_input_tokens: 7,
            output_tokens: 0,
          },
        },
      })}\n\n`,
    );
    expect(x.getResult()).toEqual({
      model: 'claude-opus-4-7',
      cacheCreate5m: 10,
      cacheCreate1h: 20,
      cacheRead: 7,
      inputTokens: 5,
    });
  });

  it('prefers the final message_delta usage over the baseline', () => {
    const x = new SseUsageExtractor();
    feed(
      x,
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 1,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
            cache_read_input_tokens: 0,
            output_tokens: 0,
          },
        },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hi' },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: {
          input_tokens: 1,
          cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 150 },
          cache_read_input_tokens: 9,
          output_tokens: 42,
        },
      })}\n\n`,
    );
    expect(x.getResult()).toEqual({
      model: 'claude-sonnet-4-6',
      cacheCreate5m: 50,
      cacheCreate1h: 150,
      cacheRead: 9,
      inputTokens: 1,
    });
  });

  it('tolerates data lines split across chunk boundaries at arbitrary offsets', () => {
    const full = `data: ${JSON.stringify({
      type: 'message_delta',
      usage: {
        input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 99, ephemeral_1h_input_tokens: 1 },
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    })}\n\n`;
    for (let split = 1; split < full.length; split++) {
      const x = new SseUsageExtractor();
      x.onChunk(full.slice(0, split));
      x.onChunk(full.slice(split));
      const r = x.getResult();
      expect(r?.cacheCreate5m).toBe(99);
      expect(r?.cacheCreate1h).toBe(1);
    }
  });

  it('accepts CRLF line endings', () => {
    const x = new SseUsageExtractor();
    x.onChunk(
      `data: ${JSON.stringify({
        type: 'message_delta',
        usage: { cache_read_input_tokens: 3 },
      })}\r\n\r\n`,
    );
    expect(x.getResult()?.cacheRead).toBe(3);
  });

  it('ignores the [DONE] sentinel and other non-JSON data', () => {
    const x = new SseUsageExtractor();
    feed(x, 'data: [DONE]\n\n', 'data: not-json\n\n', 'data: \n\n');
    expect(x.getResult()).toBeNull();
  });

  it('swallows JSON parse failures on lines that contain "usage" substring', () => {
    const x = new SseUsageExtractor();
    // Line references "usage" so it passes the fast-path substring filter,
    // but is not valid JSON: the catch in consumeLine must quietly drop it.
    feed(x, 'data: {"type":"message_delta","usage":[broken\n\n');
    expect(x.getResult()).toBeNull();
  });

  it('ignores events without usage references', () => {
    const x = new SseUsageExtractor();
    feed(
      x,
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
    );
    expect(x.getResult()).toBeNull();
  });

  it('skips events whose JSON has no type or message fields', () => {
    const x = new SseUsageExtractor();
    feed(x, 'data: {"usage":{"input_tokens":1}}\n\n');
    // No type=message_start or message_delta, so the extractor ignores it.
    expect(x.getResult()).toBeNull();
  });

  it('ignores non-data lines', () => {
    const x = new SseUsageExtractor();
    feed(
      x,
      'event: message_delta\n',
      ': comment line\n',
      `data: ${JSON.stringify({
        type: 'message_delta',
        usage: { cache_read_input_tokens: 11 },
      })}\n\n`,
    );
    expect(x.getResult()?.cacheRead).toBe(11);
  });

  it('keeps reading when a data line arrives as a Buffer', () => {
    const x = new SseUsageExtractor();
    x.onChunk(
      Buffer.from(
        `data: ${JSON.stringify({
          type: 'message_delta',
          usage: { cache_read_input_tokens: 5 },
        })}\n\n`,
        'utf-8',
      ),
    );
    expect(x.getResult()?.cacheRead).toBe(5);
  });

  it('keeps the baseline model if message_delta does not repeat it', () => {
    const x = new SseUsageExtractor();
    feed(
      x,
      `data: ${JSON.stringify({
        type: 'message_start',
        message: { model: 'claude-opus-4-7', usage: { input_tokens: 1 } },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'message_delta',
        usage: { cache_read_input_tokens: 1 },
      })}\n\n`,
    );
    expect(x.getResult()?.model).toBe('claude-opus-4-7');
  });
});
