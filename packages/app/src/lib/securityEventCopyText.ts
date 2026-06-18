import type { SecurityEvent } from '@sentinel/shared';

/** Reference-only / dedup keys carried in `details_json` that we never
 *  want surfaced in the expanded panel or in copied output. Mirrors
 *  `DETAILS_INTERNAL_KEYS` in `SecurityPanel.tsx`. */
export const COPY_INTERNAL_KEYS = new Set([
  'matchedRuleId',
  'matchedRuleRaw',
  'direction',
  'toolName',
]);

/** Friendly labels for known `details_json` keys. Mirrors
 *  `DETAILS_LABEL` in `SecurityPanel.tsx` so the copied block reads
 *  the same as the on-screen rendering. Add a new key here AND in
 *  SecurityPanel's DETAILS_LABEL when introducing new context. */
export const COPY_DETAILS_LABEL: Record<string, string> = {
  url: 'URL',
  command: 'Command',
  file_path: 'File',
  path: 'Path',
  pattern: 'Pattern',
  query: 'Query',
  prompt: 'Prompt',
  description: 'Description',
  sourceTool: 'Source tool',
  messageRole: 'Role',
};

/** Strip the «…» pattern-snippet markers so copied snippets read as
 *  plain prose. The match itself stays in place; callers want to see
 *  exactly what tripped the detector, just without the wrapper noise. */
export function stripSnippetMarkers(text: string): string {
  return text.replace(/«/g, '').replace(/»/g, '');
}

/** Build a plaintext "Sentinel security event" block suitable
 *  for pasting into a ticket or chat message. Field order matches the
 *  expanded panel; absent fields are skipped. The Details section
 *  iterates the same way DetailsList does so new context keys
 *  (sourceTool, command, …) appear automatically. */
export function buildEventCopyText(event: SecurityEvent): string {
  const lines: string[] = ['Sentinel security event'];
  lines.push(`Time: ${new Date(event.ts).toISOString()}`);
  lines.push(`Severity: ${event.severity}`);
  lines.push(`Kind: ${event.kind} (${event.detectorId})`);
  lines.push(`Title: ${event.title}`);
  lines.push(`Reason: ${event.reason}`);
  if (event.matchMask) lines.push(`Match: ${event.matchMask}`);
  if (event.sourceHint) lines.push(`Source: ${event.sourceHint}`);
  lines.push(`Origin: ${event.provenance}`);
  if (event.snippet) lines.push(`Context: ${stripSnippetMarkers(event.snippet)}`);
  if (event.details) {
    const entries = Object.entries(event.details).filter(
      ([k, v]) => !COPY_INTERNAL_KEYS.has(k) && typeof v === 'string' && (v as string).length > 0,
    );
    if (entries.length > 0) {
      lines.push('Details:');
      for (const [k, v] of entries) {
        lines.push(`  ${COPY_DETAILS_LABEL[k] ?? k}: ${String(v)}`);
      }
    }
  }
  lines.push(`Detector: ${event.detectorId} (conf ${event.confidence.toFixed(2)})`);
  if (event.occurrences > 1) lines.push(`Occurrences: ${event.occurrences}`);
  lines.push(`Blocked: ${event.blocked ? 'yes' : 'no'}`);
  if (event.approved) lines.push('Approved: yes');
  return lines.join('\n');
}
