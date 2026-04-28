import { describe, it, expect } from 'vitest';
import { redactSecretsInString, redactSecretsInValue } from './detectors.js';

describe('redactSecretsInString', () => {
  it('replaces AWS access key shapes with [REDACTED:aws-access-key]', () => {
    const input = 'before AKIA2J47K9LM3PQR5XYZ after';
    const out = redactSecretsInString(input);
    expect(out).toContain('[REDACTED:aws-access-key]');
    expect(out).not.toContain('AKIA2J47K9LM3PQR5XYZ');
    expect(out.startsWith('before ')).toBe(true);
    expect(out.endsWith(' after')).toBe(true);
  });

  it('returns the original string when no secret matches', () => {
    const input = 'just plain text with no shapes';
    expect(redactSecretsInString(input)).toBe(input);
  });

  it('redacts multiple matches (descending splice keeps positions valid)', () => {
    const input = 'first AKIA2J47K9LM3PQR5XYZ then AKIA8H1G7F6E5D4C3B2A'; // two AWS keys
    const out = redactSecretsInString(input);
    const occurrences = out.match(/\[REDACTED:aws-access-key\]/g) ?? [];
    expect(occurrences).toHaveLength(2);
    expect(out).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });

  it('is idempotent: a second pass over already-redacted text is a no-op', () => {
    const input = 'hello AKIA2J47K9LM3PQR5XYZ world';
    const once = redactSecretsInString(input);
    const twice = redactSecretsInString(once);
    expect(twice).toBe(once);
  });

  it('returns empty string unchanged', () => {
    expect(redactSecretsInString('')).toBe('');
  });
});

describe('redactSecretsInValue', () => {
  it('walks objects and arrays, redacting only string leaves', () => {
    const input = {
      command: 'echo AKIA2J47K9LM3PQR5XYZ',
      env: ['SOMETHING=AKIA2J47K9LM3PQR5XYZ', 'PLAIN=value'],
      count: 3,
      flag: true,
      nested: { token: 'AKIA2J47K9LM3PQR5XYZ', plain: 'unchanged' },
    };
    const out = redactSecretsInValue(input) as typeof input;
    expect(out.command).toContain('[REDACTED:aws-access-key]');
    expect(out.command).not.toContain('AKIA2J47K9LM3PQR5XYZ');
    expect(out.env[0]).toContain('[REDACTED:aws-access-key]');
    expect(out.env[1]).toBe('PLAIN=value');
    expect(out.count).toBe(3);
    expect(out.flag).toBe(true);
    expect(out.nested.token).toContain('[REDACTED:aws-access-key]');
    expect(out.nested.plain).toBe('unchanged');
  });

  it('preserves null and undefined leaves verbatim', () => {
    const out = redactSecretsInValue({ a: null, b: undefined, c: 'AKIA2J47K9LM3PQR5XYZ' }) as {
      a: null;
      b: undefined;
      c: string;
    };
    expect(out.a).toBeNull();
    expect(out.b).toBeUndefined();
    expect(out.c).toContain('[REDACTED:aws-access-key]');
  });

  it('does not mutate the input', () => {
    const input = { token: 'AKIA2J47K9LM3PQR5XYZ' };
    const copy = { ...input };
    redactSecretsInValue(input);
    expect(input).toEqual(copy);
  });
});
