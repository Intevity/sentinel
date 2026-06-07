/// Patches Claude Code's `~/.claude/settings.json` to route API traffic and
/// telemetry through the Sentinel daemon. This used to live in the
/// `/sentinel:setup` skill shipped by the plugin; it now belongs to the app
/// so users don't need to install anything separate.
///
/// Exposed as three Tauri commands:
///   - `is_sentinel_activated` — check whether the patch is currently applied
///   - `activate_sentinel`     — write the env vars into settings.json
///   - `deactivate_sentinel`   — remove them (optionally wipe all data too)
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde_json::{Map, Value};

/// The env vars we manage. Anything we write here is our responsibility to
/// clean up on deactivation; unrelated keys in `env` are left untouched.
const MANAGED_KEYS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_ENABLE_TELEMETRY",
    "OTEL_METRICS_EXPORTER",
    "OTEL_LOGS_EXPORTER",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_METRIC_EXPORT_INTERVAL",
    "OTEL_LOGS_EXPORT_INTERVAL",
];

const SENTINEL_BASE_URL: &str = "http://localhost:47284";

/// Resolve the user's home directory OS-correctly. Windows exposes it as
/// `USERPROFILE` (`HOME` is normally unset there); Unix uses `HOME`. Kept a
/// pure function of its inputs so the platform selection is unit-testable
/// without mutating process env.
///
/// The previous code read `HOME` unconditionally with a hardcoded `/tmp`
/// fallback. On Windows that resolved to `C:\tmp`, so activation wrote the
/// proxy + OTEL env vars to `C:\tmp\.claude\settings.json` — a file Claude
/// Code never reads. The result: Claude Code never routed through the proxy
/// and never exported telemetry, so the Metrics and Optimize tabs stayed
/// empty (while OAuth-polled usage %, which never touches these paths, kept
/// working). Mirrors the `USERPROFILE` handling already in `app_log.rs` and
/// `notify.rs`. The temp-dir last resort is cross-platform and only reached
/// if the platform's home var is unset (pathological).
fn resolve_home(userprofile: Option<OsString>, home: Option<OsString>) -> PathBuf {
    #[cfg(windows)]
    let picked = userprofile.or(home);
    #[cfg(not(windows))]
    let picked = home.or(userprofile);
    picked.map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

fn home_dir() -> PathBuf {
    resolve_home(std::env::var_os("USERPROFILE"), std::env::var_os("HOME"))
}

fn settings_path() -> PathBuf {
    home_dir().join(".claude").join("settings.json")
}

fn sentinel_data_dir() -> PathBuf {
    home_dir().join(".claude-sentinel")
}

fn read_settings() -> Value {
    let path = settings_path();
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| Value::Object(Map::new()))
}

/// Atomic write: temp file + rename, so a crash mid-write can't leave the
/// settings file truncated.
fn write_settings(value: &Value) -> Result<(), String> {
    let path = settings_path();
    let parent = path.parent().ok_or("settings.json has no parent dir")?;
    fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;

    let pretty = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");

    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp failed: {e}"))?;
        f.write_all(pretty.as_bytes())
            .map_err(|e| format!("write tmp failed: {e}"))?;
        f.flush().map_err(|e| format!("flush failed: {e}"))?;
    }

    fs::rename(&tmp, &path).map_err(|e| format!("rename failed: {e}"))?;
    Ok(())
}

/// Returns true if settings.json currently has the Sentinel proxy URL set as
/// its `env.ANTHROPIC_BASE_URL`. That's our single source of truth for
/// "activated" — the other keys are ancillary telemetry config.
#[tauri::command]
pub fn is_sentinel_activated() -> bool {
    let settings = read_settings();
    settings
        .get("env")
        .and_then(|e| e.get("ANTHROPIC_BASE_URL"))
        .and_then(|v| v.as_str())
        == Some(SENTINEL_BASE_URL)
}

