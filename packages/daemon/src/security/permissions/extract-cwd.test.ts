import { describe, expect, it } from 'vitest';
import { extractCwd } from './enforcer.js';

function buf(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj));
}

describe('Sprint 9 — extractCwd', () => {
  it('returns the path when system is a string with a Working directory line', () => {
    const body = buf({
      system: 'You are Claude Code.\n<env>\nWorking directory: /Users/jeff/repo\n</env>',
      messages: [],
    });
    expect(extractCwd(body)).toBe('/Users/jeff/repo');
  });

  it('returns the path when system is an array of text blocks', () => {
    const body = buf({
      system: [
        { type: 'text', text: 'first block' },
        { type: 'text', text: 'second\nWorking directory: /Users/jeff/another\n' },
      ],
      messages: [],
    });
    expect(extractCwd(body)).toBe('/Users/jeff/another');
  });

  it('handles a system block with cache_control mixed in', () => {
    const body = buf({
      system: [
        {
          type: 'text',
          text: '<env>\nWorking directory: /Users/jeff/with-cache\nIs directory a git repo: yes\n</env>',
          cache_control: { type: 'ephemeral' },
        },
      ],
    });
    expect(extractCwd(body)).toBe('/Users/jeff/with-cache');
  });

  it('returns null when no working-directory line is present', () => {
    const body = buf({ system: 'no env block here', messages: [] });
    expect(extractCwd(body)).toBe(null);
  });

  it('returns null on malformed JSON', () => {
    expect(extractCwd(Buffer.from('not json{'))).toBe(null);
  });

  it('returns null when system is missing entirely', () => {
    expect(extractCwd(buf({ messages: [] }))).toBe(null);
  });
});
