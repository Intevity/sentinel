/// Opens a Tauri WebviewWindow pointing at claude.ai, waits for the user to
/// log in, captures the sessionKey cookie from document.cookie via an
/// injected polling script, and forwards it to the daemon so the usage
/// fetcher can start hitting the Anthropic /api/organizations/{org}/usage
/// endpoint that returns real dollar spend + limit numbers.
///
/// Why not use Tauri's cookie-store API? WebView2 / wkwebview expose
/// HttpOnly cookies to the platform but NOT to `document.cookie`. Anthropic's
/// `sessionKey` cookie is explicitly NOT HttpOnly (it needs to be readable
/// from the claude.ai SPA) so `document.cookie` works reliably. Polling
/// keeps the implementation portable across macOS / Windows / Linux.
use serde::Deserialize;
use std::io::Write;
use std::sync::LazyLock;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::Mutex;

/// In-progress login state. Stores the Sentinel account id so the completion
/// callback can tie the captured cookie to the right account. Only one
/// login flow can be in-flight at a time — the UI should disable the
/// "Connect claude.ai" button while a window is open.
static PENDING: LazyLock<Mutex<Option<PendingLogin>>> = LazyLock::new(|| Mutex::new(None));

struct PendingLogin {
    account_id: String,
}

/// Label used for the login webview. One-at-a-time, so a fixed label is
/// sufficient — if the user clicks "Connect" again while a window is open,
/// we focus the existing one rather than spawn a second.
const LOGIN_WINDOW_LABEL: &str = "claude-ai-login";

/// Real-browser UA string for the login webview. Google's OAuth page
/// (accounts.google.com) fingerprints embedded webviews and rejects them
/// with "There was an error logging you in." The detection is heuristic,
/// but the single biggest signal is a user-agent that's missing the
/// trailing browser token ("Safari/605.1.15", "Edg/XXX", etc.) — Tauri's
/// default WKWebView / WebView2 UA on both macOS and Windows ships
/// without it, which is exactly the shape Google's filter looks for.
///
/// Our fix: claim to be whatever real browser matches the underlying
/// engine. WKWebView *is* the Safari engine, so a real Safari UA is
/// truthful, not a spoof — the JS runtime, canvas/WebGL fingerprints,
/// TLS signature, and client-hints behavior all match what real Safari
/// on macOS would produce. Cloudflare (claude.ai's front) accepts
/// Safari natively, so this doesn't re-introduce the bot-detection
/// problem that the old Chrome-UA spoof caused. On Windows, WebView2 is
/// Chromium/Edge-based, so an Edge UA is the analogous match.
///
/// macOS always reports as `10_15_7` in the UA for privacy (Apple froze
/// the OS-version field in Big Sur), which is why every real Safari UA
/// on any macOS 11+ reads identically here.
#[cfg(target_os = "macos")]
const LOGIN_WEBVIEW_UA: Option<&str> = Some(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
     (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
);
#[cfg(target_os = "windows")]
const LOGIN_WEBVIEW_UA: Option<&str> = Some(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
);
#[cfg(all(unix, not(target_os = "macos")))]
const LOGIN_WEBVIEW_UA: Option<&str> = None;

/// Runs at document-start inside the login webview. Two responsibilities:
///
/// 1. **Cookie polling.** Watches `document.cookie` every 500ms for a
///    `sessionKey=...` fragment and hands it off to the Rust-side
///    `complete_claude_ai_login` command the instant it appears. Idempotent
///    via the `sent` flag — subsequent ticks no-op until the Rust side
///    closes the window.
///
/// 2. **Minimal diagnostics.** UA string + any JS errors get logged to the
///    console so a user with DevTools open can paste them back if login
///    gets stuck.
///
/// UA choice history (why we're on Safari UA now):
///   - Default WKWebView UA (no override): Cloudflare accepts it, but
///     Google's OAuth page flags it as an embedded webview (the UA is
///     missing the trailing `Safari/605.1.15` token that real Safari
///     sends) and responds with "There was an error logging you in."
///   - Chrome UA spoof: Google was happier in isolation but Cloudflare's
///     managed-challenge JS validates that the claimed UA matches the
///     JS runtime. WKWebView exposes Safari APIs (no window.chrome, no
///     Sec-CH-UA client hints) — claiming Chrome produces a fingerprint
///     mismatch, Cloudflare returns a 403 challenge page, and the
///     webview renders blank white before ever reaching the login form.
///   - Real Safari UA (current): truthful match for the WKWebView
///     engine — same WebKit version, same JS runtime, same TLS
///     fingerprint, same (absence of) client hints. Cloudflare trusts
///     Safari natively, and Google's embedded-webview heuristic
///     typically accepts UAs that end in `Safari/605.1.15`.
/// Where the login webview's mirrored console ends up. Tail this in a
/// second terminal while reproducing a login bug and the full sequence
/// of URL transitions, console.log/warn/error, unhandled promise
/// rejections, and window.open intercepts scrolls by in order. Lives
/// alongside daemon.log so support instructions are symmetrical.
fn login_log_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home).join(".claude-sentinel/login-webview.log")
}

/// Block until the named window is no longer registered with Tauri
/// (or a timeout elapses). Used after `.destroy()` on a stale login
/// webview so we don't rebuild a new one with the same label while
/// WebKit is still tearing the old web process down — that race
/// produces a visible but empty window that never navigates.
/// Called on the main thread from #[tauri::command] handlers;
/// blocking briefly is fine because these handlers are only invoked
/// in response to a user click and the app is otherwise idle.
fn wait_for_window_gone(app: &AppHandle, label: &str) {
    // Poll at 20ms for up to 1s. On macOS in practice the window is
    // gone within 20-80ms of `.destroy()`. A 1s cap means we never
    // hang the IPC handler even if something went wrong — the
    // subsequent WebviewWindowBuilder call will surface the real
    // error in that case.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    while std::time::Instant::now() < deadline {
        if app.get_webview_window(label).is_none() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    append_login_log(&format!("[window-wait] timed out waiting for {} to tear down", label));
}

