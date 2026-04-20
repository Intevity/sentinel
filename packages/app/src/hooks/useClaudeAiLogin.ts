import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { sendToSentinel, onDaemonMessage } from '../lib/ipc.js';

/**
 * Per-account "is connected to claude.ai?" state plus helpers for starting
 * / tearing down the login flow. Used by SettingsPanel to gate the overage
 * controls behind a real sessionKey (the `/api/organizations/{org}/usage`
 * endpoint is web-session-only; without a stored cookie we can't produce
 * dollar-denominated numbers honestly).
 *
 * Source of truth for "connected":
 *   - `has_claude_ai_session_key` IPC answers "do we have anything in the
 *     keychain?" — used on mount to seed state.
 *   - A successful `claude_ai_usage_updated` broadcast with no error means
 *     the cookie works. We flip to connected on that signal.
 *   - An `auth_expired` error from that broadcast means the cookie is
 *     present but stale — surface as "expired" so the UI nudges re-login.
 *   - A `claude-ai-login-complete` Tauri event tells us the webview
 *     captured a cookie and handed it off; we mark provisionally-connected
 *     while the first usage fetch is in flight.
 */

export type ConnectionState = 'loading' | 'disconnected' | 'connected' | 'expired';

interface UseClaudeAiLoginResult {
  state: ConnectionState;
  /** Launch the Tauri webview at claude.ai/login. Resolves when the window
   *  is opened; the actual cookie capture happens asynchronously. */
  connect: () => Promise<void>;
  /** Remove the stored sessionKey. */
  disconnect: () => Promise<void>;
  /** Force the daemon to refetch usage with the current cookie. Useful as
   *  a "try again" button when state === 'expired'. */
  refresh: () => Promise<void>;
  /** Store a manually-pasted sessionKey directly, bypassing the webview
   *  login flow. Reliable fallback for logins (Google OAuth in particular)
   *  that can't complete in an embedded webview. */
  pasteSessionKey: (sessionKey: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export function useClaudeAiLogin(accountId: string | undefined): UseClaudeAiLoginResult {
  const [state, setState] = useState<ConnectionState>('loading');

  // Seed state on mount / accountId change.
  useEffect(() => {
    if (!accountId) { setState('loading'); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await sendToSentinel<{ hasKey: boolean }>({
          type: 'has_claude_ai_session_key',
          accountId,
        });
        if (cancelled) return;
        setState(res.success && res.data?.hasKey ? 'connected' : 'disconnected');
      } catch {
        if (!cancelled) setState('disconnected');
      }
    })();
    return () => { cancelled = true; };
  }, [accountId]);

  // Listen for per-account usage broadcasts and the post-login Tauri event.
  useEffect(() => {
    if (!accountId) return;
    let offDaemon: (() => void) | null = null;
    let offTauri: (() => void) | null = null;

    onDaemonMessage((msg) => {
      if (msg.type !== 'claude_ai_usage_updated') return;
      if (msg.accountId !== accountId) return;
      if (msg.error === 'auth_expired') setState('expired');
      else if (msg.error === 'missing_key') setState('disconnected');
      else if (msg.snapshot) setState('connected');
    }).then((fn) => { offDaemon = fn; }).catch(() => undefined);

    listen<{ accountId: string }>('claude-ai-login-complete', (event) => {
      if (event.payload.accountId === accountId) setState('connected');
    }).then((fn) => { offTauri = fn; }).catch(() => undefined);

    return () => {
      offDaemon?.();
      offTauri?.();
    };
  }, [accountId]);

  const connect = useCallback(async (): Promise<void> => {
    if (!accountId) return;
    await invoke('start_claude_ai_login', { accountId });
  }, [accountId]);

  const disconnect = useCallback(async (): Promise<void> => {
    if (!accountId) return;
    // Two-phase disconnect: (a) clear the daemon's keychain copy of the
    // session token, (b) wipe the webview's claude.ai cookie jar so the
    // next Connect doesn't silently re-capture the same HttpOnly
    // sessionKey that persists in WKHTTPCookieStore. Without (b),
    // Disconnect is a lie — the webview's persistent session survives
    // and the Rust-side cookie scraper finds sessionKey again on the
    // next Connect in <100ms, making the whole flow feel like nothing
    // happened. Best-effort on the cookie clear — if it fails (no
    // webview available, wry error) we still want the keychain clear
    // to win so the daemon stops probing with a dead token.
    await sendToSentinel({ type: 'clear_claude_ai_session_key', accountId });
    try { await invoke('clear_claude_ai_cookies'); } catch { /* best-effort */ }
    setState('disconnected');
  }, [accountId]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!accountId) return;
    await sendToSentinel({ type: 'refresh_claude_ai_usage', accountId });
  }, [accountId]);

  // Manual-paste fallback. Trims whitespace and leading "sessionKey="
  // prefix so users can paste either the raw value or the whole "Name=Value"
  // pair copied out of DevTools. Empty-after-trim returns an error the
  // caller can surface in the UI. Otherwise hands the key to the daemon
  // the same way the webview flow does and flips to 'connected' once the
  // daemon accepts it — no need to wait for the first usage-broadcast
  // round-trip.
  const pasteSessionKey = useCallback(async (raw: string) => {
    if (!accountId) return { ok: false as const, error: 'no account selected' };
    let key = (raw || '').trim();
    if (key.toLowerCase().startsWith('sessionkey=')) key = key.slice('sessionkey='.length).trim();
    if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1);
    if (!key) return { ok: false as const, error: 'session key is empty after trimming' };
    try {
      const res = await sendToSentinel({ type: 'set_claude_ai_session_key', accountId, sessionKey: key });
      if (!res.success) return { ok: false as const, error: res.error || 'daemon rejected session key' };
      setState('connected');
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, [accountId]);

  return { state, connect, disconnect, refresh, pasteSessionKey };
}
