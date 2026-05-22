import React, { useId, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

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
 *
 * The settings-card primitives (Switch, SettingsCard, SettingsRow) exist
 * so a page like Security can show persistent config inline and keep it
 * visually distinct from filter pills — settings read as "this changes
 * what the daemon does," filters read as "this changes what I see."
 */

// ─── Full rows (moved from SettingsPanel.tsx) ────────────────────────────

export function Section(props: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="mb-4">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1.5 px-1">
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
          <p className="text-[11px] text-muted leading-snug mt-0.5">{props.description}</p>
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
          <p className="text-[11px] text-muted leading-snug mt-0.5">{props.description}</p>
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
        props.checked ? 'bg-ios-blue text-white' : 'bg-muted/10 text-muted hover:bg-muted/20'
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
                : 'text-muted hover:text-black dark:hover:text-white'
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
        props.active ? 'bg-ios-blue text-white' : 'bg-muted/10 text-muted hover:bg-muted/20'
      }`}
    >
      {props.label}
    </button>
  );
}

// ─── Settings card (collapsible, labeled) ────────────────────────────────

/**
 * iOS-style toggle switch. Visually distinct from the pill-chip controls
 * so a page can mix "persistent settings" (switches) with "view filters"
 * (pills) without them bleeding into each other. The track fills ios-blue
 * when on; the thumb slides on a CSS transform.
 */
export function Switch(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      aria-disabled={props.disabled || undefined}
      disabled={props.disabled}
      onClick={() => !props.disabled && props.onChange(!props.checked)}
      className={`relative inline-flex w-[34px] h-[20px] rounded-full transition-colors flex-shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue focus-visible:ring-offset-1 disabled:opacity-40 ${
        props.checked ? 'bg-ios-blue' : 'bg-black/10 dark:bg-white/15'
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-[2px] w-[16px] h-[16px] bg-white rounded-full shadow-sm transition-transform ${
          props.checked ? 'translate-x-[16px]' : 'translate-x-[2px]'
        }`}
      />
    </button>
  );
}

/**
 * Collapsible card with an uppercase title, chevron toggle, and optional
 * one-line summary shown when collapsed. Mirrors the Section visual
 * language (rounded-2xl, dividers between rows) and the LogsViewer /
 * filter chevron pattern for expand/collapse interaction.
 */
export function SettingsCard(props: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const bodyId = useId();
  const headerId = useId();
  return (
    <div className="mb-2 rounded-2xl bg-white dark:bg-[#1E1E1E] shadow-card overflow-hidden">
      <button
        id={headerId}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition-colors"
      >
        {open ? (
          <ChevronDown size={11} strokeWidth={2.5} className="text-muted" />
        ) : (
          <ChevronRight size={11} strokeWidth={2.5} className="text-muted" />
        )}
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
          {props.title}
        </span>
        {!open && props.summary && (
          <span className="text-[10px] text-ios-blue truncate">· {props.summary}</span>
        )}
      </button>
      {open && (
        <div
          id={bodyId}
          role="region"
          aria-labelledby={headerId}
          className="divide-y divide-black/5 dark:divide-white/5 border-t border-black/5 dark:border-white/5"
        >
          {props.children}
        </div>
      )}
    </div>
  );
}

/**
 * A row inside a SettingsCard. Label + optional description on the left,
 * arbitrary control slot on the right. Keeps padding + typography
 * consistent across different control types (Switch, QuickSegmented,
 * chip groups) so rows line up cleanly.
 */
export function SettingsRow(props: {
  label: string;
  description?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-medium text-black dark:text-white">{props.label}</p>
        {props.description && (
          <p className="text-[11px] text-muted leading-snug mt-0.5">{props.description}</p>
        )}
      </div>
      <div className="flex-shrink-0 flex items-center justify-end mt-0.5">{props.children}</div>
    </div>
  );
}
