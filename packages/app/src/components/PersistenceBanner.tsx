import React, { useEffect, useState } from 'react';
import { Info, X } from 'lucide-react';

const STORAGE_KEY = 'sentinel.persistenceBannerDismissed.v1';

/**
 * One-time informational banner shown until the user dismisses it. Explains
 * that the Sentinel background daemon keeps running after the window is
 * closed, so Claude Code continues to route through it — and that the ⋯
 * menu has a real "Quit Sentinel" when they want to stop both.
 *
 * Rendered inline at the top of the main content; never reappears once
 * dismissed (flag persisted in localStorage).
 */
export default function PersistenceBanner(): React.ReactElement | null {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(STORAGE_KEY) !== '1') setVisible(true);
    } catch {
      // localStorage may be unavailable in some WebView contexts — fail open
      // (show the banner; user can still dismiss it this session).
      setVisible(true);
    }
  }, []);

  const dismiss = (): void => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* no-op */
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="mx-4 mt-2 rounded-2xl bg-ios-blue/[0.08] dark:bg-ios-blue/[0.12] ring-1 ring-ios-blue/20 px-3 py-2.5 flex items-start gap-2">
      <Info size={13} strokeWidth={2.5} className="text-ios-blue shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-black dark:text-white font-medium leading-snug">
          The Sentinel background service keeps running when you close this window, so Claude Code
          continues to route through it.
        </p>
        <p className="text-[10.5px] text-muted mt-0.5 leading-snug">
          Use the ⋯ menu → <span className="font-semibold">Quit Sentinel</span> to stop both.
        </p>
      </div>
      <button
        onClick={dismiss}
        className="text-muted hover:text-black dark:hover:text-white transition-colors active:scale-90 shrink-0"
        aria-label="Dismiss"
      >
        <X size={13} strokeWidth={2.5} />
      </button>
    </div>
  );
}
