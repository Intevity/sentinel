//! Cross-launch record of an update install attempt.
//!
//! Why this exists: on Windows the updater plugin's install step is
//! fire-and-forget. `tauri_plugin_updater`'s `install_inner` calls
//! `ShellExecuteW`, **discards its return value**, and then calls
//! `std::process::exit(0)` unconditionally. So once we get past extraction,
//! `Update::install` can never report a failure and never returns at all —
//! a declined UAC prompt, a SmartScreen/AV block on the downloaded
//! `-setup.exe`, or an MSI rollback are all indistinguishable from success.
//! The user sees the app vanish and nothing else happen; `app.log` ends
//! mid-install with no verdict.
//!
//! The fix is to leave a note on disk before handing control to the
//! installer, and read it back on the next launch: if the running version is
//! the one we tried to install, the update landed; if it is unchanged, the
//! install silently failed and we owe the user an explanation.
//!
//! Kept on every platform, not just Windows. macOS and Linux *can* return
//! `Err` from `install`, but they can also return `Ok` without having
//! replaced the running binary (a stale Launch Services cache, an AppImage
//! squashfs write that half-succeeded). A version comparison catches those;
//! an error check does not. The success breadcrumb is cross-platform value on
//! its own — before this, `app.log` had no line proving an update ever landed.
//!
//! Split into a pure core (`classify`, `normalize_version`, `encode`) and a
//! thin I/O shell, so the interesting branches are unit-testable without an
//! `AppHandle`, a filesystem, or a Windows VM.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Bump when a field becomes required or changes meaning. A marker carrying a
/// schema this build doesn't know classifies as `Unreadable` rather than
/// being half-interpreted into a bogus verdict.
const SCHEMA: u32 = 1;

/// A marker older than this is debris, not a signal — the machine sat off for
/// a week, or the user updated by hand in the meantime. Logged and cleared,
/// never surfaced to the user.
const STALE_AFTER_SECS: u64 = 7 * 24 * 60 * 60;

/// What we recorded immediately before handing bytes to the installer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAttempt {
    /// Version we tried to install.
    pub version: String,
    /// Version we were running when we tried.
    pub from_version: String,
    /// The manifest key the plugin actually resolved (`update.target`), e.g.
    /// `windows-x86_64-nsis`. Proves which platform entry was picked — if
    /// this and `installer` disagree, that is itself the bug.
    #[serde(default)]
    pub target: String,
    /// Filename from the download URL. Names the exact artifact that failed,
    /// which is the first thing a support reply needs.
    #[serde(default)]
    pub artifact: String,
    /// What this build *is*, per the bundler's binary-patched marker.
    #[serde(default)]
    pub installer: String,
    /// `"modal"` (a human clicked Install) or `"auto"` (silent path).
    #[serde(default)]
    pub trigger: String,
    /// Unix seconds at the moment of the attempt.
    pub ts: u64,
    #[serde(default)]
    pub schema: u32,
}

/// The reconciliation outcome for a marker read at startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptVerdict {
    /// No marker on disk: an ordinary launch.
    NoAttempt,
    /// Running version matches what we tried to install.
    Succeeded {
        version: String,
        from_version: String,
        age_secs: u64,
    },
    /// Version unchanged — the installer never replaced the app.
    Failed {
        attempt: UpdateAttempt,
        running: String,
        age_secs: u64,
    },
    /// Version unchanged, but the marker predates `STALE_AFTER_SECS`.
    Expired {
        attempt: UpdateAttempt,
        age_secs: u64,
    },
    /// Present but unparseable, or written by a newer schema.
    Unreadable { raw: String },
}

/// Strip surrounding whitespace and one leading `v`/`V`.
///
/// Load-bearing: a manifest that ever ships `"v0.9.4"` must not read as a
/// failure against a running `"0.9.4"`. Only one prefix is stripped, so a
/// pathological `"vv1"` stays distinct from `"v1"`.
pub fn normalize_version(v: &str) -> &str {
    let t = v.trim();
    t.strip_prefix('v')
        .or_else(|| t.strip_prefix('V'))
        .unwrap_or(t)
}

