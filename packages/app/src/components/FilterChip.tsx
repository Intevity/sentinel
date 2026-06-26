import React from 'react';

/**
 * Small pill toggle used by the tool-permission rules filter row and the
 * scanning-allowlist category chips, so the inline PermissionRulesPanel and
 * AllowlistPanel (Settings › Security) share one consistent chip.
 */
export function FilterChip({
  label,
  count,
  active,
  onClick,
  tone,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  tone?: 'red' | 'green' | 'orange' | 'blue';
}): React.ReactElement {
  const activeToneMap: Record<NonNullable<typeof tone>, string> = {
    red: 'bg-ios-red text-white',
    green: 'bg-ios-green text-white',
    orange: 'bg-ios-orange text-white',
    blue: 'bg-ios-blue text-white',
  };
  const activeClass = active
    ? tone
      ? activeToneMap[tone]
      : 'bg-ios-blue text-white'
    : 'bg-black/[0.05] dark:bg-white/[0.08] text-black/70 dark:text-white/80 hover:bg-black/[0.08] dark:hover:bg-white/[0.12]';
  return (
    <button
      onClick={onClick}
      className={`text-[11px] font-medium px-2 py-0.5 rounded-full transition-all active:scale-95 ${activeClass}`}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span className={`ml-1 ${active ? 'opacity-80' : 'opacity-60'}`}>· {count}</span>
      )}
    </button>
  );
}
