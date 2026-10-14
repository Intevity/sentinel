import { describe, it, expect } from 'vitest';
import { presentSystemPromptAsApiClient } from './api-key-system-prompt.js';

const BILLING = 'x-anthropic-billing-header: cc_version=2.1.296.a1b; cc_entrypoint=cli; cch=0f3e2;';
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const MAIN = 'You are an interactive agent that helps users with software engineering tasks.';
const CACHE = { type: 'ephemeral' };

const text = (t: string, cache?: object): Record<string, unknown> =>
  cache ? { type: 'text', text: t, cache_control: cache } : { type: 'text', text: t };

function rewrite(body: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(presentSystemPromptAsApiClient(Buffer.from(JSON.stringify(body))).toString());
}

describe('presentSystemPromptAsApiClient', () => {
  it("drops Claude Code's billing block and folds its identity line into the prompt after it", () => {
    const out = rewrite({
      model: 'claude-opus-5-5',
      system: [text(BILLING), text(IDENTITY, CACHE), text(MAIN, CACHE)],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out['system']).toEqual([text(`${IDENTITY}\n\n${MAIN}`, CACHE)]);
    expect(out['model']).toBe('claude-opus-5-5');
    expect(out['messages']).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('keeps the first block’s cache breakpoint when the block it folds into has none', () => {
    const out = rewrite({
      system: [text(BILLING), text('You are a security monitor.', CACHE), text('\n\n## Session')],
    });
    expect(out['system']).toEqual([text('You are a security monitor.\n\n\n\n## Session', CACHE)]);
  });

  it('folds the first two blocks and leaves the rest of the prompt alone', () => {
    const out = rewrite({
      system: [text(BILLING), text(SDK_IDENTITY, CACHE), text(MAIN, CACHE), text('Tail.')],
    });
    expect(out['system']).toEqual([text(`${SDK_IDENTITY}\n\n${MAIN}`, CACHE), text('Tail.')]);
  });

  it('ends a lone identity line with a newline, since there is nothing to fold it into', () => {
    const out = rewrite({ system: [text(BILLING), text(IDENTITY)] });
    expect(out['system']).toEqual([text(`${IDENTITY}\n`)]);
  });

  it('ends a string system prompt with a newline', () => {
    expect(rewrite({ system: IDENTITY })['system']).toBe(`${IDENTITY}\n`);
  });

  it('removes the system prompt when the billing block was all of it', () => {
    const out = rewrite({ model: 'm', system: [text(BILLING)] });
    expect(out).toEqual({ model: 'm' });
  });

  it('drops a billing block wherever it sits', () => {
    const out = rewrite({ system: [text(MAIN), text(BILLING)] });
    expect(out['system']).toEqual([text(`${MAIN}\n`)]);
  });

  it('returns the body untouched when there is no system prompt to change', () => {
    for (const raw of [
      '{"model":"m","messages":[]}',
      '{"system":[]}',
      '{"system":""}',
      '{"system":42}',
      '[1,2]',
      'null',
      '{not json',
    ]) {
      const body = Buffer.from(raw);
      expect(presentSystemPromptAsApiClient(body)).toBe(body);
    }
  });

  it('leaves a non-text first block in place', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } };
    const out = rewrite({ system: [text(BILLING), image, text(MAIN)] });
    expect(out['system']).toEqual([image, text(MAIN)]);
  });
});
