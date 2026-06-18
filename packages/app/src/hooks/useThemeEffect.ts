import { useEffect } from 'react';
import type { ThemePreference } from '@sentinel/shared';
import { THEME_STORAGE_KEY, resolveEffectiveTheme } from './useThemeEffect.logic.js';

export { THEME_STORAGE_KEY, resolveEffectiveTheme } from './useThemeEffect.logic.js';

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

function applyTheme(effective: 'light' | 'dark'): void {
  const root = document.documentElement;
  if (effective === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

/**
 * Drive `<html class="dark">` from the user's theme preference.
 *
 *   - `'light'` / `'dark'` pin the theme regardless of OS.
 *   - `'system'` resolves via `prefers-color-scheme` and re-applies
 *     whenever the OS switches.
 *
 * Also mirrors the chosen preference to localStorage so the inline
 * pre-mount script in index.html can pre-apply the class on the next
 * cold launch without waiting for the daemon's settings response —
 * avoiding a flash-of-wrong-theme.
 *
 * `pref` may be `null` while settings are still loading; the hook
 * no-ops in that case and lets the FOWT script's pre-applied class
 * stand until settings arrive.
 */
export function useThemeEffect(pref: ThemePreference | null): void {
  useEffect(() => {
    if (pref === null) return;

    try {
      localStorage.setItem(THEME_STORAGE_KEY, pref);
    } catch {
      // Non-fatal: storage may be unavailable (private mode, etc.).
      // The current-session class will still apply; only the FOWT
      // pre-launch hint is lost.
    }

    if (pref !== 'system') {
      applyTheme(resolveEffectiveTheme(pref, false));
      return;
    }

    // 'system' — track the OS preference live so theme follows the
    // OS without requiring a settings round-trip.
    const mql = window.matchMedia(DARK_MEDIA_QUERY);
    applyTheme(resolveEffectiveTheme('system', mql.matches));
    const handler = (e: MediaQueryListEvent): void => {
      applyTheme(resolveEffectiveTheme('system', e.matches));
    };
    mql.addEventListener('change', handler);
    return () => {
      mql.removeEventListener('change', handler);
    };
  }, [pref]);
}
