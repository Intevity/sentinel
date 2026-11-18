import { describe, it, expect, beforeEach } from 'vitest';
import {
  createReviewResultScanner,
  getAutoModeReviewStats,
  recordReviewOutcome,
  requestsServerReview,
  resetAutoModeReviewStats,
} from './auto-mode-review.js';
import { log } from './logger.js';

const SAFEGUARDS = [
  { type: 'dangerous_tool_use', classifier_context: { v: 1, permission_mode: 'auto' } },
];

const json = (v: unknown): Buffer => Buffer.from(JSON.stringify(v), 'utf-8');

describe('requestsServerReview', () => {
  it('is true for a body whose top level carries a non-empty safeguards array', () => {
    expect(requestsServerReview(json({ model: 'm', messages: [], safeguards: SAFEGUARDS }))).toBe(
      true,
    );
  });

  it('is false without the field, with an empty array, or with a non-array value', () => {
    expect(requestsServerReview(json({ model: 'm', messages: [] }))).toBe(false);
    expect(requestsServerReview(json({ messages: [], safeguards: [] }))).toBe(false);
    expect(requestsServerReview(json({ messages: [], safeguards: { type: 'x' } }))).toBe(false);
  });

  it('is false when "safeguards" only appears inside conversation content', () => {
    const body = json({
      messages: [{ role: 'user', content: 'what does "safeguards": [1] mean?' }],
    });
    expect(requestsServerReview(body)).toBe(false);
  });

  it('is false for a body that is not a JSON object', () => {
    expect(requestsServerReview(Buffer.from('{"safeguards": [1', 'utf-8'))).toBe(false);
    expect(requestsServerReview(Buffer.from('["safeguards"]', 'utf-8'))).toBe(false);
    expect(requestsServerReview(Buffer.from('"safeguards"', 'utf-8'))).toBe(false);
  });
});

describe('createReviewResultScanner', () => {
  const delta =
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn",' +
    '"safeguard_results":[{"type":"dangerous_tool_use","status":{"type":"available","tool_uses":{}}}]}}\n\n';
  const stop = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const deltaWithoutResults =
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n';

  it('answers when the stream carries safeguard_results, even split one byte per chunk', () => {
    const scanner = createReviewResultScanner(true);
    const bytes = Buffer.from(delta + stop, 'utf-8');
    for (let i = 0; i < bytes.length; i += 1) scanner.push(bytes.subarray(i, i + 1));
    expect(scanner.outcome(200, true)).toBe('answered');
  });

  it('is missing when a stream reaches message_stop without results', () => {
    const scanner = createReviewResultScanner(true);
    scanner.push(Buffer.from(deltaWithoutResults + stop, 'utf-8'));
    expect(scanner.outcome(200, true)).toBe('missing');
  });

  it('is incomplete when a stream ends before message_stop', () => {
    const scanner = createReviewResultScanner(true);
    scanner.push(Buffer.from(deltaWithoutResults, 'utf-8'));
    expect(scanner.outcome(200, false)).toBe('incomplete');
  });

  it('judges a JSON body by whether it ended', () => {
    const answered = createReviewResultScanner(false);
    answered.push(json({ type: 'message', safeguard_results: [] }));
    expect(answered.outcome(200, true)).toBe('answered');

    const missing = createReviewResultScanner(false);
    missing.push(json({ type: 'message' }));
    expect(missing.outcome(200, true)).toBe('missing');
    expect(missing.outcome(200, false)).toBe('incomplete');
  });

  it('is an error for a non-2xx status whatever the body says', () => {
    const scanner = createReviewResultScanner(true);
    scanner.push(Buffer.from(delta + stop, 'utf-8'));
    expect(scanner.outcome(529, true)).toBe('error');
    expect(scanner.outcome(101, true)).toBe('error');
  });

  it('stops scanning once both markers are seen', () => {
    const scanner = createReviewResultScanner(true);
    scanner.push(Buffer.from(delta + stop, 'utf-8'));
    // Anything after both markers is irrelevant to the outcome.
    scanner.push(Buffer.from('garbage', 'utf-8'));
    expect(scanner.outcome(200, true)).toBe('answered');
  });
});

describe('recordReviewOutcome', () => {
  beforeEach(() => {
    resetAutoModeReviewStats();
    log.clear();
  });

  const missingLines = (): string[] =>
    log
      .getHistory()
      .filter((e) => e.message.includes('[AutoModeReview]'))
      .map((e) => e.message);

  it('counts outcomes split by whether Sentinel rewrote the body', () => {
    recordReviewOutcome({
      outcome: 'answered',
      rewritten: false,
      credential: 'login',
      statusCode: 200,
    });
    recordReviewOutcome({
      outcome: 'answered',
      rewritten: true,
      credential: 'login',
      statusCode: 200,
    });
    recordReviewOutcome({
      outcome: 'incomplete',
      rewritten: true,
      credential: 'login',
      statusCode: 200,
    });
    recordReviewOutcome({
      outcome: 'error',
      rewritten: false,
      credential: 'login',
      statusCode: 529,
    });
    expect(getAutoModeReviewStats()).toEqual({
      untouched: { answered: 1, missing: 0, incomplete: 0, error: 1 },
      rewritten: { answered: 1, missing: 0, incomplete: 1, error: 0 },
    });
    expect(missingLines()).toEqual([]);
  });

  it('logs a missing review once per credential kind and body treatment, without credentials', () => {
    for (let i = 0; i < 3; i += 1) {
      recordReviewOutcome({
        outcome: 'missing',
        rewritten: true,
        credential: 'pooled-api-key',
        statusCode: 200,
      });
    }
    recordReviewOutcome({
      outcome: 'missing',
      rewritten: false,
      credential: 'pooled-api-key',
      statusCode: 200,
    });
    recordReviewOutcome({
      outcome: 'missing',
      rewritten: true,
      credential: 'login',
      statusCode: 200,
    });

    expect(getAutoModeReviewStats().rewritten.missing).toBe(4);
    expect(getAutoModeReviewStats().untouched.missing).toBe(1);
    const lines = missingLines();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('(credential: pooled-api-key, body: rewritten)');
    expect(lines[1]).toContain('(credential: pooled-api-key, body: untouched)');
    expect(lines[2]).toContain('(credential: login, body: rewritten)');
    expect(lines[0]).toContain('complete 200 response');
  });

  it('returns a snapshot the caller cannot mutate', () => {
    const snap = getAutoModeReviewStats();
    snap.untouched.answered = 99;
    expect(getAutoModeReviewStats().untouched.answered).toBe(0);
  });
});
