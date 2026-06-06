import React from 'react';

/**
 * Shared metric tile for the Optimize page's three sub-tabs (Context,
 * Compression, Subagents). One component so the stat boxes stay visually
 * identical everywhere; only the column count and per-tile `tone` differ.
 *
 * The canonical look is Context's Saved/Potential boxes: rounded-lg, px-3 py-2,
 * a large text-xl value, semantic value color, and an optional caption line.
 */

export type MetricTone = 'saved' | 'potential' | 'good' | 'warn' | 'neutral';

/**
 * `saved` is the one realized-savings headline per tab — emerald value plus a
 * faint emerald box accent (mirrors how Context highlights only its Saved box).
 * `good` is positive-but-not-the-headline (emerald value, neutral box).
 * `potential` is sky, `warn` is amber, `neutral` is plain foreground.
 */
const TONE: Record<MetricTone, { box: string; value: string }> = {
  saved: {
    box: 'border-emerald-500/20 bg-emerald-500/5',
    value: 'text-emerald-700 dark:text-emerald-300',
  },
  good: { box: 'border-border-subtle/10', value: 'text-emerald-700 dark:text-emerald-300' },
  potential: { box: 'border-border-subtle/10', value: 'text-sky-700 dark:text-sky-300' },
  warn: { box: 'border-border-subtle/10', value: 'text-amber-600 dark:text-amber-400' },
  neutral: { box: 'border-border-subtle/10', value: 'text-foreground' },
};

export function MetricTile({
  label,
  value,
  subtext,
  tone = 'neutral',
  title,
}: {
  label: string;
  value: string;
  subtext?: string;
  tone?: MetricTone;
  title?: string;
}): React.ReactElement {
  const t = TONE[tone];
  return (
    <div className={`rounded-lg border px-3 py-2 ${t.box}`} title={title}>
      <div className="text-[10px] uppercase tracking-wide text-foreground/55">{label}</div>
      <div className={`mt-0.5 text-xl font-semibold tabular-nums ${t.value}`}>{value}</div>
      {subtext != null && <div className="mt-0.5 text-[11px] text-foreground/45">{subtext}</div>}
    </div>
  );
}
