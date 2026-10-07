//! In-app `claude setup-token` runner.
//!
//! `claude setup-token` is a terminal UI that writes directly to the controlling
//! TTY — piped, it suspends with `(tty output)` — so we run it inside a real
//! pseudo-terminal via `portable-pty` (cross-platform incl. Windows ConPTY) and
//! stream the output to an `xterm.js` panel in the webview. The user completes
//! Claude Code's browser sign-in; the CLI prints a long-lived `sk-ant-oat01…`
//! token, which the frontend scrapes from the stream and hands to the daemon.
//!
//! Sentinel never runs the OAuth flow itself — `claude` does. We only host the
//! terminal and capture the token the user obtained through Claude Code.
//!
//! Commands: `setup_token_start` (spawn in a PTY, stream `setup-token-output`,
//! emit `setup-token-exit` on close), `setup_token_write` (keystrokes →
//! PTY stdin), `setup_token_resize`, `setup_token_kill`.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

/// Live PTY session. One at a time; a new start replaces the previous.
struct Session {
    /// Distinguishes this session from a later one in the same slot, so a
    /// stale reader thread never reaps its successor.
    id: u64,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Session {
    /// Stop the child and reap it. `Child::kill` alone is not enough:
    /// portable-pty's kill sends SIGHUP, polls `try_wait` for ~200 ms, then
    /// falls back to SIGKILL WITHOUT waiting, and dropping the underlying
    /// `std::process::Child` never reaps either. Either path left a
    /// `<defunct>` `claude` under the app. `wait` returns the cached status
    /// when the kill's grace-period `try_wait` already reaped it.
    fn terminate(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

type Slot = Arc<Mutex<Option<Session>>>;

#[derive(Default)]
pub struct SetupTokenState(Slot);

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

/// Take the session out of `slot` if it is still the one identified by `id`.
fn take_if_current(slot: &Slot, id: u64) -> Option<Session> {
    let mut guard = slot.lock().unwrap_or_else(|p| p.into_inner());
    if guard.as_ref().is_some_and(|s| s.id == id) {
        guard.take()
    } else {
        None
    }
}

/// Env vars that would route `setup-token` away from the real subscription
/// OAuth (e.g. through Sentinel's proxy) or pre-seed an API key. Scrubbed.
const SCRUB_ENV: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
];

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key).map(PathBuf::from)
}

/// PATH with the common user-bin locations prepended, since a GUI-launched app
/// inherits a minimal PATH and `claude` shells out to `node` / `open` / etc.
fn augmented_path() -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(home) = home_dir() {
        #[cfg(windows)]
        {
            parts.push(
                home.join(".local")
                    .join("bin")
                    .to_string_lossy()
                    .into_owned(),
            );
            parts.push(home.join(".bun").join("bin").to_string_lossy().into_owned());
            if let Some(appdata) = std::env::var_os("APPDATA") {
                parts.push(
                    PathBuf::from(appdata)
                        .join("npm")
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
        #[cfg(not(windows))]
        {
            parts.push(home.join(".local/bin").to_string_lossy().into_owned());
            parts.push(home.join(".bun/bin").to_string_lossy().into_owned());
        }
    }
    #[cfg(not(windows))]
    for p in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        parts.push(p.to_string());
    }
    if let Ok(existing) = std::env::var("PATH") {
        parts.push(existing);
    }
    parts.join(if cfg!(windows) { ";" } else { ":" })
}

/// Claude **Desktop**'s MSIX package publishes an app-execution alias named
/// `claude.exe` under `%LOCALAPPDATA%\Microsoft\WindowsApps` that launches the
/// desktop GUI, not the CLI — spawning it for `setup-token` would pop the
/// desktop app. Never treat it as the CLI.
#[cfg(windows)]
fn is_desktop_alias(p: &str) -> bool {
    p.to_ascii_lowercase()
        .contains("\\microsoft\\windowsapps\\")
}

/// Resolve the `claude` executable. Honors `SENTINEL_TEST_CLAUDE_BIN` (tests
/// point this at a fake script that prints a canned token), then common install
/// locations, then a login-shell / `where` lookup. None → not installed.
pub fn resolve_claude_binary() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SENTINEL_TEST_CLAUDE_BIN") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = home_dir() {
        #[cfg(windows)]
        {
            // Windows executables carry extensions — a bare `claude` path never
            // `exists()`. Native installer → .local\bin\claude.exe; npm global
            // → %APPDATA%\npm\claude.cmd; bun → .bun\bin\claude.exe.
            candidates.push(home.join(".local").join("bin").join("claude.exe"));
            candidates.push(home.join(".bun").join("bin").join("claude.exe"));
            if let Some(appdata) = std::env::var_os("APPDATA") {
                candidates.push(PathBuf::from(appdata).join("npm").join("claude.cmd"));
            }
        }
        #[cfg(not(windows))]
        {
            candidates.push(home.join(".local/bin/claude"));
            candidates.push(home.join(".bun/bin/claude"));
        }
    }
    #[cfg(not(windows))]
    for p in [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        "/usr/bin/claude",
    ] {
        candidates.push(PathBuf::from(p));
    }
    for c in &candidates {
        if c.exists() {
            return Some(c.clone());
        }
    }
    // Fall back to a shell lookup that sources the user's login profile.
    #[cfg(not(windows))]
    {
        if let Ok(out) = std::process::Command::new("sh")
            .args(["-lc", "command -v claude"])
            .output()
        {
            if out.status.success() {
                let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !p.is_empty() && Path::new(&p).exists() {
                    return Some(PathBuf::from(p));
                }
            }
        }
    }
    #[cfg(windows)]
    {
        // `where` searches the caller's PATH; use the augmented one so a CLI
        // installed after Sentinel launched (or one only on the user PATH the
        // GUI process didn't inherit) is still found. Take the first hit that
        // isn't Claude Desktop's WindowsApps GUI alias.
        if let Ok(out) = std::process::Command::new("where")
            .arg("claude")
            .env("PATH", augmented_path())
            .output()
        {
            if out.status.success() {
                for line in String::from_utf8_lossy(&out.stdout).lines() {
                    let p = line.trim();
                    if p.is_empty() || is_desktop_alias(p) {
                        continue;
                    }
                    if Path::new(p).exists() {
                        return Some(PathBuf::from(p));
                    }
                }
            }
        }
    }
    None
}

