import React, { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Check, Copy, Loader2, X } from 'lucide-react';
import { extractSetupToken } from '../lib/setupToken.js';
import { claudeInstallCommand } from '../lib/claudeInstall.js';
import { sendToSentinel } from '../lib/ipc.js';

type Phase = 'running' | 'label' | 'storing' | 'error';

interface SetupTokenTerminalProps {
  /** Called when the user closes/cancels the panel (or after a successful add). */
  onClose: () => void;
  /** When set, re-authenticating this existing account: the captured token
   *  refreshes it in place (no "name this account" step). */
  reauthAccountId?: string;
}

/**
 * Runs `claude setup-token` in a live in-app terminal (xterm.js ↔ a PTY in the
 * Tauri layer). The user completes Claude Code's browser sign-in; the printed
 * `sk-ant-oat01…` token is scraped from the stream, then stored via the daemon.
 * The daemon announces success with a `login_complete` broadcast (handled by
 * AccountSwitcher), so this panel just captures + stores + closes.
 */
export default function SetupTokenTerminal({
  onClose,
  reauthAccountId,
}: SetupTokenTerminalProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const bufferRef = useRef('');
  const tokenRef = useRef<string | null>(null);
  // Mirror props into refs so the (mount-once) effect reads current values
  // without re-subscribing the PTY listeners.
  const reauthRef = useRef(reauthAccountId);
  reauthRef.current = reauthAccountId;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [phase, setPhase] = useState<Phase>('running');
  const [label, setLabel] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  // The CLI wasn't found: swap the plain error for the guided-install panel
  // (copyable install one-liner + Retry once the user has run it).
  const [cliMissing, setCliMissing] = useState(false);
  const [copied, setCopied] = useState(false);
  // Bumped by Retry; the PTY effect depends on it, so a bump tears the old
  // terminal down and starts a fresh `claude setup-token` run.
  const [runNonce, setRunNonce] = useState(0);

  const retry = (): void => {
    bufferRef.current = '';
    tokenRef.current = null;
    setErrorMsg('');
    setCliMissing(false);
    setCopied(false);
    setPhase('running');
    setRunNonce((n) => n + 1);
  };

  const copyInstallCommand = (): void => {
    void navigator.clipboard
      .writeText(claudeInstallCommand(navigator.platform))
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  // Send the captured token to the daemon, then close. Re-auth refreshes the
  // existing account in place; a new add carries the user's label.
  const storeToken = (token: string, extra: { label?: string; accountId?: string }): void => {
    setPhase('storing');
    void sendToSentinel({ type: 'store_setup_token', token, ...extra })
      .catch(() => undefined)
      .finally(() => onCloseRef.current());
  };
  const storeTokenRef = useRef(storeToken);
  storeTokenRef.current = storeToken;

  useEffect(() => {
    const term = new Terminal({
      convertEol: true,
      cursorBlink: false,
      fontSize: 11,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#1E1E1E' },
      scrollback: 2000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;
    if (containerRef.current) term.open(containerRef.current);
    try {
      fit.fit();
    } catch {
      /* container not laid out yet — start() uses safe defaults below */
    }

    // Forward keystrokes to the PTY (Ctrl-C, the rare "paste code" fallback…).
    const dataSub = term.onData((data) => {
      void invoke('setup_token_write', { data }).catch(() => undefined);
    });

    let outUnlisten: UnlistenFn | undefined;
    let exitUnlisten: UnlistenFn | undefined;
    let disposed = false;

    // Scan the accumulated buffer for the token; on success move to the label
    // step. Returns whether a token was captured. Recovers from the 'error'
    // phase too, in case the exit event raced ahead of the final output chunk.
    const tryCapture = (): boolean => {
      if (tokenRef.current) return true;
      const token = extractSetupToken(bufferRef.current);
      if (!token) return false;
      tokenRef.current = token;
      void invoke('setup_token_kill').catch(() => undefined);
      // Re-auth refreshes the account in place (no label step); a new add
      // collects a label first.
      if (reauthRef.current) storeTokenRef.current(token, { accountId: reauthRef.current });
      else setPhase('label');
      return true;
    };

    const onChunk = (chunk: string): void => {
      if (disposed) return;
      term.write(chunk);
      if (tokenRef.current) return; // already captured
      bufferRef.current += chunk;
      tryCapture();
    };

    void (async () => {
      outUnlisten = await listen<string>('setup-token-output', (e) => onChunk(e.payload));
      exitUnlisten = await listen('setup-token-exit', () => {
        if (disposed || tokenRef.current) return;
        // The token's output chunk can race the exit event; re-check now, then
        // give a brief grace period for a straggler chunk before declaring
        // failure (a real cancel/failed sign-in stays empty and errors).
        if (tryCapture()) return;
        setTimeout(() => {
          if (disposed || tokenRef.current) return;
          if (tryCapture()) return;
          setErrorMsg('The sign-in ended before a token was created. Close and try again.');
          setPhase('error');
        }, 500);
      });
      const cols = term.cols || 80;
      const rows = term.rows || 24;
      try {
        await invoke('setup_token_start', { cols, rows });
      } catch (err) {
        if (disposed) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'claude-not-found') {
          setCliMissing(true);
          setErrorMsg('Claude Code (the `claude` CLI) was not found.');
        } else {
          setErrorMsg(`Could not start the terminal: ${msg}`);
        }
        setPhase('error');
      }
    })();

    const onResize = (): void => {
      try {
        fit.fit();
        void invoke('setup_token_resize', { cols: term.cols, rows: term.rows }).catch(
          () => undefined,
        );
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('resize', onResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      dataSub.dispose();
      outUnlisten?.();
      exitUnlisten?.();
      void invoke('setup_token_kill').catch(() => undefined);
      term.dispose();
    };
  }, [runNonce]);

  const submitLabel = (): void => {
    const token = tokenRef.current;
    if (!token) return;
    storeToken(token, label.trim() ? { label: label.trim() } : {});
  };

  return (
    <div className="rounded-2xl bg-[#1E1E1E] ring-1 ring-white/10 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <p className="text-[12px] font-semibold text-white/90">
          {phase === 'label'
            ? 'Name this account'
            : reauthAccountId
              ? 'Re-authenticate via Claude Code'
              : 'Add account via Claude Code'}
        </p>
        <button
          onClick={onClose}
          className="text-white/50 hover:text-white active:scale-90 transition"
          title="Close"
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>

      {/* Terminal is always mounted (it owns the PTY); hidden behind the label
          step so the captured token isn't left lingering on screen. */}
      <div className={phase === 'label' || phase === 'storing' ? 'hidden' : ''}>
        {phase === 'running' && (
          <p className="px-3 pt-2 text-[11px] text-white/60">
            Complete the sign-in in your browser. The account is captured automatically.
          </p>
        )}
        <div ref={containerRef} className="h-64 w-full px-2 py-2" />
      </div>

      {phase === 'error' && (
        <div className="px-3 py-3">
          <p className="text-[12px] text-ios-red">{errorMsg}</p>
          {cliMissing && (
            <>
              <p className="mt-2 text-[11px] text-white/60">
                Adding an account signs in through Claude Code (free, no subscription needed).
                Install it with the command below, then retry.
              </p>
              <div className="mt-2 flex items-center gap-2 rounded-lg bg-white/5 ring-1 ring-white/10 px-2.5 py-1.5">
                <code className="flex-1 text-[11px] text-white/80 font-mono break-all select-all">
                  {claudeInstallCommand(navigator.platform)}
                </code>
                <button
                  onClick={copyInstallCommand}
                  className="text-white/50 hover:text-white active:scale-90 transition shrink-0"
                  title="Copy install command"
                  aria-label="Copy install command"
                >
                  {copied ? <Check size={13} className="text-ios-green" /> : <Copy size={13} />}
                </button>
              </div>
            </>
          )}
          <div className="mt-2 flex items-center gap-3">
            {cliMissing && (
              <button
                onClick={retry}
                className="text-[12px] font-semibold text-white bg-ios-blue hover:opacity-90 active:scale-95 px-3 py-1.5 rounded-full transition"
              >
                Retry
              </button>
            )}
            <button
              onClick={onClose}
              className="text-[12px] font-semibold text-ios-blue hover:opacity-90 active:scale-95"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {(phase === 'label' || phase === 'storing') && (
        <div className="px-3 py-3 space-y-2">
          <p className="text-[11px] text-white/60">
            Token captured. Give this account a name (email or nickname) so you can tell it apart.
          </p>
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitLabel();
            }}
            placeholder="you@example.com"
            disabled={phase === 'storing'}
            className="w-full text-[12px] bg-white/5 text-white placeholder-white/30 rounded-lg px-2.5 py-1.5
                       outline-none ring-1 ring-white/10 focus:ring-ios-blue/60 disabled:opacity-50"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={submitLabel}
              disabled={phase === 'storing'}
              className="flex items-center gap-1 text-[12px] font-semibold text-white bg-ios-blue
                         hover:opacity-90 active:scale-95 px-3 py-1.5 rounded-full transition disabled:opacity-50"
            >
              {phase === 'storing' && <Loader2 size={12} className="animate-spin" />}
              Add account
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
