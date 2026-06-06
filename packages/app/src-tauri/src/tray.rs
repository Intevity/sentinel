/// System tray icon and menu for Claude Sentinel.
///
/// The tray icon is dynamic:
///   - The Sentinel logo is re-tinted by utilization threshold
///     (<70% blue, 70–89% orange, ≥90% red, unknown gray).
///   - A "NN%" title sits to the right of the icon on macOS
///     (via `TrayIcon::set_title` — no-op on other platforms).
///   - The disabled status menu item carries contextual text
///     ("jeff@… · 42%" or "Round-robin pool · 42%").
///
/// State lives in Tauri-managed `Arc<Mutex<TrayState>>`. The IPC read loop
/// feeds it on every daemon broadcast (`rate_limits_updated`,
/// `account_switched`, `settings_changed`, `login_complete`). On startup
/// `main.rs` seeds it once via `get_settings`, `refresh_accounts`, and
/// `get_all_rate_limits`.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};
use tokio::sync::Mutex;

use crate::ipc;
#[cfg(target_os = "windows")]
use crate::tray_icon_render::digits;
use crate::tray_icon_render::{tinted, TintColor};

pub type SharedTrayState = Arc<Mutex<TrayState>>;

pub struct TrayState {
    icon: TrayIcon<Wry>,
    status_mi: MenuItem<Wry>,
    switching_mode: SwitchingMode,
    active_id: Option<String>,
    active_email: Option<String>,
    /// Sentinel-keyed utilization, 0.0..=1.0. `None` = account known but
    /// no data yet; missing key = account never enrolled here.
    utilizations: HashMap<String, Option<f32>>,
    /// Sentinel account ids the user has excluded from the round-robin
    /// pool. Must be filtered out of the RR-mode aggregate so the tray
    /// reflects the accounts that are actually rotating, not every
    /// enrolled account. Synced from the `poolExcludedIds` field of
    /// `settings_changed` broadcasts. Ignored in Off mode.
    pool_excluded_ids: HashSet<String>,
    /// Sentinel ids the daemon has paused (weekly rate limit, budget cap,
    /// or overage disabled). Treated like pool exclusions for the RR mean:
    /// the TokenRotator already skips them, so a paused account at 100%
    /// utilization shouldn't drag the displayed % up against accounts the
    /// user can actually use. Seeded via `get_paused_accounts` and updated
    /// by `account_paused` / `account_unpaused` broadcasts. Ignored in Off
    /// mode (the active-account % comes straight from utilizations, not
    /// from a pool aggregate).
    paused_ids: HashSet<String>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum SwitchingMode {
    #[default]
    Off,
    RoundRobin,
}

impl SwitchingMode {
    fn from_str(s: &str) -> Self {
        match s {
            "round-robin" => Self::RoundRobin,
            _ => Self::Off,
        }
    }
}

pub fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let quit = MenuItem::with_id(app, "quit", "Quit Claude Sentinel", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Sentinel...", true, None::<&str>)?;
    let check_updates = MenuItem::with_id(
        app,
        "check_updates",
        "Check for updates…",
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let status = MenuItem::with_id(app, "status", "Claude Sentinel", false, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &status,
            &separator,
            &open,
            &check_updates,
            &separator,
            &quit,
        ],
    )?;

    // Start with the gray-tinted variant so we never show the monochrome
    // template until real data arrives — a template icon would visually lie
    // about the color-coded contract.
    let initial = tinted(TintColor::Gray);
    let initial_img = tauri::image::Image::new(&initial.bytes, initial.width, initial.height);

    let icon = TrayIconBuilder::with_id("main-tray")
        .icon(initial_img)
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Claude Sentinel")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => {
                // Match the HeaderMenu "Quit Sentinel" path: ask the daemon to
                // shut itself down via IPC before exiting the app. Without this
                // the daemon is orphaned on tray-quit and the two quit paths
                // leave the system in different states.
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ =
                        ipc::send_internal(serde_json::json!({ "type": "shutdown_daemon" })).await;
                    handle.exit(0);
                });
            }
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    crate::activation::show_and_activate(&window);
                }
            }
            "check_updates" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::updater::check_for_updates(handle).await;
                });
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
                        crate::activation::show_and_activate(&window);
                    }
                }
            }
        })
        .build(app)?;

    let state = Arc::new(Mutex::new(TrayState {
        icon,
        status_mi: status,
        switching_mode: SwitchingMode::Off,
        active_id: None,
        active_email: None,
        utilizations: HashMap::new(),
        pool_excluded_ids: HashSet::new(),
        paused_ids: HashSet::new(),
    }));
    app.manage(state);

    Ok(())
}

