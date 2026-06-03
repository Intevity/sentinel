//! Auto-update plumbing for Claude Sentinel.
//!
//! Three entry points share the same check core:
//!   - `spawn_update_timer` — called from `main.rs` setup; checks shortly
//!     after launch and then every `CHECK_INTERVAL` (4 h, overridable via
//!     `CLAUDE_SENTINEL_UPDATE_CHECK_INTERVAL_SECS` for testing).
//!   - `check_for_updates` — Tauri command invoked from the "Check for
//!     updates…" tray item. Always runs and always surfaces feedback.
//!   - `install_update` — Tauri command invoked from the in-app update
//!     modal's Install button. Consumes the pending update stashed by a
//!     prior check, downloads + installs, then restarts.
//!
//! Found updates are no longer installed on the spot for everyone. The flow
//! depends on the "Automatically install updates" setting:
//!   - off (default): the update is stashed in `PendingUpdate` managed state
//!     and an `update_available` event is emitted; the frontend shows a
//!     modal with an Install button (the tray window is usually hidden, so
//!     a timer-found update also fires one native notification per version
//!     and the modal greets the user the next time they open the window).
//!   - on: the update installs silently, but only once the proxy is idle
//!     (see `proxy_is_busy`). Restarting Sentinel restarts the proxy, and a
//!     restart mid-request would break the user's live Claude Code session,
//!     so a busy proxy defers the install and the timer retries.
//!
//! The daemon sidecar is a child of the app process, so exiting the app
//! terminates the daemon; the new bundle's daemon binary spawns fresh on
//! relaunch (see daemon.rs). No special coordination needed.
//!
//! On macOS the `.app` replacement step requires a signed + notarized bundle;
//! installs on unsigned builds will fail at the Gatekeeper check. That's why
//! the user-facing setting defaults to `false`.

use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

/// Default cadence for the background check loop.
const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);
/// First check after launch waits this long so startup (daemon spawn, IPC
/// connect) settles first.
const INITIAL_DELAY: Duration = Duration::from_secs(120);
/// How long to wait before re-probing a busy proxy in the silent path.
const BUSY_RETRY: Duration = Duration::from_secs(15 * 60);
/// A proxy request newer than this counts as an active session.
const IDLE_THRESHOLD_MS: i64 = 5 * 60 * 1000;

/// The update found by the most recent check, awaiting user consent via the
/// modal's Install button. Registered with `app.manage` in main.rs.
pub struct PendingUpdate(pub Mutex<Option<Update>>);

/// Payload of the `update_available` event the frontend listens for.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAvailablePayload {
    version: String,
    current_version: String,
}

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
    let Ok(home) = app.path().home_dir() else {
        return false;
    };
    let path = home.join(".claude-sentinel").join("settings.json");
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return false;
    };
    serde_json::from_str::<UpdaterSettings>(&contents)
        .map(|s| s.auto_update)
        .unwrap_or(false)
}

