import type { CSSProperties } from 'react';
import type { AccountInfo } from '@claude-sentinel/shared';

// ─── Default avatar palette ──────────────────────────────────────────────────
// Pairs with Tailwind gradient classes used when no custom color is set. The
// first hex (`from`) is also the "primary" color used for dots and accents so
// the dot color matches the dominant tone of the avatar.
const PALETTE: ReadonlyArray<{ className: string; from: string; to: string }> = [
  { className: 'from-[#007AFF] to-[#5E5CE6]', from: '#007AFF', to: '#5E5CE6' },
  { className: 'from-[#30D158] to-[#007AFF]', from: '#30D158', to: '#007AFF' },
  { className: 'from-[#BF5AF2] to-[#5E5CE6]', from: '#BF5AF2', to: '#5E5CE6' },
  { className: 'from-[#FF9F0A] to-[#FF453A]', from: '#FF9F0A', to: '#FF453A' },
];

/** The 8 tap-target swatches shown in the color-picker's quick palette. iOS
 *  system tints chosen to be instantly distinguishable at 10px. */
export const PRESET_SWATCHES: ReadonlyArray<string> = [
  '#007AFF', // blue
  '#30D158', // green
  '#FF9F0A', // orange
  '#FF453A', // red
  '#BF5AF2', // purple
  '#FF2D92', // pink
  '#64D2FF', // teal
  '#FFD60A', // yellow
];

function paletteIndex(id: string): number {
  const sum = id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return sum % PALETTE.length;
}

/** Darken a 7-char hex (`#RRGGBB`) by the given factor in [0..1]. Used to
 *  synthesize the second stop of the avatar gradient from a user-picked color
 *  so the circle keeps its 2-tone look. */
function darken(hex: string, factor: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 0xff) * factor);
  const g = Math.round(((n >> 8) & 0xff) * factor);
  const b = Math.round((n & 0xff) * factor);
  const hh = (v: number): string => v.toString(16).padStart(2, '0');
  return `#${hh(r)}${hh(g)}${hh(b)}`;
}

/**
 * Resolved primary color for an account — hex. Returns the user-picked color
 * when set, otherwise the deterministic first-stop from the default palette.
 * Use this for dots, accent strokes, and anywhere a single color is needed.
 */
export function accountColor(account: Pick<AccountInfo, 'id' | 'color'>): string {
  if (account.color) return account.color;
  const entry = PALETTE[paletteIndex(account.id)];
  /* v8 ignore next 1 */
  return entry ? entry.from : '#007AFF';
}

/**
 * Inline style + class-name pair for the circular avatar. When the account
 * has a custom color we emit an inline `linear-gradient` (color → darkened
 * variant). Otherwise we return the Tailwind class for the preset gradient
 * so Tailwind's bundler keeps these classes in the build.
 */
export function avatarStyle(account: Pick<AccountInfo, 'id' | 'color'>): {
  className: string;
  style?: CSSProperties;
} {
  if (account.color) {
    return {
      className: '',
      style: {
        backgroundImage: `linear-gradient(to bottom right, ${account.color}, ${darken(account.color, 0.75)})`,
      },
    };
  }
  const entry = PALETTE[paletteIndex(account.id)];
  /* v8 ignore next 1 */
  return { className: `bg-gradient-to-br ${entry ? entry.className : PALETTE[0]!.className}` };
}
