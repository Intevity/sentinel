import { describe, it, expect, vi } from 'vitest';
import { truncateLog, collapseStackTraces } from './text-rules.js';
import { compressMessagesBody } from './compress-body.js';
import { hashOriginal } from './types.js';

const ESC = '\x1b';

function buf(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj), 'utf-8');
}

function bodyWith(content: unknown): Buffer {
  return buf({
    model: 'claude-sonnet-4-6',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content }] },
    ],
  });
}

const ID_RE = /id="([0-9a-f]{16})"/;

describe('reversible markers in lossy rules', () => {
  it('truncateLog embeds the content-hash id of the elided middle and calls onElide once', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const text = lines.join('\n');
    const onElide = vi.fn((_rule: string, elided: string) => hashOriginal(elided));
    const out = truncateLog(text, { triggerLines: 300, headLines: 120, tailLines: 120 }, onElide);

    expect(onElide).toHaveBeenCalledTimes(1);
    const elidedExpected = lines.slice(120, 380).join('\n');
    expect(onElide).toHaveBeenCalledWith('log_truncate', elidedExpected);
    const m = ID_RE.exec(out);
    expect(m?.[1]).toBe(hashOriginal(elidedExpected));
    expect(out).toContain('retrieve the full output with the sentinel retrieve tool');
  });

  it('collapseStackTraces embeds the id of the elided frames', () => {
    const frames = Array.from({ length: 40 }, (_, i) => `    at fn${i} (file.js:${i}:1)`);
    const text = `Error: boom\n${frames.join('\n')}`;
    const onElide = vi.fn((_rule: string, elided: string) => hashOriginal(elided));
    const out = collapseStackTraces(text, 8, onElide);

    // Elided middle = frames[8 .. 40-8).
    const elidedExpected = frames.slice(8, 32).join('\n');
    expect(onElide).toHaveBeenCalledWith('stack_trace_collapse', elidedExpected);
    expect(ID_RE.exec(out)?.[1]).toBe(hashOriginal(elidedExpected));
  });

  it('produces a byte-identical marker for the same input across calls (determinism)', () => {
    const text = Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n');
    const onElide = (_r: string, e: string): string => hashOriginal(e);
    const a = truncateLog(text, { triggerLines: 300, headLines: 120, tailLines: 120 }, onElide);
    const b = truncateLog(text, { triggerLines: 300, headLines: 120, tailLines: 120 }, onElide);
    expect(a).toBe(b);
  });

  it('without onElide the marker is byte-identical to the non-reversible form', () => {
    const text = Array.from({ length: 500 }, (_, i) => `l${i}`).join('\n');
    const out = truncateLog(text, { triggerLines: 300, headLines: 120, tailLines: 120 });
    expect(out).toContain('[260 lines elided by Claude Sentinel]');
    expect(out).not.toContain('retrieve the full output');
  });
});

