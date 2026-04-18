//! Auto-update plumbing for Claude Sentinel.
//!
//! Two entry points share the same core:
//!   - `maybe_check_on_startup` — called from `main.rs` setup; no-ops when
//!     the user has not opted in via Settings → Automatically install updates.
//!   - `check_for_updates` — Tauri command invoked from the "Check for
//!     updates…" tray item. Always runs regardless of the setting and
//!     surfaces a native notification with the result.
//!
//! On success the updater downloads + installs the new bundle, then calls
//! `app.restart()`. The daemon sidecar is a child of the app process, so
//! exiting the app terminates the daemon; the new bundle's daemon binary
//! spawns fresh on relaunch (see daemon.rs). No special coordination needed.
//!
//! On macOS the `.app` replacement step requires a signed + notarized bundle;
//! installs on unsigned builds will fail at the Gatekeeper check. That's why
//! the user-facing setting defaults to `false`.

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

/// Subset of `~/.claude-sentinel/settings.json` we care about here.
/// Extra keys are tolerated so the daemon stays the source of truth for the
/// full schema.
#[derive(Debug, Deserialize)]
struct UpdaterSettings {
    #[serde(default)]
    #[serde(rename = "autoUpdate")]
    auto_update: bool,
}

fn read_auto_update_pref(app: &AppHandle) -> bool {
    let Ok(home) = app.path().home_dir() else { return false };
    let path = home.join(".claude-sentinel").join("settings.json");
    let Ok(contents) = std::fs::read_to_string(&path) else { return false };
    serde_json::from_str::<UpdaterSettings>(&contents)
        .map(|s| s.auto_update)
        .unwrap_or(false)
}

/// Called once at startup. Returns immediately when the user hasn't opted in.
pub fn maybe_check_on_startup(app: AppHandle) {
    if !read_auto_update_pref(&app) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        // Silent: no notification on success (the restart speaks for itself),
        // no notification on failure (offline / unsigned / Gatekeeper — all
        // recoverable on next launch and not worth interrupting the user).
        let _ = run_update(&app, /*notify=*/ false).await;
    });
}

/// Tauri command backing the tray-menu "Check for updates…" item and any
/// future in-app button. Always runs, always surfaces a notification so the
/// user sees feedback for an explicit action.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<(), String> {
    run_update(&app, /*notify=*/ true).await.map_err(|e| e.to_string())
}

async fn run_update(app: &AppHandle, notify: bool) -> Result<(), Box<dyn std::error::Error>> {
    let updater = app.updater()?;
    match updater.check().await {
        Ok(Some(update)) => {
            if notify {
                let _ = app
                    .notification()
                    .builder()
                    .title("Claude Sentinel")
                    .body(format!("Installing update to v{} — will restart when ready…", update.version))
                    .show();
            }
            // download_and_install takes two callbacks (progress + done).
            // We ignore both — the restart is the user-visible signal.
            update
                .download_and_install(|_chunk, _total| {}, || {})
                .await?;
            app.restart();
        }
        Ok(None) => {
            if notify {
                let _ = app
                    .notification()
                    .builder()
                    .title("Claude Sentinel")
                    .body("You're on the latest version.")
                    .show();
            }
        }
        Err(e) => {
            if notify {
                let _ = app
                    .notification()
                    .builder()
                    .title("Claude Sentinel")
                    .body(format!("Update check failed: {e}"))
                    .show();
            }
            return Err(Box::new(e));
        }
    }
    Ok(())
}
