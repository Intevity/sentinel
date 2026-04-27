import { describe, expect, it } from 'vitest';
import { orderedToolInputRows } from './toolInputFields.js';

describe('orderedToolInputRows', () => {
  it('orders known fields by precedence (command before description)', () => {
    const out = orderedToolInputRows({
      description: 'cleanup tmp',
      command: 'rm -rf /tmp/foo',
    });
    expect(out).toEqual([
      { key: 'command', value: 'rm -rf /tmp/foo' },
      { key: 'description', value: 'cleanup tmp' },
    ]);
  });

  it('appends unknown keys after known ones in insertion order', () => {
    const out = orderedToolInputRows({
      mystery: 'unknown-tool-field',
      command: 'echo hi',
    });
    expect(out.map((r) => r.key)).toEqual(['command', 'mystery']);
  });

  it('drops empty string values', () => {
    const out = orderedToolInputRows({ command: '', url: 'https://x.test' });
    expect(out).toEqual([{ key: 'url', value: 'https://x.test' }]);
  });

  it('caps the result at 4 rows, keeping the highest-precedence keys', () => {
    const out = orderedToolInputRows({
      command: 'a',
      file_path: 'b',
      path: 'c',
      url: 'd',
      pattern: 'e',
      query: 'f',
      prompt: 'g',
      description: 'h',
    });
    expect(out).toHaveLength(4);
    expect(out.map((r) => r.key)).toEqual(['command', 'file_path', 'path', 'url']);
  });

  it('preserves multi-line command values verbatim (newlines kept for pre-wrap render)', () => {
    const cmd = 'set -e\ncd /tmp\nrm -rf cache';
    const out = orderedToolInputRows({ command: cmd });
    expect(out[0]!.value).toBe(cmd);
  });

  it('returns [] for an empty input map', () => {
    expect(orderedToolInputRows({})).toEqual([]);
  });
});