fn append_login_log(line: &str) {
    let path = login_log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        let _ = writeln!(f, "[{:.3}] {}", ts, line);
    }
}

const INIT_SCRIPT: &str = r#"
(function() {
  const INTERVAL_MS = 500;
  let sent = false;

  // Wrap window.open so the tick() cookie-capture path can close the
  // Google OAuth popup after login. Google's GSI SDK calls window.open
  // when the user clicks "Continue with Google"; we stash the native
  // popup handle the call returns so we can call `popup.close()` on
  // ourselves once sessionKey lands — Google's own storagerelay
  // postMessage flow expects the popup to self-close but wry's
  // NewWindowResponse::Allow path doesn't honor JS-side window.close
  // reliably on macOS WKWebView, leaving the user staring at a stuck
  // "One moment please" page.
  //
  // Timing: this IIFE runs via post-build eval in Rust, which lands in
  // the claude.ai/login document well before the user can click the
  // Google button (popup opens on user interaction, many seconds after
  // page load). The wrapper is installed in time even on the very first
  // Connect click. A prior attempt to install this at document-start
  // via initialization_script re-introduced the cold-WKWebView blank-
  // first-paint bug, so we accept the small theoretical race and stay
  // post-build.
  try {
    var origOpen = window.open;
    window.open = function() {
      var popup = origOpen.apply(window, arguments);
      try { window.__sentinelPopup = popup; } catch(e) {}
      return popup;
    };
  } catch(e) {}

  // We talk to Rust via Tauri *events*, not invoke(). App-defined
  // `#[tauri::command]` functions are only auto-granted to local
  // webviews; our login webview is marked remote (loads claude.ai), so
  // invoke() against a custom command gets rejected by ACL silently
  // inside its promise. Events are covered by core:event:allow-emit,
  // which our capability grants, so they work from remote webviews.
  function emitToRust(name, payload) {
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        // event:emit is a core plugin command, allowed by our ACL.
        // The backend expects payload as a string; we JSON.stringify
        // so the Rust-side listener gets a single unwrap to the struct.
        window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
          event: name,
          payload: JSON.stringify(payload),
        }).catch(function() {});
      }
    } catch (e) {}
  }

  function logToRust(level, args) {
    try {
      const parts = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a && typeof a === 'object') {
          try { parts.push(JSON.stringify(a)); } catch { parts.push(String(a)); }
        } else {
          parts.push(String(a));
        }
      }
      emitToRust('sentinel-login-log', {
        level: level,
        msg: parts.join(' '),
        url: window.location.href,
      });
    } catch (e) {}
  }
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.log = function() { logToRust('log', arguments); origLog.apply(console, arguments); };
  console.warn = function() { logToRust('warn', arguments); origWarn.apply(console, arguments); };
  console.error = function() { logToRust('error', arguments); origError.apply(console, arguments); };
  window.addEventListener('unhandledrejection', function(e) {
    const reason = e && e.reason;
    logToRust('unhandledrejection', [reason && reason.message ? reason.message : String(reason)]);
  });

  // Known cookie names that claude.ai uses for the web session. Primary
  // is `sessionKey`; if it's ever renamed or served via a different key
  // (some rollouts have shipped `lastActiveOrg` + `sessionKey-<hash>`),
  // the fallbacks prevent the poller from silently missing it. We only
  // match non-HttpOnly cookies because document.cookie can't read
  // HttpOnly ones.
  // claude.ai's session cookie has shipped under a few names. Current
  // production uses `sessionKeyLC` (suffix confirmed in live DevTools
  // output — meaning TBD, possibly "long-cached" or a rollout tag). The
  // bare `sessionKey` covers legacy deployments in case they roll back.
  // Order matters: `sessionKeyLC` must come before `sessionKey` so the
  // more specific prefix wins (both start with the same letters).
  const SESSION_KEY_CANDIDATES = ['sessionKeyLC', 'sessionKey', 'sessionkey', 'session_key', 'cl_sessionKey'];
  const extractSessionKey = () => {
    const raw = document.cookie || '';
    const parts = raw.split(';');
    for (const p of parts) {
      const trimmed = p.trim();
      for (const name of SESSION_KEY_CANDIDATES) {
        if (trimmed.startsWith(name + '=')) {
          return { name, value: trimmed.substring(name.length + 1) };
        }
      }
    }
    return null;
  };
  // Log every cookie name we can see on this page once per tick burst.
  // Lets us confirm what's in document.cookie when the poller isn't
  // finding what we expect. Only logs the NAMES, never the values —
  // values may contain secrets we don't want in a tail log.
  let cookiesLogged = false;
  const logCookieNames = () => {
    if (cookiesLogged) return;
    try {
      const raw = document.cookie || '';
      const names = raw.split(';')
        .map(p => p.trim().split('=')[0])
        .filter(Boolean);
      console.log('[Sentinel login] document.cookie names:', JSON.stringify(names));
      cookiesLogged = true;
    } catch (e) {}
  };
  const tick = () => {
    if (sent) return;
    logCookieNames();
    const found = extractSessionKey();
    if (!found) return;
    sent = true;
    // Close any Google OAuth popup the user opened via the "Continue with
    // Google" button. Google's GSI SDK usually self-closes the popup via
    // storagerelay postMessage, but native WKWebView popups created via
    // wry's NewWindowResponse::Allow don't honor that reliably — the user
    // ends up staring at a "One moment please" page long after login has
    // succeeded. The POPUP_TRACKER_SCRIPT installed at document-start saved
    // the popup handle on window.__sentinelPopup; use it here before we
    // tear down this webview.
    try {
      const p = window.__sentinelPopup;
      if (p && !p.closed) {
        console.log('[Sentinel login] closing tracked Google popup');
        p.close();
      }
    } catch(e) {}
    console.log('[Sentinel login] sessionKey captured (cookie=' + found.name + '), emitting to Rust');
    emitToRust('sentinel-login-session-key', { sessionKey: found.value });
  };
  // First check immediately — if we land already logged-in (existing
  // webview session from a prior Connect), we never show a visible login
  // form at all.
  tick();
  setInterval(tick, INTERVAL_MS);

  // Surface uncaught errors to the console so DevTools / the tail log
  // shows them in context.
  window.addEventListener('error', (e) => {
    console.warn('[Sentinel login] window error:', e.message, e.filename, e.lineno);
  });

  // NOTE: We deliberately do NOT patch window.open, window.opener, or any
  // cross-window message channel here. Earlier iterations did all of
  // those to try to emulate a real popup in JS — they didn't work
  // because Google's GSI v3 SDK detects synthesized opener objects via
  // cross-origin probes. The correct fix lives in Rust: the main
  // WebviewWindowBuilder in claude_ai_login.rs installs an
  // `on_new_window` handler that spawns a real Tauri popup window when
  // claude.ai's JS calls window.open(). wry wires that popup into
  // WebKit's WKUIDelegate so the popup has a native `window.opener`
  // pointing at this main webview, and Google's postMessage handoff
  // works natively. claude.ai's own page runs its own message listener
  // in this window, sets the sessionKey cookie on callback, and the
  // poller above picks it up.
  console.log('[Sentinel login] init script loaded. UA:', navigator.userAgent);
  console.log('[Sentinel login] initial URL:', window.location.href);
  window.addEventListener('DOMContentLoaded', () => {
    console.log('[Sentinel login] DOMContentLoaded at:', window.location.href);
  });
})();
"#;

