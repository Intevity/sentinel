import type { ThemePreference } from '@claude-sentinel/shared';

/** localStorage key the FOWT script in index.html reads on cold launch to
 *  pre-apply `.dark` to `<html>` before React mounts. Kept here as the
 *  single source of truth; the index.html script duplicates the literal
 *  because it runs before any module imports. */
export const THEME_STORAGE_KEY = 'sentinel.theme.v1';

/** Resolve a `ThemePreference` to the concrete theme the app should
 *  render. For `'system'` the caller supplies whether the OS reports a
 *  dark color scheme. Pure function so the decision can be unit-tested
 *  without a DOM. */
export function resolveEffectiveTheme(
  pref: ThemePreference,
  systemPrefersDark: boolean,
): 'light' | 'dark' {
  if (pref === 'dark') return 'dark';
  if (pref === 'light') return 'light';
  return systemPrefersDark ? 'dark' : 'light';
}
