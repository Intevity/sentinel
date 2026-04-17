/// IPC bridge between the Tauri app and the sentinel daemon.
///
/// The daemon listens on a Unix socket (macOS/Linux) or named pipe (Windows).
/// This module:
///   1. Connects to the daemon socket on startup.
///   2. Exposes `ipc_send` as a Tauri command so the React frontend can send
///      messages and receive typed responses.
///   3. Forwards unsolicited daemon broadcasts to the frontend via Tauri events.
///
/// Request/response correlation: `ipc_send` registers a oneshot channel keyed
/// by `requestType`. When the read loop in `connect_daemon` receives a response
/// it delivers it to the waiting command, then also emits a Tauri event so
/// unsolicited broadcasts (overage_entered, etc.) still reach the frontend.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::{oneshot, Mutex};

/// Shared write-half of the daemon socket, protected by a mutex.
static DAEMON_SOCKET: Mutex<Option<tokio::net::unix::OwnedWriteHalf>> = Mutex::const_new(None);

/// Pending request/response correlations keyed by `requestType`.
static PENDING: LazyLock<Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn daemon_sock_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".claude-sentinel").join("daemon.sock")
}

/// Connect to the daemon socket and forward incoming messages to the frontend.
/// Retries with back-off if the daemon is not yet running.
pub async fn connect_daemon(app: AppHandle) {
    let path = daemon_sock_path();
    let mut backoff_ms = 500u64;

    loop {
        match UnixStream::connect(&path).await {
            Ok(stream) => {
                backoff_ms = 500;
                let (reader, writer) = stream.into_split();

                // Store the writer for outbound messages
                {
                    let mut guard = DAEMON_SOCKET.lock().await;
                    *guard = Some(writer);
                }

                // Read loop: deliver responses to pending requests, and also
                // emit every message as a Tauri event for unsolicited broadcasts.
                let mut lines = BufReader::new(reader).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                        // Resolve a pending ipc_send call if the requestType matches
                        if let Some(req_type) = value
                            .get("requestType")
                            .and_then(|v| v.as_str())
                            .map(str::to_owned)
                        {
                            let mut pending = PENDING.lock().await;
                            if let Some(tx) = pending.remove(&req_type) {
                                let _ = tx.send(value.clone());
                            }
                        }
                        // Always forward to frontend for broadcasts
                        let _ = app.emit("daemon-message", value);
                    }
                }

                // Socket closed — clear the writer and reconnect
                {
                    let mut guard = DAEMON_SOCKET.lock().await;
                    *guard = None;
                }
            }
            Err(_) => {
                tokio::time::sleep(tokio::time::Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(10_000);
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IpcResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "requestType")]
    pub request_type: String,
}

/// Tauri command: send a JSON message to the daemon and wait for the response.
///
/// Registers a oneshot channel keyed by the message's `type` field, sends the
/// message, then awaits the channel with a 5-second timeout. The read loop in
/// `connect_daemon` delivers the daemon's reply to the channel.
#[tauri::command]
pub async fn ipc_send(message: serde_json::Value) -> Result<IpcResponse, String> {
    let request_type = message
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("unknown")
        .to_string();

    let (tx, rx) = oneshot::channel::<serde_json::Value>();

    {
        let mut pending = PENDING.lock().await;
        pending.insert(request_type.clone(), tx);
    }

    // Send the message to the daemon
    {
        let mut guard = DAEMON_SOCKET.lock().await;
        let writer = guard
            .as_mut()
            .ok_or_else(|| "Daemon not connected".to_string())?;

        let mut line = serde_json::to_string(&message).map_err(|e| e.to_string())?;
        line.push('\n');
        writer
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
    }

    // Wait for the daemon's response (5 s timeout)
    match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
        Ok(Ok(value)) => {
            serde_json::from_value::<IpcResponse>(value).map_err(|e| e.to_string())
        }
        Ok(Err(_)) => Err("Response channel dropped".to_string()),
        Err(_) => {
            // Clean up the dangling sender on timeout
            let mut pending = PENDING.lock().await;
            pending.remove(&request_type);
            Err(format!("Timeout waiting for daemon response to '{request_type}'"))
        }
    }
}