/// Merge Sentinel's env vars into `env` inside settings.json. Preserves all
/// other keys (including unrelated env entries the user set themselves).
#[tauri::command]
pub fn activate_sentinel() -> Result<(), String> {
    let mut settings = read_settings();

    let obj = settings
        .as_object_mut()
        .ok_or("~/.claude/settings.json is not a JSON object")?;

    let env_entry = obj
        .entry("env".to_string())
        .or_insert_with(|| Value::Object(Map::new()));

    let env = env_entry
        .as_object_mut()
        .ok_or("settings.json `env` is not a JSON object")?;

    env.insert(
        "ANTHROPIC_BASE_URL".into(),
        Value::String(SENTINEL_BASE_URL.into()),
    );
    env.insert(
        "CLAUDE_CODE_ENABLE_TELEMETRY".into(),
        Value::String("1".into()),
    );
    env.insert("OTEL_METRICS_EXPORTER".into(), Value::String("otlp".into()));
    env.insert("OTEL_LOGS_EXPORTER".into(), Value::String("otlp".into()));
    env.insert(
        "OTEL_EXPORTER_OTLP_PROTOCOL".into(),
        Value::String("http/json".into()),
    );
    env.insert(
        "OTEL_EXPORTER_OTLP_ENDPOINT".into(),
        Value::String(SENTINEL_BASE_URL.into()),
    );
    env.insert(
        "OTEL_METRIC_EXPORT_INTERVAL".into(),
        Value::String("5000".into()),
    );
    env.insert(
        "OTEL_LOGS_EXPORT_INTERVAL".into(),
        Value::String("2000".into()),
    );

    write_settings(&settings)
}

/// Remove the Sentinel-managed env vars from settings.json. If the `env`
/// object is empty afterward, drop it entirely. `delete_data` additionally
/// removes `~/.claude-sentinel/` (SQLite DB, logs, socket) — the daemon
/// should be shut down first so the socket file isn't held open.
#[tauri::command]
pub fn deactivate_sentinel(delete_data: bool) -> Result<(), String> {
    let mut settings = read_settings();

    if let Some(obj) = settings.as_object_mut() {
        if let Some(Value::Object(env)) = obj.get_mut("env") {
            for key in MANAGED_KEYS {
                env.remove(*key);
            }
            // If env is now empty, remove it entirely so settings.json doesn't
            // accumulate empty stubs.
            if env.is_empty() {
                obj.remove("env");
            }
        }
    }

    write_settings(&settings)?;

    if delete_data {
        let dir = sentinel_data_dir();
        if dir.exists() {
            fs::remove_dir_all(&dir)
                .map_err(|e| format!("Failed to remove {}: {e}", dir.display()))?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn resolve_home_prefers_userprofile_on_windows() {
        // The regression: HOME is normally unset on Windows. The fix must
        // pick USERPROFILE so settings land in the real home, not C:\tmp.
        let got = resolve_home(Some(OsString::from(r"C:\Users\Jeff")), None);
        assert_eq!(got, PathBuf::from(r"C:\Users\Jeff"));

        // Even if some shell exported HOME, USERPROFILE wins on Windows.
        let got = resolve_home(
            Some(OsString::from(r"C:\Users\Jeff")),
            Some(OsString::from(r"C:\msys\home\jeff")),
        );
        assert_eq!(got, PathBuf::from(r"C:\Users\Jeff"));
    }

    #[cfg(not(windows))]
    #[test]
    fn resolve_home_prefers_home_on_unix() {
        let got = resolve_home(None, Some(OsString::from("/home/jeff")));
        assert_eq!(got, PathBuf::from("/home/jeff"));

        // USERPROFILE is ignored on Unix when HOME is present.
        let got = resolve_home(
            Some(OsString::from(r"C:\Users\Jeff")),
            Some(OsString::from("/home/jeff")),
        );
        assert_eq!(got, PathBuf::from("/home/jeff"));
    }

    #[test]
    fn resolve_home_falls_back_to_temp_dir_not_slash_tmp() {
        // With neither var set we must not hand back a hardcoded "/tmp"
        // (the old bug); the OS temp dir is the cross-platform last resort.
        let got = resolve_home(None, None);
        assert_eq!(got, std::env::temp_dir());
    }

    #[test]
    fn settings_path_is_home_anchored_and_correctly_suffixed() {
        let p = settings_path();
        assert!(
            p.starts_with(home_dir()),
            "settings path {p:?} must live under the resolved home dir"
        );
        assert!(p.ends_with("settings.json"));
        // The Sentinel-managed settings file lives in the Claude Code config
        // dir; assert the full tail so a stray rename is caught.
        assert!(p.ends_with(PathBuf::from(".claude").join("settings.json")));
    }
}