/// Seed the TrayState from the daemon once on startup. Called after the
/// IPC socket connects so the initial queries don't race the connection.
pub async fn seed(app: &AppHandle) {
    let state = match app.try_state::<SharedTrayState>() {
        Some(s) => s.inner().clone(),
        None => return,
    };

    let settings = ipc::send_internal(serde_json::json!({"type": "get_settings"}))
        .await
        .ok()
        .and_then(|r| r.data);
    let accts = ipc::send_internal(serde_json::json!({"type": "refresh_accounts"}))
        .await
        .ok()
        .and_then(|r| r.data);
    let all_rl = ipc::send_internal(serde_json::json!({"type": "get_all_rate_limits"}))
        .await
        .ok()
        .and_then(|r| r.data);
    let paused = ipc::send_internal(serde_json::json!({"type": "get_paused_accounts"}))
        .await
        .ok()
        .and_then(|r| r.data);

    let mut guard = state.lock().await;
    if let Some(s) = settings.as_ref() {
        guard.apply_settings(s);
    }
    if let Some(a) = accts.as_ref() {
        guard.apply_accounts(a);
    }
    if let Some(r) = all_rl.as_ref() {
        guard.apply_all_rate_limits(r);
    }
    if let Some(p) = paused.as_ref() {
        guard.apply_paused_accounts(p);
    }
    guard.apply();
}

/// Handle a single daemon broadcast. Called from `ipc::connect_daemon`'s
/// read loop for every parsed message. Spawned in a separate task so
/// follow-up `send_internal` calls don't block the read loop.
pub async fn handle_daemon_message(value: Value, app: AppHandle) {
    let msg_type = match value.get("type").and_then(Value::as_str) {
        Some(t) => t.to_string(),
        None => return,
    };

    match msg_type.as_str() {
        "rate_limits_updated" => {
            if let Some(account_id) = value.get("accountId").and_then(Value::as_str) {
                let resp = ipc::send_internal(
                    serde_json::json!({"type": "get_rate_limits", "accountId": account_id}),
                )
                .await
                .ok()
                .and_then(|r| r.data);
                let Some(state) = app.try_state::<SharedTrayState>() else {
                    return;
                };
                let mut guard = state.inner().clone().lock_owned().await;
                if let Some(windows) = resp {
                    guard
                        .utilizations
                        .insert(account_id.to_string(), extract_5h_util(&windows));
                }
                guard.apply();
            }
        }
        "account_switched" => {
            let to = match value.get("to") {
                Some(v) => v,
                None => return,
            };
            let Some(state) = app.try_state::<SharedTrayState>() else {
                return;
            };
            let mut guard = state.inner().clone().lock_owned().await;
            guard.apply_active_from_oauth_account(to);
            guard.apply();
        }
        "settings_changed" => {
            if let Some(s) = value.get("settings") {
                let Some(state) = app.try_state::<SharedTrayState>() else {
                    return;
                };
                let mut guard = state.inner().clone().lock_owned().await;
                guard.apply_settings(s);
                guard.apply();
            }
        }
        "login_complete" => {
            // A new account was added (or re-auth). Fully reseed to learn
            // the new account id and its initial rate-limit windows.
            seed(&app).await;
        }
        "account_paused" => {
            if let Some(id) = value.get("accountId").and_then(Value::as_str) {
                let Some(state) = app.try_state::<SharedTrayState>() else {
                    return;
                };
                let mut guard = state.inner().clone().lock_owned().await;
                guard.paused_ids.insert(id.to_string());
                guard.apply();
            }
        }
        "account_unpaused" => {
            if let Some(id) = value.get("accountId").and_then(Value::as_str) {
                let Some(state) = app.try_state::<SharedTrayState>() else {
                    return;
                };
                let mut guard = state.inner().clone().lock_owned().await;
                guard.paused_ids.remove(id);
                guard.apply();
            }
        }
        _ => {}
    }
}

