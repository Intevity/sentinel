#!/usr/bin/env node
/**
 * Fail on Tailwind colour utilities whose colour name this project does not
 * define — the class Tailwind then emits nothing for, so the element silently
 * renders with no background, no text colour, or no border.
 *
 * v0.9.5 shipped the Update-credentials modal using `bg-background` and
 * `text-background`. Neither exists (the theme defines `foreground`, `muted`,
 * `border-subtle`, `surface-overlay` — there is no `background`), so the modal
 * was fully transparent with an invisible button label. Type-check, 3900 unit
 * tests, coverage, and every CI leg passed: nothing in the pipeline can see an
 * unreadable panel. This script is the cheap mechanical guard for that class of
 * mistake.
 *
 * Deliberately narrow to stay false-positive-free:
 *   - only the utility prefixes that take a colour (bg-, text-, border-, …)
 *   - arbitrary values (`bg-[#1C1C1E]`), CSS vars, and template interpolation
 *     are skipped — they can't be validated here and are already explicit
 *   - the allowlist is the Tailwind default palette plus this repo's theme
 *     colours, read from tailwind.config.js so the two cannot drift
 *
 * Usage: node scripts/tailwind-classes.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCAN_DIR = join(REPO_ROOT, 'packages/app/src');
const TAILWIND_CONFIG = join(REPO_ROOT, 'packages/app/tailwind.config.js');

/** Utility prefixes whose next segment is a colour name. */
const COLOR_PREFIXES = [
  'bg',
  'text',
  'border',
  'ring',
  'divide',
  'outline',
  'decoration',
  'fill',
  'stroke',
  'shadow',
  'accent',
  'caret',
  'from',
  'via',
  'to',
  'placeholder',
];

/** Tailwind's default palette names (v3). */
const DEFAULT_PALETTE = new Set([
  'inherit',
  'current',
  'transparent',
  'black',
  'white',
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
]);

/**
 * Non-colour values that legitimately follow a colour-capable prefix — sizes,
 * positions, keywords and the like. `text-sm` is a font size, not a colour;
 * `border-2` is a width. Listing them keeps the check quiet on valid code.
 */
const NON_COLOR_VALUES = new Set([
  // side / axis selectors: border-t, border-l-2, divide-y, inset-x …
  't',
  'b',
  'l',
  'r',
  'x',
  'y',
  's',
  'e',
  // shared keywords
  'none',
  'auto',
  'left',
  'right',
  'center',
  'top',
  'bottom',
  'start',
  'end',
  'justify',
  'wrap',
  'nowrap',
  'balance',
  'pretty',
  'clip',
  'ellipsis',
  'solid',
  'dashed',
  'dotted',
  'double',
  'hidden',
  'collapse',
  'separate',
  'opacity',
  // font sizes
  'xs',
  '2xs',
  'sm',
  'base',
  'lg',
  'xl',
  '2xl',
  '3xl',
  '4xl',
  '5xl',
  '6xl',
  '7xl',
  '8xl',
  '9xl',
  // bg-* non-colour utilities
  'cover',
  'contain',
  'fixed',
  'local',
  'scroll',
  'repeat',
  'no',
  'origin',
  'gradient',
  'blend',
  'clip',
  // shadow / ring / border sizes handled numerically below
  'inner',
  'sm',
  'md',
  'inset',
  'offset',
]);

function themeColorNames() {
  const src = readFileSync(TAILWIND_CONFIG, 'utf-8');
  const names = new Set();
  // `colors: { ... }` block — capture top-level keys, quoted or bare.
  const colorsIdx = src.indexOf('colors:');
  if (colorsIdx === -1) throw new Error('could not find `colors:` in tailwind.config.js');
  const tail = src.slice(colorsIdx);
  for (const m of tail.matchAll(/^\s{6,8}'?([a-zA-Z][\w-]*)'?:/gm)) {
    names.add(m[1]);
  }
  return names;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

const themeColors = themeColorNames();
const allowed = new Set([...DEFAULT_PALETTE, ...themeColors]);
const prefixAlt = COLOR_PREFIXES.join('|');
// Matches `[variant:]prefix-name[/opacity]` inside a class-ish string. The
// name capture stops before `/`, whitespace, quote, or backtick.
const CLASS_RE = new RegExp(`\\b(?:[a-z-]+:)*(${prefixAlt})-([a-zA-Z][\\w-]*)`, 'g');

const failures = [];
for (const file of walk(SCAN_DIR)) {
  const lines = readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    // Only inspect lines that plausibly carry classes, and never bracketed
    // arbitrary values or interpolated expressions.
    if (!/class(Name)?\s*[=:]|['"`][a-z-]+ /.test(line)) return;
    for (const m of line.matchAll(CLASS_RE)) {
      const [, prefix, rawName] = m;
      // `border-border-subtle` → first segment `border`, which is a real theme
      // colour only if defined; check the LONGEST defined match first.
      if (allowed.has(rawName)) continue;
      const firstSeg = rawName.split('-')[0];
      if (allowed.has(firstSeg)) continue;
      if (NON_COLOR_VALUES.has(rawName) || NON_COLOR_VALUES.has(firstSeg)) continue;
      if (/^\d/.test(rawName)) continue; // border-2, shadow-0
      failures.push({
        file: relative(REPO_ROOT, file),
        line: i + 1,
        cls: `${prefix}-${rawName}`,
      });
    }
  });
}

if (failures.length > 0) {
  console.error(
    `\ntailwind-classes: ${failures.length} colour utility/utilities reference a colour this project does not define.\n` +
      `Tailwind emits nothing for these, so the element renders with no colour at all.\n` +
      `Defined theme colours: ${[...themeColors].sort().join(', ')}\n`,
  );
  for (const f of failures) console.error(`  ${f.file}:${f.line}  ${f.cls}`);
  console.error(
    '\nUse a defined theme colour, an arbitrary value (bg-[#1C1C1E]), or a component\n' +
      'class from index.css (glass-card, btn-primary, btn-ghost).\n',
  );
  process.exit(1);
}

console.log(
  `tailwind-classes ok: no undefined colour utilities in ${relative(REPO_ROOT, SCAN_DIR)}`,
);