fn build_command(claude: &Path) -> CommandBuilder {
    // npm's Windows global install is a `claude.cmd` batch shim, which
    // CreateProcess can't exec directly — route batch files through
    // `cmd.exe /c`. Real executables (and all Unix paths) spawn as-is.
    let is_batch = claude
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
        .unwrap_or(false);
    let mut cmd = if is_batch {
        let mut c = CommandBuilder::new("cmd.exe");
        c.arg("/c");
        c.arg(claude);
        c
    } else {
        CommandBuilder::new(claude)
    };
    cmd.arg("setup-token");
    // Inherit a scrubbed environment so setup-token does the real subscription
    // OAuth and is not routed through Sentinel's proxy or an injected API key.
    for (k, v) in std::env::vars() {
        if k == "PATH" || SCRUB_ENV.iter().any(|s| k.eq_ignore_ascii_case(s)) {
            continue;
        }
        cmd.env(k, v);
    }
    cmd.env("PATH", augmented_path());
    cmd.env("TERM", "xterm-256color");
    if let Some(home) = home_dir() {
        cmd.cwd(home);
    }
    cmd
}

#[tauri::command]
pub fn setup_token_start(
    app: AppHandle,
    state: State<'_, SetupTokenState>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let claude = resolve_claude_binary().ok_or_else(|| "claude-not-found".to_string())?;
    let out_app = app.clone();
    start_session(
        &state.0,
        &claude,
        cols,
        rows,
        move |chunk| {
            let _ = out_app.emit("setup-token-output", chunk);
        },
        move || {
            let _ = app.emit("setup-token-exit", ());
        },
    )
    .map(|_| ())
}

/// Spawn `claude setup-token` in a PTY and stream its output. Returns the
/// session id. The reader thread reaps the child when the PTY closes, before
/// `on_exit` fires, so a CLI that exits on its own never lingers as a zombie
/// while the session sits in the slot.
fn start_session(
    slot: &Slot,
    claude: &Path,
    cols: u16,
    rows: u16,
    on_output: impl Fn(String) + Send + 'static,
    on_exit: impl FnOnce() + Send + 'static,
) -> Result<u64, String> {
    // Replace any prior session.
    let prev = slot.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(prev) = prev {
        prev.terminate();
    }

    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let child = pair
        .slave
        .spawn_command(build_command(claude))
        .map_err(|e| e.to_string())?;
    // Drop the slave so the master read loop sees EOF once the child exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    // Install the session before the reader can hit EOF, so a CLI that exits
    // instantly is still found (and reaped) by the reader below.
    *slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(Session {
        id,
        master: pair.master,
        writer,
        child,
    });

    let reader_slot = Arc::clone(slot);
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Lossy is fine: the token + ANSI are ASCII; only decorative
                    // box-art (multi-byte) can be cosmetically clipped at a read
                    // boundary, which never affects token capture.
                    on_output(String::from_utf8_lossy(&buf[..n]).into_owned());
                }
                Err(_) => break,
            }
        }
        // The PTY closed: the CLI exited (or detached from its terminal).
        // Reap it now rather than whenever the next start/kill comes along.
        // A session already taken by kill/start is that caller's to reap.
        if let Some(session) = take_if_current(&reader_slot, id) {
            session.terminate();
        }
        on_exit();
    });

    Ok(id)
}