impl TrayState {
    fn apply_settings(&mut self, settings_json: &Value) {
        let mode = settings_json
            .get("switchingMode")
            .and_then(Value::as_str)
            .map(SwitchingMode::from_str)
            .unwrap_or_default();
        self.switching_mode = mode;
        // Pool exclusions feed into compute_display so the tray average
        // doesn't include accounts the user has explicitly taken out of
        // rotation. Treat a missing / malformed field as "no exclusions"
        // rather than dropping state — keeps the tray stable across
        // partial settings payloads.
        self.pool_excluded_ids = settings_json
            .get("poolExcludedIds")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
    }

    fn apply_accounts(&mut self, accounts_json: &Value) {
        let Some(arr) = accounts_json.as_array() else {
            return;
        };
        let mut live_ids = std::collections::HashSet::new();
        for a in arr {
            if let Some(id) = a.get("id").and_then(Value::as_str) {
                live_ids.insert(id.to_string());
                if a.get("isActive").and_then(Value::as_bool).unwrap_or(false) {
                    self.active_id = Some(id.to_string());
                    self.active_email = a.get("email").and_then(Value::as_str).map(str::to_string);
                }
            }
        }
        // Prune utilizations + exclusion set + paused set for accounts that
        // no longer exist. Without the retains, a removed account's id
        // could linger forever — harmless today (the filters ignore
        // missing ids) but slowly grows the sets.
        self.utilizations.retain(|k, _| live_ids.contains(k));
        self.pool_excluded_ids.retain(|k| live_ids.contains(k));
        self.paused_ids.retain(|k| live_ids.contains(k));
        if arr.is_empty() {
            self.active_id = None;
            self.active_email = None;
        }
    }

    fn apply_all_rate_limits(&mut self, rl_json: &Value) {
        let Some(obj) = rl_json.as_object() else {
            return;
        };
        for (account_id, windows) in obj {
            self.utilizations
                .insert(account_id.clone(), extract_5h_util(windows));
        }
    }