// Popup init script was used during the Google-OAuth popup investigation
// but is no longer wired up — removed along with its `on_new_window`
// handler. Keeping the main LOGIN_INIT_SCRIPT (above) is sufficient since
// claude.ai's current OAuth flow stays in-window.
#[allow(dead_code)]
const _UNUSED_POPUP_INIT_SCRIPT: &str = r#"
(function() {
  // Same event-based log forwarding as the main webview. Lets us see
  // Google's console output + any errors that fire in the popup.
  function emitToRust(name, payload) {
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
          event: name,
          payload: JSON.stringify(payload),
        }).catch(function() {});
      }
    } catch (e) {}
  }
  function logToRust(level, args) {
    try {
      const parts = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a && typeof a === 'object') {
          try { parts.push(JSON.stringify(a)); } catch { parts.push(String(a)); }
        } else {
          parts.push(String(a));
        }
      }
      emitToRust('sentinel-login-log', {
        level: 'popup:' + level,
        msg: parts.join(' '),
        url: window.location.href,
      });
    } catch (e) {}
  }
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.log = function() { logToRust('log', arguments); origLog.apply(console, arguments); };
  console.warn = function() { logToRust('warn', arguments); origWarn.apply(console, arguments); };
  console.error = function() { logToRust('error', arguments); origError.apply(console, arguments); };
  window.addEventListener('unhandledrejection', function(e) {
    const reason = e && e.reason;
    logToRust('unhandledrejection', [reason && reason.message ? reason.message : String(reason)]);
  });

  // --- Diagnostic probe of window.opener ---
  // The hypothesis this test validates: WebKit sets a native cross-origin
  // opener relationship when wry returns our WKWebView from the parent's
  // UIDelegate `createWebViewWithConfiguration:`. If that worked, we'll
  // see opener-is-Window below. If wry didn't honor the delegate
  // contract (e.g. passed back a WKWebView with a different
  // configuration than the one WebKit offered), opener will be null.
  try {
    const ok = (typeof window.opener);
    let info = 'typeof=' + ok;
    if (window.opener) {
      info += ' isWindow=' + (window.opener === window.opener) /* always true if non-null */;
      try { info += ' originReadable=' + JSON.stringify(window.opener.origin); }
      catch (e) { info += ' originAccess_threw=' + (e.name || String(e)); }
      try { info += ' closedReadable=' + String(window.opener.closed); }
      catch (e) { info += ' closedAccess_threw=' + (e.name || String(e)); }
    }
    console.log('[Sentinel popup] window.opener:', info, 'url=' + window.location.href);
  } catch (e) {
    console.error('[Sentinel popup] opener probe threw:', e && e.message || String(e));
  }

  // Wrap postMessage on window.opener (if present) so we see every
  // payload Google tries to send back to the parent. Pass through
  // unchanged so Google's handoff proceeds normally. Only installed if
  // opener is a real Window; if our opener is null we have nothing to
  // wrap.
  try {
    if (window.opener && typeof window.opener.postMessage === 'function') {
      const origPostMessage = window.opener.postMessage.bind(window.opener);
      window.opener.postMessage = function(data, targetOrigin, transfer) {
        try {
          const ds = typeof data === 'string' ? data : JSON.stringify(data);
          console.log('[Sentinel popup] opener.postMessage ->', (ds || '').substring(0, 800), 'target=', targetOrigin);
        } catch (e) {}
        return origPostMessage(data, targetOrigin, transfer);
      };
    }
  } catch (e) {}

  console.log('[Sentinel popup] init script loaded. UA:', navigator.userAgent);
  window.addEventListener('DOMContentLoaded', () => {
    console.log('[Sentinel popup] DOMContentLoaded at:', window.location.href);
  });
})();
"#;

