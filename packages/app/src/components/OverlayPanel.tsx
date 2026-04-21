import React from 'react';
import { motion } from 'motion/react';
import { panelSlide } from '../lib/motion.js';

interface OverlayPanelProps {
  /** Callback ref forwarded from `useAutoResizeWindow().overlayRef`.
   *  The hook reads `scrollHeight` on this element to drive the window
   *  height, so it must sit on a **block-layout** element whose natural
   *  height equals its content — which is exactly the inner wrapper
   *  this component renders. */
  measureRef?: ((el: HTMLElement | null) => void) | undefined;
  /** Optional chrome (header / tab bar) that pins to the top of the
   *  scroll viewport via `position: sticky` so it stays visible when
   *  content exceeds the window height. */
  stickyChrome?: React.ReactNode;
  /** Panel body. Rendered as a normal block beneath the sticky chrome
   *  — wrap in any padding you need. */
  children: React.ReactNode;
}

/**
 * Full-window overlay wrapper that plugs into `useAutoResizeWindow`
 * cleanly. Three invariants make the auto-resize correct and robust:
 *
 * 1. The outer `motion.div` is the **only scroll container** (`absolute
 *    inset-0 overflow-y-auto`). It also provides the opaque background
 *    fill so the main-app tab behind the overlay never peeks through
 *    during the slide-in animation.
 * 2. The inner `<div ref={measureRef}>` uses **plain block layout** —
 *    no flex, no percentage max-heights, no `flex-basis: auto`
 *    gymnastics. Its `offsetHeight` / `scrollHeight` deterministically
 *    equal the sum of its children's heights, which is what the hook
 *    uses to size the window.
 * 3. Optional `stickyChrome` sits inside the measured wrapper and uses
 *    `position: sticky; top: 0` so the panel's own header + tab bar
 *    remain visible when the content is taller than the window cap and
 *    the outer motion.div scrolls.
 *
 * Any future full-window overlay page should use this component. The
 * alternative — fighting CSS to size an absolute-positioned flex column
 * to auto-height with a percentage max — is a bug generator.
 */
export default function OverlayPanel({
  measureRef,
  stickyChrome,
  children,
}: OverlayPanelProps): React.ReactElement {
  return (
    <motion.div
      {...panelSlide}
      className="absolute inset-0 z-20 overflow-y-auto bg-[#F2F2F7] dark:bg-[#111111]"
    >
      <div ref={measureRef as React.Ref<HTMLDivElement>}>
        {stickyChrome && (
          <div className="sticky top-0 z-10 bg-[#F2F2F7] dark:bg-[#111111]">{stickyChrome}</div>
        )}
        {children}
      </div>
    </motion.div>
  );
}
