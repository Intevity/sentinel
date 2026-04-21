/**
 * Typed IPC helpers for communicating with the sentinel daemon.
 * Uses Tauri's invoke API to reach the Rust sidecar bridge.
 */
import { invoke } from '@tauri-apps/api/core';
import type { AppToDaemonMessage, DaemonToAppMessage, IpcResponse } from '@claude-sentinel/shared';

export type { AppToDaemonMessage, DaemonToAppMessage, IpcResponse };

/**
 * Send a message to the daemon and await a response.
 */
export async function sendToSentinel<T = unknown>(
  message: AppToDaemonMessage,
): Promise<IpcResponse<T>> {
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
