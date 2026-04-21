import React, { useRef, useState, useCallback } from 'react';
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
 * Small info icon with a hover tooltip. The tooltip is a `position: fixed`
 * bubble pinned to the content edges (`left: 16px; right: 16px`) rather
 * than anchored to the icon itself — this gives the bubble the full
 * ~448px content width of the Tauri window regardless of where the icon
 * sits in the header, so long help text never clips on either edge.
 *
 * Vertical position is measured on hover: top or bottom of the icon's
 * bounding rect + 6px breathing room.
 */
export default function InfoTooltip({
  text,
  placement = 'top',
  size = 11,
  className,
}: InfoTooltipProps): React.ReactElement {
  const { triggerProps, bubbleStyle } = useTooltipPosition(placement);
  return (
    <TooltipShell className={className} triggerProps={triggerProps} bubbleStyle={bubbleStyle} size={size}>
      {text}
    </TooltipShell>
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
  const { triggerProps, bubbleStyle } = useTooltipPosition(placement);
  return (
    <TooltipShell
      className={className}
      triggerProps={triggerProps}
      bubbleStyle={bubbleStyle}
      size={size}
      extraInnerClass="space-y-1"
    >
      {children}
    </TooltipShell>
  );
}

// ─── Internals ───────────────────────────────────────────────────────────────

/** Hover/focus state + measured position for a tooltip trigger. */
function useTooltipPosition(placement: 'top' | 'bottom'): {
  triggerProps: {
    ref: React.RefObject<HTMLSpanElement>;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onFocus: () => void;
    onBlur: () => void;
    tabIndex: number;
  };
  bubbleStyle: React.CSSProperties | null;
} {
  const ref = useRef<HTMLSpanElement>(null);
  const [style, setStyle] = useState<React.CSSProperties | null>(null);

  const show = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Pin the bubble to the window's content edges (matches the tab's px-4
    // padding) regardless of where the icon sits horizontally. Vertical
    // anchor is the icon's near edge plus 6px breathing room.
    if (placement === 'bottom') {
      setStyle({ top: Math.round(rect.bottom + 6), left: 16, right: 16 });
    } else {
      setStyle({ bottom: Math.round(window.innerHeight - rect.top + 6), left: 16, right: 16 });
    }
  }, [placement]);

  const hide = useCallback(() => setStyle(null), []);

  return {
    triggerProps: {
      ref,
      onMouseEnter: show,
      onMouseLeave: hide,
      onFocus: show,
      onBlur: hide,
      tabIndex: 0,
    },
    bubbleStyle: style,
  };
}

interface TooltipShellProps {
  className: string | undefined;
  triggerProps: ReturnType<typeof useTooltipPosition>['triggerProps'];
  bubbleStyle: React.CSSProperties | null;
  size: number;
  children: React.ReactNode;
  extraInnerClass?: string;
}

function TooltipShell({
  className,
  triggerProps,
  bubbleStyle,
  size,
  children,
  extraInnerClass,
}: TooltipShellProps): React.ReactElement {
  return (
    <span
      ref={triggerProps.ref}
      onMouseEnter={triggerProps.onMouseEnter}
      onMouseLeave={triggerProps.onMouseLeave}
      onFocus={triggerProps.onFocus}
      onBlur={triggerProps.onBlur}
      tabIndex={triggerProps.tabIndex}
      className={`inline-flex items-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue ${className ?? ''}`}
    >
      <Info
        size={size}
        strokeWidth={2.2}
        className="text-[#8E8E93] hover:text-ios-blue transition-colors"
      />
      {bubbleStyle && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50"
          style={bubbleStyle}
        >
          <div className={`bg-black/90 dark:bg-white/95 text-white dark:text-black text-[10px] font-medium px-2.5 py-1.5 rounded-md shadow-lg leading-snug ${extraInnerClass ?? ''}`}>
            {children}
          </div>
        </div>
      )}
    </span>
  );
}
