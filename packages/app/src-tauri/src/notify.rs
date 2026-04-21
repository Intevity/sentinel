// All NSUserNotification / NSUserNotificationCenter API is deprecated
// by Apple in favour of UserNotifications.framework. We're intentionally
// still on the old API for now (see the `Limitation documented` note
// below) — silence the deprecation noise at the module boundary so
// real warnings aren't lost in the flood.
#![allow(deprecated)]

// Native macOS notification bridge for security events.
//
// Why this file exists in the shape it does:
//
// We previously used `mac-notification-sys` 0.6, which allocated a
// fresh `NotificationCenterDelegate` per `.send()` and installed it as
// the shared `NSUserNotificationCenter`'s unretained delegate. That
// crate's own source even admits it can't explain the resulting
// crashes (`notify.m:145-146`: *"prevents crash described in #64, the
// underlying issue is not yet understood"*). On our side we saw a hard
// segfault in `objc_release` inside `didActivateNotification:` after
// two back-to-back security notifications — a use-after-free on a
// prior call's `actionData` dictionary.
//
// Replacement design:
//
//   - One persistent `NotificationDelegate` installed once at app
//     startup and deliberately leaked (`mem::forget`) so it lives for
//     the entire process — the shared `NSUserNotificationCenter`'s
//     `delegate` slot is unretained, so we need to own the only strong
//     reference ourselves and hold it forever.
//   - Notifications carry only a "Details" affordance: tapping the
//     button or the banner body brings the tray window forward and
//     (when the broadcast supplied one) emits a
//     `security_notification_details` event carrying the persisted
//     event row id so the frontend can scroll to it. Approve / Deny
//     live exclusively in the in-app `PendingBlockBanner`, which is
//     the authoritative UI and avoids NSUserNotification's limitation
//     that `otherButtonTitle` dismissal never fires the delegate.
//   - No thread-per-notification. `deliverNotification:` returns
//     immediately; the OS schedules the banner, and a click fires the
//     delegate on the main thread where the stored `AppHandle` can
//     safely `emit` and `show()`+`set_focus()` the tray window.
//
// Two details below that look weird but are load-bearing for reliable
// banner presentation on macOS 26:
//
//   - Every notification gets a unique `identifier` (monotonic
//     counter). Without it, macOS has been observed to silently
//     replace the current banner in-place instead of surfacing a new
//     one when a second notification arrives quickly after the first.
//   - We set the private `_showsButtons` KVC key to YES. This is what
//     `mac-notification-sys` did via `[notification setValue:@YES
//     forKey:@"_showsButtons"]`, and we need it too: on alert-style
//     AND banner-style presentations, the action button only renders
//     when this undocumented key is set. Without it, the "Details"
//     affordance is missing and the banner has been observed to
//     coalesce with the previous one.
//
// NSUserNotification is formally deprecated by Apple in favour of
// `UNUserNotificationCenter`, but it still works on macOS 26 and is
// what Tauri's own notification plugin uses underneath. Migrating is a
// larger change (bundle-identity entitlements, permission prompts,
// category registration) — acceptable follow-up, not this fix.
//
// Diagnostics: every delivery and every delegate callback writes a
// line to `~/.claude-sentinel/app.log`. The daemon sidecar already
// writes to `daemon.log` alongside, so having the Tauri app emit its
// own file keeps the two streams separable while letting us correlate
// broadcasts (daemon) with notification-posts (app) during a
// reproduction.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::ProtocolObject;
#[cfg(target_os = "macos")]
use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
#[cfg(target_os = "macos")]
use objc2_foundation::{
    NSDictionary, NSNumber, NSObject, NSObjectProtocol, NSString, NSUserNotification,
    NSUserNotificationActivationType, NSUserNotificationCenter,
    NSUserNotificationCenterDelegate,
};

/// Right-hand action on every security banner. Tapping it and tapping
/// the banner body both bring the app forward and (when an `event_id`
/// was supplied) scroll to the matching Security-tab row.
const DETAILS_LABEL: &str = "Details";

/// Event fired when the user clicks a notification body or the Details
/// button on one with an `event_id`. Payload: `{ eventId: number }`.
/// Frontend routes this to the Security tab with the matching row
/// auto-expanded.
const DETAILS_EVENT: &str = "security_notification_details";

