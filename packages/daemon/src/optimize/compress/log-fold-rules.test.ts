import { describe, it, expect } from 'vitest';
import { normalizeTemplate, foldNearDuplicateLines, type NearDupOpts } from './log-fold-rules.js';
import { extractLogErrors } from './text-rules.js';
import { hashOriginal, type RuleId } from './types.js';
import type { OnElide } from './text-rules.js';

const MODERATE: NearDupOpts = { minRun: 5 };
const AGGRESSIVE: NearDupOpts = { minRun: 3 };

/** A recording OnElide closure: no mocks. Records (ruleId, elided) and returns
 *  the real content hash so markers can be verified against hashOriginal(). */
function recorder() {
  const calls: { ruleId: RuleId; elided: string }[] = [];
  const onElide: OnElide = (ruleId, elided) => {
    calls.push({ ruleId, elided });
    return hashOriginal(elided);
  };
  return { calls, onElide };
}

/** Build N near-duplicate request lines that differ only in volatile fields. */
function infoLines(n: number, offset = 0): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = i + offset;
    out.push(
      `2026-03-14T02:1${k % 10}:0${k % 6}.00${k % 10}Z INFO request handled route=/api/v1/users status=200 latency_ms=${12 + k} req_id=${(0xabcdef01 + k).toString(16)}`,
    );
  }
  return out;
}

describe('normalizeTemplate', () => {
  it('masks ISO timestamps', () => {
    expect(normalizeTemplate('2026-03-14T02:11:05.123Z INFO ready')).toBe('<TS> INFO ready');
    expect(normalizeTemplate('2026-03-14 02:11:05+01:00 started')).toBe('<TS> started');
  });

  it('masks bare clock times before the number pass shreds them', () => {
    expect(normalizeTemplate('done at 03:04:05.678 today')).toBe('done at <TS> today');
  });

  it('masks UUIDs as a unit, not as hex/number fragments', () => {
    expect(normalizeTemplate('user 6f9619ff-8b86-d011-b42d-00c04fc964ff logged in')).toBe(
      'user <UUID> logged in',
    );
  });

  it('masks 0x and bare long-hex addresses', () => {
    expect(normalizeTemplate('ptr 0xDEADbeef freed')).toBe('ptr <ADDR> freed');
    expect(normalizeTemplate('req_id=ab12cd34ef done')).toBe('req_id=<ADDR> done');
  });

  it('masks absolute POSIX and Windows paths, preserving the boundary char', () => {
    expect(normalizeTemplate('read /var/log/app-2.log ok')).toBe('read <PATH> ok');
    expect(normalizeTemplate('open "C:\\Users\\jeff\\app.log" failed?')).toBe(
      'open "<PATH>" failed?',
    );
  });

  it('masks remaining integers and decimals last', () => {
    expect(normalizeTemplate('served 41 requests in 2.5s')).toBe('served <N> requests in <N>s');
  });

  it('produces identical templates for near-duplicate lines', () => {
    const [a, b] = infoLines(2);
    expect(a).not.toBe(b);
    expect(normalizeTemplate(a ?? '')).toBe(normalizeTemplate(b ?? ''));
  });

  it('is deterministic and idempotent on already-masked text', () => {
    const t = normalizeTemplate('latency 35ms from 10.0.0.1');
    expect(normalizeTemplate('latency 35ms from 10.0.0.1')).toBe(t);
    // A masked template has no digits/paths left to re-mask.
    expect(normalizeTemplate(t)).toBe(t);
  });
});

