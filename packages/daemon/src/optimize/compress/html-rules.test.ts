import { describe, it, expect } from 'vitest';
import { isHtml, extractHtmlText } from './html-rules.js';
import { hashOriginal, byteLen, type RuleId } from './types.js';
import type { OnElide } from './text-rules.js';

/** Plain-closure OnElide stub: records every call, returns the deterministic
 *  content-hash id the production hook would. No vitest mocking utilities. */
function makeRecorder(): { onElide: OnElide; calls: Array<{ ruleId: RuleId; elided: string }> } {
  const calls: Array<{ ruleId: RuleId; elided: string }> = [];
  const onElide: OnElide = (ruleId, elided) => {
    calls.push({ ruleId, elided });
    return hashOriginal(elided);
  };
  return { onElide, calls };
}

const REALISTIC_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Widgets Inc</title>
  <style>body { color: red; }</style>
  <script>console.log('tracking', secret);</script>
</head>
<body>
  <!-- top banner comment -->
  <nav><a href="/home">Home</a><a href="/about">About</a></nav>
  <div class="hero">
    <h1>Welcome &amp; hello</h1>
    <p>Use &lt;widgets&gt; today. Don&#x27;t wait.</p>
  </div>
  <img src="/logo.png" alt="Company logo" width="120">
  <ul>
    <li>First</li>
    <li>Second</li>
  </ul>
