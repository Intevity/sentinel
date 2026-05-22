// All NSUserNotification / NSUserNotificationCenter API is deprecated
// by Apple in favour of UserNotifications.framework. We're intentionally
// still on the old API — see the Architecture block below — so silence
// the deprecation noise at the module boundary.
#![allow(deprecated)]

// Native macOS notification bridge for security events.
//
// Three iterations shipped; here's why the current one looks like it does:
//
//   1. `mac-notification-sys` 0.6 — crashed on click in `objc_release`
//      inside the crate's internal delegate (notify.m:145 even admits
//      "the underlying issue is not yet understood"). Replaced.
//   2. Our own `NSUserNotificationCenterDelegate` on top of `objc2` —
//      banners delivered reliably, but on macOS 26 Apple has
//      effectively hollowed out the deprecated delegate callback path.
//      `didActivateNotification:` and `shouldPresentNotification:`
//      never fire. Verified across ~30 deliveries: zero callbacks
//      observed in `app.log`.
//   3. Migrated to `UNUserNotificationCenter` — correct API, but
//      `requestAuthorization` returns `NotificationsNotAllowed` on
//      our ad-hoc-signed bundle (`codesign` shows Identifier=
//      `claude_sentinel-<hash>`, not the bundle id, and Info.plist is
//      not bound to the signature). Fixing that means reworking
//      Tauri's signing pipeline — a larger, separate piece of work.
//
// This iteration keeps `NSUserNotification` for *delivery* (the one
// thing that reliably works on macOS 26 without auth) and routes
// clicks via an *app-activation side channel* instead of the dead
// delegate callback: when we post a notification carrying a
// Security-tab row id, we stash it in `LAST_NOTIF_EVENT`. macOS's
// own bundle-attribution logic brings our app forward on any
// notification click (banner body, Details button, or NC entry);
// Tauri's main window fires `WindowEvent::Focused(true)` as a
// consequence. `main.rs`'s `on_window_event` handler consumes the
// stashed id and emits `security_notification_details`, the same
// frontend event the (now dead) delegate used to emit. Net effect:
// identical UX, without needing the delegate callback to fire.
//
// Trade-offs documented for future readers:
//
//   - "Details" as a button label is no longer special. Clicking the
//     button and clicking the banner body do the same thing (activate
//     the app + route to the stashed eventId). We still render the
//     button because it nudges the user that the notification is
//     actionable, and because the private `_showsButtons` KVC key
//     ensures macOS presents the richer banner layout that includes
//     it.
//   - The routing is "most recently posted within window". If three
//     security events fire in a row and the user clicks the OLDEST
//     one from Notification Center, they still land on the NEWEST —
//     because we can't tell which notification the activation came
//     from. In practice the rapid-fire case is rare; the common case
//     is a single notification clicked within seconds.
//   - If the user manually cmd-tabs to the app within the post
//     window (default 12s), they also get auto-routed to the most
//     recent security row. Arguably fine: if you're activating the
//     app right after we notified you, you were probably reacting to
//     the notification.
//
// The monotonic `identifier` and `_showsButtons` private-KVC tweaks
// are retained from iteration (2) — both were empirically load-
// bearing for reliable banner presentation on macOS 26.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};

#[cfg(target_os = "macos")]
use std::ptr::NonNull;

#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::{msg_send, MainThreadMarker};
#[cfg(target_os = "macos")]
use objc2_app_kit::NSApplicationDidBecomeActiveNotification;
#[cfg(target_os = "macos")]
use objc2_foundation::{
    NSDictionary, NSNotification, NSNotificationCenter, NSNumber, NSString, NSUserNotification,
    NSUserNotificationCenter,
};

/// Right-hand action on every security banner. We still render it
/// because it surfaces the "this is actionable" affordance and, in
/// combination with `_showsButtons`, makes macOS present the richer
/// alert layout. Clicking it does the same thing as clicking the
/// banner body: activates our app, which routes via the consume-on-
/// focus path in `main.rs`.
const DETAILS_LABEL: &str = "Details";

/// Event fired when a security notification's click activates our
/// app and we have a stashed event id. Payload: `{ eventId: number }`.
/// Frontend routes this to the Security tab and auto-expands the
/// matching row.
const DETAILS_EVENT: &str = "security_notification_details";

/// How long after posting a notification a window-activation counts
/// as a "click that belongs to that notification". Long enough to
/// cover the user tapping a banner that's fading out; short enough
/// that a much-later cmd-tab into the app doesn't accidentally
/// auto-route.
const ACTIVATION_ROUTE_WINDOW: Duration = Duration::from_secs(12);

