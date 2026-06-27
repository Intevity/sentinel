// Injected via addInitScript before every frame loads. Provides:
//  - a Tauri internals stub so the app's invoke() calls (e.g.
//    is_sentinel_activated) resolve in a plain browser, hiding the Activate
//    banner. Runs in ALL frames because the app renders inside the stage's
//    cross-origin iframe.
//  - a synthetic macOS-style cursor with eased movement + a click pulse, in
//    the TOP frame only, so a single cursor floats over the whole desktop
//    (the app is driven via Playwright frameLocator clicks; this cursor is
//    the visible companion that moves to each target first).
// The cursor API hangs off window.__demo.* and is driven from record-clip.mjs.
// Zoom is applied in post (ffmpeg zoompan), not here — Playwright's video
// recorder does not capture CSS transforms.
(() => {
  const isTop = window.top === window;

  // ---- Tauri stub (all frames — the app may be in a child frame) ----
  const tauriReturns = (cmd) => {
    if (cmd === 'is_sentinel_activated') return true;
    if (cmd === 'get_autostart') return false;
    return null;
  };
  if (!window.__TAURI_INTERNALS__) {
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd) => tauriReturns(cmd),
      transformCallback: () => 0,
      convertFileSrc: (p) => p,
    };
  }

  const ready = (fn) => {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  };

  // Hide the real cursor in every frame so only the synthetic one shows.
  ready(() => {
    const style = document.createElement('style');
    style.textContent = '*{cursor:none !important}';
    document.head.appendChild(style);
  });

  // The synthetic cursor + driver API live only on the top (stage) frame.
  if (!isTop) return;

  const state = { x: 960, y: 320 };
  let cursorEl = null;

  function ensureCursor() {
    if (cursorEl && cursorEl.isConnected) return cursorEl;
    const el = document.createElement('div');
    el.id = '__demo_cursor';
    el.style.cssText =
      'position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;' +
      'pointer-events:none;will-change:transform;filter:drop-shadow(0 2px 4px rgba(0,0,0,.45));';
    el.innerHTML =
      '<svg width="26" height="26" viewBox="0 0 24 24" fill="none">' +
      '<path d="M5 3l14 8-6 1.5L10 19 5 3z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/>' +
      '</svg>';
    document.body.appendChild(el);
    cursorEl = el;
    el.style.transform = `translate(${state.x}px,${state.y}px)`;
    return el;
  }

  function easeOutCubic(p) {
    return 1 - Math.pow(1 - p, 3);
  }

  window.__demo = {
    moveTo(tx, ty, ms = 700) {
      const el = ensureCursor();
      const sx = state.x;
      const sy = state.y;
      const t0 = performance.now();
      return new Promise((resolve) => {
        (function step(now) {
          const p = Math.min(1, (now - t0) / ms);
          const e = easeOutCubic(p);
          state.x = sx + (tx - sx) * e;
          state.y = sy + (ty - sy) * e;
          el.style.transform = `translate(${state.x}px,${state.y}px)`;
          if (p < 1) requestAnimationFrame(step);
          else resolve();
        })(t0);
      });
    },
    // Fake macOS notification banner, top-right of the desktop. The real app
    // fires a native OS notification (Tauri) that a headless browser can't
    // render, so the alerts recipe calls this to show the equivalent banner.
    notify({ app = 'Sentinel', title = '', body = '', ms = 4200 } = {}) {
      const card = document.createElement('div');
      card.style.cssText =
        'position:fixed;top:52px;right:-400px;width:344px;z-index:2147483647;pointer-events:none;' +
        'background:rgba(40,40,43,.82);backdrop-filter:blur(28px) saturate(160%);-webkit-backdrop-filter:blur(28px) saturate(160%);' +
        'border:.5px solid rgba(255,255,255,.14);border-radius:18px;padding:13px 15px;' +
        'box-shadow:0 16px 48px rgba(0,0,0,.5);display:flex;gap:11px;align-items:flex-start;' +
        'font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;opacity:0;' +
        'transition:right .55s cubic-bezier(.22,1,.36,1),opacity .4s ease;';
      const esc = (s) =>
        String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
      card.innerHTML =
        '<div style="flex:0 0 auto;width:38px;height:38px;border-radius:9px;background:linear-gradient(135deg,#007AFF,#5E5CE6);' +
        'display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.3);">' +
        '<svg width="21" height="21" viewBox="0 0 24 24" fill="none"><path d="M12 2l7 3v6c0 5-3.5 8.6-7 9.6C8.5 19.6 5 16 5 11V5l7-3z" fill="#fff"/></svg></div>' +
        '<div style="flex:1 1 auto;min-width:0;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1px;">' +
        `<span style="font-size:12px;font-weight:700;color:#fff;letter-spacing:.3px;">${esc(app)}</span>` +
        '<span style="font-size:11px;color:rgba(235,235,245,.55);">now</span></div>' +
        `<div style="font-size:13px;font-weight:600;color:#fff;line-height:1.3;">${esc(title)}</div>` +
        `<div style="font-size:13px;color:rgba(235,235,245,.78);line-height:1.35;margin-top:1px;">${esc(body)}</div></div>`;
      document.body.appendChild(card);
      requestAnimationFrame(() => {
        card.style.right = '24px';
        card.style.opacity = '1';
      });
      if (ms > 0)
        setTimeout(() => {
          card.style.right = '-400px';
          card.style.opacity = '0';
          setTimeout(() => card.remove(), 700);
        }, ms);
      return card;
    },
    clickPulse() {
      const ring = document.createElement('div');
      ring.style.cssText =
        `position:fixed;left:${state.x - 6}px;top:${state.y - 6}px;width:12px;height:12px;` +
        'border-radius:50%;border:2px solid rgba(0,122,255,.9);z-index:2147483646;pointer-events:none;' +
        'transform:scale(1);opacity:.9;transition:transform .45s ease-out,opacity .45s ease-out;';
      document.body.appendChild(ring);
      requestAnimationFrame(() => {
        ring.style.transform = 'scale(3.4)';
        ring.style.opacity = '0';
      });
      setTimeout(() => ring.remove(), 500);
    },
  };

  ready(ensureCursor);
})();
