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
import type { AppToDaemonMessage, DaemonToAppMessage, IpcResponse } from '@claude-sentinel/shared';

export type { AppToDaemonMessage, DaemonToAppMessage, IpcResponse };

const E2E_BRIDGE_URL: string | undefined =
  import.meta.env.VITE_E2E === 'true' ? (import.meta.env.VITE_E2E_BRIDGE_URL as string) : undefined;

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
 */
export async function onDaemonMessage(
  handler: (msg: DaemonToAppMessage) => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<DaemonToAppMessage>('daemon-message', (event) => {
    handler(event.payload);
  });
}
