/// Patches Claude Code's `~/.claude/settings.json` to route API traffic and
/// telemetry through the Sentinel daemon. This used to live in the
/// `/sentinel:setup` skill shipped by the plugin; it now belongs to the app
/// so users don't need to install anything separate.
///
/// Exposed as three Tauri commands:
///   - `is_sentinel_activated` — check whether the patch is currently applied
///   - `activate_sentinel`     — write the env vars into settings.json
///   - `deactivate_sentinel`   — remove them (optionally wipe all data too)
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

fn settings_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".claude").join("settings.json")
}

fn sentinel_data_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".claude-sentinel")
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