#[tauri::command]
pub fn setup_token_write(state: State<'_, SetupTokenState>, data: String) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    if let Some(s) = guard.as_mut() {
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn setup_token_resize(
    state: State<'_, SetupTokenState>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    if let Some(s) = guard.as_ref() {
        s.master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn setup_token_kill(state: State<'_, SetupTokenState>) -> Result<(), String> {
    kill_session(&state.0);
    Ok(())
}

fn kill_session(slot: &Slot) {
    let session = slot.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(session) = session {
        session.terminate();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_honors_test_env_override() {
        std::env::set_var("SENTINEL_TEST_CLAUDE_BIN", "/tmp/fake-claude-xyz");
        let got = resolve_claude_binary();
        std::env::remove_var("SENTINEL_TEST_CLAUDE_BIN");
        assert_eq!(got, Some(PathBuf::from("/tmp/fake-claude-xyz")));
    }

    #[test]
    fn augmented_path_includes_common_bins() {
        let p = augmented_path();
        // The prepended set is platform-specific, and so is the separator.
        // This assertion was POSIX-only and failed the first time CI ran
        // `cargo test` on Windows — there is no /usr/bin to prepend there.
        #[cfg(not(windows))]
        {
            assert!(p.contains("/usr/bin"), "got {p}");
            assert!(p.contains("/.bun/bin"), "got {p}");
            assert!(p.contains(':'), "POSIX PATH is :-separated, got {p}");
        }
        #[cfg(windows)]
        {
            assert!(p.contains("\\.local\\bin"), "got {p}");
            assert!(p.contains("\\.bun\\bin"), "got {p}");
            assert!(p.contains(';'), "Windows PATH is ;-separated, got {p}");
        }
    }
}

/// PTY sessions must never leave a `<defunct>` child behind, whether the CLI
/// exits on its own, is killed, or is replaced by a new start. These run a
/// fake `claude` (a shell script that prints its own pid) in a real PTY and
/// check the process table directly.
#[cfg(all(test, unix))]
mod reap_tests {
    use super::*;
    use crate::child_reap::{ps_state, wait_until_gone};
    use std::sync::mpsc;
    use std::time::Duration;

    /// Write an executable fake `claude` whose first line of output is
    /// `pid:<its pid>`. Each test gets its own file.
    fn fake_claude(name: &str, body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sentinel-setup-token-reap-{}-{name}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("claude");
        std::fs::write(&path, format!("#!/bin/sh\necho \"pid:$$\"\n{body}\n")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    struct Started {
        pid: u32,
        exited: mpsc::Receiver<()>,
    }

    fn start(slot: &Slot, claude: &Path) -> (u64, Started) {
        let (out_tx, out_rx) = mpsc::channel::<String>();
        let (exit_tx, exit_rx) = mpsc::channel::<()>();
        let id = start_session(
            slot,
            claude,
            80,
            24,
            move |chunk| {
                let _ = out_tx.send(chunk);
            },
            move || {
                let _ = exit_tx.send(());
            },
        )
        .expect("start_session");
        let mut seen = String::new();
        let pid = loop {
            let chunk = out_rx
                .recv_timeout(Duration::from_secs(10))
                .unwrap_or_else(|_| panic!("no pid line from fake claude; saw {seen:?}"));
            seen.push_str(&chunk);
            if let Some(rest) = seen.split("pid:").nth(1) {
                let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                if rest.len() > digits.len() && !digits.is_empty() {
                    break digits.parse::<u32>().unwrap();
                }
            }
        };
        (
            id,
            Started {
                pid,
                exited: exit_rx,
            },
        )
    }

    #[test]
    fn natural_exit_is_reaped_without_a_kill() {
        let slot = Slot::default();
        let claude = fake_claude("natural", "exit 0");
        let (_, s) = start(&slot, &claude);
        s.exited
            .recv_timeout(Duration::from_secs(10))
            .expect("exit callback");
        // Reaped before the exit callback fired, and the slot is cleared.
        assert_eq!(ps_state(s.pid), None, "pid {} left behind", s.pid);
        assert!(slot.lock().unwrap().is_none());
    }

    /// The case portable-pty's own kill leaks: SIGHUP is ignored, so it
    /// escalates to SIGKILL and returns without waiting.
    #[test]
    fn kill_reaps_a_child_that_ignores_sighup() {
        let slot = Slot::default();
        let claude = fake_claude("ignores-hup", "trap '' HUP\nwhile :; do sleep 1; done");
        let (_, s) = start(&slot, &claude);
        kill_session(&slot);
        assert_eq!(
            wait_until_gone(s.pid),
            None,
            "killed setup-token child {} was not reaped",
            s.pid
        );
        assert!(slot.lock().unwrap().is_none());
    }

    #[test]
    fn restart_reaps_the_previous_session_and_keeps_the_new_one() {
        let slot = Slot::default();
        let claude = fake_claude("restart", "trap '' HUP\nwhile :; do sleep 1; done");
        let (_, first) = start(&slot, &claude);
        let (second_id, second) = start(&slot, &claude);
        assert_eq!(wait_until_gone(first.pid), None, "replaced session leaked");
        // The first session's reader saw EOF after the swap; it must not have
        // taken (and killed) the second session.
        first
            .exited
            .recv_timeout(Duration::from_secs(10))
            .expect("first exit callback");
        assert_eq!(slot.lock().unwrap().as_ref().map(|s| s.id), Some(second_id));
        let state = ps_state(second.pid).expect("second session still running");
        assert!(!state.starts_with('Z'), "got {state}");
        kill_session(&slot);
        assert_eq!(wait_until_gone(second.pid), None);
    }
}