/// Start the claude.ai login flow. Opens a webview window pointing at the
/// claude.ai login page; the injected script detects the sessionKey cookie
/// and hands it back to us via the completion command.
#[tauri::command]
pub async fn start_claude_ai_login(app: AppHandle, account_id: String) -> Result<(), String> {
    append_login_log(&format!("=== start_claude_ai_login account={} ===", account_id));
    // If a prior login window still exists, tear it down rather than
    // focusing it. Focusing a stale window caused a subtle bug: after
    // Add Account → Remove Account → Add Account, the second Add's
    // auto-triggered Connect flow would land here, find the stale
    // `claude-ai-login` window, and focus it — but the window had a
    // blank WebKit view (the web process got into a degraded state
    // during the previous teardown), so the user saw an empty frame
    // with no way forward. Destroying and rebuilding gives a clean
    // WKWebView every time; the user-visible cost is ~50ms of
    // teardown before the fresh window appears.
    let mut pending = PENDING.lock().await;
    if let Some(existing) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        append_login_log("[claude-ai-login] destroying stale window before opening a new one");
        let _ = existing.destroy();
        wait_for_window_gone(&app, LOGIN_WINDOW_LABEL);
    }

    *pending = Some(PendingLogin { account_id });

    // Build the login webview. Reasonable size for an auth flow; the user
    // can resize. `data_directory` is left as default so cookies persist
    // across sessions — a returning user won't have to type their password
    // every time.
    let url: tauri::Url = "https://claude.ai/login"
        .parse()
        .map_err(|e| format!("bad url: {e}"))?;
    // Always enable devtools on the login webview. The login flow is the
    // only place we run against an opaque third-party auth UI (claude.ai +
    // its OAuth providers); when it misbehaves, a user with DevTools can
    // grab the failing request from the Network tab in one click. The
    // `devtools` feature is enabled on tauri in Cargo.toml so this works
    // in release builds too.
    let app_for_popup = app.clone();
    // No `.initialization_script(...)` — a document-start injection (even a
    // minimal one) races with claude.ai's SPA hydration on a cold WKWebView
    // and produces a blank first-paint regression. INIT_SCRIPT is installed
    // via post-build `window.eval(...)` below instead, mirroring what
    // `open_oauth_webview` does for the Add-Account flow.
    let mut builder = WebviewWindowBuilder::new(&app, LOGIN_WINDOW_LABEL, WebviewUrl::External(url))
        .title("Connect claude.ai")
        .inner_size(500.0, 860.0)
        .resizable(true)
        .devtools(true)
        // Every top-level navigation in the login webview is logged from
        // the Rust side. Returning true approves the nav (we don't block
        // anything here — the log is observation only). Covers cases the
        // JS-side forward() can't: navigations that happen before our
        // init script has a chance to wrap console (rare but possible at
        // cross-origin redirect boundaries) and navigations that get
        // cancelled by the remote origin before DOMContentLoaded.
        .on_navigation(|url| {
            append_login_log(&format!("[nav] {}", url.as_str()));
            true
        })
        // Native popup handling — the thing that makes "Continue with
        // Google" actually work. When claude.ai's JS calls window.open()
        // (Google Identity Services v3 does this with a storagerelay://
        // redirect_uri), wry asks this closure what to do. Returning
        // NewWindowResponse::Create { window } hands wry a freshly built
        // WebviewWindow; on macOS wry plumbs that into WebKit's
        // WKUIDelegate `createWebViewWithConfiguration:for:windowFeatures:`
        // return path, so WebKit treats it as a real popup with a
        // native `window.opener` pointing at this main webview. That
        // makes `window.opener.postMessage(authResult, 'https://claude.ai')`
        // route natively back to claude.ai's own page in this window,
        // which runs its own message listener and completes the login
        // server-side — no JS patching required.
        .on_new_window(move |url, _features| {
            // Return `Allow` (not `Create`) so wry lets WebKit create the
            // popup natively via the caller's WKUIDelegate
            // `createWebViewWithConfiguration:`. That path preserves the
            // native `window.opener` relationship between parent and
            // popup — our previous `Create { window }` approach handed
            // wry a WKWebView we'd already built, but that WKWebView
            // used a different WKWebViewConfiguration than the one
            // WebKit expected, so WebKit marked the popup detached and
            // `window.opener` came back null. Null opener → Google's
            // GSI SDK skips its postMessage to parent → login hangs.
            //
            // With `Allow`, we lose control of the popup (no init
            // script, no devtools, no window-label in Tauri's window
            // map). Tradeoff is worth it: a real opener means Google's
            // post-auth `window.opener.postMessage(code, 'https://claude.ai')`
            // lands natively in claude.ai's main window here, its own
            // message listener processes the code, hits its backend,
            // and sets the sessionKey cookie. Our cookie poller in the
            // main webview catches that cookie just like any other
            // login path.
            let _ = app_for_popup; // popup path no longer builds via Tauri
            append_login_log(&format!("[popup-req/allow] url={}", url.as_str()));
            NewWindowResponse::Allow
        });
    if let Some(ua) = LOGIN_WEBVIEW_UA {
        builder = builder.user_agent(ua);
    }
    let window = builder.build().map_err(|e| format!("webview build: {e}"))?;

    // Inject the cookie-polling / console-forwarding instrumentation via
    // post-build eval rather than `.initialization_script(...)`. See comment
    // above the builder for why document-start injection broke first-paint
    // hydration. The script is idempotent (guarded by the `sent` flag inside
    // its IIFE) so running it after the claude.ai page has loaded is safe —
    // the setInterval cookie poller still fires every 500ms until it captures
    // sessionKey, and the console patches layer on top of whatever claude.ai
    // has already set up. Silently-failing eval (returning Err from Tauri)
    // just means the logger and poller won't attach; the user can still
    // complete the login manually.
    if let Err(e) = window.eval(INIT_SCRIPT) {
        append_login_log(&format!("[init] eval INIT_SCRIPT failed: {}", e));
    }

    // Wire up the two event listeners that replace the custom-command
    // IPC paths we abandoned. App commands (#[tauri::command]) only
    // auto-grant to local webviews in Tauri 2 — our login webview is
    // remote, so invoke() against them got silently ACL-rejected. The
    // core event plugin is allowed from remote webviews (we grant
    // core:event:allow-emit in capabilities/claude-ai-login.json), so
    // emit→listen is the clean path.
    //
    // sentinel-login-log: mirrors console.{log,warn,error} + unhandled
    // rejections into ~/.claude-sentinel/login-webview.log alongside the
    // [nav] URL trail that on_navigation above writes. A support session
    // can tail -f that file and watch the entire login flow from the
    // outside without the user pasting console output.
    window.listen("sentinel-login-log", |event| {
        let raw = event.payload();
        // Defensive parse: Tauri's plugin:event|emit may deliver the
        // payload either as the raw struct (single JSON layer) or as a
        // stringified-struct wrapped in a JSON string (double-encoded).
        // Try direct first, fall through to unwrap-once if needed.
        #[derive(Deserialize)]
        struct L { level: String, msg: String, url: String }
        let parsed: Option<L> = serde_json::from_str::<L>(raw).ok()
            .or_else(|| {
                serde_json::from_str::<String>(raw).ok()
                    .and_then(|s| serde_json::from_str::<L>(&s).ok())
            });
        match parsed {
            Some(l) => {
                // Format: `[level] msg | url=host+path`. The msg goes
                // first because Google's URLs contain 500+ character
                // query strings that would push the msg past the
                // 800-char truncation threshold in any log tailer. Only
                // the host + path of the URL is kept; the OAuth query
                // params are not useful for triage and the navigation
                // logger already prints the full URL on every [nav]
                // transition if we need it.
                // Simple manual truncate: strip everything from '?'
                // onward to drop OAuth query params. Keeps scheme+host+path
                // which is what we actually need for triage.
                let short_url = match l.url.find('?') {
                    Some(idx) => &l.url[..idx],
                    None => l.url.as_str(),
                };
                append_login_log(&format!("[{}] {} | url={}", l.level, l.msg, short_url));
            }
            None => append_login_log(&format!("[log-raw] {}", raw)),
        }
    });

    // sentinel-login-session-key: the sessionKey cookie-poll in the
    // init script fires this as soon as document.cookie contains the
    // webview-visible session fragment (`sessionKeyLC`). BUT — and this
    // is the critical wrinkle — `sessionKeyLC` appears to be a short
    // (13-char) client-visible session identifier, NOT the secret that
    // actually authenticates to Anthropic's /api/organizations/:uuid/usage
    // endpoint. The real session secret is an HttpOnly cookie (likely
    // named `sessionKey` or similar) that document.cookie can't see.
    //
    // Fix: on the JS-side signal, pivot to a Rust-side cookie read via
    // Tauri 2's `webview.cookies_for_url(...)` which queries the
    // underlying WKHTTPCookieStore and returns ALL cookies including
    // HttpOnly ones. We log every cookie's name and httponly status,
    // then prefer `sessionKey` (HttpOnly) over the client-visible
    // `sessionKeyLC` when picking what to hand the daemon.
    let app_for_session = app.clone();
    let window_for_cookies = window.clone();
    window.listen("sentinel-login-session-key", move |event| {
        // First: enumerate ALL cookies from the webview's store so we
        // can see exactly what's there (HttpOnly included) and hand
        // the daemon the right secret.
        let js_value_fallback: String = {
            #[derive(Deserialize)]
            struct S { #[serde(rename = "sessionKey")] session_key: String }
            let raw = event.payload();
            let parsed: Option<S> = serde_json::from_str::<S>(raw).ok()
                .or_else(|| {
                    serde_json::from_str::<String>(raw).ok()
                        .and_then(|inner| serde_json::from_str::<S>(&inner).ok())
                });
            parsed.map(|s| s.session_key.trim().to_string()).unwrap_or_default()
        };

        let cookies_result = "https://claude.ai".parse::<tauri::Url>()
            .ok()
            .and_then(|u| window_for_cookies.cookies_for_url(u).ok());
        let (chosen_name, chosen_value) = match cookies_result {
            Some(cookies) => {
                // Log every cookie we can see from Rust side (HttpOnly
                // visible here even when it wasn't in document.cookie).
                let summary: Vec<String> = cookies.iter().map(|c| {
                    format!("{}(httpOnly={}, len={})", c.name(), c.http_only().unwrap_or(false), c.value().len())
                }).collect();
                append_login_log(&format!("[cookie-jar/rust] {}", summary.join(", ")));

                // Prefer the HttpOnly `sessionKey` cookie if present;
                // fall back to any cookie whose name contains
                // "sessionKey" (case-insensitive); ultimately fall back
                // to whatever the JS side captured.
                let primary = cookies.iter().find(|c| c.name() == "sessionKey" && !c.value().is_empty());
                let fallback = cookies.iter().find(|c| c.name().to_lowercase().contains("sessionkey") && !c.value().is_empty());
                match primary.or(fallback) {
                    Some(c) => (c.name().to_string(), c.value().to_string()),
                    None => ("<js-fallback>".to_string(), js_value_fallback.clone()),
                }
            }
            None => {
                append_login_log("[cookie-jar/rust] cookies_for_url failed; using JS-captured value");
                ("<js-fallback>".to_string(), js_value_fallback.clone())
            }
        };
        append_login_log(&format!("[session-key] chose cookie={} (len={})", chosen_name, chosen_value.len()));
        if chosen_value.is_empty() {
            append_login_log("[session-key] empty, ignoring");
            return;
        }
        let trimmed = chosen_value;
        let app_handle = app_for_session.clone();
        tauri::async_runtime::spawn(async move {
            // Resolve which account this login was for.
            let account_id = {
                let pending = PENDING.lock().await;
                match pending.as_ref() {
                    Some(p) => p.account_id.clone(),
                    None => {
                        append_login_log("[session-key] no pending login, dropping");
                        return;
                    }
                }
            };
            let msg = serde_json::json!({
                "type": "set_claude_ai_session_key",
                "accountId": account_id,
                "sessionKey": trimmed,
            });
            match crate::ipc::send_internal(msg).await {
                Ok(resp) if resp.success => {
                    append_login_log("[session-key] daemon accepted");
                    if let Some(w) = app_handle.get_webview_window(LOGIN_WINDOW_LABEL) {
                        let _ = w.close();
                    }
                    // Close the Google OAuth popup (and any other
                    // transient window that was spawned by the login
                    // flow). Google's post-auth JS normally calls
                    // `window.close()` on itself after the storagerelay
                    // postMessage completes, but wry's default
                    // NewWindowResponse::Allow popup doesn't reliably
                    // honor that JS-side close (no WKUIDelegate
                    // webViewDidClose: wiring on the native window).
                    // Result: the "One moment please" page stays open
                    // after login. Clean up explicitly here — iterate
                    // every Tauri-tracked webview and close anything
                    // that isn't the tray or the login window we just
                    // closed above. The only other windows that should
                    // exist are popups spawned by this flow.
                    let labels_to_keep = ["main", LOGIN_WINDOW_LABEL];
                    let mut closed = 0usize;
                    for (label, w) in app_handle.webview_windows() {
                        if labels_to_keep.contains(&label.as_str()) { continue; }
                        append_login_log(&format!("[session-key] closing extra window: {}", label));
                        let _ = w.close();
                        closed += 1;
                    }
                    if closed > 0 {
                        append_login_log(&format!("[session-key] closed {} extra window(s)", closed));
                    }
                    *PENDING.lock().await = None;
                    let _ = app_handle.emit("claude-ai-login-complete", serde_json::json!({ "accountId": account_id }));
                }
                Ok(resp) => {
                    append_login_log(&format!("[session-key] daemon rejected: {:?}", resp.error));
                }
                Err(e) => {
                    append_login_log(&format!("[session-key] daemon send failed: {}", e));
                }
            }
        });
    });

    // DevTools on the login webview are opt-in now. Early iterations
    // auto-opened them to aid diagnosing the Google-OAuth-in-WebView
    // maze (blank windows, postMessage misses, cookie-capture quirks),
    // but once the flow actually works end-to-end the inspector
    // window is visual noise for normal users. Set
    // `SENTINEL_DEBUG_LOGIN=1` (or any non-empty value) before
    // launching Sentinel to re-enable. Right-click → Inspect in the
    // login window still works — devtools feature is enabled at the
    // Cargo level.
    if std::env::var("SENTINEL_DEBUG_LOGIN").map(|v| !v.is_empty()).unwrap_or(false) {
        window.open_devtools();
    }

    Ok(())
}