/// Sole userInfo key we read back in the delegate. Stored as a decimal
/// NSString and parsed in `read_user_info_i64` — avoids an NSNumber
/// bridge for a single optional integer.
const USER_INFO_EVENT_ID: &str = "eventId";

/// Handle to the Tauri app, stashed so the delegate (which has no
/// per-instance state) can reach back into the runtime when a click
/// fires on the main thread. Written exactly once by `init`.
static APP_HANDLE: OnceLock<AppHandle<Wry>> = OnceLock::new();

/// Monotonic counter → unique `NSUserNotification.identifier` per post.
/// Starts at 1 so log lines and identifier strings don't look empty on
/// the first delivery.
static NOTIFICATION_SEQ: AtomicU64 = AtomicU64::new(1);

// The delegate instance itself is MainThreadOnly (and therefore
// !Send+!Sync), so it cannot live in a plain `static`. We don't need
// Rust-side access after installation anyway — once set on the shared
// `NSUserNotificationCenter`, AppKit drives it from the main thread on
// every click. We use `mem::forget` to give it a process-long lifetime
// (the center's delegate slot is unretained) and rely on
// `APP_HANDLE.set(..)` returning `Err` as the "already initialised"
// gate.

#[cfg(target_os = "macos")]
define_class!(
    // SAFETY:
    // - NSObject has no subclassing requirements.
    // - `NotificationDelegate` does not implement `Drop` and holds no
    //   Rust ivars (the `AppHandle` lives in the `APP_HANDLE`
    //   OnceLock), so the compiler-synthesised dealloc is fine.
    // - The delegate is only used on the main thread — macOS dispatches
    //   `didActivateNotification:` via the main dispatch queue (see
    //   `_NSConcreteUserNotificationCenter _notificationClickedMessage:`
    //   in the prior crash trace). Tagging MainThreadOnly makes objc2
    //   enforce that at the type level.
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[name = "ClaudeSentinelNotificationDelegate"]
    struct NotificationDelegate;

    // SAFETY: NSObjectProtocol has no additional requirements.
    unsafe impl NSObjectProtocol for NotificationDelegate {}

    // SAFETY: Method signatures match the NSUserNotificationCenterDelegate
    // protocol; each method runs on the main thread per AppKit's
    // contract for notification-center callbacks.
    unsafe impl NSUserNotificationCenterDelegate for NotificationDelegate {
        /// Force-present banners even when our app is frontmost.
        /// Default macOS behaviour suppresses them, which hides the
        /// security-block UX the user is relying on — especially
        /// after the first click brings Sentinel to the front and the
        /// second notification would otherwise be swallowed.
        #[unsafe(method(userNotificationCenter:shouldPresentNotification:))]
        fn should_present(
            &self,
            _center: &NSUserNotificationCenter,
            notification: &NSUserNotification,
        ) -> bool {
            diag_log(&format!(
                "shouldPresent called id={} title={:?}",
                identifier_of(notification).unwrap_or_default(),
                notification.title().map(|s| s.to_string()).unwrap_or_default(),
            ));
            true
        }

        /// Called on click. We don't touch any ivars here — all state
        /// is carried on the notification's own `userInfo`, which is
        /// retained by the notification itself, so there's no
        /// cross-call lifetime for Objective-C to get wrong.
        #[unsafe(method(userNotificationCenter:didActivateNotification:))]
        fn did_activate(
            &self,
            center: &NSUserNotificationCenter,
            notification: &NSUserNotification,
        ) {
            let activation = notification.activationType();
            let id = identifier_of(notification).unwrap_or_default();
            diag_log(&format!(
                "didActivate id={} activation={:?}",
                id, activation,
            ));
            match activation {
                NSUserNotificationActivationType::ActionButtonClicked
                | NSUserNotificationActivationType::ContentsClicked => {
                    // Always bring the window forward — "click a
                    // Sentinel banner, see the app" is the whole UX
                    // contract.
                    show_main_window();
                    // Only emit the deep-link event when the
                    // broadcast carried a row id; pending-block
                    // notifications omit it (the row isn't persisted
                    // until resolve) and rely on the in-app banner
                    // being visible on arrival.
                    if let Some(row_id) = read_user_info_i64(notification, USER_INFO_EVENT_ID) {
                        emit_details(row_id);
                    }
                    // Remove the delivered notification proactively
                    // — on macOS 26 leftover delivered items have
                    // been observed to interfere with subsequent
                    // banners.
                    center.removeDeliveredNotification(notification);
                }
                _ => {}
            }
        }
    }
);