    fn apply_paused_accounts(&mut self, paused_json: &Value) {
        // `get_paused_accounts` returns an array of
        // { accountId, reason, resetsAt } — we only need the ids for the
        // round-robin filter. Replace (don't merge) so a freshly-cleared
        // pause set doesn't leave stale ids around.
        let Some(arr) = paused_json.as_array() else {
            return;
        };
        self.paused_ids = arr
            .iter()
            .filter_map(|v| {
                v.get("accountId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
    }

    fn apply_active_from_oauth_account(&mut self, to: &Value) {
        // sentinelKey = organizationUuid || accountUuid  (see daemon/index.ts)
        let org = to
            .get("organizationUuid")
            .and_then(Value::as_str)
            .unwrap_or("");
        let acct = to.get("accountUuid").and_then(Value::as_str).unwrap_or("");
        let key = if !org.is_empty() { org } else { acct };
        if key.is_empty() {
            return;
        }
        self.active_id = Some(key.to_string());
        self.active_email = to
            .get("emailAddress")
            .and_then(Value::as_str)
            .map(str::to_string);
    }

    fn apply(&self) {
        let pct = compute_display(self);
        let color = tint_for(pct);

        // Windows has no tray title API (`set_title` is a no-op there), so
        // the percentage IS the icon: threshold-colored digits, with the
        // logo only while no data has arrived. The hover tooltip carries
        // the full status text the macOS title would have shown.
        #[cfg(target_os = "windows")]
        {
            let buf = match pct {
                Some(p) => digits(p, color),
                None => tinted(color),
            };
            let img = tauri::image::Image::new(&buf.bytes, buf.width, buf.height);
            let _ = self.icon.set_icon(Some(img));
            let _ = self.icon.set_tooltip(Some(format_tooltip(self, pct)));
        }

        #[cfg(not(target_os = "windows"))]
        {
            let buf = tinted(color);
            let img = tauri::image::Image::new(&buf.bytes, buf.width, buf.height);
            let _ = self.icon.set_icon(Some(img));
            let title = pct.map(|p| format!("{p}%"));
            let _ = self.icon.set_title(title.as_deref());
        }

        let _ = self.status_mi.set_text(format_status_text(self, pct));
    }
}

fn compute_display(state: &TrayState) -> Option<u8> {
    match state.switching_mode {
        SwitchingMode::RoundRobin => {
            // Only accounts actually rotating contribute to the pool mean.
            // An excluded or paused account at 100% used to drag the
            // displayed % upwards even though its traffic was zero — both
            // sets are filtered the same way for the same reason.
            let known: Vec<f32> = state
                .utilizations
                .iter()
                .filter(|(id, _)| {
                    !state.pool_excluded_ids.contains(*id) && !state.paused_ids.contains(*id)
                })
                .filter_map(|(_, v)| *v)
                .collect();
            if known.is_empty() {
                return None;
            }
            let mean = known.iter().sum::<f32>() / known.len() as f32;
            Some(to_pct(mean))
        }
        SwitchingMode::Off => {
            let id = state.active_id.as_deref()?;
            let util = (*state.utilizations.get(id)?)?;
            Some(to_pct(util))
        }
    }
}

fn to_pct(util: f32) -> u8 {
    let scaled = (util * 100.0).round().clamp(0.0, 100.0);
    scaled as u8
}

fn tint_for(pct: Option<u8>) -> TintColor {
    match pct {
        None => TintColor::Gray,
        Some(p) if p >= 90 => TintColor::Red,
        Some(p) if p >= 70 => TintColor::Orange,
        Some(_) => TintColor::Blue,
    }
}

/// Windows hover tooltip: the app name plus the same status line the
/// macOS menu-bar title and the tray menu show, single-sourced through
/// `format_status_text`. Colon separator on purpose: UI copy avoids em
/// dashes project-wide.
#[cfg(target_os = "windows")]
fn format_tooltip(state: &TrayState, pct: Option<u8>) -> String {
    let status = format_status_text(state, pct);
    if status == "Claude Sentinel" {
        status
    } else {
        format!("Claude Sentinel: {status}")
    }
}

fn format_status_text(state: &TrayState, pct: Option<u8>) -> String {
    let pct_str = match pct {
        Some(p) => format!("{p}%"),
        None => "—".to_string(),
    };
    match state.switching_mode {
        SwitchingMode::RoundRobin => {
            // Count only rotating members so the "pool" label agrees with
            // the percentage (which is already filtered). An excluded- or
            // paused-only view shows "Claude Sentinel" rather than a stale
            // pool count.
            let pool_size = state
                .utilizations
                .keys()
                .filter(|k| !state.pool_excluded_ids.contains(*k) && !state.paused_ids.contains(*k))
                .count();
            if pool_size == 0 {
                "Claude Sentinel".to_string()
            } else {
                format!("Round-robin pool · {pct_str}")
            }
        }
        SwitchingMode::Off => match &state.active_email {
            Some(email) => format!("{email} · {pct_str}"),
            None => "Claude Sentinel".to_string(),
        },
    }
}

/// Mirrors `fiveHourUtilization` in `packages/app/src/hooks/useAllRateLimits.ts`:
/// find the `unified-5h` window, use `utilization` if set, else derive from
/// `(limit - remaining) / limit` for API-key plans. Returns `None` otherwise.
fn extract_5h_util(windows_json: &Value) -> Option<f32> {
    let arr = windows_json.as_array()?;
    let w = arr
        .iter()
        .find(|w| w.get("name").and_then(Value::as_str) == Some("unified-5h"))?;

    if let Some(util) = w.get("utilization").and_then(Value::as_f64) {
        return Some(util as f32);
    }
    let limit = w.get("limit").and_then(Value::as_f64)?;
    let remaining = w.get("remaining").and_then(Value::as_f64)?;
    if limit <= 0.0 {
        return None;
    }
    Some(((limit - remaining) / limit) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // compute_display and apply() depend on a live TrayState (icon/menu
    // handles need a real Tauri App). Tests below cover the pure helpers
    // directly; for compute_display the StateMirror struct mirrors the
    // exact branch logic so we can table-test it without a Tauri runtime.

    #[test]
    fn tint_for_thresholds() {
        assert_eq!(tint_for(None), TintColor::Gray);
        assert_eq!(tint_for(Some(0)), TintColor::Blue);
        assert_eq!(tint_for(Some(69)), TintColor::Blue);
        assert_eq!(tint_for(Some(70)), TintColor::Orange);
        assert_eq!(tint_for(Some(89)), TintColor::Orange);
        assert_eq!(tint_for(Some(90)), TintColor::Red);
        assert_eq!(tint_for(Some(100)), TintColor::Red);
    }

    #[test]
    fn to_pct_rounding_boundaries() {
        assert_eq!(to_pct(0.0), 0);
        assert_eq!(to_pct(0.694), 69);
        assert_eq!(to_pct(0.695), 70); // round-half-to-even on .5 in f32; in practice 0.695*100 = 69.5 → 70
        assert_eq!(to_pct(0.894), 89);
        assert_eq!(to_pct(0.896), 90);
        assert_eq!(to_pct(0.996), 100);
        assert_eq!(to_pct(1.0), 100);
        assert_eq!(to_pct(1.5), 100); // clamped
    }

    #[test]
    fn extract_5h_util_from_subscription_plan() {
        let json = json!([
            {"name": "unified-7d", "utilization": 0.1},
            {"name": "unified-5h", "utilization": 0.42}
        ]);
        assert_eq!(extract_5h_util(&json), Some(0.42));
    }

    #[test]
    fn extract_5h_util_from_api_key_plan() {
        let json = json!([
            {"name": "unified-5h", "utilization": null, "limit": 1000.0, "remaining": 250.0}
        ]);
        let got = extract_5h_util(&json).unwrap();
        assert!((got - 0.75).abs() < 1e-6, "got {got}");
    }

    #[test]
    fn extract_5h_util_returns_none_when_missing() {
        let json = json!([{"name": "unified-7d", "utilization": 0.1}]);
        assert_eq!(extract_5h_util(&json), None);
        assert_eq!(extract_5h_util(&json!([])), None);
        assert_eq!(extract_5h_util(&json!(null)), None);
    }

    /// Table-driven compute_display test using a lightweight struct mirror
    /// to avoid constructing a real TrayState (which needs a Tauri App).
    struct StateMirror {
        switching_mode: SwitchingMode,
        active_id: Option<String>,
        utilizations: HashMap<String, Option<f32>>,
        pool_excluded_ids: HashSet<String>,
        paused_ids: HashSet<String>,
    }

    impl StateMirror {
        fn empty(mode: SwitchingMode) -> Self {
            StateMirror {
                switching_mode: mode,
                active_id: None,
                utilizations: HashMap::new(),
                pool_excluded_ids: HashSet::new(),
                paused_ids: HashSet::new(),
            }
        }
    }

    fn compute_mirror(s: &StateMirror) -> Option<u8> {
        // Inlined copy of compute_display's logic against StateMirror.
        match s.switching_mode {
            SwitchingMode::RoundRobin => {
                let known: Vec<f32> = s
                    .utilizations
                    .iter()
                    .filter(|(id, _)| {
                        !s.pool_excluded_ids.contains(*id) && !s.paused_ids.contains(*id)
                    })
                    .filter_map(|(_, v)| *v)
                    .collect();
                if known.is_empty() {
                    return None;
                }
                let mean = known.iter().sum::<f32>() / known.len() as f32;
                Some(to_pct(mean))
            }
            SwitchingMode::Off => {
                let id = s.active_id.as_deref()?;
                let util = (*s.utilizations.get(id)?)?;
                Some(to_pct(util))
            }
        }
    }

    #[test]
    fn compute_display_empty_returns_none() {
        let s = StateMirror::empty(SwitchingMode::Off);
        assert_eq!(compute_mirror(&s), None);
    }

    #[test]
    fn compute_display_active_account() {
        let mut s = StateMirror::empty(SwitchingMode::Off);
        s.utilizations.insert("acct-a".to_string(), Some(0.423));
        s.active_id = Some("acct-a".to_string());
        assert_eq!(compute_mirror(&s), Some(42));
    }

    #[test]
    fn compute_display_active_account_null_util_returns_none() {
        let mut s = StateMirror::empty(SwitchingMode::Off);
        s.utilizations.insert("acct-a".to_string(), None);
        s.active_id = Some("acct-a".to_string());
        assert_eq!(compute_mirror(&s), None);
    }

    #[test]
    fn compute_display_round_robin_mean() {
        let mut s = StateMirror::empty(SwitchingMode::RoundRobin);
        s.utilizations.insert("a".to_string(), Some(0.50));
        s.utilizations.insert("b".to_string(), Some(0.90));
        s.utilizations.insert("c".to_string(), None); // skipped
        s.active_id = Some("a".to_string());
        // mean of 0.50 and 0.90 = 0.70 → 70
        assert_eq!(compute_mirror(&s), Some(70));
    }

    #[test]
    fn compute_display_round_robin_excludes_pool_excluded_ids() {
        // Reproduces the bug: user has two accounts at 12% and 100%; the
        // 100%-util one is excluded from round-robin. Pre-fix this showed
        // 56% (the mean); post-fix it shows 12%.
        let mut s = StateMirror::empty(SwitchingMode::RoundRobin);
        s.utilizations.insert("rotating".to_string(), Some(0.12));
        s.utilizations.insert("excluded".to_string(), Some(1.00));
        s.pool_excluded_ids.insert("excluded".to_string());
        assert_eq!(compute_mirror(&s), Some(12));
    }

    #[test]
    fn compute_display_round_robin_all_excluded_returns_none() {
        let mut s = StateMirror::empty(SwitchingMode::RoundRobin);
        s.utilizations.insert("a".to_string(), Some(0.5));
        s.utilizations.insert("b".to_string(), Some(0.8));
        s.pool_excluded_ids.insert("a".to_string());
        s.pool_excluded_ids.insert("b".to_string());
        assert_eq!(compute_mirror(&s), None);
    }

    #[test]
    fn compute_display_round_robin_all_null_returns_none() {
        let mut s = StateMirror::empty(SwitchingMode::RoundRobin);
        s.utilizations.insert("a".to_string(), None);
        s.utilizations.insert("b".to_string(), None);
        assert_eq!(compute_mirror(&s), None);
    }

    #[test]
    fn switching_mode_from_str() {
        assert_eq!(SwitchingMode::from_str("off"), SwitchingMode::Off);
        assert_eq!(
            SwitchingMode::from_str("round-robin"),
            SwitchingMode::RoundRobin
        );
        assert_eq!(SwitchingMode::from_str("garbage"), SwitchingMode::Off);
    }

    #[test]
    fn compute_display_round_robin_excludes_paused_ids() {
        // A weekly-capped account stays at 100% util but stops rotating —
        // including it in the pool mean made the tray % look way worse than
        // the accounts the user could actually use. Filter same as
        // pool_excluded_ids: 12% + 100% (paused) → 12%, not 56%.
        let mut s = StateMirror::empty(SwitchingMode::RoundRobin);
        s.utilizations.insert("rotating".to_string(), Some(0.12));
        s.utilizations.insert("paused".to_string(), Some(1.00));
        s.paused_ids.insert("paused".to_string());
        assert_eq!(compute_mirror(&s), Some(12));
    }

    #[test]
    fn compute_display_round_robin_excludes_pool_excluded_and_paused() {
        // Both filters apply: only the lone rotating account contributes.
        let mut s = StateMirror::empty(SwitchingMode::RoundRobin);
        s.utilizations.insert("rotating".to_string(), Some(0.30));
        s.utilizations.insert("manual_excl".to_string(), Some(0.95));
        s.utilizations.insert("paused".to_string(), Some(1.00));
        s.pool_excluded_ids.insert("manual_excl".to_string());
        s.paused_ids.insert("paused".to_string());
        assert_eq!(compute_mirror(&s), Some(30));
    }

    #[test]
    fn compute_display_round_robin_all_paused_returns_none() {
        // If every known account is paused there's nothing to display.
        // Mirrors the all-excluded case so the icon goes gray rather than
        // showing an arbitrary number from a stale value.
        let mut s = StateMirror::empty(SwitchingMode::RoundRobin);
        s.utilizations.insert("a".to_string(), Some(0.5));
        s.utilizations.insert("b".to_string(), Some(0.8));
        s.paused_ids.insert("a".to_string());
        s.paused_ids.insert("b".to_string());
        assert_eq!(compute_mirror(&s), None);
    }

    #[test]
    fn apply_paused_accounts_replaces_state() {
        // The IPC payload shape: array of objects with accountId. Reason
        // and resetsAt are present in the daemon response but the tray
        // doesn't need them — only the id set drives filtering.
        let mut s = StateMirror::empty(SwitchingMode::RoundRobin);
        s.paused_ids.insert("stale".to_string());
        // Inline the parse logic (apply_paused_accounts is on TrayState
        // proper, not StateMirror — but the contract is "replace").
        let payload = json!([
            { "accountId": "fresh-a", "reason": "sentinel_weekly_rate_limit", "resetsAt": 1 },
            { "accountId": "fresh-b", "reason": "sentinel_budget", "resetsAt": null },
        ]);
        s.paused_ids = payload
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| {
                v.get("accountId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .collect();
        assert!(!s.paused_ids.contains("stale"));
        assert!(s.paused_ids.contains("fresh-a"));
        assert!(s.paused_ids.contains("fresh-b"));
    }
}
