import React, { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { Bug } from 'lucide-react';
import type { LogEntry, LogRequestSummary } from '@sentinel/shared';
import intevityLogo from '../assets/intevityLogoIcon.png';
import { openBugReport } from '../lib/bugReport.js';
import { sendToSentinel } from '../lib/ipc.js';

const INTEVITY_URL =
  'https://www.intevity.com/?utm_source=sentinel&utm_medium=app&utm_campaign=built-by-footer';

interface FooterProps {
  daemonErrors?: LogEntry[];
  recentEntries?: LogEntry[];
  hasUnseenErrors?: boolean;
  markErrorsSeen?: () => void;
}

// `v<tag>` is a nicer render for tagged releases (v0.2.0) but the "dev"
// fallback reads better without the leading `v`.
const displayVersion = __APP_VERSION__.startsWith('v')
  ? __APP_VERSION__
  : __APP_VERSION__ === 'dev'
    ? 'dev'
    : `v${__APP_VERSION__}`;

// Dev builds surface the version as a clickable DevTools trigger for the
// main webview — useful for diagnosing the claude.ai login flow, rate-limit
// IPC round-trips, or any UI state that needs `console.log` visibility.
// Release builds keep it as a plain title tooltip.
const isDevBuild = displayVersion === 'dev';

export default function Footer({
  daemonErrors,
  recentEntries,
  hasUnseenErrors,
  markErrorsSeen,
}: FooterProps = {}): React.ReactElement {
  const handleOpen = (): void => {
    void openUrl(INTEVITY_URL);
  };

  const handleReportBug = (): void => {
    // Auto-include any surfaced daemon errors so the user doesn't have to
    // copy-paste them. The badge's "unseen" signal clears regardless of
    // whether the GitHub composer actually opens — we don't want the dot
    // to stay red forever if the user abandons the report.
    const source =
      hasUnseenErrors && daemonErrors && daemonErrors.length > 0 ? 'daemon-error' : 'manual';

    // Best-effort enrichment: each error that carries a requestId points
    // to a captured row in the request-logs DB with status, duration,
    // and isSse — exactly the metadata that distinguishes a pre-headers
    // ETIMEDOUT (statusCode=null) from a mid-stream one (statusCode=200,
    // long durationMs). If the IPC call fails (daemon down, bodies
    // already purged), we still open the report with whatever we have.
    const requestIds = Array.from(
      new Set((daemonErrors ?? []).map((e) => e.requestId).filter((id): id is string => !!id)),
    );

    const fetchSummaries = async (): Promise<LogRequestSummary[]> => {
      if (requestIds.length === 0) return [];
      try {
        const res = await sendToSentinel<LogRequestSummary[]>({
          type: 'get_request_summaries',
          requestIds,
        });
        return res.success && res.data ? res.data : [];
      } catch {
        return [];
      }
    };

    void fetchSummaries().then((requestSummaries) => {
      void openBugReport({
        source,
        daemonErrors: daemonErrors ?? [],
        recentEntries: recentEntries ?? [],
        requestSummaries,
      });
    });
    markErrorsSeen?.();
  };

  const [inspectorError, setInspectorError] = useState<string | null>(null);

  const handleVersionClick = (): void => {
    setInspectorError(null);
    // Toggle DevTools on the main window. The Rust side temporarily
    // expands the window + enables resizing so the docked inspector has
    // room to work; closing DevTools restores the tray dimensions. See
    // `toggle_devtools` in packages/app/src-tauri/src/main.rs.
    void invoke('toggle_devtools').catch((err: unknown) => {
      const msg = typeof err === 'string' ? err : String(err);
      setInspectorError(msg);
      console.error('toggle_devtools failed:', err);
    });
  };

  return (
    <footer className="flex-shrink-0 flex flex-col items-stretch border-t border-black/10 dark:border-white/10 text-[10px] text-muted">
      {inspectorError && (
        <div className="px-4 py-1.5 bg-ios-orange/10 text-ios-orange text-[10px] flex items-start justify-between gap-2 border-b border-ios-orange/20">
          <span className="break-words">{inspectorError}</span>
          <button
            type="button"
            onClick={() => setInspectorError(null)}
            className="shrink-0 text-ios-orange/70 hover:text-ios-orange font-bold"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
      <div className="flex items-center justify-between px-4 py-1.5">
        <div className="flex items-center gap-2">
          {isDevBuild ? (
            <button
              type="button"
              onClick={handleVersionClick}
              className="font-mono tabular-nums rounded-md px-1 -mx-1 py-0.5 hover:text-[#3A3A3C] dark:hover:text-white hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue"
              title="Click to open DevTools (Safari Web Inspector on macOS)"
            >
              {displayVersion}
            </button>
          ) : (
            <span className="font-mono tabular-nums" title={`Sentinel ${displayVersion}`}>
              {displayVersion}
            </span>
          )}
          <span aria-hidden="true" className="h-3 w-px bg-black/15 dark:bg-white/15" />
          <button
            type="button"
            onClick={handleReportBug}
            className="relative flex items-center gap-1 rounded-md px-1 py-0.5 hover:text-[#3A3A3C] dark:hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue"
            aria-label={
              hasUnseenErrors ? 'Report a bug (new daemon errors detected)' : 'Report a bug'
            }
            title={hasUnseenErrors ? 'Recent daemon errors detected; report a bug' : 'Report a bug'}
          >
            <Bug size={11} strokeWidth={2.2} />
            <span>Report</span>
            {hasUnseenErrors && (
              <span
                aria-hidden="true"
                className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-ios-red"
              />
            )}
          </button>
        </div>
        <button
          type="button"
          onClick={handleOpen}
          className="flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:text-[#3A3A3C] dark:hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue"
          aria-label="Built by Intevity; open intevity.com"
        >
          <span>Built by</span>
          <img src={intevityLogo} alt="Intevity" className="h-3.5 w-auto" />
        </button>
      </div>
    </footer>
  );
}
