/// Daemon sidecar lifecycle management.
///
/// The daemon binary is bundled inside the Tauri app as an external binary
/// (see tauri.conf.json `bundle.externalBin`). Tauri places it in the same
/// directory as the main app executable, stripping the Rust target-triple
/// suffix from the filename.
///
/// On startup the app spawns the daemon process. The daemon binds to
/// 127.0.0.1:47284 and exits cleanly if the port is already occupied
/// (i.e. a previous instance is still running), so spawning is idempotent.
///
/// Sprint 2 anti-tamper: spawn opens a piped stdin to the daemon, writes
/// a freshly-generated 32-byte hex token (`<token>\n`), and drops the
/// stdin handle. The daemon reads the token from its stdin during start-
/// up and uses it to gate every IPC connection. The same token is
/// stashed in `IPC_HANDSHAKE_TOKEN` so the IPC client can present it on
/// connect.
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;

use rand::RngCore;
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

/// One-shot store for the IPC handshake token. Populated before the
/// daemon is spawned (in `spawn`); read by `ipc::connect_daemon` when it
/// opens the socket. `OnceLock` instead of `OnceCell` so reads from any
/// thread are safe without async coordination.
pub static IPC_HANDSHAKE_TOKEN: OnceLock<String> = OnceLock::new();

/// Resolve the absolute path to the bundled daemon binary.
fn sidecar_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.to_path_buf();
    let name = if cfg!(target_os = "windows") {
        "claude-sentinel-daemon.exe"
    } else {
        "claude-sentinel-daemon"
    };
    Some(dir.join(name))
}

/// Generate a 32-byte cryptographically random token, hex-encoded.
fn generate_handshake_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Spawn the daemon sidecar in the background.
///
/// If the binary is not found (e.g. during `tauri dev` before a sidecar has
/// been built), a warning is logged and the function returns. The IPC module
/// will keep retrying its connection so the app remains functional once the
/// developer starts the daemon manually.
pub fn spawn(_app: &AppHandle) {
    let Some(path) = sidecar_path() else {
        eprintln!("[sentinel] Could not resolve daemon sidecar path");
        return;
    };

    if !path.exists() {
        eprintln!(
            "[sentinel] Daemon binary not found at {} — start it manually for dev",
            path.display()
        );
        return;
    }

    // Generate the token BEFORE spawn so it's available to the IPC client
    // by the time the read loop starts. `set` is fallible if a prior call
    // already populated the cell — which only happens if `spawn` is
    // called twice (we don't), so log and continue.
    let token = generate_handshake_token();
    if IPC_HANDSHAKE_TOKEN.set(token.clone()).is_err() {
        eprintln!("[sentinel] IPC handshake token already initialised — reusing existing");
    }

    tauri::async_runtime::spawn(async move {
        match tokio::process::Command::new(&path)
            .arg("start")
            .stdin(Stdio::piped())
            .spawn()
        {
            Ok(mut child) => {
                // Write the handshake token to the daemon's stdin and
                // drop the writer. The daemon's `readHandshakeTokenFromStdin`
                // resolves on `\n`; closing the pipe afterwards lets it
                // resolve on EOF if the read raced ahead. Failures here
                // are non-fatal — the daemon will fall back to an
                // unauthenticated IPC server (logged loudly), and the
                // Tauri client's subsequent connections will fail the
                // handshake check, surfacing a clear error in the UI
                // rather than a silent privilege escalation.
                if let Some(stdin) = child.stdin.as_mut() {
                    let line = format!("{token}\n");
                    if let Err(e) = stdin.write_all(line.as_bytes()).await {
                        eprintln!("[sentinel] Failed to write IPC token to daemon stdin: {e}");
                    }
                    if let Err(e) = stdin.shutdown().await {
                        eprintln!("[sentinel] Failed to close daemon stdin: {e}");
                    }
                }
                // Explicitly drop stdin to release the pipe.
                drop(child.stdin.take());

                let status = child.wait().await;
                eprintln!("[sentinel] Daemon process exited: {status:?}");
            }
            Err(e) => eprintln!("[sentinel] Failed to spawn daemon: {e}"),
        }
    });
}
