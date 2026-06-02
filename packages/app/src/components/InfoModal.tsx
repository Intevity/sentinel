import React, { useState, useEffect, useCallback } from 'react';
import { Info, X } from 'lucide-react';

/**
 * A small info (ⓘ) icon that opens a click-to-read modal. Use this instead of
 * {@link InfoTooltip} when the explanation is more than a sentence or two
 * (e.g. comparing options, multi-paragraph help) — a deliberate, dismissible
 * dialog reads better than a hover bubble for that.
 *
 * Visuals mirror the app's modal convention (OtelDriftBanner / SettingsPanel):
 * a `bg-black/40 backdrop-blur-sm` overlay with a centered glass card. Closes
 * on backdrop click, the X button, or Escape. Tall content scrolls.
 */
export default function InfoModal({
  title,
  children,
  ariaLabel,
  size = 12,
  className,
}: {
  /** Modal heading, also the dialog's accessible name. */
  title: string;
  /** The explanation body (rich JSX). */
  children: React.ReactNode;
  /** Accessible label for the trigger icon. Defaults to "What is {title}?". */
  ariaLabel?: string;
  /** Trigger icon size in px. Defaults to 12 to sit inline with labels. */
  size?: number;
  className?: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label={ariaLabel ?? `What is ${title}?`}
        onClick={() => setOpen(true)}
        className={`inline-flex items-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue ${className ?? ''}`}
      >
        <Info
          size={size}
          strokeWidth={2.2}
          className="text-muted hover:text-ios-blue transition-colors"
        />
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-label={title}
          onClick={close}
        >
          <div
            className="max-h-[80vh] w-[420px] max-w-[92vw] overflow-y-auto rounded-2xl bg-white p-5 shadow-card-lg dark:bg-[#1C1C1E]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2 flex items-start justify-between gap-3">
              <h3 className="text-[14px] font-semibold text-black dark:text-white">{title}</h3>
              <button
                type="button"
                aria-label="Close"
                onClick={close}
                className="shrink-0 text-muted transition-colors hover:text-black dark:hover:text-white"
              >
                <X size={16} strokeWidth={2.4} />
              </button>
            </div>
            <div className="space-y-2 text-[12px] leading-relaxed text-muted">{children}</div>
          </div>
        </div>
      )}
    </>
  );
}
