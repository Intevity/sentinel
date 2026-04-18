// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod daemon;
mod ipc;
mod settings_patch;
mod sound;
mod tray;
mod tray_icon_render;
mod updater;

use tauri::{AppHandle, Manager};
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        // Intercept red-X / Cmd+W: hide the window instead of closing it.
        // Sentinel is an LSUIElement tray app — the daemon keeps running in the
        // background so Claude Code continues routing through it. The user
        // explicitly quits via the tray menu or the in-app ⋯ → Quit Sentinel.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .setup(|app| {
            // Build the tray icon and menu
            tray::setup_tray(app)?;

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

            // Hide the main window on startup — we're a tray app
            if let Some(window) = app.get_webview_window("main") {
                window.hide().unwrap_or_default();
            }

            // Fire-and-forget update check. No-op unless the user has toggled
            // "Automatically install updates" in Settings. Silent success
            // (triggers a restart when an update lands) and silent failure.
            updater::maybe_check_on_startup(app.handle().clone());

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
            sound::play_system_sound,
            updater::check_for_updates,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Claude Sentinel");
}
