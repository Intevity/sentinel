//! First-run detection for auto-showing the tray window.
//!
//! Sentinel is a tray app that hides its main window on startup, but on a
//! fresh install there's no visual cue that the user needs to click the tray
//! icon to run the tour / security-setup wizard. This module answers one
//! question: "is this the user's first launch?" — used by `main.rs` setup to
//! decide whether to reveal the window or keep it hidden.
//!
//! We key off `settings.tourCompleted` because it already flips to `true`
//! the moment the user finishes or skips the tour (see `App.tsx`). A missing
//! or unreadable settings file is treated as first run — on a genuinely-fresh
//! install the daemon hasn't written the file yet, and a corrupt file is rare
//! enough that failing-open (showing the window) is the less surprising path.

use serde::Deserialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize)]
struct FirstRunSettings {
    #[serde(default)]
    #[serde(rename = "tourCompleted")]
    tour_completed: bool,
}

pub fn is_first_run(app: &AppHandle) -> bool {
    let Ok(home) = app.path().home_dir() else {
        return true;
    };
    let path = home.join(".sentinel").join("settings.json");
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return true;
    };
    match serde_json::from_str::<FirstRunSettings>(&contents) {
        Ok(s) => !s.tour_completed,
        Err(_) => true,
    }
}
