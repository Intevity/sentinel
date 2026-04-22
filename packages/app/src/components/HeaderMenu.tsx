import React, { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Power, Activity, Trash2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { invoke } from '@tauri-apps/api/core';
import { sendToSentinel } from '../lib/ipc.js';
import type { DaemonProcessStatus } from '@claude-sentinel/shared';
import { menuPop } from '../lib/motion.js';

/**
 * Format a millisecond uptime as a short human-readable string.
 */
function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/**
 * Header overflow menu — click the ⋯ icon to reveal daemon status + Quit.
 *
 * "Quit Sentinel" asks the daemon to shut itself down via IPC, then exits the
 * Tauri app. We deliberately quit the daemon too (even though it normally
 * persists after closing the window) because this menu item expresses explicit
 * user intent to stop everything.
 */
interface HeaderMenuProps {
  /** Callback ref attached to the dropdown when open, so the auto-resize hook
   *  can grow the window to fit the expanded menu (e.g. the Uninstall confirm
   *  panel) instead of letting it get clipped by the current window height. */
  measureRef?: (el: HTMLElement | null) => void;
}

export default function HeaderMenu({ measureRef }: HeaderMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<DaemonProcessStatus | null>(null);
  const [quitting, setQuitting] = useState(false);
  const [uninstallStep, setUninstallStep] = useState<'idle' | 'confirm' | 'running'>('idle');
  const [deleteData, setDeleteData] = useState(false);
  const [uninstallError, setUninstallError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click and refresh status while open. 1s tick is enough to
  // keep the uptime readout fresh without any real cost.
  useEffect(() => {
    if (!open) return;

    const fetchStatus = async (): Promise<void> => {
      try {
        const res = await sendToSentinel<DaemonProcessStatus>({ type: 'get_daemon_status' });
        if (res.data) setStatus(res.data);
      } catch {
        setStatus(null);
      }
    };
    void fetchStatus();
    const interval = setInterval(() => void fetchStatus(), 1000);

    const onDocClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        // Also reset any half-open uninstall confirm when dismissing.
        setUninstallStep('idle');
        setDeleteData(false);
        setUninstallError(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);

    return () => {
      clearInterval(interval);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [open]);

  const handleQuit = async (): Promise<void> => {
    setQuitting(true);
    try {
      // Best-effort: ask the daemon to shut itself down. If the IPC call fails
      // or times out, we still exit the app — the daemon will be reaped when
      // the OS cleans up child processes of the app.
      await sendToSentinel({ type: 'shutdown_daemon' }).catch(() => undefined);
    } finally {
      await invoke('quit_app').catch(() => undefined);
    }
  };

  const handleUninstall = async (): Promise<void> => {
    setUninstallStep('running');
    setUninstallError(null);
    try {
      // 1. If user opted in, purge keychain entries (daemon still alive).
      if (deleteData) {
        await sendToSentinel({ type: 'purge_all_data' }).catch(() => undefined);
        // 1b. Evict WebKit's persistent cookie jar (HttpOnly claude.ai
        //     sessionKey + localStorage + disk cache). Without this, the
        //     cookie survives uninstall — WKWebsiteDataStore lives at
        //     ~/Library/WebKit/Claude Sentinel/, separate from both the
        //     macOS keychain and ~/.claude-sentinel/. On next Connect
        //     claude.ai would auto-authenticate in <1 second from the
        //     cached cookie and the user never sees a login screen —
        //     making "Also delete all local data" a lie. Must run while
        //     a webview is still alive (before shutdown/quit). Best-effort:
        //     failures don't block the rest of the uninstall.
        await invoke('clear_claude_ai_cookies').catch(() => undefined);
      }
      // 2. Shut the daemon down so the socket/db are released before file deletion.
      await sendToSentinel({ type: 'shutdown_daemon' }).catch(() => undefined);
      // 3. Unpatch settings.json (+ optionally wipe ~/.claude-sentinel/).
      await invoke('deactivate_sentinel', { deleteData });
      // 4. Exit the app.
      await invoke('quit_app').catch(() => undefined);
    } catch (e) {
      setUninstallError(String(e));
      setUninstallStep('confirm');
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors active:scale-90 p-0.5 -m-0.5"
        title="More"
        aria-label="Menu"
      >
        <MoreHorizontal size={16} strokeWidth={2.2} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            {...menuPop}
            ref={measureRef}
            style={{ transformOrigin: 'top right' }}
            className="absolute right-0 top-full mt-1 z-30 min-w-[220px] rounded-xl bg-white dark:bg-[#2A2A2C] shadow-lg ring-1 ring-black/10 dark:ring-white/10 overflow-hidden"
          >
            {/* Daemon status row (display-only) */}
            <div className="px-3 py-2 border-b border-black/5 dark:border-white/5">
              <div className="flex items-center gap-1.5 mb-0.5">
                <Activity size={11} strokeWidth={2.5} className="text-ios-green" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-[#8E8E93]">
                  Daemon
                </span>
              </div>
              {status ? (
                <p className="text-[11px] text-black dark:text-white tabular-nums">
                  pid <span className="font-semibold">{status.pid}</span>
                  <span className="text-[#8E8E93]"> · uptime </span>
                  <span className="font-semibold">{formatUptime(status.uptimeMs)}</span>
                </p>
              ) : (
                <p className="text-[11px] text-[#8E8E93]">Not connected</p>
              )}
            </div>

            {/* Quit Sentinel */}
            <button
              onClick={() => void handleQuit()}
              disabled={quitting || uninstallStep !== 'idle'}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-black dark:text-white whitespace-nowrap hover:bg-black/[0.05] dark:hover:bg-white/[0.06] disabled:opacity-50 transition-colors"
            >
              <Power size={12} strokeWidth={2.5} />
              <span>{quitting ? 'Quitting…' : 'Quit Sentinel'}</span>
              <span className="ml-auto pl-3 text-[10px] text-[#8E8E93]">
                Stops the background service
              </span>
            </button>

            {/* Uninstall */}
            {uninstallStep === 'idle' && (
              <button
                onClick={() => setUninstallStep('confirm')}
                disabled={quitting}
                className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-ios-red border-t border-black/5 dark:border-white/5 hover:bg-ios-red/10 dark:hover:bg-ios-red/15 disabled:opacity-50 transition-colors"
              >
                <Trash2 size={12} strokeWidth={2.5} />
                Uninstall Sentinel…
              </button>
            )}

            {uninstallStep !== 'idle' && (
              <div className="border-t border-black/5 dark:border-white/5 px-3 py-3 bg-ios-red/[0.04] dark:bg-ios-red/[0.08]">
                <p className="text-[12px] font-semibold text-black dark:text-white mb-1">
                  Uninstall Sentinel?
                </p>
                <p className="text-[11px] text-[#8E8E93] leading-snug mb-2">
                  Removes the Sentinel env vars from{' '}
                  <code className="font-mono">~/.claude/settings.json</code> so Claude Code goes
                  back to calling Anthropic directly.
                </p>
                <label className="flex items-start gap-2 text-[11px] text-black dark:text-white mb-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deleteData}
                    onChange={(e) => setDeleteData(e.target.checked)}
                    disabled={uninstallStep === 'running'}
                    className="mt-0.5 accent-ios-red"
                  />
                  <span>
                    Also delete all local data (usage history, rate-limit cache, stored credentials)
                  </span>
                </label>
                {uninstallError && (
                  <p className="text-[11px] text-ios-red mb-2 font-mono break-all">
                    {uninstallError}
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => void handleUninstall()}
                    disabled={uninstallStep === 'running'}
                    className="flex-1 text-[12px] font-semibold text-white bg-ios-red hover:opacity-90 active:scale-95 px-3 py-1.5 rounded-full transition-all disabled:opacity-50"
                  >
                    {uninstallStep === 'running' ? 'Uninstalling…' : 'Uninstall'}
                  </button>
                  <button
                    onClick={() => {
                      setUninstallStep('idle');
                      setDeleteData(false);
                      setUninstallError(null);
                    }}
                    disabled={uninstallStep === 'running'}
                    className="text-[12px] text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors px-2"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
