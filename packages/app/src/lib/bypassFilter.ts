/**
 * Pure filter for the Settings → Security → Permissions tab's
 * "Permission bypasses" list. Pulled out of SettingsPanel.tsx so it can be
 * unit-tested without a React renderer (the app package's vitest setup only
 * collects `*.test.ts`).
 *
 * Each bypass cancels a deny rule for one exact tool input. The list can grow
 * unbounded as users tick "Always" on pending tool-use banners, so the
 * Settings UI needs a search box — this is the matching logic behind it.
 */

import type { PermissionBypassEntry } from '@sentinel/shared';

/**
 * Keep the bypasses whose tool name, mask, or note contains `query`
 * (case-insensitive substring). A blank or whitespace-only query is a no-op:
 * the full list is returned unchanged (same array reference) so callers can
 * skip re-rendering work. Order is preserved.
 */
export function filterBypasses(
  entries: PermissionBypassEntry[],
  query: string,
): PermissionBypassEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return entries;
  return entries.filter(
    (e) =>
      e.toolName.toLowerCase().includes(needle) ||
      e.mask.toLowerCase().includes(needle) ||
      (e.note ?? '').toLowerCase().includes(needle),
  );
}