/// Serialize an attempt for the on-disk marker.
pub fn encode(attempt: &UpdateAttempt) -> String {
    // The struct is plain strings + integers, so this cannot fail; a broken
    // marker is still handled downstream by the `Unreadable` verdict.
    serde_json::to_string_pretty(attempt).unwrap_or_default()
}

/// Decide what a marker means. Pure: `raw` is the file contents (`None` when
/// absent) and `now_secs` is injected so age arithmetic is deterministic.
pub fn classify(raw: Option<&str>, running_version: &str, now_secs: u64) -> AttemptVerdict {
    let Some(raw) = raw else {
        return AttemptVerdict::NoAttempt;
    };
    let Ok(attempt) = serde_json::from_str::<UpdateAttempt>(raw) else {
        return AttemptVerdict::Unreadable {
            raw: raw.to_string(),
        };
    };
    // A downgraded build reading a newer marker must not invent a verdict
    // from fields whose meaning it doesn't know.
    if attempt.schema > SCHEMA {
        return AttemptVerdict::Unreadable {
            raw: raw.to_string(),
        };
    }
    // Saturating: a marker written under a clock that later jumped backwards
    // would otherwise underflow and panic in debug builds.
    let age_secs = now_secs.saturating_sub(attempt.ts);

    if normalize_version(&attempt.version) == normalize_version(running_version) {
        return AttemptVerdict::Succeeded {
            version: attempt.version,
            from_version: attempt.from_version,
            age_secs,
        };
    }
    if age_secs > STALE_AFTER_SECS {
        return AttemptVerdict::Expired { attempt, age_secs };
    }
    AttemptVerdict::Failed {
        attempt,
        running: running_version.to_string(),
        age_secs,
    }
}

/// What kind of bundle this binary was installed from, per
/// `tauri::utils::platform::bundle_type()` (patched into the binary by the
/// bundler, so an MSI-installed exe and an NSIS-installed exe report
/// differently even though they are the same build).
pub fn installer_label() -> &'static str {
    use tauri::utils::config::BundleType;
    match tauri::utils::platform::bundle_type() {
        Some(BundleType::Deb) => "deb",
        Some(BundleType::Rpm) => "rpm",
        Some(BundleType::AppImage) => "appimage",
        Some(BundleType::Msi) => "msi",
        Some(BundleType::Nsis) => "nsis",
        Some(BundleType::App) => "app",
        Some(BundleType::Dmg) => "dmg",
        // Non-exhaustive upstream enum, and `None` for an unbundled dev
        // binary. Both mean "we can't tailor the advice" downstream.
        _ => "unknown",
    }
}

/// Current wall clock in unix seconds.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Build an attempt record stamped with this build's installer + now.
pub fn new_attempt(
    version: &str,
    from_version: &str,
    target: &str,
    download_url: &str,
    trigger: &str,
) -> UpdateAttempt {
    UpdateAttempt {
        version: version.to_string(),
        from_version: from_version.to_string(),
        target: target.to_string(),
        artifact: artifact_name(download_url),
        installer: installer_label().to_string(),
        trigger: trigger.to_string(),
        ts: now_secs(),
        schema: SCHEMA,
    }
}

