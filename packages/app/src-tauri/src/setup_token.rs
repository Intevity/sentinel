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
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

/// Live PTY session. One at a time; a new start replaces the previous.
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct SetupTokenState(Mutex<Option<Session>>);

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

    // Replace any prior session.
    if let Some(mut prev) = state.0.lock().unwrap().take() {
        let _ = prev.child.kill();
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
        .spawn_command(build_command(&claude))
        .map_err(|e| e.to_string())?;
    // Drop the slave so the master read loop sees EOF once the child exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let app_thread = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // Lossy is fine: the token + ANSI are ASCII; only decorative
                    // box-art (multi-byte) can be cosmetically clipped at a read
                    // boundary, which never affects token capture.
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_thread.emit("setup-token-output", chunk);
                }
                Err(_) => break,
            }
        }
        let _ = app_thread.emit("setup-token-exit", ());
    });

    *state.0.lock().unwrap() = Some(Session {
        master: pair.master,
        writer,
        child,
    });
    Ok(())
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
    if let Some(mut s) = state.0.lock().unwrap().take() {
        let _ = s.child.kill();
    }
    Ok(())
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
        assert!(p.contains("/usr/bin"));
    }
}
