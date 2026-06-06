/**
 * Pure HTML-to-text extraction for tool_result content that is actually an
 * HTML document or fragment (a fetched web page, a rendered email, an HTML
 * report). Modeled on headroom's biggest showcase: a real page is mostly
 * markup, so stripping it down to readable text is the single largest win the
 * compressor can make on web-fetch output.
 *
 * Every function here is a deterministic fixed point: `rule(rule(x)) ===
 * rule(x)`. There is no clock, randomness, locale, or I/O; entity decoding and
 * whitespace cleanup are pure string transforms. See `types.ts` for why
 * determinism is what keeps Anthropic prompt-cache prefixes byte-stable.
 *
 * Idempotency argument: the transform always appends an elision marker whose
 * text contains the literal phrase "elided by Claude Sentinel". The leading
 * guard short-circuits any input that already carries that phrase, so a second
 * pass over our own output returns it unchanged BEFORE `isHtml` is ever
 * consulted. That is why decoded entities are safe: an extracted body might
 * legitimately contain the text `<div>` (from `&lt;div&gt;`), which would make
 * `isHtml` think the output is HTML again, but the guard fires first and we
 * never reach `isHtml` on a marker-bearing string.
 */

import type { RuleId } from './types.js';
import { byteLen } from './types.js';
import { retrievalHint, type OnElide } from './text-rules.js';

const RULE_ID: RuleId = 'html_extract';

/**
 * Byte length of the reversible hint suffix when onElide is present. Derived
 * once from retrievalHint() itself with a fixed-length (16 hex char) stub id,
 * so it stays exact even if the hint wording changes. The real id from
 * hashOriginal() is always 16 hex chars, all ASCII, so its byte length equals
 * this constant. Computing it here (module load) keeps extractHtmlText pure and
 * avoids invoking the caller's onElide just to size the marker.
 */
const HINT_BYTES = byteLen(retrievalHint(() => '0'.repeat(16), RULE_ID, ''));

/** A tag token: `<tag ...>` or `</tag>`. Used for the density heuristic. */
const TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?>/g;

/**
 * Shape test: does this text look like HTML we should extract from?
 *
 * Pure and deterministic. Two cheap signals:
 *  - a fast positive when the text opens with `<!doctype html` or `<html`;
 *  - otherwise a tag-density check over the first 4 KiB: enough tag tokens,
 *    a high enough fraction of the sample is markup, AND at least one common
 *    HTML closing/self-closing tag is present.
 *
 * The closing-tag requirement is the false-positive guard: TypeScript generics
 * (`Array<string>`) and comparison-operator soup (`a < b && c > d`) can hit the
 * tag regex by accident, but they do not contain `</div>`, `</p>`, `</span>`,
 * `</a>`, or `<br`. Real markup almost always does.
 */
export function isHtml(text: string): boolean {
  const head = text.trimStart().slice(0, 15).toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return true;

  const sampleLen = Math.min(4096, text.length);
  if (sampleLen === 0) return false;
  const sample = text.slice(0, sampleLen);

  let count = 0;
  let matchedChars = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(sample)) !== null) {
    count++;
    matchedChars += m[0].length;
  }
  if (count < 8) return false;
  if (matchedChars / sampleLen < 0.05) return false;

  const lower = sample.toLowerCase();
  return (
    lower.includes('</div>') ||
    lower.includes('</p>') ||
    lower.includes('</span>') ||
    lower.includes('</a>') ||
    lower.includes('<br')
  );
}

// Whole elements (tag + content) to drop entirely: their content is not
// readable prose. Non-greedy, case-insensitive, [\s\S] to span newlines.
const DROP_ELEMENT_RE =
  /<(script|style|head|svg|noscript|template)(?:\s[^<>]*)?>[\s\S]*?<\/\1\s*>/gi;

// HTML comments, including multiline. Stripped before declarations so a
// comment's `-->` terminator is honored rather than swallowed by the broader
// declaration regex below.
const COMMENT_RE = /<!--[\s\S]*?-->/g;

// SGML/XML declarations: <!DOCTYPE html>, <![CDATA[...]]>, etc. These are
// markup, not prose, and (unlike normal tags) start with `<!`, so the
// `<[a-zA-Z]` tag regexes below never touch them. Run after comments so we do
// not clip a comment short at its first `>`.
const DECLARATION_RE = /<![^>]*>/g;

// <img ...> — we keep only the alt text, dropped in place.
const IMG_RE = /<img\b[^<>]*>/gi;
const ALT_RE = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/i;

// Closing tags + <br>/<hr> that should become a line break.
const BLOCK_TAGS =
  'p|div|section|article|header|footer|li|ul|ol|table|tr|td|th|h1|h2|h3|h4|h5|h6|blockquote|pre|figure|nav|aside|main|form|title';
const BLOCK_CLOSE_RE = new RegExp(`</(?:${BLOCK_TAGS})\\s*>`, 'gi');
const BR_HR_RE = /<(?:br|hr)\b[^<>]*>/gi;

// Any remaining tag.
const ANY_TAG_RE = /<\/?[a-zA-Z][^<>]*>/g;

