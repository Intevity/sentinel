import { describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY, resolveEffectiveTheme } from './useThemeEffect.logic.js';

describe('resolveEffectiveTheme', () => {
  it('pins to "light" regardless of system preference', () => {
    expect(resolveEffectiveTheme('light', false)).toBe('light');
    expect(resolveEffectiveTheme('light', true)).toBe('light');
  });

  it('pins to "dark" regardless of system preference', () => {
    expect(resolveEffectiveTheme('dark', false)).toBe('dark');
    expect(resolveEffectiveTheme('dark', true)).toBe('dark');
  });

  it('follows the system preference when set to "system"', () => {
    expect(resolveEffectiveTheme('system', true)).toBe('dark');
    expect(resolveEffectiveTheme('system', false)).toBe('light');
  });
});

describe('THEME_STORAGE_KEY', () => {
  it('matches the literal used by the inline pre-mount script in index.html', () => {
    // The FOWT script in packages/app/index.html duplicates this literal
    // because it runs before any modules import. If you change one,
    // you must change the other.
    expect(THEME_STORAGE_KEY).toBe('sentinel.theme.v1');
  });
});
