import React from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import intevityLogo from '../assets/intevityLogoIcon.png';

const INTEVITY_URL = 'https://www.intevity.com';

// `v<tag>` is a nicer render for tagged releases (v0.2.0) but the "dev"
// fallback reads better without the leading `v`.
const displayVersion = __APP_VERSION__.startsWith('v')
  ? __APP_VERSION__
  : __APP_VERSION__ === 'dev'
    ? 'dev'
    : `v${__APP_VERSION__}`;

export default function Footer(): React.ReactElement {
  const handleOpen = (): void => {
    void openUrl(INTEVITY_URL);
  };

  return (
    <footer className="flex-shrink-0 flex items-center justify-between px-4 py-1.5 border-t border-black/10 dark:border-white/10 text-[10px] text-[#8E8E93]">
      <span className="font-mono tabular-nums" title={`Claude Sentinel ${displayVersion}`}>
        {displayVersion}
      </span>
      <button
        type="button"
        onClick={handleOpen}
        className="flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:text-[#3A3A3C] dark:hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue"
        aria-label="Built by Intevity — open intevity.com"
      >
        <span>Built by</span>
        <img src={intevityLogo} alt="Intevity" className="h-3.5 w-auto" />
      </button>
    </footer>
  );
}
