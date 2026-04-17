// Native system-sound playback for the Settings → Alert Sound preview button.
//
// Why a Tauri command instead of @tauri-apps/plugin-notification's sound param:
// macOS intentionally suppresses NSSound-backed notification sounds when the
// target app is the frontmost window. The preview happens while the user is
// focused on the Settings panel, so sendNotification({ sound }) shows the
// banner but plays no audio. This command bypasses the notification system
// entirely by shelling to `afplay`, which always plays regardless of focus.

/// Play a macOS system sound by name (e.g. "Glass", "Ping", "Hero").
/// Matches the files under `/System/Library/Sounds/`.
///
/// Linux / Windows: intentional no-op for now. Cross-platform playback can
/// follow if users request it; macOS is the primary target for v0.1.x.
#[tauri::command]
pub fn play_system_sound(name: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let path = format!("/System/Library/Sounds/{}.aiff", name);
        std::process::Command::new("afplay")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("afplay failed: {}", e))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Intentionally unused on non-macOS builds.
        let _ = name;
    }
    Ok(())
}
