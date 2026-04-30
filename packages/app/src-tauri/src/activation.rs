/// Bring the Sentinel tray window forward across other apps.
///
/// `WebviewWindow::set_focus()` on macOS only does
/// `[NSWindow makeKeyAndOrderFront:]`, which is a within-app raise.
/// Sentinel ships with `LSUIElement=true` (Info.plist), so AppKit will
/// not promote our window above another running app's foreground
/// window without an explicit `[NSApp activateIgnoringOtherApps:YES]`.
/// Without this, clicking the tray icon while Chrome (or any other
/// fullscreen app) is foreground silently shows the window underneath
/// and the user never sees it.
///
/// On non-macOS platforms `set_focus()` is sufficient; the helper is a
/// thin pass-through there.
use tauri::{Runtime, WebviewWindow};

#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSApplication;

pub fn show_and_activate<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "macos")]
    {
        if let Some(mtm) = MainThreadMarker::new() {
            let app = NSApplication::sharedApplication(mtm);
            // `activateIgnoringOtherApps` is deprecated in macOS 14 in
            // favour of `activate()`, but the older selector still does
            // the right thing on every supported macOS and works on
            // pre-14 systems we'd otherwise lose. objc2-app-kit gates
            // it on the MainThreadMarker so it's safe to call here.
            #[allow(deprecated)]
            app.activateIgnoringOtherApps(true);
        }
    }
    let _ = window.show();
    let _ = window.set_focus();
}