describe('foldNearDuplicateLines', () => {
  it('folds a run of near-duplicate lines to first + marker with exact capture', () => {
    const lines = infoLines(8);
    const { calls, onElide } = recorder();
    const out = foldNearDuplicateLines(lines.join('\n'), MODERATE, onElide);
    const outLines = out.split('\n');
    expect(outLines).toHaveLength(2);
    expect(outLines[0]).toBe(lines[0]);
    const expectedElided = lines.slice(1).join('\n');
    expect(outLines[1]).toBe(
      `... [7 similar lines elided by Claude Sentinel; retrieve the full output with the sentinel retrieve tool, id="${hashOriginal(expectedElided)}"] ...`,
    );
    expect(calls).toEqual([{ ruleId: 'log_near_dup_fold', elided: expectedElided }]);
  });

  it('does not fold byte-identical-after-normalization lines below minRun', () => {
    const input = infoLines(4).join('\n');
    const out = foldNearDuplicateLines(input, MODERATE);
    expect(out).toBe(input); // same instance: nothing folded
  });

  it('folds at exactly minRun', () => {
    const input = infoLines(5).join('\n');
    const out = foldNearDuplicateLines(input, MODERATE);
    expect(out.split('\n')).toHaveLength(2);
    expect(out).toContain('[4 similar lines elided by Claude Sentinel] ...');
  });

  it('moderate and aggressive thresholds diverge on a 3-line run', () => {
    const input = infoLines(3).join('\n');
    expect(foldNearDuplicateLines(input, MODERATE)).toBe(input);
    const out = foldNearDuplicateLines(input, AGGRESSIVE);
    expect(out.split('\n')).toHaveLength(2);
  });

  it('never folds an interesting line: an ERROR splits the run and survives verbatim', () => {
    const error = '2026-03-14T02:11:05.000Z ERROR upstream connection refused host=db-primary-3';
    const lines = [...infoLines(6), error, ...infoLines(6, 100)];
    const { calls, onElide } = recorder();
    const out = foldNearDuplicateLines(lines.join('\n'), MODERATE, onElide);
    const outLines = out.split('\n');
    // first INFO + marker, ERROR verbatim, first INFO of 2nd run + marker.
    expect(outLines).toHaveLength(5);
    expect(outLines[0]).toBe(lines[0]);
    expect(outLines[2]).toBe(error);
    expect(outLines[3]).toBe(lines[7]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.elided).toBe(lines.slice(1, 6).join('\n'));
    expect(calls[1]?.elided).toBe(lines.slice(8).join('\n'));
    // Non-interference contract: the ERROR is still extractable downstream.
    // (extractLogErrors skips marker-bearing text by design, so the contract
    // here is simply that the error line rides through the fold verbatim.)
    expect(out).toContain(error);
  });

  it('keeps errors extractable when folding does not fire', () => {
    // A run too short to fold, inside a long framework log: extractLogErrors
    // still sees and keeps the error line with context.
    const noise = Array.from({ length: 250 }, (_, i) => `   Compiling unit-${i} v0.1.${i % 10}`);
    const error = 'error[E0308]: mismatched types';
    const log = [...noise.slice(0, 120), error, ...noise.slice(120)].join('\n');
    const folded = foldNearDuplicateLines(log, MODERATE);
    const extracted = extractLogErrors(folded === log ? log : folded, {
      triggerLines: 200,
      headLines: 3,
      tailLines: 5,
      contextLines: 2,
      minRun: 6,
    });
    expect(extracted).toContain(error);
  });

  it('blank lines break runs', () => {
    const half = infoLines(3);
    const rest = infoLines(3, 50);
    const input = [...half, '', ...rest].join('\n');
    const out = foldNearDuplicateLines(input, MODERATE);
    expect(out).toBe(input); // two runs of 3 < minRun 5; the blank prevented a run of 6
  });

  it('different templates do not merge into one run', () => {
    const a = infoLines(3);
    const b = Array.from(
      { length: 3 },
      (_, i) => `2026-03-14T02:11:0${i}.000Z INFO cache warmed shard=${i}`,
    );
    const input = [...a, ...b].join('\n');
    // Aggressive (minRun 3): both runs fold separately, not as one run of 6.
    const out = foldNearDuplicateLines(input, AGGRESSIVE);
    const outLines = out.split('\n');
    expect(outLines).toHaveLength(4);
    expect(outLines[0]).toBe(a[0]);
    expect(outLines[2]).toBe(b[0]);
  });

  it('is deterministic: two runs produce identical bytes', () => {
    const input = [...infoLines(9), 'plain text', ...infoLines(7, 30)].join('\n');
    const a = foldNearDuplicateLines(input, MODERATE);
    const b = foldNearDuplicateLines(input, MODERATE);
    expect(a).toBe(b);
  });

  it('is idempotent: folding the folded output is a no-op (same instance)', () => {
    const once = foldNearDuplicateLines(infoLines(10).join('\n'), MODERATE);
    const twice = foldNearDuplicateLines(once, MODERATE);
    expect(twice).toBe(once);
  });

  it('returns the same instance for marker-bearing input (leading guard)', () => {
    const input = [
      ...infoLines(6),
      '... [3 lines elided by Claude Sentinel] ...',
      ...infoLines(6, 60),
    ].join('\n');
    expect(foldNearDuplicateLines(input, MODERATE)).toBe(input);
  });

  it('returns the same instance when nothing is foldable', () => {
    const input = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].join('\n');
    expect(foldNearDuplicateLines(input, MODERATE)).toBe(input);
  });

  it('omits the retrieval hint when no OnElide is provided', () => {
    const out = foldNearDuplicateLines(infoLines(6).join('\n'), MODERATE);
    expect(out).toContain('... [5 similar lines elided by Claude Sentinel] ...');
    expect(out).not.toContain('id="');
  });
});