/// Handle to the Tauri app, stashed so any non-main-thread future
/// code that wants to emit events can (currently unused; the
/// activation consumer lives in `main.rs` and gets its handle from
/// the Tauri event loop). Also the "already initialised" gate.
static APP_HANDLE: OnceLock<AppHandle<Wry>> = OnceLock::new();

/// Monotonic counter → unique `NSUserNotification.identifier` per
/// post. Without a unique identifier, macOS has been observed to
/// silently replace the current banner in-place instead of surfacing
/// a new one when a second notification arrives quickly after the
/// first.
static NOTIFICATION_SEQ: AtomicU64 = AtomicU64::new(1);

/// Most recently posted security-event row id + the instant of
/// posting. `main.rs`'s window-focus handler consumes this on any
/// activation inside `ACTIVATION_ROUTE_WINDOW`; anything older is
/// discarded so a stale post can't trigger on an unrelated
/// activation hours later.
static LAST_NOTIF_EVENT: Mutex<Option<(i64, Instant)>> = Mutex::new(None);

/// Display a security-event OS notification. Always renders with a
/// "Details" action button. When `event_id` is supplied, it's stashed
/// for the window-activation consumer in `main.rs`, which will emit
/// `security_notification_details` after the user clicks the banner
/// (any click path: button, body, or NC entry) and macOS brings our
/// app forward.
#[tauri::command]
pub fn display_os_notification<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: String,
    event_id: Option<i64>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app; // activation routing uses the handle stashed in `init`
        match MainThreadMarker::new() {
            Some(_) => {
                deliver_notification(&title, &body, event_id);
                Ok(())
            }
            None => {
                // Tauri commands invoked from the frontend dispatch onto
                // the main thread, so this shouldn't hit in practice.
                // If it ever does (e.g. a future
                // `#[tauri::command(async)]`), surface the error
                // rather than silently mis-routing.
                diag_log("display_os_notification called off main thread — rejecting");
                Err("display_os_notification must be called on the main thread".into())
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, title, body, event_id);
        Ok(())
    }
}

/// One-time setup. Stashes the `AppHandle` for the activation-route
/// helpers and installs an `NSApplicationDidBecomeActiveNotification`
/// observer so we also route when the user clicks a notification
/// while the tray window is hidden (the common tray-app state).
///
/// The main-window `WindowEvent::Focused(true)` handler in `main.rs`
/// catches clicks that arrive while the window is already visible;
/// this observer catches clicks that arrive while the window is
/// hidden. Both paths call `route_recent_event` so the behaviour is
/// identical in either state.
///
/// Safe to call more than once; second and later calls are no-ops
/// via `OnceLock::set` returning Err.
pub fn init(app: &AppHandle<Wry>) {
    if APP_HANDLE.set(app.clone()).is_err() {
        return;
    }
    diag_log("notify::init called (NSUserNotification delivery + activation-route clicks)");

    #[cfg(target_os = "macos")]
    {
        if MainThreadMarker::new().is_none() {
            diag_log("notify::init not on main thread — activation observer NOT installed");
            return;
        }
        // SAFETY: the block only captures `&'static` references and
        // `'static` APP_HANDLE reads; it is Sync+Send-compatible for
        // the purposes of NSNotificationCenter which posts on the
        // main thread. We pass `None` for the queue, so the block
        // executes on the posting thread (the main thread for
        // NSApplicationDidBecomeActiveNotification).
        let block = RcBlock::new(|_notification: NonNull<NSNotification>| {
            diag_log("NSApplicationDidBecomeActive fired");
            route_recent_event();
        });
        let center = NSNotificationCenter::defaultCenter();
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSApplicationDidBecomeActiveNotification),
                None,
                None,
                &block,
            )
        };
        // Leak both the block and the returned observer handle so
        // the observer stays registered for the lifetime of the
        // process. Without the leak, both would drop at end of
        // scope and the notification center would auto-unregister
        // the observer.
        std::mem::forget(block);
        std::mem::forget(observer);
        diag_log("activation observer installed");
    }
}

/// Shared consume+emit used by both the main-window focus handler
/// (in `main.rs`) and the app-activation observer (above). Brings
/// the tray window forward and fires
/// `security_notification_details` with the most-recently stashed
/// event id, if any landed inside `ACTIVATION_ROUTE_WINDOW`. Safe to
/// call spuriously — returns quietly on cold state.
pub fn route_recent_event() {
    let Some(event_id) = consume_recent_event_id() else {
        return;
    };
    let Some(app) = APP_HANDLE.get() else {
        return;
    };
    // LSUIElement tray apps stay hidden by default — bring the
    // window forward so the emitted event lands on a visible tab.
    if let Some(window) = app.get_webview_window("main") {
        crate::activation::show_and_activate(&window);
    }
    let payload = serde_json::json!({ "eventId": event_id });
    let _ = app.emit(DETAILS_EVENT, payload);
}

