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
use std::path::PathBuf;

use tauri::AppHandle;

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

    tauri::async_runtime::spawn(async move {
        match tokio::process::Command::new(&path).arg("start").spawn() {
            Ok(mut child) => {
                let status = child.wait().await;
                eprintln!("[sentinel] Daemon process exited: {status:?}");
            }
            Err(e) => eprintln!("[sentinel] Failed to spawn daemon: {e}"),
        }
    });
}
