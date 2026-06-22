/**
 * Parse the long-lived OAuth token that `claude setup-token` prints to its
 * terminal at the end of the sign-in flow. The token is captured from a live
 * PTY stream (rendered by xterm), so the accumulated text contains ANSI escape
 * sequences and the token is typically **wrapped across lines** by the CLI's
 * formatter, e.g.:
 *
 *   Your OAuth token (valid for 1 year):
 *
 *    sk-ant-oat01--rjtALI-2WUB…HIv0k
 *    Q-KEi-JwAA
 *
 *    Store this token securely. You won't be able to see it again.
 *
 * So extraction must (1) strip ANSI, (2) reassemble the token across the
 * inserted whitespace/newlines, and (3) stop at the blank line the CLI prints
 * after the token (so trailing prose like "Store this token…" isn't slurped in —
 * note "Store" begins with a token-legal character).
 */

const TOKEN_PREFIX = 'sk-ant-oat01-';

/** Strip the ANSI escape sequences a PTY/Ink UI emits (colors, cursor moves,
 *  screen clears, OSC/DCS, charset/keypad). The token itself contains no ESC. */
function stripAnsi(s: string): string {
  return (
    s
      // CSI: ESC [ ... final byte (colors, cursor positioning, clears)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // OSC: ESC ] ... (BEL | ST)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // DCS/PM/APC/SOS: ESC P|X|^|_ ... ST
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')
      // Charset select / keypad mode
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[()][AB0]|\x1b[=>]/g, '')
      // Lone carriage returns from line redraws
      .replace(/\r/g, '')
  );
}

/**
 * Extract the `sk-ant-oat01…` token from accumulated terminal output, or null
 * if a complete token isn't present yet (caller re-runs as more output streams).
 *
 * @param accumulated Raw bytes read from the PTY so far (may include ANSI).
 */
export function extractSetupToken(accumulated: string): string | null {
  // Strip ANSI, then collapse ALL whitespace. Under a PTY the CLI's Ink UI
  // wraps the token across lines and may use cursor positioning instead of
  // newlines, so neither line structure nor a trailing blank line survives
  // reliably. Collapsing whitespace reassembles the token — and rejoins a
  // prefix that a line-wrap split (e.g. "sk-ant-oat01" \n "-rjt…").
  const collapsed = stripAnsi(accumulated).replace(/\s+/g, '');
  // Use the LAST occurrence: an Ink UI may redraw frames; the final one wins.
  const idx = collapsed.lastIndexOf(TOKEN_PREFIX);
  if (idx === -1) return null;

  const after = collapsed.slice(idx + TOKEN_PREFIX.length);
  // The body is a fixed length (sk-ant-oat01- + 95 chars = 108 total). Take
  // exactly that many token chars, ignoring whatever follows once the token has
  // fully printed (e.g. the concatenated "Storethistoken…" prose). Fewer than
  // 95 available → the token is still streaming, so return null and retry.
  const m = after.match(/^[A-Za-z0-9_-]{95}/);
  if (!m) return null;
  return TOKEN_PREFIX + m[0];
}
