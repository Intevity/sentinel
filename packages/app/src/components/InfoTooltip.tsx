import React from 'react';
import { Info } from 'lucide-react';

interface InfoTooltipProps {
  /** Tooltip body. Plain string — line breaks render as spaces.
   *  Use <InfoTooltipRich> for longer content with links. */
  text: string;
  /** Which edge of the trigger the tooltip docks to. Defaults to "top". */
  placement?: 'top' | 'bottom';
  /** Override icon size. Defaults to 11px to fit inline with section headers. */
  size?: number;
  className?: string;
}

/**
 * Small info icon with a group-hover tooltip. Extracted from the pattern
 * first used on AccountCard so other tabs can surface provenance / help text
 * without duplicating the markup.
 *
 * The tooltip is pointer-events-none so it never blocks clicks on sibling
 * buttons, and positions itself right-aligned by default to avoid clipping
 * on narrow cards.
 */
export default function InfoTooltip({
  text,
  placement = 'top',
  size = 11,
  className,
}: InfoTooltipProps): React.ReactElement {
  const bubblePos =
    placement === 'bottom'
      ? 'top-full right-0 mt-1.5'
      : 'bottom-full right-0 mb-1.5';

  return (
    <div className={`relative group inline-flex items-center ${className ?? ''}`}>
      <Info
        size={size}
        strokeWidth={2.2}
        className="text-[#8E8E93] hover:text-ios-blue transition-colors cursor-help"
      />
      <div
        className={`pointer-events-none absolute ${bubblePos} opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-20`}
      >
        <div className="bg-black/90 dark:bg-white/95 text-white dark:text-black text-[10px] font-medium px-2.5 py-1.5 rounded-md shadow-lg leading-snug max-w-[280px]">
          {text}
        </div>
      </div>
    </div>
  );
}

interface InfoTooltipRichProps {
  /** Tooltip body — can include React nodes (links, formatting). */
  children: React.ReactNode;
  placement?: 'top' | 'bottom';
  size?: number;
  className?: string;
}

/** Variant of InfoTooltip that accepts arbitrary ReactNode content (multi-paragraph,
 *  links, code spans). Use for longer-form help copy. */
export function InfoTooltipRich({
  children,
  placement = 'top',
  size = 11,
  className,
}: InfoTooltipRichProps): React.ReactElement {
  const bubblePos =
    placement === 'bottom'
      ? 'top-full right-0 mt-1.5'
      : 'bottom-full right-0 mb-1.5';

  return (
    <div className={`relative group inline-flex items-center ${className ?? ''}`}>
      <Info
        size={size}
        strokeWidth={2.2}
        className="text-[#8E8E93] hover:text-ios-blue transition-colors cursor-help"
      />
      <div
        className={`pointer-events-none absolute ${bubblePos} opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-20`}
      >
        <div className="bg-black/90 dark:bg-white/95 text-white dark:text-black text-[10px] font-medium px-2.5 py-1.5 rounded-md shadow-lg leading-snug max-w-[320px] space-y-1">
          {children}
        </div>
      </div>
    </div>
  );
}
