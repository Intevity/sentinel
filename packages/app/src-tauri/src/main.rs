// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activation;
mod app_log;
mod daemon;
mod first_run;
mod ipc;
mod notify;
mod settings_patch;
mod setup_token;
mod sound;
mod tray;
mod tray_icon_render;
#[cfg(target_os = "windows")]
mod tray_pin;
mod updater;

use tauri::{AppHandle, Emitter, LogicalSize, Manager};
use tauri_plugin_autostart::ManagerExt;

/// Tauri command exposed to the frontend so the "Quit Sentinel" menu item can
/// shut the app down after it has already asked the daemon to exit via IPC.
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Enable or disable launch-at-login. Backed by tauri-plugin-autostart,
/// which uses LaunchAgent on macOS, the registry on Windows, and a .desktop
/// file on Linux.
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

/// Returns the current OS-level autostart state.
#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Default tray-window dimensions. Mirror tauri.conf.json — the pinned
/// size is what keeps the app feeling like a compact tray menu. When
/// DevTools opens we temporarily blow these constraints out so the
/// inspector has room to dock; we restore on close.
const TRAY_WIDTH: f64 = 580.0;
const TRAY_HEIGHT: f64 = 628.0;

/// Size the window expands to when DevTools opens. Chosen to leave ~540×628
/// of the viewport for the app content and the rest for a docked
/// inspector — matches Chrome's typical "bottom-docked" footprint on a
/// laptop-sized display.
const DEVTOOLS_OPEN_WIDTH: f64 = 1280.0;
const DEVTOOLS_OPEN_HEIGHT: f64 = 900.0;

/// Toggle DevTools on the main tray window. Uses Tauri's standard
/// `open_devtools` / `close_devtools` / `is_devtools_open` APIs.
///
/// Tricky part: our tray window is locked to 540×628 non-resizable, so
/// a docked inspector has no room. The toggle lifts those constraints
/// while DevTools is open and puts them back when closed:
///
///   - **Opening**: clear max-size, enable resizable, grow to 1280×900,
///     `open_devtools()`, emit `devtools_state_changed {open: true}`,
///     spawn a watchdog task that polls `is_devtools_open()` and runs
///     the close/restore path when the user closes DevTools via a
///     non-Sentinel path (inspector X button, ⌘-Option-I, etc.).
///   - **Closing**: see `restore_tray_window_size` — called both by
///     this command and by the watchdog.
///
/// The watchdog is what fixes the "closed DevTools and my window stayed
/// huge" case. Without it, closing the inspector from its own UI left
/// the window at 1280×900 forever (until Sentinel restarted).
#[tauri::command]
fn toggle_devtools(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not available".to_string())?;

    if window.is_devtools_open() {
        window.close_devtools();
        restore_tray_window_size(&window, &app)?;
    } else {
        // Clearing the cap BEFORE enabling resize + grow. set_max_size(None)
        // is what allows the window to exceed its pinned tray size — without
        // it, set_size would be clamped back to 540×628 and DevTools would
        // still have no room.
        window
            .set_max_size(None::<LogicalSize<f64>>)
            .map_err(|e| format!("set_max_size: {e}"))?;
        window
            .set_resizable(true)
            .map_err(|e| format!("set_resizable: {e}"))?;
        window
            .set_size(LogicalSize::new(DEVTOOLS_OPEN_WIDTH, DEVTOOLS_OPEN_HEIGHT))
            .map_err(|e| format!("set_size: {e}"))?;
        window.open_devtools();
        let _ = app.emit(
            "devtools_state_changed",
            serde_json::json!({ "open": true }),
        );

        // Watchdog: poll every 500ms for DevTools closing. Self-
        // terminating — the task ends as soon as the user closes the
        // inspector (by any path), after firing the restore sequence.
        // Single-shot, so duplicate `toggle_devtools` "open" presses
        // while the inspector is already open are effectively no-ops
        // (the first branch's `is_devtools_open()` would be true and
        // we'd take the close path instead).
        let watch_window = window.clone();
        let watch_app = app.clone();
        tauri::async_runtime::spawn(async move {
            use tokio::time::{sleep, Duration};
            loop {
                sleep(Duration::from_millis(500)).await;
                if !watch_window.is_devtools_open() {
                    let _ = restore_tray_window_size(&watch_window, &watch_app);
                    return;
                }
            }
        });
    }
    Ok(())
}

/// Shrink the main window back to its pinned tray dimensions and
/// re-engage the max-size + non-resizable constraints. Also fires
/// `devtools_state_changed {open: false}` so the frontend's auto-resize
/// hook unpauses and recalibrates against the restored viewport.
///
/// Called from two paths: the "close" branch of `toggle_devtools`, and
/// the watchdog task for external DevTools closes (keyboard shortcut,
/// inspector X button). Idempotent — repeating the sequence on an
/// already-restored window is harmless.
fn restore_tray_window_size(window: &tauri::WebviewWindow, app: &AppHandle) -> Result<(), String> {
    // Order matters: set size first (while still resizable), then pin
    // max + disable resize. If we disabled resize first, set_size might
    // silently refuse to change.
    window
        .set_size(LogicalSize::new(TRAY_WIDTH, TRAY_HEIGHT))
        .map_err(|e| format!("set_size: {e}"))?;
    window
        .set_max_size(Some(LogicalSize::new(TRAY_WIDTH, TRAY_HEIGHT)))
        .map_err(|e| format!("set_max_size: {e}"))?;
    window
        .set_resizable(false)
        .map_err(|e| format!("set_resizable: {e}"))?;
    let _ = app.emit(
        "devtools_state_changed",
        serde_json::json!({ "open": false }),
    );
    Ok(())
}