/// Historical shim so call sites don't have to change when the
/// underlying notification backend shuffles. No-op: NSUserNotification
/// attributes to the hosting bundle without any private-API swizzle.
#[allow(unused_variables)]
pub fn init_notification_bundle(bundle_id: &str) {}

/// Consume the most recently posted security-event row id if it
/// landed inside `ACTIVATION_ROUTE_WINDOW`; clears the slot on hit
/// so a single click doesn't re-fire on back-to-back activations.
/// Only reachable via `route_recent_event` — the public surface
/// that both activation paths call.
fn consume_recent_event_id() -> Option<i64> {
    let mut slot = LAST_NOTIF_EVENT.lock().ok()?;
    let (id, posted_at) = slot.take()?;
    if posted_at.elapsed() <= ACTIVATION_ROUTE_WINDOW {
        diag_log(&format!(
            "consume_recent_event_id → routing event_id={id} (age={}ms)",
            posted_at.elapsed().as_millis(),
        ));
        Some(id)
    } else {
        diag_log(&format!(
            "consume_recent_event_id → discarded stale event_id={id} (age={}ms)",
            posted_at.elapsed().as_millis(),
        ));
        None
    }
}

#[cfg(target_os = "macos")]
fn deliver_notification(title: &str, body: &str, event_id: Option<i64>) {
    let seq = NOTIFICATION_SEQ.fetch_add(1, Ordering::Relaxed);
    let identifier = format!("sentinel-notif-{seq}");

    let notification = NSUserNotification::new();
    notification.setIdentifier(Some(&NSString::from_str(&identifier)));
    notification.setTitle(Some(&NSString::from_str(title)));
    notification.setInformativeText(Some(&NSString::from_str(body)));
    notification.setHasActionButton(true);
    notification.setActionButtonTitle(&NSString::from_str(DETAILS_LABEL));

    // Private KVC: forces the action button to render on the banner.
    // Without this, macOS renders a stripped-down banner that has
    // been observed to coalesce with subsequent notifications.
    unsafe { set_private_shows_buttons(&notification) };

    if let Some(id) = event_id {
        // Belt-and-suspenders: also attach the id as userInfo, so if
        // a future macOS release revives `didActivateNotification:`
        // (or a new API surfaces it), we can pick the id back up
        // without changing the notification-post call shape.
        let key = NSString::from_str("eventId");
        let value = NSString::from_str(&id.to_string());
        let keys: [&NSString; 1] = [&key];
        let values: [&NSString; 1] = [&value];
        let user_info = NSDictionary::<NSString, NSString>::from_slices(&keys, &values);
        // SAFETY: phantom-generic cast; NSDictionary runtime layout
        // is independent of its type parameters.
        let user_info_any: Retained<NSDictionary<NSString, objc2::runtime::AnyObject>> =
            unsafe { Retained::cast_unchecked(user_info) };
        unsafe { notification.setUserInfo(Some(&user_info_any)) };

        if let Ok(mut slot) = LAST_NOTIF_EVENT.lock() {
            *slot = Some((id, Instant::now()));
        }
    }

    let center = NSUserNotificationCenter::defaultUserNotificationCenter();
    center.deliverNotification(&notification);

    diag_log(&format!(
        "delivered id={identifier} title={title:?} event_id={event_id:?}"
    ));
}

/// SAFETY: calls `[notification setValue:@YES forKey:@"_showsButtons"]`
/// via the Objective-C runtime. `_showsButtons` is a private KVC key
/// on NSUserNotification that forces the action button to actually
/// render on the banner (rather than only on long-press / NC expand).
/// Matches what `mac-notification-sys` did on the same class.
#[cfg(target_os = "macos")]
unsafe fn set_private_shows_buttons(notification: &NSUserNotification) {
    let key = NSString::from_str("_showsButtons");
    let yes = NSNumber::numberWithBool(true);
    let _: () = unsafe { msg_send![notification, setValue: &*yes, forKey: &*key] };
}

/// Append a timestamped line to `~/.claude-sentinel/app.log`. Silently
/// drops on any I/O error — logging is best-effort and must never
/// break the UI path. The daemon logs to `daemon.log` in the same
/// directory; having a separate `app.log` here keeps the two streams
/// clearly attributable when diagnosing notification flow.
fn diag_log(msg: &str) {
    let Some(dir) = sentinel_dir() else { return };
    let path = dir.join("app.log");
    let ts = chrono_like_now();
    let line = format!("{ts} [notify] {msg}\n");
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

fn sentinel_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".claude-sentinel"))
}

/// Cheap HH:MM:SS timestamp without pulling in `chrono`. Enough for
/// correlating with `daemon.log` and system `log stream` output.
fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{h:02}:{m:02}:{s:02}")
}