// Named entities we decode explicitly. (Numeric ones handled separately.)
const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};
const NAMED_ENTITY_RE = /&(?:amp|lt|gt|quot|#39|apos|nbsp);/g;
// Numeric character references: decimal (&#123;) or hex (&#x1F600;).
const NUMERIC_ENTITY_RE = /&#(x[0-9a-fA-F]+|[0-9]+);/g;

/** Decode the supported entity set. Pure; invalid numeric code points are left
 *  verbatim (we never throw). */
function decodeEntities(text: string): string {
  // NAMED_ENTITY_RE's alternatives are exactly the keys of NAMED_ENTITIES, so a
  // match is always present in the map; the assertion removes a dead `?? e`
  // branch the type system would otherwise force (noUncheckedIndexedAccess).
  let out = text.replace(NAMED_ENTITY_RE, (e) => NAMED_ENTITIES[e]!);
  out = out.replace(NUMERIC_ENTITY_RE, (whole, digits: string) => {
    const code =
      digits[0] === 'x' || digits[0] === 'X' ? parseInt(digits.slice(1), 16) : parseInt(digits, 10);
    // String.fromCodePoint throws only for non-integers or code points outside
    // [0, 0x10FFFF]. parseInt yields an integer or NaN, so this single range +
    // finiteness guard covers every case it would reject. A bogus entity (e.g.
    // &#x110000;) survives untouched; once past the guard fromCodePoint cannot
    // throw, so no try/catch is needed.
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
    return String.fromCodePoint(code);
  });
  return out;
}

/** Idempotent whitespace cleanup: collapse intra-line space runs to one space,
 *  trim trailing spaces per line, collapse 3+ newlines to 2, trim leading and
 *  trailing blank lines. Running it on its own output is a no-op. */
function cleanWhitespace(text: string): string {
  const lines = text.split('\n');
  // `lines` is string[] (String.split never yields undefined elements), so the
  // map callback's `line` is already a string; no index coalesce needed.
  const trimmed = lines.map((line) => line.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/g, ''));
  let out = trimmed.join('\n');
  // Collapse 3+ consecutive newlines (i.e. 2+ blank lines) down to exactly one
  // blank line. Looping is unnecessary: the class match is greedy.
  out = out.replace(/\n{3,}/g, '\n\n');
  // Trim leading/trailing blank lines (and surrounding spaces already gone).
  out = out.replace(/^\n+/, '').replace(/\n+$/, '');
  return out;
}

/**
 * Extract readable text from an HTML document/fragment, replacing the markup
 * with a single reversible elision marker that records the byte count removed.
 *
 * Order is fixed and meaningful:
 *   1. leading marker guard (idempotency);
 *   2. bail to the same instance when the input is not HTML;
 *   3. comments out, then SGML declarations (<!DOCTYPE>, <![CDATA[]]>) out;
 *   4. script/style/head/svg/noscript/template elements (with content) out;
 *   5. <img> -> its alt text in place;
 *   6. block-level closing tags + <br>/<hr> -> newline;
 *   7. all remaining tags out;
 *   8. entity decode;
 *   9. whitespace cleanup.
 *
 * The marker is the final line: `... [<N> bytes of HTML markup elided by
 * Claude Sentinel<hint>] ...` where N is the original byte length minus the
 * extracted-text byte length. A net-gain guard returns the original instance
 * when the marker would make the output as large or larger than the input
 * (tiny snippets), and in that case `onElide` is never invoked, so no capture
 * leaks for an unchanged result.
 */
export function extractHtmlText(text: string, onElide?: OnElide): string {
  if (text.includes('elided by Claude Sentinel')) return text;
  if (!isHtml(text)) return text;

  let body = text;
  body = body.replace(COMMENT_RE, '');
  body = body.replace(DECLARATION_RE, '');
  body = body.replace(DROP_ELEMENT_RE, '');
  body = body.replace(IMG_RE, (tag) => {
    const alt = ALT_RE.exec(tag);
    if (!alt) return '';
    // A successful match populates exactly one of the three quote-style groups
    // (double / single / unquoted); the others are undefined. Pick the one that
    // is a string. An empty alt ("") is a valid string and is kept as "".
    if (typeof alt[1] === 'string') return alt[1];
    if (typeof alt[2] === 'string') return alt[2];
    return alt[3] as string;
  });
  body = body.replace(BLOCK_CLOSE_RE, '\n');
  body = body.replace(BR_HR_RE, '\n');
  body = body.replace(ANY_TAG_RE, '');
  body = decodeEntities(body);
  const extracted = cleanWhitespace(body);

  const removed = byteLen(text) - byteLen(extracted);

  // Decide net-gain WITHOUT invoking onElide: the hint is fixed-shape (a 16-hex
  // char id), so its byte length is known a priori. This keeps the contract
  // that captures never leak for an unchanged output. HINT_LEN is the exact
  // byte length retrievalHint() produces; 0 when reversible mode is off.
  const hintLen = onElide ? HINT_BYTES : 0;
  const markerBase = `... [${removed} bytes of HTML markup elided by Claude Sentinel`;
  const markerLen = byteLen(markerBase) + hintLen + byteLen('] ...');
  const sep = extracted.length === 0 ? 0 : 1; // the '\n' joining body and marker
  const predictedLen = (extracted.length === 0 ? 0 : byteLen(extracted)) + sep + markerLen;

  // Net-gain guard: never grow the body. On a tiny page the marker can outweigh
  // the markup it replaced; return the original instance so callers' identity
  // checks short-circuit and no capture is recorded (onElide never ran).
  if (predictedLen >= byteLen(text)) return text;

  // Only now do we commit: invoke onElide (recording the capture) and assemble.
  const hint = retrievalHint(onElide, RULE_ID, text);
  const marker = `${markerBase}${hint}] ...`;
  return extracted.length === 0 ? marker : `${extracted}\n${marker}`;
}