</body>
</html>`;

describe('isHtml', () => {
  it('fast-positives on a doctype html prefix (with leading whitespace)', () => {
    expect(isHtml('  \n<!DOCTYPE HTML><html></html>')).toBe(true);
  });

  it('fast-positives on a bare <html prefix', () => {
    expect(isHtml('<html lang="en"><body>hi</body></html>')).toBe(true);
  });

  it('positives on a dense fragment without a doctype', () => {
    const frag =
      '<div class="a"><span>one</span></div><div><span>two</span></div>' +
      '<div><p>three</p></div><div><a href="#">link</a></div>';
    expect(isHtml(frag)).toBe(true);
  });

  it('rejects TypeScript generics and comparison operators', () => {
    const ts =
      'function f<T>(a: Array<string>, b: Map<string, T>): boolean { return a.length < b.size && 1 > 0; }';
    expect(isHtml(ts)).toBe(false);
  });

  it('rejects markdown with a couple of <br> but low tag density', () => {
    const md =
      '# Title\n\nA long paragraph of ordinary prose that goes on for quite a while ' +
      'so the tag density stays well under five percent.<br>\nAnother long line of ' +
      'plain words with nothing markup-like about it at all to speak of here.<br>\n' +
      'And still more plain text padding the sample so density cannot trip.';
    expect(isHtml(md)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isHtml('')).toBe(false);
  });

  it('rejects enough tags but no recognizable HTML closing tag', () => {
    // Eight self-closing custom tags, high density, but none of div/p/span/a/br.
    const x = '<x1 /><x2 /><x3 /><x4 /><x5 /><x6 /><x7 /><x8 /><x9 />';
    expect(isHtml(x)).toBe(false);
  });

  it('positives via the <br fallback when no closing block tag is present', () => {
    // Many <br> tags, high density, none of </div></p></span></a> -> <br branch.
    const x = '<br><br><br><br><br><br><br><br><br><br>';
    expect(isHtml(x)).toBe(true);
  });

  it('rejects when tag count is high enough but density is under five percent', () => {
    // 8 short tags diluted by a long run of plain text -> density < 0.05.
    const filler = 'x'.repeat(2000);
    const x = '<div></div><p></p><span></span><a></a>' + filler;
    expect(isHtml(x)).toBe(false);
  });
});

describe('extractHtmlText', () => {
  it('extracts readable text from a realistic page (exact output, no reversible hint)', () => {
    const out = extractHtmlText(REALISTIC_PAGE);
    const removed = byteLen(REALISTIC_PAGE) - byteLen(out.slice(0, out.lastIndexOf('\n')));
    const lines = out.split('\n');
    const marker = lines[lines.length - 1];

    // Script/style/head content is gone.
    expect(out).not.toContain('console.log');
    expect(out).not.toContain('color: red');
    expect(out).not.toContain('tracking');
    expect(out).not.toContain('Widgets Inc'); // <title> is in <head>, dropped wholesale
    // Comment is gone.
    expect(out).not.toContain('top banner comment');
    // Doctype declaration and structural tags are gone.
    expect(out.toLowerCase()).not.toContain('<!doctype');
    expect(out).not.toContain('<html');
    expect(out).not.toContain('<body');
    // Alt text is present; src is not.
    expect(out).toContain('Company logo');
    expect(out).not.toContain('/logo.png');
    // Entities decoded.
    expect(out).toContain('Welcome & hello');
    expect(out).toContain('Use <widgets> today.');
    expect(out).toContain("Don't wait.");
    // Marker is the final line, byte-count shaped, no hint (onElide absent).
    expect(marker).toBe('... [' + removed + ' bytes of HTML markup elided by Claude Sentinel] ...');
  });

  it('produces a deterministic, byte-stable result across two runs', () => {
    const a = extractHtmlText(REALISTIC_PAGE);
    const b = extractHtmlText(REALISTIC_PAGE);
    expect(a).toBe(b);
  });

  it('is idempotent: re-running on its own output returns it unchanged', () => {
    const once = extractHtmlText(REALISTIC_PAGE);
    const twice = extractHtmlText(once);
    expect(twice).toBe(once); // same content
  });

  it('returns the marker-bearing input unchanged (leading guard, same instance)', () => {
    const marked = 'some text\n... [10 bytes of HTML markup elided by Claude Sentinel] ...';
    expect(extractHtmlText(marked)).toBe(marked);
  });

  it('returns a non-HTML input as the same instance', () => {
    const input = 'just a line of plain command output\nwith a second line';
    const out = extractHtmlText(input);
    expect(out).toBe(input);
  });

  it('reversible round-trip: marker embeds id === hashOriginal(original) and capture reconstructs it', () => {
    const { onElide, calls } = makeRecorder();
    const out = extractHtmlText(REALISTIC_PAGE, onElide);

    // Exactly one elision occurred; the captured bytes are the whole original.
    expect(calls.length).toBe(1);
    expect(calls[0]?.ruleId).toBe('html_extract');
    expect(calls[0]?.elided).toBe(REALISTIC_PAGE);

    const id = hashOriginal(REALISTIC_PAGE);
    expect(out).toContain('id="' + id + '"');
    // The marker carries the retrieval hint phrase.
    expect(out).toContain('retrieve the full output with the sentinel retrieve tool');
    // Byte-for-byte: the recorded capture reconstructs exactly what was dropped.
    expect(calls[0]?.elided).toBe(REALISTIC_PAGE);
  });

  it('reversible mode is deterministic (same id, same bytes) across runs', () => {
    const r1 = makeRecorder();
    const r2 = makeRecorder();
    expect(extractHtmlText(REALISTIC_PAGE, r1.onElide)).toBe(
      extractHtmlText(REALISTIC_PAGE, r2.onElide),
    );
    expect(r1.calls[0]?.elided).toBe(r2.calls[0]?.elided);
  });

  it('emits ONLY the marker line when the extracted body is empty (and it survives net-gain)', () => {
    // A large doctype page whose entire visible body is inside <script>/<style>:
    // extraction yields empty text, and the markup removed dwarfs the marker, so
    // the net-gain guard passes and the output is exactly the marker line.
    const noise = '<script>' + 'var a=1;'.repeat(200) + '</script>';
    const html =
      '<!DOCTYPE html><html><head><style>' +
      'p{}'.repeat(200) +
      '</style></head><body>' +
      noise +
      '</body></html>';
    const { onElide, calls } = makeRecorder();
    const out = extractHtmlText(html, onElide);
    expect(out).not.toBe(html); // it changed
    expect(out.includes('\n')).toBe(false); // marker only, no body line
    expect(out.startsWith('... [')).toBe(true);
    expect(out.endsWith('] ...')).toBe(true);
    expect(out).toContain('id="' + hashOriginal(html) + '"');
    expect(calls.length).toBe(1);
    expect(calls[0]?.elided).toBe(html);
  });

  it('keeps double-quoted, single-quoted, and unquoted img alt text; drops alt-less images', () => {
    const html =
      '<div><p><img src="a.png" alt="double quoted"></p></div>' +
      "<div><p><img src='b.png' alt='single quoted'></p></div>" +
      '<div><p><img src=c.png alt=unquoted></p></div>' +
      '<div><p><img src="d.png"></p></div>' + // no alt -> contributes nothing
      '<div><p>tail padding text long enough to clear the net gain guard comfortably here</p></div>';
    const out = extractHtmlText(html);
    expect(out).toContain('double quoted');
    expect(out).toContain('single quoted');
    expect(out).toContain('unquoted');
    expect(out).not.toContain('a.png');
    expect(out).not.toContain('d.png');
  });

  it('net-gain guard: a tiny HTML snippet returns the same instance and records ZERO captures', () => {
    const tiny = '<html><body>hi</body></html>';
    const { onElide, calls } = makeRecorder();
    const out = extractHtmlText(tiny, onElide);
    expect(out).toBe(tiny); // same instance: marker would outweigh savings
    expect(calls.length).toBe(0); // capture must never leak for an unchanged output
  });

  it('leaves a numeric entity with an invalid code point verbatim', () => {
    const html =
      '<div><p>start</p></div><div><p>mid</p></div><div><p>end</p></div>' +
      '<div><span>x</span></div><p>bad: &#x110000; ok: &#65;</p>' +
      '<div><p>padding text to clear the net gain guard so the body survives</p></div>';
    const out = extractHtmlText(html);
    expect(out).toContain('&#x110000;'); // invalid -> left as-is
    expect(out).toContain('ok: A'); // valid decimal entity decoded (&#65; -> A)
    expect(out).not.toContain('<div>');
  });

  it('collapses 3+ blank lines and block tags into clean spacing', () => {
    const html =
      '<div><p>alpha</p></div>\n\n\n\n<div><p>beta</p></div>' +
      '<div><p>gamma</p></div><div><p>delta padding so the body clears net gain easily here</p></div>';
    const out = extractHtmlText(html);
    const body = out.slice(0, out.lastIndexOf('\n'));
    // No run of 3+ newlines anywhere in the extracted body.
    expect(/\n{3,}/.test(body)).toBe(false);
    expect(out).toContain('alpha');
    expect(out).toContain('delta');
  });
});

describe('extractHtmlText threshold and boundary behavior', () => {
  it('decodes the full named entity set and nbsp to a space', () => {
    const html =
      '<div><p>a&amp;b &lt;c&gt; &quot;d&quot; &apos;e&apos; f&#39;g h&nbsp;i</p></div>' +
      '<div><p>second line of body text long enough to clear the net gain guard comfortably</p></div>' +
      '<div><p>third line of body text for additional padding to be safe about it</p></div>';
    const out = extractHtmlText(html);
    expect(out).toContain("a&b <c> \"d\" 'e' f'g h i");
  });

  it('marker N equals original bytes minus extracted bytes (with reversible hint present)', () => {
    const { onElide } = makeRecorder();
    const out = extractHtmlText(REALISTIC_PAGE, onElide);
    const idx = out.lastIndexOf('\n... [');
    const body = out.slice(0, idx);
    const marker = out.slice(idx + 1);
    const expectedN = byteLen(REALISTIC_PAGE) - byteLen(body);
    expect(
      marker.startsWith('... [' + expectedN + ' bytes of HTML markup elided by Claude Sentinel'),
    ).toBe(true);
  });
});
