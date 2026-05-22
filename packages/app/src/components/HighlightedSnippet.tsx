import React from 'react';

/** Renders the `Context:` snippet. Two formats arrive from the daemon:
 *  - Sensitive findings (secret/PII/unicode-tag/base64): a 40-char window
 *    with `[REDACTED:kind]` in place of the match. No markers — falls
 *    through to plain rendering.
 *  - Non-secret pattern findings: ~200 chars trimmed to a sentence boundary,
 *    with the literal match wrapped in `«…»` markers. We split on the
 *    first `«` and last `»` (so any inner literals survive as text) and
 *    render the matched span with a yellow highlight.
 *  Old DB rows pre-dating the marker format also fall through cleanly. */
export default function HighlightedSnippet({ text }: { text: string }): React.ReactElement {
  const open = text.indexOf('«');
  const close = text.lastIndexOf('»');
  if (open === -1 || close === -1 || close <= open) {
    return (
      <code className="text-[10px] font-mono bg-muted/10 px-1 py-0.5 rounded break-all">
        {text}
      </code>
    );
  }
  const before = text.slice(0, open);
  const match = text.slice(open + 1, close);
  const after = text.slice(close + 1);
  return (
    <code className="text-[10px] font-mono bg-muted/10 px-1 py-0.5 rounded break-all">
      {before}
      <span className="bg-ios-orange/20 text-ios-orange font-semibold px-0.5 rounded">{match}</span>
      {after}
    </code>
  );
}