/// Last path segment of the download URL, query string dropped.
pub fn artifact_name(download_url: &str) -> String {
    download_url
        .split(['?', '#'])
        .next()
        .unwrap_or(download_url)
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

// ── I/O ──────────────────────────────────────────────────────────────────
// Deliberately thin, and deliberately routed through `app_log::home_dir` so
// the marker lands in the same `~/.sentinel` as `app.log` and the daemon's
// stores. `AppHandle::path().home_dir()` resolves the Windows profile via
// SHGetKnownFolderPath while `app_log` reads `%USERPROFILE%`; they agree in
// practice, but the marker has to be readable by whichever of the two the
// rest of the update path uses.

fn marker_path() -> Option<PathBuf> {
    Some(
        crate::app_log::home_dir()?
            .join(".sentinel")
            .join("update-attempt.json"),
    )
}

/// Write the marker atomically (temp + rename), mirroring
/// `settings_patch::write_settings`. Best-effort: a marker we failed to write
/// only costs us the diagnosis, so it must never block the install.
pub fn record_attempt(attempt: &UpdateAttempt) -> bool {
    marker_path().is_some_and(|path| write_marker_at(&path, attempt))
}

/// Read the raw marker contents, if any.
pub fn read_raw() -> Option<String> {
    read_marker_at(&marker_path()?)
}

/// Remove the marker. Called on every verdict — a retained marker would
/// re-classify against the same running version on every subsequent launch
/// and re-raise the banner forever. `app.log` keeps the forensics.
pub fn clear_attempt() {
    if let Some(path) = marker_path() {
        remove_marker_at(&path);
    }
}

// Path-injected so the round-trip is testable against a temp dir without
// mutating process env (which `settings_patch` also deliberately avoids).

fn write_marker_at(path: &Path, attempt: &UpdateAttempt) -> bool {
    if let Some(dir) = path.parent() {
        if std::fs::create_dir_all(dir).is_err() {
            return false;
        }
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, encode(attempt)).is_err() {
        return false;
    }
    if std::fs::rename(&tmp, path).is_err() {
        // Don't leave a half-written sibling behind for the next read to trip
        // over.
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    true
}

fn read_marker_at(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

fn remove_marker_at(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_753_800_000;

    fn attempt() -> UpdateAttempt {
        UpdateAttempt {
            version: "0.9.4".into(),
            from_version: "0.9.3".into(),
            target: "windows-x86_64-nsis".into(),
            artifact: "Sentinel_0.9.4_x64-setup.exe".into(),
            installer: "nsis".into(),
            trigger: "modal".into(),
            ts: NOW,
            schema: SCHEMA,
        }
    }

    #[test]
    fn absent_marker_is_no_attempt() {
        assert_eq!(classify(None, "0.9.3", NOW), AttemptVerdict::NoAttempt);
    }

    #[test]
    fn matching_version_is_success() {
        let raw = encode(&attempt());
        assert_eq!(
            classify(Some(&raw), "0.9.4", NOW),
            AttemptVerdict::Succeeded {
                version: "0.9.4".into(),
                from_version: "0.9.3".into(),
                age_secs: 0,
            }
        );
    }

    #[test]
    fn leading_v_still_counts_as_success() {
        // A manifest shipping "v0.9.4" against a bundle reporting "0.9.4"
        // must not report a failure the user then can't act on.
        let raw = encode(&UpdateAttempt {
            version: "v0.9.4".into(),
            ..attempt()
        });
        match classify(Some(&raw), "0.9.4", NOW) {
            AttemptVerdict::Succeeded { version, .. } => assert_eq!(version, "v0.9.4"),
            other => panic!("expected Succeeded, got {other:?}"),
        }
    }

    #[test]
    fn mismatch_reports_target_running_and_artifact() {
        let raw = encode(&attempt());
        match classify(Some(&raw), "0.9.3", NOW) {
            AttemptVerdict::Failed {
                attempt,
                running,
                age_secs,
            } => {
                assert_eq!(attempt.version, "0.9.4");
                assert_eq!(attempt.from_version, "0.9.3");
                assert_eq!(attempt.target, "windows-x86_64-nsis");
                assert_eq!(attempt.artifact, "Sentinel_0.9.4_x64-setup.exe");
                assert_eq!(attempt.installer, "nsis");
                assert_eq!(attempt.trigger, "modal");
                assert_eq!(running, "0.9.3");
                assert_eq!(age_secs, 0);
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn age_is_computed_from_injected_now() {
        let raw = encode(&UpdateAttempt {
            ts: NOW - 137,
            ..attempt()
        });
        match classify(Some(&raw), "0.9.3", NOW) {
            AttemptVerdict::Failed { age_secs, .. } => assert_eq!(age_secs, 137),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn future_timestamp_saturates_to_zero() {
        // Clock skew must not underflow (panics in debug builds).
        let raw = encode(&UpdateAttempt {
            ts: NOW + 500,
            ..attempt()
        });
        match classify(Some(&raw), "0.9.3", NOW) {
            AttemptVerdict::Failed { age_secs, .. } => assert_eq!(age_secs, 0),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn stale_mismatch_is_expired_not_failed() {
        let raw = encode(&UpdateAttempt {
            ts: NOW - (8 * 24 * 60 * 60),
            ..attempt()
        });
        match classify(Some(&raw), "0.9.3", NOW) {
            AttemptVerdict::Expired { age_secs, .. } => {
                assert_eq!(age_secs, 8 * 24 * 60 * 60);
            }
            other => panic!("expected Expired, got {other:?}"),
        }
    }

    #[test]
    fn garbage_is_unreadable_and_preserves_raw() {
        assert_eq!(
            classify(Some("{not json"), "0.9.3", NOW),
            AttemptVerdict::Unreadable {
                raw: "{not json".into()
            }
        );
    }

    #[test]
    fn missing_required_fields_is_unreadable() {
        // `version` and `ts` have no serde default: an empty object is not a
        // half-valid attempt, it's debris.
        assert_eq!(
            classify(Some("{}"), "0.9.3", NOW),
            AttemptVerdict::Unreadable { raw: "{}".into() }
        );
    }

    #[test]
    fn future_schema_is_unreadable_not_failed() {
        let raw = encode(&UpdateAttempt {
            schema: 99,
            ..attempt()
        });
        assert_eq!(
            classify(Some(&raw), "0.9.3", NOW),
            AttemptVerdict::Unreadable { raw }
        );
    }

    #[test]
    fn encode_round_trips_through_classify() {
        // Locks the camelCase wire names: a field rename that broke
        // `fromVersion` would surface here rather than in production.
        let raw = encode(&attempt());
        assert!(raw.contains("\"fromVersion\""));
        match classify(Some(&raw), "0.9.3", NOW) {
            AttemptVerdict::Failed { attempt: got, .. } => assert_eq!(got, attempt()),
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[test]
    fn normalize_version_strips_exactly_one_prefix() {
        assert_eq!(normalize_version("  0.9.4 "), "0.9.4");
        assert_eq!(normalize_version("v0.9.4"), "0.9.4");
        assert_eq!(normalize_version("V0.9.4"), "0.9.4");
        assert_eq!(normalize_version("vv0.9.4"), "v0.9.4");
    }

    #[test]
    fn artifact_name_takes_the_last_segment() {
        assert_eq!(
            artifact_name("https://github.com/o/r/releases/download/v1/Sentinel_1_x64-setup.exe"),
            "Sentinel_1_x64-setup.exe"
        );
        assert_eq!(artifact_name("https://h/a.msi?token=abc"), "a.msi");
        assert_eq!(artifact_name(""), "");
    }

    #[test]
    fn marker_round_trips_through_the_filesystem() {
        // Exercises the real atomic write + read + clear, not just the pure
        // core: a rename that left the payload in `update-attempt.json.tmp`
        // would make every failed install unreportable while every unit test
        // above still passed.
        let dir = std::env::temp_dir().join(format!("sentinel-marker-test-{}", std::process::id()));
        let path = dir.join(".sentinel").join("update-attempt.json");
        let _ = std::fs::remove_dir_all(&dir);

        assert!(write_marker_at(&path, &attempt()), "write should succeed");
        assert!(
            path.exists(),
            "marker written to the final path, not the temp one"
        );
        assert!(
            !path.with_extension("json.tmp").exists(),
            "no .tmp debris left behind"
        );

        let raw = read_marker_at(&path).expect("marker readable after write");
        match classify(Some(&raw), "0.9.3", NOW) {
            AttemptVerdict::Failed { attempt: got, .. } => assert_eq!(got, attempt()),
            other => panic!("expected Failed, got {other:?}"),
        }

        remove_marker_at(&path);
        assert_eq!(read_marker_at(&path), None);
        assert_eq!(
            classify(read_marker_at(&path).as_deref(), "0.9.3", NOW),
            AttemptVerdict::NoAttempt
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn installer_label_reports_this_platform() {
        // `bundle_type()` falls back to `App` on macOS for an unbundled test
        // binary and `None` (-> "unknown") elsewhere.
        #[cfg(target_os = "macos")]
        assert_eq!(installer_label(), "app");
        #[cfg(not(target_os = "macos"))]
        assert_eq!(installer_label(), "unknown");
    }
}