/// Label for the OAuth authorize webview. Separate from the claude.ai
/// login webview so they can be open simultaneously without conflict
/// (though in practice OAuth finishes before the login webview needs
/// to be created). Shares the default WKWebsiteDataStore with every
/// other Sentinel webview so cookies captured during login/approval
/// are immediately visible to the `claude-ai-login` cookie-scrape
/// flow that fires after the new account is created.
const OAUTH_WINDOW_LABEL: &str = "oauth-login";

/// Open the OAuth authorize URL in an embedded Tauri webview instead
/// of handing it off to the system browser. The upshot: claude.ai's
/// login + consent pages set cookies in the app's own
/// WKHTTPCookieStore, which means the existing Connect claude.ai
/// flow (`start_claude_ai_login` → `cookies_for_url("https://claude.ai")`)
/// finds the sessionKey immediately after the account is created —
/// no second login prompt required.
///
/// Navigation to `http://localhost:47285/*` is the OAuth callback
/// from claude.ai's approve button. We close the webview at that
/// point and let the daemon's callback server + exchange flow
/// proceed as usual.
///
/// One-at-a-time: if a prior OAuth window is still open, we focus it
/// and navigate it to the new URL rather than spawning a second.
/// Tauri rejects duplicate labels so this matters.
#[tauri::command]
pub async fn open_oauth_webview(
    app: AppHandle,
    url: String,
    #[allow(non_snake_case)] orgUuidHint: Option<String>,
) -> Result<(), String> {
    append_login_log(&format!(
        "=== open_oauth_webview url={} orgHint={} ===",
        url,
        orgUuidHint.as_deref().unwrap_or("(none)"),
    ));
    let parsed: tauri::Url = url
        .parse()
        .map_err(|e| format!("bad oauth url: {e}"))?;
    // When the caller asked to preselect an org, land the webview at
    // a benign claude.ai page first and run a tiny fetch that hits
    // `/api/organizations/{uuid}/sync/settings`. That endpoint's
    // response carries `Set-Cookie: lastActiveOrg=<uuid>` which
    // lands in the webview's WKHTTPCookieStore. After the fetch
    // resolves, the script window.location.href's to the OAuth URL.
    // claude.ai's authorize handler keys off the cookie and mints
    // the token for that org without ever showing the chooser.
    //
    // If the caller didn't hint, we point straight at the OAuth URL
    // as before — the user is presented with the normal chooser
    // (which is still correct for a first-time Add Account).
    let (initial_url, preselect_script): (tauri::Url, Option<String>) = match orgUuidHint.as_deref() {
        Some(hint) if !hint.is_empty() => {
            // Benign landing page on the claude.ai origin so the
            // fetch executes with the sessionKey cookie attached.
            // `/login` is always accessible (no auth required, just
            // renders the login form) and — importantly — is the
            // same origin we use everywhere else so the WKWebView's
            // web process state stays consistent.
            let landing: tauri::Url = "https://claude.ai/login"
                .parse()
                .map_err(|e| format!("landing url parse: {e}"))?;
            // NOTE: the fetch uses `credentials: 'include'` so it
            // carries every claude.ai cookie (including the
            // HttpOnly sessionKey). `keepalive: true` isn't
            // necessary — we await the promise before navigating.
            let script = format!(
                r#"(async () => {{
                    try {{
                        console.log('[oauth-preselect] fetching sync/settings for org {hint}');
                        const r = await fetch('/api/organizations/{hint}/sync/settings', {{
                            method: 'GET',
                            credentials: 'include',
                            headers: {{
                                'accept': '*/*',
                                'anthropic-client-platform': 'web_claude_ai',
                                'anthropic-client-version': '1.0.0',
                                'content-type': 'application/json',
                            }},
                        }});
                        console.log('[oauth-preselect] sync/settings status=' + r.status);
                    }} catch (e) {{
                        console.warn('[oauth-preselect] sync/settings failed:', e && e.message);
                    }}
                    // Navigate regardless — the OAuth chooser is a
                    // fine fallback if the preseed didn't take.
                    console.log('[oauth-preselect] navigating to authorize URL');
                    window.location.href = {auth_url_json};
                }})();"#,
                hint = hint,
                auth_url_json = serde_json::to_string(&url).map_err(|e| format!("json url: {e}"))?,
            );
            (landing, Some(script))
        }
        _ => (parsed.clone(), None),
    };

    // If an OAuth window is already open (user clicked Add Account
    // twice, removed an account mid-flow, or the previous close-
    // cleanup is still running), destroy it and start fresh. Reusing
    // the existing window by calling `eval('location.href = ...')`
    // works in theory, but Tauri's label-uniqueness rules + navigation
    // lifecycle events make it fragile; the user always gets the same
    // visible outcome (a new OAuth webview pointing at the new URL),
    // so just create a clean one.
    //
    // Previously we called `.close()` + slept 150ms and hoped the
    // teardown finished. That race bit us in the Add → Remove → Add
    // flow: the second Add sometimes produced a blank webview because
    // the new WebviewWindowBuilder ran while WebKit was still tearing
    // down the old web process and the navigation request dropped on
    // the floor. Fix: prefer `.destroy()` (bypasses CloseRequested),
    // then poll until the window is actually gone before building.
    if let Some(existing) = app.get_webview_window(OAUTH_WINDOW_LABEL) {
        append_login_log("[oauth] destroying stale oauth window before opening new one");
        let _ = existing.destroy();
        wait_for_window_gone(&app, OAUTH_WINDOW_LABEL);
    }
    // Belt: the claude-ai-login webview is sometimes the stale one
    // (user hit Connect, webview survived a quick cancel, second Add
    // starts OAuth). Leaving it around competes for focus with the
    // new OAuth window and has caused user-visible "blank window"
    // reports. Tear it down here too so the OAuth flow owns the
    // screen.
    if let Some(existing) = app.get_webview_window(LOGIN_WINDOW_LABEL) {
        append_login_log("[oauth] destroying stale claude-ai-login window before opening new OAuth window");
        let _ = existing.destroy();
        wait_for_window_gone(&app, LOGIN_WINDOW_LABEL);
    }

    let mut builder = WebviewWindowBuilder::new(
        &app,
        OAUTH_WINDOW_LABEL,
        WebviewUrl::External(initial_url),
    )
    .title("Add claude.ai account")
    .inner_size(500.0, 720.0)
    .resizable(true)
    .devtools(true)
    .on_navigation(|nav_url| {
        append_login_log(&format!("[oauth-nav] {}", nav_url.as_str()));
        true
    })
    // Same popup handler we ship on the claude-ai-login webview.
    // claude.ai's "Continue with Google" uses Google Identity Services
    // v3, which opens a popup via window.open(). Without a
    // NewWindowResponse::Allow here, wry's default behavior returns
    // null to claude.ai's JS — which then surfaces "There was an
    // error logging you in." We had to fix this for the Connect
    // claude.ai flow; the same fix belongs on the Add Account flow
    // because it loads the same claude.ai login page.
    .on_new_window(|url, _features| {
        append_login_log(&format!("[oauth-popup-req/allow] url={}", url.as_str()));
        NewWindowResponse::Allow
    });

    // Safari UA — same reasoning as the claude.ai login webview: a
    // Cloudflare-trusted UA lets the page render without the
    // managed-challenge interstitial, and matches the underlying
    // WebKit engine so there's no fingerprint mismatch.
    if let Some(ua) = LOGIN_WEBVIEW_UA {
        builder = builder.user_agent(ua);
    }

    let window = builder.build().map_err(|e| format!("oauth webview build: {e}"))?;

    // Close the window automatically once navigation hits the
    // daemon's OAuth callback server. The daemon has already received
    // the code by then — holding the webview open just shows the
    // user an empty "you can close this" page. Do the close via a
    // second on_navigation listener layered on top of the log-only
    // one in the builder (Tauri keeps only the last one, so we use
    // set_navigation_handler-equivalent — here we rebuild with the
    // close logic). Simpler: install the close logic directly in
    // the builder's on_navigation.
    //
    // (Implementation note: we rebuilt the builder above without the
    // close logic to keep the compiled code readable. We now
    // register a closure on the window's navigation events by
    // listening for the "close-on-callback" Tauri event emitted by
    // a tiny init script.)
    // Init script: when we land on localhost:*, tell Rust to close.
    // Less flaky than weaving a second navigation handler in.
    let close_script = r#"(function(){
        var t = setInterval(function(){
            try {
                if (window.location.host.indexOf('localhost') !== -1) {
                    clearInterval(t);
                    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
                        window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {
                            event: 'oauth-callback-reached',
                            payload: JSON.stringify({ href: window.location.href })
                        }).catch(function(){});
                    }
                }
            } catch(e) {}
        }, 300);
    })();"#;
    let _ = window.eval(close_script);

    // If we landed at the warmup URL, run the preselect script now.
    // This executes in the claude.ai origin of the current (login)
    // page, so the sync/settings fetch carries the sessionKey cookie
    // and the resulting Set-Cookie lands in the same jar. Once done,
    // the script navigates to the real OAuth URL.
    if let Some(script) = preselect_script {
        append_login_log("[oauth-preselect] injecting sync/settings warmup script");
        let _ = window.eval(&script);
    }

    let app_for_close = app.clone();
    window.listen("oauth-callback-reached", move |_event| {
        append_login_log("[oauth] callback URL reached, scheduling cleanup");
        let app_handle = app_for_close.clone();
        // Brief delay so the daemon's callback server has time to
        // respond to the browser before we yank the webview. 750ms
        // is generous — the exchange is a single POST.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(750));
            // Close the oauth-login webview and any leftover popups
            // from the Google "Continue with Google" flow, but NOT
            // the main tray OR the Connect-claude.ai login webview.
            //
            // Previously we closed every non-main window here. That
            // raced with the auto-Connect flow: after login_complete
            // broadcasts, the frontend opens a new `claude-ai-login`
            // webview within ~250-500ms to capture the sessionKey,
            // and this cleanup fires at T+750ms — killing the
            // just-opened webview mid-navigation (leaving
            // `about:blank`). The symptom: the sibling-enrollment
            // walk never captured sessionKey for the second org
            // because its capture webview got yanked out from under
            // it. The scoped close preserves that in-flight capture.
            for (label, w) in app_handle.webview_windows() {
                if label == "main" || label == LOGIN_WINDOW_LABEL { continue; }
                append_login_log(&format!("[oauth] closing window: {}", label));
                let _ = w.close();
            }
        });
    });

    Ok(())
}

