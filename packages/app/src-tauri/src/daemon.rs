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
///
/// Stale-daemon eviction: the daemon is deliberately long-lived (it
/// keeps proxying Claude Code traffic while the UI is closed), so a
/// user who closes the app and reopens it — or who builds a fresh app
/// bundle and launches it — typically finds a daemon already bound to
/// port 47284. That daemon was spawned by a PRIOR app launch and is
/// gated by THAT launch's handshake token; our freshly-generated token
/// won't authenticate against it, leaving the UI permanently stuck on
/// "waiting for daemon". Before spawning, we probe `/health` to detect
/// such a stale daemon, pull its PID out of the response, SIGTERM it,
/// and wait for the port to free. If the daemon doesn't exit within
/// ~5 s we escalate to SIGKILL. The new daemon then binds cleanly and
/// receives our fresh token via stdin.
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use rand::RngCore;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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

/// Probe `127.0.0.1:47284/health` and return the daemon's PID if a
/// daemon answers, or `None` if no daemon is listening (or the
/// response shape was unexpected). Times out fast so we don't stall
/// app launch when the port is free.
///
/// Uses raw TCP + a tiny HTTP/1.1 request rather than `reqwest` to
/// avoid pulling in a full HTTP client just for one probe.
async fn probe_daemon_pid() -> Option<u32> {
    let stream_result = tokio::time::timeout(
        Duration::from_millis(500),
        tokio::net::TcpStream::connect("127.0.0.1:47284"),
    )
    .await;
    let mut stream = match stream_result {
        Ok(Ok(s)) => s,
        _ => return None,
    };

    let req = b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(req).await.is_err() {
        return None;
    }

    let mut buf = Vec::with_capacity(512);
    let read_result = tokio::time::timeout(Duration::from_millis(500), async {
        // Cap to a few KB — /health is tiny; if the listener replies
        // with anything larger we don't care, the pid is at the top of
        // the JSON body.
        let mut tmp = [0u8; 2048];
        loop {
            match stream.read(&mut tmp).await {
                Ok(0) => break,
                Ok(n) => {
                    buf.extend_from_slice(&tmp[..n]);
                    if buf.len() >= 4096 {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    })
    .await;
    if read_result.is_err() {
        return None;
    }

    let text = String::from_utf8_lossy(&buf);
    // The daemon's /health body is JSON like `{"status":"ok","pid":12345,...}`.
    // A literal substring search is robust enough — `"pid":` only
    // appears in the body field, never in headers.
    let marker = "\"pid\":";
    let i = text.find(marker)?;
    let rest = &text[i + marker.len()..];
    let pid_str: String = rest
        .chars()
        .skip_while(|c| c.is_whitespace())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    pid_str.parse::<u32>().ok()
}

/// Send a Unix signal (or Windows process-termination equivalent) to
/// `pid` by shelling out. Returns true if the kill command succeeded.
/// Failures are logged but never fatal — the caller's port-free poll
/// is the real gate on "did the daemon actually exit?".
async fn send_kill(pid: u32, force: bool) -> bool {
    #[cfg(unix)]
    {
        let signal = if force { "KILL" } else { "TERM" };
        match tokio::process::Command::new("kill")
            .args([format!("-{signal}"), pid.to_string()])
            .output()
            .await
        {
            Ok(out) => out.status.success(),
            Err(e) => {
                eprintln!("[sentinel] kill -{signal} {pid} failed to launch: {e}");
                false
            }
        }
    }
    #[cfg(windows)]
    {
        let mut cmd = tokio::process::Command::new("taskkill");
        // CREATE_NO_WINDOW — taskkill is a console app; without this it
        // flashes a console window on every launch that evicts a stale daemon.
        cmd.creation_flags(0x0800_0000);
        if force {
            cmd.arg("/F");
        }
        cmd.args(["/PID", &pid.to_string()]);
        match cmd.output().await {
            Ok(out) => out.status.success(),
            Err(e) => {
                eprintln!("[sentinel] taskkill /PID {pid} failed to launch: {e}");
                false
            }
        }
    }
}

/// If a daemon is already listening on the IPC port, request a
/// graceful shutdown and wait for it to release the port. Escalates
/// to SIGKILL if the daemon hasn't exited within ~5 seconds. No-op
/// when no daemon is running, which is the normal case for a clean
/// launch.
async fn evict_stale_daemon() {
    let Some(pid) = probe_daemon_pid().await else {
        return;
    };

    eprintln!(
        "[sentinel] Found existing daemon (pid {pid}) — requesting graceful shutdown so a fresh handshake token can be installed"
    );
    send_kill(pid, false).await;

    // Poll until the port is free, up to ~5 s.
    for _ in 0..25 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if probe_daemon_pid().await.is_none() {
            eprintln!("[sentinel] Existing daemon exited cleanly");
            return;
        }
    }

    eprintln!("[sentinel] Existing daemon did not exit after SIGTERM; escalating to SIGKILL");
    send_kill(pid, true).await;
    // Give the OS a beat to reclaim the port after a forced kill.
    tokio::time::sleep(Duration::from_millis(500)).await;
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
        // Evict any stale daemon left over from a previous app launch
        // before spawning ours. Without this, the new daemon binds-fail
        // (port still owned by the old one) and our IPC handshake
        // doesn't match the old daemon's token — UI sticks on
        // "waiting for daemon" forever.
        evict_stale_daemon().await;

        let mut cmd = tokio::process::Command::new(&path);
        cmd.arg("start").stdin(Stdio::piped());
        // CREATE_NO_WINDOW — the daemon is a pkg console-subsystem exe; the
        // parent GUI app has no console, so without this flag Windows
        // allocates a visible console window for the child. The flag only
        // suppresses console allocation; the piped-stdin handshake below is
        // unaffected.
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);

        match cmd.spawn() {
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
