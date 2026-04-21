import { describe, it, expect } from 'vitest';
import { ResponseTap } from './response-tap.js';

/** Builds a canonical Anthropic SSE stream for a single tool_use block. */
function toolUseStream(params: {
  index: number;
  id: string;
  name: string;
  inputJsonParts: string[];
}): string {
  const header = `event: content_block_start\ndata: ${JSON.stringify({
    type: 'content_block_start',
    index: params.index,
    content_block: { type: 'tool_use', id: params.id, name: params.name, input: {} },
  })}\n\n`;
  const deltas = params.inputJsonParts
    .map(
      (pj) =>
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta',
          index: params.index,
          delta: { type: 'input_json_delta', partial_json: pj },
        })}\n\n`,
    )
    .join('');
  const stop = `event: content_block_stop\ndata: ${JSON.stringify({
    type: 'content_block_stop',
    index: params.index,
  })}\n\n`;
  return header + deltas + stop;
}

describe('ResponseTap', () => {
  it('accepts Buffer chunks as well as strings', () => {
    const stream =
      `data: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'a', name: 'Bash', input: {} },
      })}\n\n` +
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
      })}\n\n` +
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`;
    const tap = new ResponseTap();
    tap.push(Buffer.from(stream, 'utf-8'));
    const { blocks } = tap.flush();
    expect(blocks).toHaveLength(1);
  });

  it('assembles a single tool_use block with fragmented JSON input', () => {
    const stream = toolUseStream({
      index: 0,
      id: 'toolu_abc',
      name: 'Bash',
      inputJsonParts: ['{"comm', 'and": "ls', ' -la"}'],
    });
    const tap = new ResponseTap();
    // Feed it in arbitrary byte-boundary chunks.
    const chunks = [stream.slice(0, 80), stream.slice(80, 160), stream.slice(160)];
    for (const c of chunks) tap.push(c);
    const { blocks, truncated } = tap.flush();
    expect(truncated).toBe(false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      index: 0,
      id: 'toolu_abc',
      name: 'Bash',
      input: { command: 'ls -la' },
    });
  });

  it('assembles multiple tool_use blocks with interleaved deltas', () => {
    const a = toolUseStream({
      index: 0,
      id: 'a',
      name: 'Bash',
      inputJsonParts: ['{"command":"echo 1"}'],
    });
    const b = toolUseStream({
      index: 1,
      id: 'b',
      name: 'Write',
      inputJsonParts: ['{"file_path":"/tmp/x","content":"hi"}'],
    });
    const tap = new ResponseTap();
    tap.push(a + b);
    const { blocks } = tap.flush();
    expect(blocks).toHaveLength(2);
    expect(blocks.map((x) => x.name).sort()).toEqual(['Bash', 'Write']);
  });

  it('drops chunks past the budget and reports truncated=true', () => {
    const tap = new ResponseTap(100);
    const tooBig = 'data: ' + 'x'.repeat(200) + '\n\n';
    tap.push(tooBig);
    const { truncated } = tap.flush();
    expect(truncated).toBe(true);
  });

  it('is a no-op after destroy()', () => {
    const tap = new ResponseTap();
    tap.destroy();
    tap.push(
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"a","name":"B","input":{}}}\n\n',
    );
    const { blocks } = tap.flush();
    expect(blocks).toEqual([]);
  });

  it('ignores non-tool_use content blocks', () => {
    const text = `event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })}\n\n`;
    const tap = new ResponseTap();
    tap.push(text);
    const { blocks } = tap.flush();
    expect(blocks).toEqual([]);
  });

  it('handles malformed data: lines without throwing', () => {
    const tap = new ResponseTap();
    tap.push('data: {bad json\n\n');
    tap.push('data: [DONE]\n\n');
    expect(() => tap.flush()).not.toThrow();
  });

  it('finalizes a block that ended without a content_block_stop event', () => {
    const stream =
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'abc', name: 'Bash', input: {} },
      })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
      })}\n\n`;
    const tap = new ResponseTap();
    tap.push(stream);
    const { blocks } = tap.flush();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.name).toBe('Bash');
    expect((blocks[0]!.input as Record<string, unknown>)['command']).toBe('ls');
  });

  it('finalizes a block with empty partial on stream end (defaults to {})', () => {
    const stream = `event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
    })}\n\n`;
    const tap = new ResponseTap();
    tap.push(stream);
    const { blocks } = tap.flush();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.input).toEqual({});
  });

  it('finalizes a block with malformed partial JSON on stream end', () => {
    const stream =
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
      })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{broken' },
      })}\n\n`;
    const tap = new ResponseTap();
    tap.push(stream);
    const { blocks } = tap.flush();
    expect(blocks).toHaveLength(1);
    expect((blocks[0]!.input as Record<string, unknown>)['_parseError']).toBe(true);
  });

  it('ignores stop events for unknown indices', () => {
    const stream = `event: content_block_stop\ndata: ${JSON.stringify({
      type: 'content_block_stop',
      index: 42,
    })}\n\n`;
    const tap = new ResponseTap();
    tap.push(stream);
    const { blocks } = tap.flush();
    expect(blocks).toEqual([]);
  });

  it('ignores delta events with missing or wrong delta.type', () => {
    const stream =
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0 })}\n\n` +
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } })}\n\n`;
    const tap = new ResponseTap();
    tap.push(stream);
    expect(() => tap.flush()).not.toThrow();
  });

  it('ignores content_block_start with non-numeric index', () => {
    const stream = `data: ${JSON.stringify({
      type: 'content_block_start',
      index: 'not-a-number',
      content_block: { type: 'tool_use', id: 'a', name: 'Bash', input: {} },
    })}\n\n`;
    const tap = new ResponseTap();
    tap.push(stream);
    const { blocks } = tap.flush();
    expect(blocks).toEqual([]);
  });

  it('treats tool_use with non-string id/name as empty strings', () => {
    const stream =
      `data: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 123, name: null, input: {} },
      })}\n\n` + `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`;
    const tap = new ResponseTap();
    tap.push(stream);
    const { blocks } = tap.flush();
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.id).toBe('');
    expect(blocks[0]!.name).toBe('');
  });

  it('ignores delta events for unknown indices', () => {
    const stream = `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      index: 99,
      delta: { type: 'input_json_delta', partial_json: '{"x":1}' },
    })}\n\n`;
    const tap = new ResponseTap();
    tap.push(stream);
    const { blocks } = tap.flush();
    expect(blocks).toEqual([]);
  });

  it('returns a parse-error marker when a tool_use input fails to parse', () => {
    const stream =
      `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
      })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{not valid' },
      })}\n\n` +
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      })}\n\n`;
    const tap = new ResponseTap();
    tap.push(stream);
    const { blocks } = tap.flush();
    expect(blocks).toHaveLength(1);
    expect((blocks[0]!.input as Record<string, unknown>)['_parseError']).toBe(true);
  });
});
