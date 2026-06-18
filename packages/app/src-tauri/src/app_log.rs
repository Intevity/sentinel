//! Durable app-side diagnostics log: `~/.sentinel/app.log`.
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
    Some(home_dir()?.join(".sentinel").join("app.log"))
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

/// Append a timestamped line to `~/.sentinel/app.log` (best-effort;
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

/// One-time migration of the legacy data directory `~/.claude-sentinel` to
/// `~/.sentinel`, for users upgrading across the "Claude Sentinel" → "Sentinel"
/// rename. Idempotent and best-effort: a no-op if the new dir already exists or
/// the legacy one doesn't; otherwise the whole tree is renamed in one move
/// (atomic on a single filesystem), carrying the daemon's DBs, settings, logs,
/// and the Windows credential file across.
///
/// Called as the very first thing in `setup()` — before any `app_log` write
/// (which would create `~/.sentinel` and turn this into a no-op, orphaning the
/// legacy dir) and before the daemon sidecar spawns, so both processes observe
/// the renamed path.
pub fn migrate_data_dir() {
    let Some(home) = home_dir() else { return };
    let legacy = home.join(".claude-sentinel");
    // The legacy dir only exists pre-migration; a successful migration renames
    // it away, so the whole routine is a one-shot keyed on its presence.
    if !legacy.exists() {
        return;
    }
    let new = home.join(".sentinel");
    if !new.exists() {
        // Clean case: nothing at the new path yet — atomic rename.
        match rename(&legacy, &new) {
            Ok(()) => app_log("migrated data dir: ~/.claude-sentinel -> ~/.sentinel"),
            Err(e) => eprintln!("[sentinel] data-dir migration failed: {e}"),
        }
        return;
    }
    // ~/.sentinel already exists even though the real data is still in the
    // legacy dir. That means something created a *shell* ~/.sentinel before the
    // migration ran — a stray launch, an interrupted prior attempt, or a test
    // run's logger writing daemon.log there. The legacy dir is the source of
    // truth, so set the shell aside to a timestamped backup (non-destructive)
    // and promote the legacy data into place. Without this, a pre-existing
    // empty ~/.sentinel would strand the user's data at the old path.
    let backup = home.join(format!(".sentinel.superseded-{}", epoch_secs()));
    if let Err(e) = rename(&new, &backup) {
        eprintln!("[sentinel] data-dir migration: could not set aside existing ~/.sentinel: {e}");
        return;
    }
    match rename(&legacy, &new) {
        Ok(()) => app_log(&format!(
            "migrated data dir: ~/.claude-sentinel -> ~/.sentinel (prior shell kept at {})",
            backup.display()
        )),
        // Promotion failed — restore the backup so we never leave the user with
        // no ~/.sentinel at all.
        Err(e) => {
            let _ = rename(&backup, &new);
            eprintln!("[sentinel] data-dir migration failed promoting legacy dir: {e}");
        }
    }
}

/// Whole seconds since the Unix epoch, for timestamping the set-aside backup
/// directory name. Falls back to 0 if the clock is before the epoch.
fn epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
