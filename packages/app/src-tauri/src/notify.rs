// Native OS-notification fallback for security events.
//
// Why shell to `osascript` instead of the tauri-plugin-notification path:
// macOS's UNUserNotificationCenter silently suppresses banners when the
// sending app is the frontmost window — which is exactly when security
// events fire most often (the user is actively inside Sentinel). The
// AppleScript `display notification` facility is not subject to that
// suppression rule, so the banner always reaches Notification Center
// regardless of focus state.
//
// The pattern mirrors `sound::play_system_sound`, which shells to
// `afplay` for the same "plugin path is suppressed when frontmost"
// reason.

/// Display an OS notification via macOS's AppleScript `display
/// notification` facility. Bypasses the foreground-app suppression that
/// drops `sendNotification` banners when Sentinel is visible.
///
/// `title` and `body` are interpolated into an AppleScript literal.
/// Both are sanitised so an embedded single quote can't break out of
/// the quoted-string or inject additional statements.
///
/// Linux / Windows: intentional no-op — the Tauri plugin's default path
/// works on those OSes because neither enforces macOS-style foreground
/// suppression on notifications.
#[tauri::command]
pub fn display_os_notification(title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // `osascript` receives one script string per `-e`. Inside a
        // single-quoted AppleScript literal, a single quote ends the
        // literal — so we escape each embedded `'` as `'"'"'` (close
        // quote, double-quoted single quote, reopen). This is the
        // canonical shell-escape dance.
        let safe_title = title.replace('\'', "'\"'\"'");
        let safe_body = body.replace('\'', "'\"'\"'");
        let script = format!(
            "display notification '{}' with title '{}'",
            safe_body, safe_title,
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("osascript failed: {}", e))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Not wired up on non-macOS; the Tauri notification plugin still
        // handles those platforms via the frontend fallback path.
        let _ = (title, body);
    }
    Ok(())
}
