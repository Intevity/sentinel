/// System tray icon and menu for Claude Sentinel.
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, Manager,
};

pub fn setup_tray(app: &mut App) -> tauri::Result<()> {
    let quit = MenuItem::with_id(app, "quit", "Quit Claude Sentinel", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Sentinel...", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let status = MenuItem::with_id(app, "status", "Claude Sentinel", false, None::<&str>)?;

    let menu = Menu::with_items(app, &[&status, &separator, &open, &separator, &quit])?;

    let _tray = TrayIconBuilder::with_id("main-tray")
        .icon(tauri::include_image!("icons/tray-icon.png"))
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Claude Sentinel")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => {
                app.exit(0);
            }
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}
