//! Durable app-side diagnostics log: `~/.claude-sentinel/app.log`.
//!
//! Release builds on Windows use `windows_subsystem = "windows"`, which has
//! no console — every `eprintln!` in the daemon-lifecycle and updater paths
//! vanishes on exactly the platform where spawn/eviction/update failures
//! happen. This module gives those paths a file the user can actually send
//! us. `app_log` mirrors each line to stderr too, so dev runs and macOS
//! Console keep their existing visibility.
//!
//! Deliberately std-only (no chrono/log-crate deps): best-effort append with
//! a one-deep rotation to `app.log.1` once the file passes ~1 MB.

use std::fs::{create_dir_all, metadata, rename, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Rotate once the live file exceeds this many bytes (~1 MB keeps months of
/// lifecycle lines while bounding what users attach to bug reports).
const MAX_BYTES: u64 = 1024 * 1024;

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn log_path() -> Option<PathBuf> {
    Some(home_dir()?.join(".claude-sentinel").join("app.log"))
}

/// `YYYY-MM-DD HH:MM:SSZ` from the system clock, derived by hand so we don't
/// pull a date crate in for one log file. Civil-from-days per Howard
/// Hinnant's algorithm; UTC on purpose (matches the daemon log and avoids
/// platform TZ-database lookups).
fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let (h, m, s) = (secs / 3600 % 24, secs / 60 % 60, secs % 60);
    // Days since 1970-01-01 -> civil y/m/d (era-based, valid for our range).
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{m:02}:{s:02}Z")
}

/// Append a timestamped line to `~/.claude-sentinel/app.log` (best-effort;
/// never panics, never blocks the caller on failure) and mirror it to stderr.
pub fn app_log(msg: &str) {
    eprintln!("[sentinel] {msg}");
    let Some(path) = log_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = create_dir_all(dir);
    }
    if let Ok(meta) = metadata(&path) {
        if meta.len() > MAX_BYTES {
            // `app.log` -> `app.log.1`, clobbering the previous rotation.
            let _ = rename(&path, path.with_extension("log.1"));
        }
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "[{}] {msg}", timestamp());
    }
}