fn main() {
    // WebKit2GTK's DMA-BUF renderer triggers EPROTO (Error 71) on some Wayland
    // compositors — the compositor rejects the zwp_linux_dmabuf_v1 buffer-sharing
    // protocol. Falling back to wl_shm transport works universally. Must be set
    // before Tauri initialises the GTK/WebKit runtime. Skipped if the user has
    // already set this env var (so WEBKIT_DISABLE_DMABUF_RENDERER=0 opts out).
    #[cfg(target_os = "linux")]
    {
        let on_wayland = std::env::var("WAYLAND_DISPLAY").is_ok()
            || std::env::var("XDG_SESSION_TYPE")
                .map(|v| v == "wayland")
                .unwrap_or(false);
        if on_wayland && std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    tauri::Builder::default()
        // Must be the FIRST plugin: a second launch (double-click on an
        // already-running Sentinel, autostart racing a manual open) is
        // rejected before any other plugin initializes. The callback runs
        // in the surviving instance; the duplicate process exits on its
        // own. The daemon sidecar needs no extra guard — the rejected
        // instance never reaches .setup, so it never spawns one.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                crate::activation::show_and_activate(&window);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Intercept red-X / Cmd+W on the tray window: hide instead of close.
        // Sentinel is an LSUIElement tray app — the daemon keeps running in the
        // background so Claude Code continues routing through it. The user
        // explicitly quits via the tray menu or the in-app ⋯ → Quit Sentinel.
        //
        // Scoped to the "main" window label only. Other windows (the claude.ai
        // login webview) must honor their normal close behavior so closing
        // actually destroys the webview — otherwise a closed-but-hidden login
        // window would block the next `WebviewWindowBuilder::new(..., "claude-ai-login", ...)`
        // and the user's second Connect click would silently focus the stale
        // hidden window instead of opening a fresh one.
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let _ = window.hide();
                    api.prevent_close();
                }
                // Notification-click → app-activation is our routing
                // channel instead of the dead
                // NSUserNotificationCenterDelegate callback on macOS
                // 26. Two code paths call `notify::route_recent_event`
                // for the same reason: this one catches clicks that
                // arrive with the window already visible; notify.rs's
                // NSApplicationDidBecomeActive observer catches clicks
                // that arrive with the window hidden (the tray app
                // default). Keeping both handlers means it works in
                // either state.
                tauri::WindowEvent::Focused(true) => {
                    let _ = window;
                    notify::route_recent_event();
                }
                _ => {}
            }
        })
        .setup(|app| {
            // One-time migration of the legacy data dir ~/.claude-sentinel ->
            // ~/.sentinel (the product was renamed "Claude Sentinel" -> "Sentinel").
            // MUST be the first thing we do: before any app_log write (which
            // creates ~/.sentinel and would make the migration a no-op, orphaning
            // the legacy dir) and before the daemon sidecar spawns, so both the
            // app and the daemon observe the renamed path.
            app_log::migrate_data_dir();

            // Install the persistent NSUserNotificationCenter delegate
            // and stash an AppHandle for it to reach back into Tauri.
            // Must run before any daemon broadcast can trigger a
            // notification. `init_notification_bundle` is retained as
            // a no-op shim for symmetry with prior call sites.
            #[cfg(target_os = "macos")]
            notify::init_notification_bundle(&app.config().identifier);
            notify::init(app.handle());

            // Build the tray icon and menu
            tray::setup_tray(app)?;

            // Best-effort: pin the tray icon out of the overflow flyout on
            // Windows 11 (own retry thread; silent if the shell hasn't
            // created the registry entry yet).
            #[cfg(target_os = "windows")]
            tray_pin::promote_tray_icon();

            // Spawn the bundled daemon sidecar (idempotent — exits if already running)
            daemon::spawn(app.handle());

            // Start the IPC connection to the daemon in the background
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                ipc::connect_daemon(handle).await;
            });

            // Seed the tray state once the daemon socket is up. Runs once at
            // startup; live updates after that arrive via daemon broadcasts
            // dispatched from the IPC read loop.
            let seed_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while !ipc::is_connected().await {
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
                tray::seed(&seed_handle).await;
            });

            // Tray app: normally start hidden. On first launch, reveal the
            // window so the user lands in the onboarding tour instead of
            // staring at a tray icon with no cue that anything needs doing.
            if let Some(window) = app.get_webview_window("main") {
                if first_run::is_first_run(app.handle()) {
                    activation::show_and_activate(&window);
                } else {
                    window.hide().unwrap_or_default();
                }
            }

            // Background update checks: shortly after launch, then every
            // 4 h. Found updates either install silently (user opted in via
            // "Automatically install updates", proxy idle) or stage the
            // in-app update modal. The managed state holds the pending
            // update between the check and the modal's Install click.
            app.manage(updater::PendingUpdate(std::sync::Mutex::new(None)));
            app.manage(setup_token::SetupTokenState::default());
            updater::spawn_update_timer(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::ipc_send,
            settings_patch::is_sentinel_activated,
            settings_patch::activate_sentinel,
            settings_patch::deactivate_sentinel,
            quit_app,
            set_autostart,
            get_autostart,
            toggle_devtools,
            sound::play_system_sound,
            notify::display_os_notification,
            notify::display_alert_notification,
            updater::check_for_updates,
            updater::install_update,
            setup_token::setup_token_start,
            setup_token::setup_token_write,
            setup_token::setup_token_resize,
            setup_token::setup_token_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sentinel");
}