describe('compressMessagesBody reversible mode', () => {
  const bigLog = Array.from({ length: 500 }, (_, i) => `log line ${i}`).join('\n');

  it('captures the elided original keyed by the id embedded in the body', () => {
    const {
      body: out,
      stats,
      captures,
    } = compressMessagesBody(bodyWith(bigLog), {
      level: 'moderate',
      maxBodyBytes: 4 * 1024 * 1024,
      reversible: true,
    });
    expect(stats.changed).toBe(true);
    expect(captures).toHaveLength(1);

    const parsed = JSON.parse(out.toString('utf-8')) as {
      messages: Array<{ content: Array<{ content?: string }> }>;
    };
    const trContent = String(parsed.messages[1]!.content[0]!.content);
    const idInBody = ID_RE.exec(trContent)?.[1];
    const cap = captures[0]!;
    // The id in the body marker matches the captured record's id...
    expect(idInBody).toBe(cap.id);
    // ...and the id is the hash of the captured original (the elided middle).
    expect(cap.id).toBe(hashOriginal(cap.original));
    // The 500 near-identical lines share one template ("log line <N>"), so the
    // near-duplicate fold elides them before truncate ever sees the text.
    expect(cap.ruleId).toBe('log_near_dup_fold');
    // The captured original is the lines that were dropped from the body.
    expect(cap.original).toContain('log line 200');
    expect(trContent).not.toContain('log line 200');
  });

  it('is deterministic: same input yields identical body and captures', () => {
    const opts = { level: 'moderate' as const, maxBodyBytes: 4 * 1024 * 1024, reversible: true };
    const a = compressMessagesBody(bodyWith(bigLog), opts);
    const b = compressMessagesBody(bodyWith(bigLog), opts);
    expect(a.body.equals(b.body)).toBe(true);
    expect(a.captures).toEqual(b.captures);
  });

  it('is idempotent: compressing its own output yields no new captures', () => {
    const opts = { level: 'moderate' as const, maxBodyBytes: 4 * 1024 * 1024, reversible: true };
    const first = compressMessagesBody(bodyWith(bigLog), opts);
    const second = compressMessagesBody(first.body, opts);
    expect(second.body).toBe(first.body); // unchanged reference
    expect(second.stats.skipReason).toBe('already_compressed');
    expect(second.captures).toEqual([]);
  });

  it('dedups identical elisions across blocks to a single capture', () => {
    // Two logs that differ only in their head line (so the intra-body fold,
    // which needs byte-identical blocks, does NOT fire) but share an identical
    // elided middle -> truncate produces the same content-hash id -> one capture.
    const tail = Array.from({ length: 499 }, (_, i) => `log line ${i + 1}`);
    const logA = ['HEADER-A', ...tail].join('\n');
    const logB = ['HEADER-B', ...tail].join('\n');
    const body = buf({
      model: 'claude-sonnet-4-6',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} },
            { type: 'tool_use', id: 'tu_2', name: 'Bash', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: logA },
            { type: 'tool_result', tool_use_id: 'tu_2', content: logB },
          ],
        },
      ],
    });
    const { stats, captures } = compressMessagesBody(body, {
      level: 'moderate',
      maxBodyBytes: 4 * 1024 * 1024,
      reversible: true,
    });
    // No fold (blocks differ); both truncations elide the same middle -> 1 id.
    expect(stats.perRule.intra_body_fold).toBeUndefined();
    expect(captures).toHaveLength(1);
  });

  it('produces no captures when reversible is off', () => {
    const { stats, captures } = compressMessagesBody(bodyWith(bigLog), {
      level: 'aggressive',
      maxBodyBytes: 4 * 1024 * 1024,
    });
    expect(stats.changed).toBe(true);
    expect(captures).toEqual([]);
    // And no retrieval hint leaks into the body markers.
  });

  it('drops captures when the result is reverted as no_gain', () => {
    // 5 tiny objects -> aggressive tabular fold expands -> no_gain revert.
    const tiny = JSON.stringify([{ a: 1 }, { a: 1 }, { a: 1 }, { a: 1 }, { a: 1 }]);
    const { stats, captures } = compressMessagesBody(bodyWith(tiny), {
      level: 'aggressive',
      maxBodyBytes: 4 * 1024 * 1024,
      reversible: true,
    });
    expect(stats.skipReason).toBe('no_gain');
    expect(captures).toEqual([]);
  });

  it('emits no retrieval hint at the conservative tier (nothing is elided)', () => {
    const noisy = `${ESC}[32mok${ESC}[0m\n${bigLog}`;
    const { body: out, captures } = compressMessagesBody(bodyWith(noisy), {
      level: 'conservative',
      maxBodyBytes: 4 * 1024 * 1024,
      reversible: true,
    });
    expect(captures).toEqual([]);
    expect(out.toString('utf-8')).not.toContain('retrieve the full output');
  });
});