/// Background-check cadence, overridable for testing
/// (`CLAUDE_SENTINEL_UPDATE_CHECK_INTERVAL_SECS=60` makes the loop tick
/// every minute).
fn check_interval() -> Duration {
    std::env::var("CLAUDE_SENTINEL_UPDATE_CHECK_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&secs| secs > 0)
        .map(Duration::from_secs)
        .unwrap_or(CHECK_INTERVAL)
}

fn notify(app: &AppHandle, body: String) {
    let _ = app
        .notification()
        .builder()
        .title("Claude Sentinel")
        .body(body)
        .show();
}

/// Stash the found update for the modal's Install button and tell the
/// frontend. The modal renders whenever the window is (or becomes) visible.
fn stash_and_emit(app: &AppHandle, update: Update) {
    let payload = UpdateAvailablePayload {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
    };
    let state = app.state::<PendingUpdate>();
    *state.0.lock().expect("pending update lock") = Some(update);
    let _ = app.emit("update_available", payload);
}

/// Ask the daemon whether the proxy is mid-session. Busy means an in-flight
/// request right now, or any request within the last `IDLE_THRESHOLD_MS`.
/// An unreachable daemon reads as idle: if the proxy isn't serving, a
/// restart can't interrupt anything.
async fn proxy_is_busy() -> bool {
    let msg = serde_json::json!({ "type": "get_proxy_activity" });
    let Ok(resp) = crate::ipc::send_internal(msg).await else {
        return false;
    };
    if !resp.success {
        return false;
    }
    let Some(data) = resp.data else {
        return false;
    };
    let in_flight = data
        .get("inFlightRequests")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if in_flight > 0 {
        return true;
    }
    let Some(last_ts) = data.get("lastRequestTs").and_then(|v| v.as_i64()) else {
        return false;
    };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(i64::MAX);
    now_ms.saturating_sub(last_ts) < IDLE_THRESHOLD_MS
}

/// Called once at startup. First check after `INITIAL_DELAY`, then every
/// `check_interval()` forever. Check failures are silent (offline, S3 blip);
/// the next tick retries.
pub fn spawn_update_timer(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let interval = check_interval();
        // Track the last version we fired a notification for, so a 4-hourly
        // re-find of the same release doesn't nag every tick.
        let mut notified_version: Option<String> = None;
        tokio::time::sleep(std::cmp::min(interval, INITIAL_DELAY)).await;
        loop {
            scheduled_check(&app, &mut notified_version).await;
            tokio::time::sleep(interval).await;
        }
    });
}

/// One background tick: check, then either install silently (opted-in users,
/// idle proxy only) or stage the modal + notify.
async fn scheduled_check(app: &AppHandle, notified_version: &mut Option<String>) {
    let Ok(updater) = app.updater() else { return };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        // No update / check error: silent. The tray item exists for users
        // who want explicit feedback.
        Ok(None) | Err(_) => return,
    };

    if read_auto_update_pref(app) {
        // Silent path. Defer while the proxy is serving a session; the
        // retry is bounded only by the user going idle, which is the point.
        // Cap each wait at the configured interval so test runs with a
        // short override aren't stuck on the 15-minute production retry.
        let retry = std::cmp::min(BUSY_RETRY, check_interval());
        while proxy_is_busy().await {
            tokio::time::sleep(retry).await;
        }
        // Install errors are silent like check errors: recoverable on the
        // next tick and not worth interrupting the user.
        if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
            app.restart();
        }
    } else {
        let version = update.version.clone();
        stash_and_emit(app, update);
        if notified_version.as_deref() != Some(version.as_str()) {
            notify(
                app,
                format!("Claude Sentinel v{version} is available. Open Sentinel to install."),
            );
            *notified_version = Some(version);
        }
    }
}

/// Tauri command backing the tray-menu "Check for updates…" item. Always
/// runs. On a hit it brings the window forward and raises the update modal;
/// otherwise it surfaces a notification so an explicit action always gets
/// feedback.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            if let Some(window) = app.get_webview_window("main") {
                crate::activation::show_and_activate(&window);
            }
            stash_and_emit(&app, update);
            Ok(())
        }
        Ok(None) => {
            notify(&app, "You're on the latest version.".to_string());
            Ok(())
        }
        Err(e) => {
            notify(&app, format!("Update check failed: {e}"));
            Err(e.to_string())
        }
    }
}

/// Tauri command backing the update modal's Install button. Consumes the
/// pending update from the last check (re-checks as a fallback so a stale
/// webview can't strand the button), installs, and restarts.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    // Take the stash inside a block so the guard drops before any await.
    let pending = {
        let state = app.state::<PendingUpdate>();
        let taken = state.0.lock().expect("pending update lock").take();
        taken
    };
    let update = match pending {
        Some(update) => update,
        None => {
            let updater = app.updater().map_err(|e| e.to_string())?;
            updater
                .check()
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "No update available.".to_string())?
        }
    };
    // download_and_install takes two callbacks (progress + done). We ignore
    // both; the modal shows an indeterminate "Installing…" state and the
    // restart is the completion signal.
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}
