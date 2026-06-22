import { describe, it, expect } from 'vitest';
import { extractSetupToken } from './setupToken.js';

// The real token + wrapping observed from `claude setup-token` (the CLI wraps
// the 108-char token across two lines, each indented by a space).
const TOKEN =
  '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';

/** Build the CLI's success screen with the token wrapped after `wrapAt` chars. */
function successScreen(token: string, wrapAt = 96): string {
  const wrapped =
    token.length > wrapAt ? `${token.slice(0, wrapAt)}\n ${token.slice(wrapAt)}` : token;
  return [
    '✓ Long-lived authentication token created successfully!',
    '',
    ' Your OAuth token (valid for 1 year):',
    '',
    ` ${wrapped}`,
    '',
    " Store this token securely. You won't be able to see it again.",
    '',
    ' Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>',
    '',
  ].join('\n');
}

describe('extractSetupToken', () => {
  it('reassembles a line-wrapped token from the real success screen', () => {
    expect(extractSetupToken(successScreen(TOKEN))).toBe(TOKEN);
  });

  it('extracts an un-wrapped token', () => {
    const out = [
      ' Your OAuth token (valid for 1 year):',
      '',
      ` ${TOKEN}`,
      '',
      ' Store this token securely.',
      '',
    ].join('\n');
    expect(extractSetupToken(out)).toBe(TOKEN);
  });

  it('does not slurp the trailing prose (Store…) that begins with a token-legal char', () => {
    const out = extractSetupToken(successScreen(TOKEN));
    expect(out).toBe(TOKEN);
    expect(out).not.toContain('Store');
  });

  it('strips ANSI escapes around and within the output', () => {
    const esc = '\x1b[2m';
    const reset = '\x1b[0m';
    const clear = '\x1b[2J\x1b[3J\x1b[H';
    const wrapped = `${TOKEN.slice(0, 96)}\n ${TOKEN.slice(96)}`;
    const out = `${clear}${esc} Your OAuth token (valid for 1 year):${reset}\n\n ${esc}${wrapped}${reset}\n\n Store this token securely.\n`;
    expect(extractSetupToken(out)).toBe(TOKEN);
  });

  it('uses the final frame when an Ink redraw repeats the screen', () => {
    const doubled = successScreen(TOKEN) + '\x1b[2J\x1b[H' + successScreen(TOKEN);
    expect(extractSetupToken(doubled)).toBe(TOKEN);
  });

  it('captures a fully-printed token even without a trailing blank line', () => {
    // Real PTY output may exit right after the token, with no blank line after.
    const noTrailer = ` Your OAuth token (valid for 1 year):\n\n ${TOKEN.slice(0, 96)}\n ${TOKEN.slice(96)}`;
    expect(extractSetupToken(noTrailer)).toBe(TOKEN);
  });

  it('returns null while the token body is still streaming (incomplete)', () => {
    const partial = ` Your OAuth token (valid for 1 year):\n\n ${TOKEN.slice(0, 40)}`;
    expect(extractSetupToken(partial)).toBeNull();
  });

  it('returns null when there is no token in the stream', () => {
    expect(extractSetupToken('Opening browser to sign in…\n\nBrowser didn’t open?\n')).toBeNull();
  });

  it('returns null for a too-short sk-ant-oat01 fragment', () => {
    expect(extractSetupToken(' sk-ant-oat01-tooshort\n\n Store this token.\n')).toBeNull();
  });
});
