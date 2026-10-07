/**
 * Usage recovery from the head + rolling tail of a non-streaming message too
 * large for the proxy's 256 KB head buffer.
 */

import { describe, it, expect } from 'vitest';
import { appendToTail, extractUsageFromJsonTail, USAGE_TAIL_BYTES } from './usage-json-tail.js';

const USAGE = {
  input_tokens: 1200,
  output_tokens: 48000,
  cache_read_input_tokens: 300,
  cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 2 },
};

function bigMessage(textBytes: number, usage: unknown = USAGE): string {
  return JSON.stringify({
    id: 'msg_big',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    content: [{ type: 'text', text: 'x'.repeat(textBytes) }],
    stop_reason: 'max_tokens',
    stop_sequence: null,
    usage,
  });
}

/** Feed `body` through appendToTail in `chunkSize` pieces, as the proxy does. */
function tailOf(body: Buffer, chunkSize = 16 * 1024): Buffer {
  let tail: Buffer = Buffer.alloc(0);
  for (let i = 0; i < body.length; i += chunkSize) {
    tail = appendToTail(tail, body.subarray(i, i + chunkSize));
  }
  return tail;
}

describe('appendToTail', () => {
  it('keeps exactly the last USAGE_TAIL_BYTES of the stream', () => {
    const body = Buffer.from(Array.from({ length: 200_000 }, (_, i) => String(i % 10)).join(''));
    const tail = tailOf(body, 7_001);
    expect(tail.length).toBe(USAGE_TAIL_BYTES);
    expect(tail.equals(body.subarray(body.length - USAGE_TAIL_BYTES))).toBe(true);
  });

  it('keeps a short stream whole', () => {
    const tail = appendToTail(appendToTail(Buffer.alloc(0), Buffer.from('ab')), Buffer.from('cd'));
    expect(tail.toString()).toBe('abcd');
  });
});

describe('extractUsageFromJsonTail', () => {
  it('recovers model and usage from a message far larger than the head buffer', () => {
    const body = Buffer.from(bigMessage(600 * 1024));
    const head = body.subarray(0, 256 * 1024);
    expect(extractUsageFromJsonTail(head, tailOf(body))).toEqual({
      model: 'claude-opus-4-7',
      inputTokens: 1200,
      outputTokens: 48000,
      cacheRead: 300,
      cacheCreate5m: 40,
      cacheCreate1h: 2,
    });
  });

  it('ignores a "usage" key quoted inside the content and takes the top-level one', () => {
    const decoy = `${'y'.repeat(1000)} "usage": {"input_tokens": 999999} ${'y'.repeat(1000)}`;
    const body = Buffer.from(
      JSON.stringify({
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: decoy }],
        usage: { input_tokens: 5, output_tokens: 6 },
      }),
    );
    const result = extractUsageFromJsonTail(body, body);
    expect(result?.inputTokens).toBe(5);
    expect(result?.outputTokens).toBe(6);
  });

  it('honors escaped quotes and braces inside strings when closing the object', () => {
    const body = Buffer.from(
      '{"model":"m","usage":{"input_tokens":3,"note":"a \\"}\\" {","output_tokens":4}}',
    );
    const result = extractUsageFromJsonTail(body, body);
    expect(result?.inputTokens).toBe(3);
    expect(result?.outputTokens).toBe(4);
  });

  it('returns null model when the head carries none', () => {
    const tail = Buffer.from('"usage": {"input_tokens": 1, "output_tokens": 2}}');
    const result = extractUsageFromJsonTail(Buffer.from('{"content":['), tail);
    expect(result?.model).toBeNull();
    expect(result?.outputTokens).toBe(2);
  });

  it('skips "usage" occurrences that are not an object key with an object value', () => {
    // A string value "usage", a null usage, an unterminated object and an
    // object that is not valid JSON: none of them yields a result.
    const tails = [
      '"type":"usage"}',
      '"usage": null}',
      '"usage": {"input_tokens": 1',
      '"usage": {"input_tokens": }}',
      'no usage here',
    ];
    for (const t of tails) {
      expect(extractUsageFromJsonTail(Buffer.from('{"model":"m"'), Buffer.from(t))).toBeNull();
    }
  });

  it('falls back to an earlier usage object when the last one does not parse', () => {
    const tail = Buffer.from(
      '"usage": {"input_tokens": 7, "output_tokens": 8}, "x": {"usage": {"input_tokens": }}',
    );
    expect(extractUsageFromJsonTail(Buffer.alloc(0), tail)?.inputTokens).toBe(7);
  });
});
