import { describe, it, expect } from 'vitest';
import { compressMessagesBody } from './compress-body.js';
import { parseCacheControlMarkers } from '../../cache-ttl/parser.js';

const ESC = '\x1b';
const BIG = 4 * 1024 * 1024;

function buf(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj), 'utf-8');
}

/** A realistic body: an assistant tool_use followed by a user tool_result. */
function bodyWithToolResult(content: unknown, opts?: { toolUseId?: string }): Buffer {
  const id = opts?.toolUseId ?? 'tu_1';
  return buf({
    model: 'claude-sonnet-4-6',
    system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
    ],
  });
}

describe('compressMessagesBody', () => {
  it('compresses string tool_result content and reports stats', () => {
    const noisy = `${ESC}[32mok${ESC}[0m\n${'noise\n'.repeat(50)}`;
    const body = bodyWithToolResult(noisy);
    const { body: out, stats } = compressMessagesBody(body, {
      level: 'conservative',
      maxBodyBytes: BIG,
    });

    expect(stats.changed).toBe(true);
    expect(stats.skipReason).toBeNull();
    expect(stats.bytesOut).toBeLessThan(stats.bytesIn);
    expect(stats.estTokensOut).toBeLessThan(stats.estTokensIn);
    expect(out.length).toBeLessThan(body.length);

    const parsed = JSON.parse(out.toString('utf-8')) as {
      messages: Array<{ content: Array<{ type: string; content?: string }> }>;
    };
    const tr = parsed.messages[1]!.content[0]!;
    expect(tr.type).toBe('tool_result');
    expect(tr.content).not.toContain(ESC);
  });

  it('compresses array-of-text content and leaves non-text elements + array length intact', () => {
    const arr = [
      { type: 'text', text: `${ESC}[31mred${ESC}[0m output` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ];
    const body = bodyWithToolResult(arr);
    const { body: out, stats } = compressMessagesBody(body, {
      level: 'conservative',
      maxBodyBytes: BIG,
    });

    expect(stats.changed).toBe(true);
    const parsed = JSON.parse(out.toString('utf-8')) as {
      messages: Array<{ content: Array<{ content: Array<Record<string, unknown>> }> }>;
    };
    const blocks = parsed.messages[1]!.content[0]!.content;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!['text']).toBe('red output');
    // Image element is byte-identical.
    expect(blocks[1]).toEqual(arr[1]);
  });

  it('preserves cache_control markers and overall structure exactly', () => {
    const content = [{ type: 'text', text: `${ESC}[33mwarn${ESC}[0m\n${'x\n'.repeat(100)}` }];
    // Put a cache_control on the tool_result block itself, too.
    const body = buf({
      model: 'claude-sonnet-4-6',
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'Bash', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content,
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    });

    const before = parseCacheControlMarkers(body);
    const { body: out, stats } = compressMessagesBody(body, {
      level: 'moderate',
      maxBodyBytes: BIG,
    });
    expect(stats.changed).toBe(true);
    const after = parseCacheControlMarkers(out);
    expect(after).toEqual(before);

    const parsed = JSON.parse(out.toString('utf-8')) as {
      model: string;
      system: unknown;
      tools: unknown;
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    // Unchanged top-level / system / tools.
    expect(parsed.model).toBe('claude-sonnet-4-6');
    expect(parsed.system).toEqual([
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
    ]);
    expect(parsed.tools).toEqual([
      { name: 'Bash', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
    // tool_result block keeps its cache_control.
    expect(parsed.messages[1]!.content[0]!['cache_control']).toEqual({ type: 'ephemeral' });
  });

  it('attributes savings to the resolved tool name, and "unknown" otherwise', () => {
    const noisy = `${ESC}[36mlog${ESC}[0m line`;
    const known = compressMessagesBody(bodyWithToolResult(noisy, { toolUseId: 'tu_1' }), {
      level: 'conservative',
      maxBodyBytes: BIG,
    });
    expect(Object.keys(known.stats.perTool)).toEqual(['Bash']);
    expect(known.stats.perTool['Bash']!.blocks).toBe(1);

    // tool_result whose id has no matching tool_use -> "unknown".
    const orphan = buf({
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_missing', content: noisy }],
        },
      ],
    });
    const res = compressMessagesBody(orphan, { level: 'conservative', maxBodyBytes: BIG });
    expect(Object.keys(res.stats.perTool)).toEqual(['unknown']);
  });

  it('returns the same Buffer reference and parse_error on invalid JSON', () => {
    const body = Buffer.from('{ not json', 'utf-8');
    const res = compressMessagesBody(body, { level: 'aggressive', maxBodyBytes: BIG });
    expect(res.body).toBe(body);
    expect(res.stats.skipReason).toBe('parse_error');
    expect(res.stats.changed).toBe(false);
  });

  it('treats a top-level JSON array as parse_error (not a messages object)', () => {
    const body = buf([1, 2, 3]);
    const res = compressMessagesBody(body, { level: 'conservative', maxBodyBytes: BIG });
    expect(res.body).toBe(body);
    expect(res.stats.skipReason).toBe('parse_error');
  });

  it('skips a body with no messages array (no_tool_results)', () => {
    const body = buf({ model: 'claude-sonnet-4-6' });
    const res = compressMessagesBody(body, { level: 'conservative', maxBodyBytes: BIG });
    expect(res.body).toBe(body);
    expect(res.stats.skipReason).toBe('no_tool_results');
  });

  it('skips when there are messages but no tool_result blocks', () => {
    const body = buf({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });
    const res = compressMessagesBody(body, { level: 'conservative', maxBodyBytes: BIG });
    expect(res.body).toBe(body);
    expect(res.stats.skipReason).toBe('no_tool_results');
  });

  it('returns already_compressed (same reference) when nothing changes', () => {
    const body = bodyWithToolResult('a clean line of tool output, nothing to strip');
    const res = compressMessagesBody(body, { level: 'conservative', maxBodyBytes: BIG });
    expect(res.body).toBe(body);
    expect(res.stats.changed).toBe(false);
    expect(res.stats.skipReason).toBe('already_compressed');
  });

  it('leaves tool_result blocks with non-text content untouched (already_compressed)', () => {
    // content is neither a string nor an array — e.g. a structured object.
    const body = bodyWithToolResult({ unexpected: 'shape' });
    const res = compressMessagesBody(body, { level: 'aggressive', maxBodyBytes: BIG });
    expect(res.body).toBe(body);
    expect(res.stats.changed).toBe(false);
    expect(res.stats.skipReason).toBe('already_compressed');
    expect(res.stats.perTool['Bash']!.blocks).toBe(1);
    expect(res.stats.perTool['Bash']!.bytesIn).toBe(0);
  });

  it('skips oversized bodies (same reference)', () => {
    const body = bodyWithToolResult(`${ESC}[31mred${ESC}[0m`);
    const res = compressMessagesBody(body, { level: 'conservative', maxBodyBytes: 10 });
    expect(res.body).toBe(body);
    expect(res.stats.skipReason).toBe('oversized');
  });

  it('reverts (no_gain) when compression would not shrink the body', () => {
    // 5 tiny objects: the aggressive tabular fold produces a LARGER payload
    // than the original array, so the body-level guard reverts.
    const tinyArray = JSON.stringify([{ a: 1 }, { a: 1 }, { a: 1 }, { a: 1 }, { a: 1 }]);
    const body = bodyWithToolResult(tinyArray);
    const res = compressMessagesBody(body, { level: 'aggressive', maxBodyBytes: BIG });
    expect(res.body).toBe(body);
    expect(res.stats.changed).toBe(false);
    expect(res.stats.skipReason).toBe('no_gain');
  });

  it('skips malformed messages/blocks defensively and still compresses valid ones', () => {
    const body = buf({
      model: 'claude-sonnet-4-6',
      messages: [
        null, // not an object
        'a string message', // typeof !== object
        { role: 'assistant', content: 'not an array' }, // content not an array
        {
          role: 'assistant',
          content: [
            null, // falsy block
            42, // non-object block
            { type: 'tool_use', id: 'tu_ok', name: 'Read' }, // valid
            { type: 'tool_use', id: 123, name: 456 }, // non-string id/name
            { type: 'text', text: 'thinking' }, // not a tool_use
          ],
        },
        {
          role: 'user',
          content: [
            null, // falsy block in the main loop
            {
              type: 'tool_result',
              tool_use_id: 'tu_ok',
              content: [
                null, // falsy content element
                { type: 'image', source: { type: 'base64', data: 'AA' } }, // non-text element
                { type: 'text', text: `${ESC}[31mred${ESC}[0m` }, // compressible
              ],
            },
          ],
        },
      ],
    });

    const res = compressMessagesBody(body, { level: 'conservative', maxBodyBytes: BIG });
    expect(res.stats.changed).toBe(true);
    expect(res.stats.skipReason).toBeNull();
    expect(res.stats.perTool['Read']!.blocks).toBe(1);
    expect(res.body.toString('utf-8')).not.toContain(ESC);
  });

  it('is deterministic and idempotent at the body level', () => {
    const noisy = `${ESC}[32mok${ESC}[0m\n${Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')}`;
    const body = bodyWithToolResult(noisy);
    const a = compressMessagesBody(body, { level: 'aggressive', maxBodyBytes: BIG });
    const b = compressMessagesBody(body, { level: 'aggressive', maxBodyBytes: BIG });
    expect(a.body.equals(b.body)).toBe(true);
    expect(a.stats).toEqual(b.stats);

    // Re-compressing our own output is a no-op (cache-stability property).
    const again = compressMessagesBody(a.body, { level: 'aggressive', maxBodyBytes: BIG });
    expect(again.body).toBe(a.body);
    expect(again.stats.skipReason).toBe('already_compressed');
  });
});
