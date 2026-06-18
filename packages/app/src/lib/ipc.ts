/**
 * Typed IPC helpers for communicating with the sentinel daemon.
 * Uses Tauri's invoke API to reach the Rust sidecar bridge.
 *
 * E2E mode: when Vite is built with VITE_E2E=true (Playwright harness),
 * IPC is forwarded to an HTTP bridge at VITE_E2E_BRIDGE_URL that speaks
 * the same JSON IPC protocol. Production builds never set VITE_E2E, so
 * the Tauri path is the only live one.
 */
import { invoke } from '@tauri-apps/api/core';
import type { AppToDaemonMessage, DaemonToAppMessage, IpcResponse } from '@sentinel/shared';

export type { AppToDaemonMessage, DaemonToAppMessage, IpcResponse };

const E2E_BRIDGE_URL: string | undefined =
  import.meta.env.VITE_E2E === 'true' ? (import.meta.env.VITE_E2E_BRIDGE_URL as string) : undefined;

// Single EventSource shared across every onDaemonMessage subscriber in E2E
// mode. Production uses Tauri's event bus which already fans one channel out
// to many listeners; under plain Vite we have to do that ourselves or each
// hook opens its own /events connection and saturates Chrome's per-origin
// socket limit (~6 for HTTP/1.1), which then blocks every POST to the same
// origin — including the IPC round-trips the app needs to render.
let e2eEventSource: EventSource | null = null;
const e2eHandlers = new Set<(msg: DaemonToAppMessage) => void>();

function ensureE2EEventSource(bridgeUrl: string): EventSource {
  if (e2eEventSource) return e2eEventSource;
  const es = new EventSource(new URL('events', bridgeUrl).toString());
  es.onmessage = (ev) => {
    let parsed: DaemonToAppMessage;
    try {
      parsed = JSON.parse(ev.data) as DaemonToAppMessage;
    } catch {
      return;
    }
    for (const h of e2eHandlers) h(parsed);
  };
  e2eEventSource = es;
  return es;
}

function subscribeToE2EEvents(handler: (msg: DaemonToAppMessage) => void): () => void {
  ensureE2EEventSource(E2E_BRIDGE_URL as string);
  e2eHandlers.add(handler);
  return () => {
    e2eHandlers.delete(handler);
  };
}

/**
 * Send a message to the daemon and await a response.
 */
export async function sendToSentinel<T = unknown>(
  message: AppToDaemonMessage,
): Promise<IpcResponse<T>> {
  if (E2E_BRIDGE_URL) {
    const res = await fetch(E2E_BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
    });
    return (await res.json()) as IpcResponse<T>;
  }
  return invoke<IpcResponse<T>>('ipc_send', { message });
}

/**
 * Listen for unsolicited messages broadcast by the daemon (e.g. overage_entered).
 * Returns an unlisten function.
 *
 * In E2E mode, the Rust sidecar isn't in the loop — broadcasts stream from the
 * IPC HTTP bridge's `/events` SSE endpoint. The bridge holds a persistent
 * daemon socket and writes each broadcast frame as `data: <json>\n\n`. Every
 * broadcast shape the production Tauri path would deliver arrives here
 * unchanged, so downstream handlers don't need to care about the transport.
 */
export async function onDaemonMessage(
  handler: (msg: DaemonToAppMessage) => void,
): Promise<() => void> {
  if (E2E_BRIDGE_URL) {
    return subscribeToE2EEvents(handler);
  }
  const { listen } = await import('@tauri-apps/api/event');
  return listen<DaemonToAppMessage>('daemon-message', (event) => {
    handler(event.payload);
  });
}
