//! Auto-update plumbing for Sentinel.
//!
//! Three entry points share the same check core:
//!   - `spawn_update_timer` — called from `main.rs` setup; checks shortly
//!     after launch and then every `CHECK_INTERVAL` (4 h, overridable via
//!     `SENTINEL_UPDATE_CHECK_INTERVAL_SECS` for testing).
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
//! The daemon sidecar is deliberately long-lived: it keeps proxying Claude
//! Code traffic while the UI window is closed and is NOT killed when the
//! window hides. At update time it is therefore still running and, on
//! Windows, still holds an exclusive lock on sentinel-daemon.exe —
//! the NSIS/MSI passive installers then fail with "Error opening file for
//! writing" (Tauri #7931 class). `perform_install` downloads first (proxy
//! keeps serving), then on macOS/Linux calls
//! `daemon::stop_daemon_for_update()` (graceful IPC shutdown, kill escalation
//! fallback) right before `update.install()`; `app.restart()` and the Windows
//! installer's own relaunch respawn a fresh daemon. On Windows the installers
//! do that kill themselves — see the note below on why we no longer duplicate
//! it. If the install fails on macOS/Linux we respawn the daemon ourselves so
//! the proxy comes back on the old version (`daemon::spawn` reuses the
//! session's handshake token, so the existing IPC client still
//! authenticates).
//!
//! On macOS the `.app` replacement step requires a signed + notarized bundle;
//! installs on unsigned builds will fail at the Gatekeeper check. That's why
//! the user-facing setting defaults to `false`. On Windows and Linux the
//! plugin runs the matching installer (NSIS/MSI in `passive` mode, AppImage
//! in-place swap, deb/rpm via the package manager). On Windows the installers
//! and the embedded daemon sidecar are Authenticode-signed via Azure
//! Trusted/Artifact Signing when the release pipeline's AZURE_* repo variables
//! are configured (unset — e.g. forks — builds unsigned); Linux bundles carry
//! no OS code signature. Regardless, every download is still minisign-verified
//! against the pubkey in tauri.conf.json.
//!
//! WINDOWS CANNOT REPORT AN INSTALL FAILURE. `Update::install` hands the
//! downloaded installer to `ShellExecuteW`, **discards whether that
//! succeeded**, and calls `std::process::exit(0)` unconditionally. Past the
//! extraction step it therefore never returns — not `Ok`, not `Err` — so the
//! error arm below and `app.restart()` are dead code on that platform, and a
//! declined UAC prompt, a SmartScreen/AV block, or an MSI rollback all look
//! exactly like success. That is why `perform_install` writes an
//! `~/.sentinel/update-attempt.json` marker BEFORE calling `install`, and
//! `reconcile_update_attempt` reads it back on the next launch: if the running
//! version is unchanged, the install silently failed and the frontend raises a
//! recovery banner. See `update_marker` for the schema and the verdicts.
//!
//! It is also why the pre-install daemon stop is `#[cfg(not(windows))]`. Both
//! Windows installers already kill the daemon themselves (windows/hooks.nsh
//! `NSIS_HOOK_PREINSTALL`, windows/daemon-close.wxs), so stopping it here
//! bought nothing on the success path — and on the failure path the process
//! was already gone before the respawn could run, leaving the user with no app
//! AND no proxy. Leaving the daemon up means a failed install degrades to
//! "the app closed, Claude Code keeps working on the old version".

use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::update_marker::{self, AttemptVerdict};

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

/// A previous launch's install attempt that never landed, populated by
/// `reconcile_update_attempt` during setup. Registered with `app.manage` in
/// main.rs and read by the frontend via `get_failed_update_attempt`.
pub struct FailedUpdate(pub Mutex<Option<FailedUpdatePayload>>);

/// What the recovery banner needs to explain a silently-failed install.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedUpdatePayload {
    /// The version that failed to install.
    pub target_version: String,
    /// The version still running.
    pub running_version: String,
    /// `nsis` | `msi` | `app` | `appimage` | … — decides which likely cause
    /// the banner names (elevation prompt vs SmartScreen/antivirus).
    pub installer: String,
    /// The exact artifact that failed, for support replies.
    pub artifact: String,
    /// `modal` (a human clicked Install) or `auto` (silent path).
    pub trigger: String,
}

