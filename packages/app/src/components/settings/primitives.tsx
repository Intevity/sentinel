import React from 'react';

/**
 * Shared building-block components for settings UIs. Extracted from
 * SettingsPanel.tsx so the new quick-access toggles on other tab headers
 * (Security, Alerts, Accounts) can reuse the same visual language without
 * copy-pasting.
 *
 * The "full" row primitives (Section, ToggleRow, RadioRow) are the legacy
 * in-panel style — padded, descriptive, one-per-row. The "Quick" variants
 * (QuickToggle, QuickSegmented, QuickChipToggle) are compact pill-style
 * controls designed to live inline in tab headers next to other action
 * buttons — matching the existing filter-chip sizing on LogsViewer /
 * SecurityPanel so nothing looks out of place.
 */

// ─── Full rows (moved from SettingsPanel.tsx) ────────────────────────────

export function Section(props: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="mb-4">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[#8E8E93] mb-1.5 px-1">
        {props.title}
      </p>
      <div className="rounded-2xl bg-white dark:bg-[#1E1E1E] shadow-card overflow-hidden divide-y divide-black/5 dark:divide-white/5">
        {props.children}
      </div>
    </div>
  );
}

export function ToggleRow(props: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): React.ReactElement {
  return (
    <label className="flex items-start gap-3 px-3 py-2.5 cursor-pointer">
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-black dark:text-white">{props.label}</p>
        {props.description && (
          <p className="text-[11px] text-[#8E8E93] leading-snug mt-0.5">{props.description}</p>
        )}
      </div>
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        className="mt-1 accent-ios-blue w-4 h-4"
      />
    </label>
  );
}

export function RadioRow(props: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: () => void;
}): React.ReactElement {
  return (
    <label className="flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
      <input
        type="radio"
        checked={props.checked}
        onChange={props.onChange}
        className="mt-1 accent-ios-blue w-4 h-4"
      />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-black dark:text-white">{props.label}</p>
        {props.description && (
          <p className="text-[11px] text-[#8E8E93] leading-snug mt-0.5">{props.description}</p>
        )}
      </div>
    </label>
  );
}

// ─── Quick-access pills (new) ────────────────────────────────────────────

/**
 * Compact on/off pill with a leading label. The active state fills with
 * ios-blue; inactive is muted gray. Meant for persistent tab-header quick
 * toggles (e.g. "Scan [ON]"). Keyboard accessible via native button.
 */
export function QuickToggle(props: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  title?: string;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => !props.disabled && props.onChange(!props.checked)}
      disabled={props.disabled}
      aria-pressed={props.checked}
      title={props.title}
      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors inline-flex items-center gap-1 disabled:opacity-40 ${
        props.checked
          ? 'bg-ios-blue text-white'
          : 'bg-[#8E8E93]/10 text-[#8E8E93] hover:bg-[#8E8E93]/20'
      }`}
    >
      <span>{props.label}</span>
      <span className="opacity-80">{props.checked ? 'ON' : 'OFF'}</span>
    </button>
  );
}

/**
 * Compact segmented control for 2–4 mutually-exclusive options. Matches
 * the filter-chip visual but groups the options with a connected container
 * so the relationship is obvious. Type-parameterized over the value so
 * callers can pass string-literal unions safely.
 */
export function QuickSegmented<T extends string>(props: {
  options: Array<{ value: T; label: string; title?: string }>;
  value: T;
  onChange: (v: T) => void;
  ariaLabel?: string;
}): React.ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label={props.ariaLabel}
      className="inline-flex items-center bg-black/[0.06] dark:bg-white/[0.08] rounded-full p-[2px]"
    >
      {props.options.map((opt) => {
        const active = opt.value === props.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={opt.title}
            onClick={() => props.onChange(opt.value)}
            className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors ${
              active
                ? 'bg-ios-blue text-white'
                : 'text-[#8E8E93] hover:text-black dark:hover:text-white'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Single on/off category chip. Same shape as the filter chips on
 * SecurityPanel/LogsViewer — active = filled blue, inactive = muted gray.
 * Used for quick scan-category toggles where each category stands alone
 * rather than forming a segmented group.
 */
export function QuickChipToggle(props: {
  label: string;
  active: boolean;
  onChange: (v: boolean) => void;
  title?: string;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => !props.disabled && props.onChange(!props.active)}
      disabled={props.disabled}
      aria-pressed={props.active}
      title={props.title}
      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full transition-colors disabled:opacity-40 ${
        props.active
          ? 'bg-ios-blue text-white'
          : 'bg-[#8E8E93]/10 text-[#8E8E93] hover:bg-[#8E8E93]/20'
      }`}
    >
      {props.label}
    </button>
  );
}
