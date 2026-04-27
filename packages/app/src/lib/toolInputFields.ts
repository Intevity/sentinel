/**
 * Ordering and rendering rules for `PendingSecurityBlock.toolInputFields`.
 * Lives in `lib/` (under the coverage gate) so the precedence + cap
 * logic is unit-tested without needing JSX render tests.
 */

/** Render order: most-relevant for the user's "is this dangerous?"
 *  decision first. Bash `command` and Write `file_path` are the
 *  highest-signal fields; `description` is a Claude-generated summary
 *  that adds noise next to a real command and goes last. */
const FIELD_ORDER = [
  'command',
  'file_path',
  'path',
  'url',
  'pattern',
  'query',
  'prompt',
  'description',
] as const;

/** Cap on rendered rows. The daemon truncates per-field length to keep
 *  any one cell from getting absurd; this caps row count so an
 *  unfamiliar tool with eight recognised scalars doesn't push the
 *  action buttons offscreen. */
const MAX_ROWS = 4;

export interface ToolInputRow {
  key: string;
  value: string;
}

/**
 * Order, deduplicate, and cap the daemon-supplied field map.
 *
 * - Known keys come first in `FIELD_ORDER`.
 * - Unknown keys (forward-compat for new tool_use shapes the daemon
 *   added but the app hasn't shipped support for yet) come after, in
 *   insertion order.
 * - Empty-string values are dropped: the daemon already filters these,
 *   but defend in depth.
 * - Newlines in values are preserved by the renderer's
 *   whitespace-pre-wrap class so a multi-line Bash pipeline shows as
 *   multiple lines inside one cell rather than collapsing.
 */
export function orderedToolInputRows(fields: Record<string, string>): ToolInputRow[] {
  const rows: ToolInputRow[] = [];
  const seen = new Set<string>();
  for (const k of FIELD_ORDER) {
    const v = fields[k];
    if (typeof v === 'string' && v.length > 0) {
      rows.push({ key: k, value: v });
      seen.add(k);
    }
  }
  for (const [k, v] of Object.entries(fields)) {
    if (seen.has(k)) continue;
    if (typeof v === 'string' && v.length > 0) {
      rows.push({ key: k, value: v });
    }
  }
  return rows.slice(0, MAX_ROWS);
}