/// Wipe claude.ai session state from the webview on Disconnect. The
/// previous implementation looped over `cookies_for_url()` calling
/// `delete_cookie` for each — that works for non-HttpOnly cookies but
/// leaves `sessionKey` (HttpOnly, 131 chars) stubbornly behind in
/// WKHTTPCookieStore on macOS, so the next Connect click's Rust-side
/// cookie scrape re-captures it and silently logs the user back in.
/// Net effect to the user: "I clicked Disconnect, then Connect, and
/// nothing changed."
///
/// Fix: use `WebviewWindow::clear_all_browsing_data()` which calls
/// into wry → `WKWebsiteDataStore::removeDataOfTypes(.allWebsiteDataTypes,
/// modifiedSince: epoch)`. That's the system API that actually
/// removes HttpOnly cookies. Tradeoff on macOS: since all Sentinel
/// webviews (main tray + login) share the default WKWebsiteDataStore,
/// this also wipes Sentinel frontend localStorage (useSettings,
/// dismissals, error history). Those re-sync from the daemon on next
/// load, so the functional impact is a tolerable one-shot reset.
/// Isolating the login webview to its own data store (via
/// `data_directory`) would avoid that but requires architectural
/// changes we can do later if it becomes an issue.
///
/// We also keep the legacy delete_cookie loop as a best-effort
/// pre-step so that if clear_all_browsing_data hits an edge-case
/// failure (the WebKit call can no-op on very-recent cookies), we've
/// still surfaced the visible ones.
#[tauri::command]
pub fn clear_claude_ai_cookies(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .or_else(|| app.get_webview_window(LOGIN_WINDOW_LABEL))
        .ok_or_else(|| "no webview available for cookie clearing".to_string())?;

    // Legacy best-effort delete — catches most client-visible cookies.
    let origins = ["https://claude.ai", "https://api.anthropic.com"];
    let mut deleted = 0usize;
    for origin in origins {
        let Ok(url) = origin.parse::<tauri::Url>() else { continue };
        if let Ok(cookies) = window.cookies_for_url(url) {
            for cookie in cookies {
                if window.delete_cookie(cookie).is_ok() {
                    deleted += 1;
                }
            }
        }
    }
    append_login_log(&format!("[cookies/clear] per-cookie delete: {} removed", deleted));

    // Heavy hammer — WebKit-level wipe including HttpOnly cookies +
    // localStorage + cache. This is what actually gets the
    // `sessionKey` cookie gone.
    match window.clear_all_browsing_data() {
        Ok(()) => append_login_log("[cookies/clear] clear_all_browsing_data ok"),
        Err(e) => {
            append_login_log(&format!("[cookies/clear] clear_all_browsing_data failed: {}", e));
            return Err(format!("clear_all_browsing_data: {e}"));
        }
    }
    Ok(())
}

// Command-based completion callbacks from earlier iterations
// (`complete_claude_ai_login`, `sentinel_login_log`) have been removed.
// App-defined #[tauri::command] functions only auto-grant to *local*
// webviews in Tauri 2's ACL; our login webview is remote (loads
// claude.ai), so invoke() against those commands was silently rejected,
// which is why sessionKey handoff used to need the login webview to be
// local. Event-based emit→listen is allowed from remote webviews via
// core:event:allow-emit in capabilities/claude-ai-login.json — that's
// the path start_claude_ai_login above now wires up.
