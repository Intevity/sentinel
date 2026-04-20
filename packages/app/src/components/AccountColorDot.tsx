import React from 'react';

interface Props {
  /** 7-char hex color. When omitted the dot renders in a muted gray so rows
   *  without an associated account (e.g. pool-scoped alerts) still keep
   *  horizontal alignment with account-scoped rows. */
  color?: string | null;
  /** Diameter. `xs` (6px) fits inline with 10-11px text; `sm` (8px) is the
   *  default for row accents. */
  size?: 'xs' | 'sm';
  title?: string;
}

export default function AccountColorDot({ color, size = 'sm', title }: Props): React.ReactElement {
  const px = size === 'xs' ? 'w-1.5 h-1.5' : 'w-2 h-2';
  const bg = color ?? '#8E8E93';
  const opacity = color ? 1 : 0.45;
  return (
    <span
      className={`inline-block rounded-full shrink-0 ${px}`}
      style={{ backgroundColor: bg, opacity }}
      {...(title ? { title } : {})}
    />
  );
}