/// Which path asked for the install. Recorded in the marker so the log says
/// whether a human clicked Install or the background timer ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallTrigger {
    Modal,
    Auto,
}

impl InstallTrigger {
    fn as_str(self) -> &'static str {
        match self {
            Self::Modal => "modal",
            Self::Auto => "auto",
        }
    }
}

/// Payload of the `update_available` event the frontend listens for.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAvailablePayload {
    version: String,
    current_version: String,
}

/// Subset of `~/.sentinel/settings.json` we care about here.
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
    let path = home.join(".sentinel").join("settings.json");
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return false;
    };
    serde_json::from_str::<UpdaterSettings>(&contents)
        .map(|s| s.auto_update)
        .unwrap_or(false)
}

/// Background-check cadence, overridable for testing
/// (`SENTINEL_UPDATE_CHECK_INTERVAL_SECS=60` makes the loop tick
/// every minute).
fn check_interval() -> Duration {
    std::env::var("SENTINEL_UPDATE_CHECK_INTERVAL_SECS")
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
        .title("Sentinel")
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
        // Failures are logged inside `perform_install`. There is no modal to
        // show them in on this path, and the next tick retries — so the error
        // is dropped here deliberately rather than interrupting the user.
        let _ = perform_install(app, update, InstallTrigger::Auto).await;
    } else {
        let version = update.version.clone();
        stash_and_emit(app, update);
        if notified_version.as_deref() != Some(version.as_str()) {
            notify(
                app,
                format!("Sentinel v{version} is available. Open Sentinel to install."),
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
    perform_install(&app, update, InstallTrigger::Modal).await
}

/// The one install path, shared by the modal's Install button and the silent
/// auto-update tick so both record attempts and log identically.
///
/// Ordering is load-bearing, because on Windows this function does not return
/// (see the module doc):
///
/// 1. log the intent, so `app.log` proves the click reached Rust at all
/// 2. download — before anything destructive, so a download failure leaves the
///    daemon untouched and the modal's error is the whole story
/// 3. write the marker, the only channel a Windows failure has
/// 4. stop the daemon (macOS/Linux only)
/// 5. hand off to the installer
async fn perform_install(
    app: &AppHandle,
    update: Update,
    trigger: InstallTrigger,
) -> Result<(), String> {
    let version = update.version.clone();
    let from_version = update.current_version.clone();
    let attempt = update_marker::new_attempt(
        &version,
        &from_version,
        &update.target,
        update.download_url.as_str(),
        trigger.as_str(),
    );
    crate::app_log::app_log(&format!(
        "Update install requested: {from_version} -> {version} (trigger={}, installer={}, target={}, artifact={})",
        attempt.trigger, attempt.installer, attempt.target, attempt.artifact
    ));

    // download takes two callbacks (progress + done). We ignore both; the
    // modal shows an indeterminate "Installing…" state and the restart is the
    // completion signal.
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(e) => {
            crate::app_log::app_log(&format!("Update download failed: {e}"));
            return Err(e.to_string());
        }
    };
    crate::app_log::app_log(&format!(
        "Update payload downloaded ({} bytes)",
        bytes.len()
    ));

    if update_marker::record_attempt(&attempt) {
        crate::app_log::app_log("Recorded update-attempt marker");
    } else {
        // Non-fatal: we lose the ability to REPORT a silent failure, not the
        // ability to update. Say so, since it changes how to read this log.
        crate::app_log::app_log(
            "Could not write the update-attempt marker; a silent install failure will go unreported",
        );
    }

    // Windows omits this on purpose — both installers kill the daemon
    // themselves, and stopping it here made a failed install take the proxy
    // down with the app. See the module doc.
    #[cfg(not(windows))]
    crate::daemon::stop_daemon_for_update().await;

    crate::app_log::app_log(&format!(
        "Launching installer for {version}; on Windows this process exits here"
    ));

    // Test seam: reproduce the Windows blind-exit on any platform so the
    // marker -> reconcile -> banner -> clear cycle can be exercised without a
    // VM, a real failing installer, or a denied UAC prompt.
    if std::env::var_os("SENTINEL_SIMULATE_FAILED_INSTALL").is_some() {
        crate::app_log::app_log(
            "SENTINEL_SIMULATE_FAILED_INSTALL is set — exiting without installing",
        );
        app.exit(0);
        return Ok(());
    }

    match update.install(bytes) {
        Ok(()) => app.restart(),
        Err(e) => {
            // Reachable on every platform: the plugin extracts the payload
            // BEFORE its Windows exit, so temp-write / disk-full / AV-on-write
            // failures still land here. The caller shows this error, so clear
            // the marker — otherwise the next launch reports the same failure
            // a second time.
            update_marker::clear_attempt();
            crate::app_log::app_log(&format!(
                "Update install failed before the installer launched: {e}"
            ));
            #[cfg(not(windows))]
            crate::daemon::spawn(app);
            Err(e.to_string())
        }
    }
}

/// Reconcile the marker left by a previous install attempt against the version
/// we actually booted. Called once from main.rs `setup()`.
///
/// The marker is cleared on every verdict. A retained one would re-classify
/// against the same running version on every subsequent launch and re-raise
/// the banner forever; `app.log` is the durable record instead.
pub fn reconcile_update_attempt(app: &AppHandle) {
    let running = app.package_info().version.to_string();
    let raw = update_marker::read_raw();
    match update_marker::classify(raw.as_deref(), &running, update_marker::now_secs()) {
        AttemptVerdict::NoAttempt => {}
        AttemptVerdict::Succeeded {
            version,
            from_version,
            age_secs,
        } => {
            crate::app_log::app_log(&format!(
                "Update to {version} installed successfully (from {from_version}, {age_secs}s after the attempt)"
            ));
            update_marker::clear_attempt();
        }
        AttemptVerdict::Failed {
            attempt,
            running: still_running,
            age_secs,
        } => {
            crate::app_log::app_log(&format!(
                "Update to {} did NOT install — still running {still_running} {age_secs}s after the attempt (trigger={}, installer={}, target={}, artifact={}). The installer never replaced the app; on Windows the updater exits before it can report why.",
                attempt.version, attempt.trigger, attempt.installer, attempt.target, attempt.artifact
            ));
            update_marker::clear_attempt();
            *app.state::<FailedUpdate>()
                .0
                .lock()
                .expect("failed update lock") = Some(FailedUpdatePayload {
                target_version: attempt.version,
                running_version: still_running,
                installer: attempt.installer,
                artifact: attempt.artifact,
                trigger: attempt.trigger,
            });
        }
        AttemptVerdict::Expired { attempt, age_secs } => {
            crate::app_log::app_log(&format!(
                "Discarding a stale update-attempt marker for {} ({age_secs}s old)",
                attempt.version
            ));
            update_marker::clear_attempt();
        }
        AttemptVerdict::Unreadable { raw } => {
            crate::app_log::app_log(&format!(
                "Discarding an unreadable update-attempt marker: {raw}"
            ));
            update_marker::clear_attempt();
        }
    }
}

/// Frontend pulls this on mount to decide whether to show the recovery banner.
///
/// A pull, not an `emit` like `update_available`: the verdict is known during
/// `setup()`, before the webview exists, and Sentinel starts hidden in the
/// tray — an event fired at that moment is guaranteed to be dropped. Managed
/// state plus a command is race-free and idempotent under StrictMode.
#[tauri::command]
pub fn get_failed_update_attempt(app: AppHandle) -> Option<FailedUpdatePayload> {
    app.state::<FailedUpdate>()
        .0
        .lock()
        .expect("failed update lock")
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_trigger_strings_are_stable() {
        // On-disk vocabulary: the marker, the log lines, and the banner copy
        // all read these exact strings.
        assert_eq!(InstallTrigger::Modal.as_str(), "modal");
        assert_eq!(InstallTrigger::Auto.as_str(), "auto");
    }
}
