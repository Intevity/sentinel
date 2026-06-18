//! Best-effort tray-icon pinning on Windows 11.
//!
//! Windows hides new tray icons in the "^" overflow flyout by default and
//! offers no supported API to promote them. Windows 11 (22H2+) persists the
//! per-icon preference at `HKCU\Control Panel\NotifyIconSettings\<id>` —
//! one randomly-named subkey per icon, identified by its `ExecutablePath`
//! value — with an `IsPromoted` DWORD (1 = always visible). Setting it for
//! our own exe is a per-user write that takes effect immediately.
//!
//! Undocumented and version-specific, so everything here is best-effort and
//! silent: on Windows 10 (no such key) or a future shell that changes the
//! layout, the function simply does nothing. The shell creates the subkey
//! asynchronously the first time the icon appears, hence the short retry
//! ladder; on a genuinely first-ever launch the entry may only exist by the
//! next start, which is the accepted floor.

use std::thread;
use std::time::Duration;

use windows_registry::CURRENT_USER;

const NOTIFY_ICON_SETTINGS: &str = "Control Panel\\NotifyIconSettings";

/// Spawn a background thread that promotes Sentinel's tray icon, retrying
/// briefly to give the shell time to create the registry entry. Call after
/// the tray icon has been built.
pub fn promote_tray_icon() {
    thread::spawn(|| {
        for delay_secs in [2u64, 3, 5] {
            thread::sleep(Duration::from_secs(delay_secs));
            if try_promote_once() {
                return;
            }
        }
        eprintln!(
            "[sentinel] tray pin: no NotifyIconSettings entry matched this exe; \
             pinning will be retried on next launch"
        );
    });
}

/// One pass over `HKCU\Control Panel\NotifyIconSettings`: find the subkey
/// whose `ExecutablePath` matches the running exe and set `IsPromoted = 1`.
/// Returns true when a matching entry was found and written.
fn try_promote_once() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let exe = exe.to_string_lossy().to_string();

    let Ok(root) = CURRENT_USER.open(NOTIFY_ICON_SETTINGS) else {
        return false; // Windows 10, or a future shell that moved the key.
    };
    let Ok(subkeys) = root.keys() else {
        return false;
    };
    for name in subkeys {
        let Ok(entry) = CURRENT_USER.create(format!("{NOTIFY_ICON_SETTINGS}\\{name}")) else {
            continue;
        };
        let Ok(path) = entry.get_string("ExecutablePath") else {
            continue;
        };
        if !paths_match(&path, &exe) {
            continue;
        }
        match entry.set_u32("IsPromoted", 1) {
            Ok(()) => return true,
            Err(e) => {
                eprintln!("[sentinel] tray pin: IsPromoted write failed: {e}");
                return false;
            }
        }
    }
    false
}

/// Case-insensitive, separator-insensitive full-path comparison. Windows
/// paths are case-preserving but case-insensitive, and the registry value
/// may differ from `current_exe()` in slash direction.
fn paths_match(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('/', "\\").to_ascii_lowercase();
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::paths_match;

    #[test]
    fn paths_match_is_case_insensitive() {
        assert!(paths_match(
            "C:\\Program Files\\Sentinel\\sentinel.exe",
            "c:\\program files\\claude sentinel\\Claude-Sentinel.EXE",
        ));
    }

    #[test]
    fn paths_match_normalizes_slash_direction() {
        assert!(paths_match(
            "C:/Apps/sentinel.exe",
            "C:\\Apps\\sentinel.exe",
        ));
    }

    #[test]
    fn paths_match_rejects_different_binaries() {
        assert!(!paths_match(
            "C:\\Apps\\sentinel.exe",
            "C:\\Apps\\other-app.exe",
        ));
        assert!(!paths_match(
            "C:\\A\\sentinel.exe",
            "C:\\B\\sentinel.exe",
        ));
    }
}
