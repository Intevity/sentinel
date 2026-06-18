import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowDownToLine, Loader2, X } from 'lucide-react';

/**
 * "Update available" dialog raised by the Rust updater's `update_available`
 * event (manual tray check, the Settings "Check for updates now…" button, or
 * the 4-hourly background check). Nothing installs until the user clicks
 * Install: the Rust side stashes the found update and the `install_update`
 * command consumes it, downloads, installs, and restarts the app.
 * Dismissing is cheap; the next check raises the dialog again.
 *
 * Visuals mirror InfoModal's overlay + centered card convention.
 */
export default function UpdateModal({
  version,
  currentVersion,
  onClose,
}: {
  /** Version announced by the update endpoint (no leading "v"). */
  version: string;
  /** Version currently running (no leading "v"). */
  currentVersion: string;
  onClose: () => void;
}): React.ReactElement {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape closes, but not mid-install: the restart is imminent and the
  // dialog is the only progress signal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !installing) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [installing, onClose]);

  const install = useCallback(async (): Promise<void> => {
    setInstalling(true);
    setError(null);
    try {
      // On success the app restarts and this promise never settles in a
      // surviving webview; the catch below only runs on failure.
      await invoke('install_update');
    } catch (e) {
      setError(typeof e === 'string' ? e : 'Update failed. Please try again later.');
      setInstalling(false);
    }
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Update available"
      onClick={() => {
        if (!installing) onClose();
      }}
    >
      <div
        className="w-[360px] max-w-[92vw] rounded-2xl bg-white p-5 shadow-card-lg dark:bg-[#1C1C1E]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-start justify-between gap-3">
          <h3 className="text-[14px] font-semibold text-black dark:text-white">Update available</h3>
          {!installing && (
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="shrink-0 text-muted transition-colors hover:text-black dark:hover:text-white"
            >
              <X size={16} strokeWidth={2.4} />
            </button>
          )}
        </div>
        <div className="space-y-2 text-[12px] leading-relaxed text-muted">
          <p>
            Sentinel <span className="font-semibold text-black dark:text-white">v{version}</span> is
            ready to install. You are on v{currentVersion}.
          </p>
          <p>Sentinel restarts to finish the update; the proxy is back within seconds.</p>
          {error !== null && <p className="text-red-600 dark:text-red-400">{error}</p>}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={installing}
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:text-black disabled:opacity-40 dark:hover:text-white"
          >
            Later
          </button>
          <button
            type="button"
            disabled={installing}
            onClick={() => void install()}
            className="flex items-center gap-1.5 rounded-lg bg-ios-blue px-3 py-1.5 text-[12px] font-semibold text-white transition-all hover:bg-ios-blue/90 active:scale-95 disabled:opacity-60"
          >
            {installing ? (
              <>
                <Loader2 size={13} className="animate-spin" /> Installing…
              </>
            ) : (
              <>
                <ArrowDownToLine size={13} /> Install and restart
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