#[cfg(target_os = "macos")]
impl NotificationDelegate {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        // `set_ivars(())` is the objc2 boilerplate for a class that
        // declares no custom ivars — it transitions the allocated
        // object into the "ivars initialised" state that `init` wants.
        let this = Self::alloc(mtm).set_ivars(());
        // SAFETY: NSObject's `init` signature is nullary -> Retained<Self>.
        unsafe { msg_send![super(this), init] }
    }
}

/// Display a security-event OS notification. Always renders with a
/// "Details" action button. Tapping the button or the banner body
/// brings the tray window forward; when `event_id` is supplied, it
/// also fires `security_notification_details` so the frontend can
/// scroll to the matching Security-tab row.
#[tauri::command]
pub fn display_os_notification<R: Runtime>(
    app: AppHandle<R>,
    title: String,
    body: String,
    event_id: Option<i64>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app; // click handler reuses the handle stashed by `init`
        match MainThreadMarker::new() {
            Some(mtm) => {
                deliver_notification(mtm, &title, &body, event_id);
                Ok(())
            }
            None => {
                // Tauri commands invoked from the frontend dispatch onto
                // the main thread, so this branch shouldn't hit in
                // practice. If it ever does (e.g. a future
                // `#[tauri::command(async)]`), surface the error rather
                // than silently mis-routing.
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

/// One-time setup called from `main.rs` `.setup(|app| { .. })` on
/// macOS: stashes the `AppHandle` so delegate callbacks can reach back
/// into Tauri, and installs the persistent delegate on the shared
/// `NSUserNotificationCenter`. Safe to call more than once; second
/// and later calls are no-ops.
pub fn init(app: &AppHandle<Wry>) {
    // Use `APP_HANDLE.set()` as the idempotency gate — if it returns
    // Err the first call already did its work and we should leave the
    // existing delegate in place (leaking a second one on every call
    // would be a slow drip).
    if APP_HANDLE.set(app.clone()).is_err() {
        return;
    }

    diag_log("notify::init called");

    #[cfg(target_os = "macos")]
    {
        // `init` is invoked from Tauri's setup closure on the main
        // thread, so this should always succeed. Bail silently if
        // not; the worst case is notifications without click routing,
        // not a crash.
        let mtm = match MainThreadMarker::new() {
            Some(mtm) => mtm,
            None => {
                diag_log("notify::init not on main thread — delegate NOT installed");
                return;
            }
        };

        // `NSUserNotificationCenter.defaultUserNotificationCenter` is
        // a process-wide singleton, and its `delegate` slot is
        // unretained. We deliberately leak the delegate: the only
        // sensible lifetime for it is "as long as AppKit might send
        // notification events" = the entire process. `mem::forget`
        // leaves the object at refcount ≥ 1 forever, so the center's
        // raw pointer is valid until the process exits.
        let delegate = NotificationDelegate::new(mtm);
        let center = NSUserNotificationCenter::defaultUserNotificationCenter();
        let protocol = ProtocolObject::from_ref(&*delegate);
        // SAFETY: `delegate` is leaked below, outliving any use.
        unsafe { center.setDelegate(Some(protocol)) };
        std::mem::forget(delegate);
        diag_log("notify::init delegate installed");
    }
}

/// Historical shim retained so `main.rs` doesn't need to know the
/// difference between the old crate's bundle-swizzle and our native
/// path. Now a no-op: since our delegate and `deliverNotification:`
/// both run on the main thread inside the real application bundle,
/// `NSUserNotificationCenter` already attributes notifications to our
/// own bundle id. No private-API `NSBundle` override needed.
#[allow(unused_variables)]
pub fn init_notification_bundle(bundle_id: &str) {}

#[cfg(target_os = "macos")]
fn deliver_notification(
    _mtm: MainThreadMarker,
    title: &str,
    body: &str,
    event_id: Option<i64>,
) {
    let seq = NOTIFICATION_SEQ.fetch_add(1, Ordering::Relaxed);
    let identifier = format!("sentinel-notif-{seq}");

    let notification = NSUserNotification::new();
    notification.setIdentifier(Some(&NSString::from_str(&identifier)));
    notification.setTitle(Some(&NSString::from_str(title)));
    notification.setInformativeText(Some(&NSString::from_str(body)));
    notification.setHasActionButton(true);
    notification.setActionButtonTitle(&NSString::from_str(DETAILS_LABEL));

    // Private KVC: forces the action button to actually render on the
    // banner. Without this, macOS renders a stripped-down banner that
    // has been observed to coalesce with subsequent notifications
    // (second banner "doesn't appear"). See the module comment.
    unsafe { set_private_shows_buttons(&notification) };

    if let Some(id) = event_id {
        // userInfo is only needed for the deep-link case. Skipping it
        // when absent keeps the pending-block banner payload
        // dictionary-free.
        let key = NSString::from_str(USER_INFO_EVENT_ID);
        let value = NSString::from_str(&id.to_string());
        let keys: [&NSString; 1] = [&key];
        let values: [&NSString; 1] = [&value];
        let user_info =
            NSDictionary::<NSString, NSString>::from_slices(&keys, &values);
        // SAFETY: The `Value` generic on NSDictionary is a phantom
        // type — every NSDictionary has the same runtime layout
        // regardless. We cast NSString to AnyObject (its supertype)
        // to match `setUserInfo`'s declared generic. `setUserInfo:`
        // copies the dictionary, so the Retained going out of scope
        // after the call is safe.
        let user_info_any: Retained<NSDictionary<NSString, objc2::runtime::AnyObject>> =
            unsafe { Retained::cast_unchecked(user_info) };
        unsafe { notification.setUserInfo(Some(&user_info_any)) };
    }

    let center = NSUserNotificationCenter::defaultUserNotificationCenter();
    center.deliverNotification(&notification);

    diag_log(&format!(
        "delivered id={} title={:?} event_id={:?}",
        identifier, title, event_id,
    ));
}

/// SAFETY: calls `[notification setValue:@YES forKey:@"_showsButtons"]`
/// via the Objective-C runtime. `_showsButtons` is a private KVC key
/// on NSUserNotification; passing an NSNumber for a BOOL-valued key
/// is the standard bridging pattern and matches what
/// `mac-notification-sys` did on the same class.
#[cfg(target_os = "macos")]
unsafe fn set_private_shows_buttons(notification: &NSUserNotification) {
    let key = NSString::from_str("_showsButtons");
    let yes = NSNumber::numberWithBool(true);
    let _: () = unsafe { msg_send![notification, setValue: &*yes, forKey: &*key] };
}

#[cfg(target_os = "macos")]
fn identifier_of(notification: &NSUserNotification) -> Option<String> {
    notification.identifier().map(|s| s.to_string())
}

#[cfg(target_os = "macos")]
fn read_user_info_i64(notification: &NSUserNotification, key: &str) -> Option<i64> {
    let info = notification.userInfo()?;
    let ns_key = NSString::from_str(key);
    let value = info.objectForKey(&ns_key)?;
    // SAFETY: We only insert NSString values in `deliver_notification`,
    // and `NSUserNotification` copies the dictionary on set — nothing
    // else can swap in non-NSString values for the keys we read.
    let as_ns: &NSString = unsafe { &*(&*value as *const _ as *const NSString) };
    as_ns.to_string().parse::<i64>().ok()
}

fn show_main_window() {
    if let Some(app) = APP_HANDLE.get() {
        // LSUIElement tray apps stay hidden until we explicitly bring
        // the window forward — same routine the tray menu click uses
        // in `tray.rs`.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn emit_details(event_id: i64) {
    if let Some(app) = APP_HANDLE.get() {
        let payload = serde_json::json!({ "eventId": event_id });
        let _ = app.emit(DETAILS_EVENT, payload);
    }
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

/// Cheap ISO-ish timestamp without pulling in `chrono`. Goes down to
/// seconds — plenty for correlating with `daemon.log` and system
/// `log stream` output.
fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Format as HH:MM:SS against UTC — good enough for a log file
    // that is only read while triaging a specific session. Full date
    // is omitted on purpose; the daemon log already starts with one.
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{h:02}:{m:02}:{s:02}")
}
