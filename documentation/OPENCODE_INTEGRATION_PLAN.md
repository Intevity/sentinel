# opencode integration — findings and open work

_Last updated: 2026-09-05. Status: **subscription routing works** (two verified plugin paths);
cost/token accounting **shipped** as staged usage rows with OTEL request-id dedupe. Companion to
the BYOK surface work ("support opencode as a bring-your-own-key surface" and "require the /v1 path
before reporting the surface as routed") — referenced by subject rather than SHA so the pointers
survive a rebase or squash-merge._

## Second verified subscription path — `opencode-claude-auth` (2026-09-05)

`opencode-claude-auth` (griffinmartin) also routes through Sentinel, with no spawned CLI: it
registers an opencode `auth.loader` returning `{ apiKey: "", baseURL: "https://api.anthropic.com/v1",
fetch }`, where the custom `fetch` injects an OAuth Bearer from Claude Code's keychain and presents
UA `claude-cli/x (external, sdk-cli)`. Two source-verified facts make it compose with the BYOK
surface's `provider.anthropic.options.baseURL` write:

1. Its `buildRequestUrl` passes the incoming URL's host through untouched — `api.anthropic.com`
   appears only as the loader's *default* baseURL.
2. opencode (verified at v1.18.29 and dev) re-applies user config **after** auth loaders in the
   provider merge, so Sentinel's baseURL wins while the loader's `fetch` survives the deep-merge.

Empirically confirmed 2026-09-05: with the surface activated, an `opencode run` against
`anthropic/claude-haiku-4-5` produced `POST /v1/messages?beta=true → 200` through the proxy and
`cache_ttl_events` rows attributed to the pooled account. Do not confuse this plugin with
Meridian/`opencode-with-claude` (ruled out below), which genuinely owns the endpoint.

Since this plugin presents a `claude-cli/` UA and never emits OTEL, it produced zero
`usage_events` rows — the same accounting gap as the spawned-CLI path, now closed (next section).

## Goal

Use Claude **subscriptions** (Pro and Team) from opencode, switchable by Sentinel the way it already
switches them for Claude Code, with Sentinel observing the traffic, and **no API-key billing**.

## Current state — it works

```
opencode → @khalilgharbaoui/opencode-claude-code-plugin
         → spawns `claude --print`  (real Claude Code CLI)
         → reads ~/.claude/settings.json → ANTHROPIC_BASE_URL = Sentinel
         → Sentinel proxy → pooled subscription token
```

Verified 2026-08-12 19:01: two `cache_ttl_events` rows for `claude-opus-4-8` (the model opencode
requested) attributed to a real pooled account, seconds after opencode's stream events. No API key
involved.

**Why this plugin works where others don't** — its entire child-environment construction
(`claudeSpawnEnv`, `src/session-manager.ts`) is:

```ts
{ ...process.env, TERM: "xterm-256color" }
// deletes ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN only when ignoreAnthropicApiKey is set
```

`ANTHROPIC_BASE_URL` appears nowhere in that file and `CLAUDE_CONFIG_DIR` is never set, so the child
inherits the environment and reads the **default** `~/.claude/settings.json` — the file Sentinel
already manages. It also registers a separate `provider.claude-code` (never touching
`provider.anthropic`), and proxies `Bash`/`Edit`/`Write`/`WebFetch`/`Task` back through opencode's
own executor over a loopback MCP server, so opencode keeps its own tools.

No identity forging anywhere: the real CLI originates every request using documented flags.

### Working config

```jsonc
"plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"],
"provider": { "claude-code": { "options": { "ignoreAnthropicApiKey": true } } }
```

- `ignoreAnthropicApiKey: true` is a guard — a stray `ANTHROPIC_API_KEY` in the environment would
  otherwise flip the CLI to pay-as-you-go silently.
- **Leave `accounts` unset.** It isolates accounts via generated per-account `CLAUDE_CONFIG_DIR`
  wrapper scripts, which takes account selection away from Sentinel — the opposite of the goal.
- Requires the Claude Code CLI surface to be **activated** in Sentinel, since that is what puts
  `ANTHROPIC_BASE_URL` into `~/.claude/settings.json`.

## Closed gap — cost and tokens (shipped 2026-09-05)

Quota (5h / weekly) was always correct, because the account-level usage poller is independent of
the proxy. But `usage_events` got **no row** for claude-cli-UA traffic that never delivered OTEL:
`clientEmitsOtel()` (`packages/daemon/src/proxy.ts`) inferred "this client reports its own cost"
from the UA, and both the spawned `claude --print` child (exits before its exporter's first flush)
and `opencode-claude-auth` (no OTEL at all) broke the prediction — so neither writer ran.

**The general lesson held:** the UA test was a *prediction about client behavior*, and predictions
about client behavior failed three times on this work. The shipped fix decides on an observed fact.

### Shipped: staged rows + OTEL dedupe keyed on Anthropic's `request-id`

The per-request refinement of the "per-session OTEL liveness" option from the original table:

- For claude-cli-UA requests the proxy no longer skips the write — it **stages** the observed usage
  in `pending_usage_events`, keyed by the upstream response's `request-id` header (the same id the
  CLI's OTEL `api_request` events carry, already used by `RequestAccountMap`).
- The OTEL receiver **claims** (deletes) the staged row when its `api_request` for that id arrives —
  OTEL owns accounting for clients that actually report.
- `pending-usage-sweeper.ts` **commits** unclaimed rows into `usage_events` after a 90 s grace
  window (OTEL exports in 2-5 s while a client lives); an immediate startup tick commits rows
  staged by a previous daemon run, and `get_usage_summary` / `get_metrics_summary` sweep on demand.
- A partial UNIQUE index on `usage_events.request_id` (nullable; `INSERT OR IGNORE`) makes every
  interleaving — claim-then-sweep, sweep-then-late-OTEL, lost claim — land exactly one row.
- Non-claude-cli clients (Desktop, BYOK) keep the immediate write, now stamped with the request-id.

Behavior shift worth remembering: a real CLI session with OTEL disabled/broken now produces
proxy-priced rows after ~90 s (previously nothing). Tests:
`db.pending-usage.test.ts`, `pending-usage-sweeper.test.ts`,
`proxy.usage-staging.integration.test.ts`, plus additions in `otel-receiver.test.ts`,
`proxy.usage-accounting.integration.test.ts`, and `index.opencode.integration.test.ts`.

## Remaining Sentinel-side work

1. **The surface card misreports on this path.** The plugin never touches
   `provider.anthropic.options.baseURL`, so `classifyOpencodeConfig`
   (`packages/daemon/src/opencode-config.ts`) sees a stale value and reports `foreign-base-url`
   ("routed elsewhere") about a provider nothing is using. Neither existing state fits —
   `plugin-override` means genuinely bypassing (Meridian), `active` means BYOK.

   Add a routed-via-Claude-Code state keyed on `@khalilgharbaoui/opencode-claude-code-plugin` in
   `plugin[]` **and** the CLI surface being activated (reuse the `probeCliActivated` logic:
   `inspectClaudeOtelConfig` + `isSentinelEndpoint`, wired in `index.ts`) — because on this path
   Sentinel is in the loop exactly when the CLI is. Surface it in `OpencodeSurfaceCard.tsx` and the
   Settings toggle; keep `unwritable` precedence intact. Distinguish the two plugins rather than
   folding both into `BASE_URL_OVERRIDING_PLUGINS`.

2. ~~Restructure `connect-opencode.mdx`~~ **Resolved 2026-09-05** (product call: unlisted recipe +
   named callout). The public guide keeps its BYOK spine, drops the falsified "mutually exclusive"
   framing, and gains a "Subscription plans via community plugins" section naming
   `opencode-claude-auth` as verified working alongside Sentinel (with the ToS caveat) and Meridian
   as the bypassing one. The full recipe and rationale stay in this doc.

3. **Unverified:** switch Pro↔Team in Sentinel, prompt opencode again, confirm the serving
   `account_id` changes. This is the last unproven part of the original requirement.

4. ~~Roadmap: surface BYOK usage in the Metrics UI~~ **Shipped 2026-09-05.** The Metrics picker
   gains an "API key" scope (`BYOK_VIEW` sentinel) gated on a new `get_byok_state` IPC (true once
   any `usage_events` row exists under `BYOK_ACCOUNT_ID`, now defined in `@sentinel/shared`). The
   row renders last and is skipped by every default-selection fallback — BYOK is opt-in only.
   Scope logic extracted to `packages/app/src/lib/metricsScope.ts` (tested); the daemon handler
   needed no query changes (`get_metrics_summary` never validated enrollment); MetricsDashboard
   needed nothing (its OTEL-only sections were already data-gated). "All accounts" deliberately
   remains an enrolled-accounts total.

   **Dual-provider recipe (verified live 2026-09-05):** alongside the plugin's `anthropic`
   provider, a custom `anthropic-api` entry (`npm: "@ai-sdk/anthropic"`, `apiKey` +
   Sentinel `baseURL`, explicit models map) is untouched by opencode-claude-auth (its loader is
   registered `provider: "anthropic"`; its system transform early-returns for other provider ids).
   Bogus-key probe returned `POST /v1/messages → 401 (account: byok)` — routed, BYOK-classified,
   key forwarded untouched — while the same session's subscription calls kept pooling (200s under
   the pooled account). Public recipe: connect-opencode.mdx "Running both side by side".

   **Real-key confirmation (2026-09-05, same install):** one `anthropic-api/claude-haiku-4-5`
   run produced two `POST /v1/messages → 200 (account: byok)` — note *no* `?beta=true`, the
   plain AI-SDK shape vs. the plugin's Claude-identity requests — and exactly two `usage_events`
   rows under `account_id='byok'` with `cost_usd` and `request_id` populated. Zero duplicate
   `request_id`s table-wide, and pooled `claude-opus-5` rows interleaved untouched: both billing
   paths coexist in one opencode install without cross-contamination.

   **Cost note worth keeping:** that trivial "say hi" cost **$0.125** — 99,945 cache-*creation*
   tokens (opencode's system prompt + tool definitions) at haiku's $1.25/MTok write rate, vs.
   $0.0006 for the actual turn. On the subscription path the plan absorbs this; on BYOK the user
   pays it on every cache miss. BYOK-with-opencode is dominated by cache writes, not by prompts.

   **Placement gotcha (fixed):** `AccountViewPicker` renders pool options and accounts as two
   separate groups, so appending BYOK last in `buildMetricsPoolOptions` still drew it *above* the
   real accounts. The array-order test passed while the UI was wrong. `PoolOption.trailing` now
   demotes it below the account list; the test asserts the flag, not the array index.

## Ruled out — do not re-derive

**`opencode-with-claude` / Meridian.** Bridges the Claude *Agent SDK* and owns the endpoint. Four
routes in, all closed with evidence:

| Route | Result |
|---|---|
| Inherited env var | Deliberately stripped (`ANTHROPIC_BASE_URL: _dropBaseUrl`) |
| `profile.baseUrl` | Honored only for `type: "api"` — API-key billing |
| `settings.json` env via `claudeConfigDir` | That dir owns credentials; relocating it broke auth |
| `settings.json` env via forced `oauth-token` dir | SDK ignores it; request hit Anthropic directly and 401'd (zero 401s ever reached our proxy) |

Also: its `chat.headers` hook deletes `anthropic-beta`, and it ships
`@rynfar/meridian-plugin-opencode-scrub` — "strip opencode-identifying fingerprints from the system
prompt before it reaches Claude."

**Sentinel's own opencode plugin.** Feasible without forging (opencode's `auth.loader` hook can
supply a custom `fetch` that spawns Claude Code and translates `stream-json` → Anthropic SSE), but
it means reimplementing Meridian, and the tool-proxying problem it would have to solve is already
solved by the plugin above.

**Any HTTP-level integration** that sends opencode's own system prompt under a pooled subscription
token. Requires an `anthropic-beta: oauth-2025-04-20` we did not receive plus a rewritten `system`
field impersonating Claude Code. `http-identity.ts` rejects this by name; it is the same reasoning
that removed the 429-replay path.

## Incidental findings worth keeping

- **Sentinel's keychain credential is a setup-token** — `scopes: ['user:inference']`,
  `hasRefreshToken: false`, long expiry. Any third-party tool that expects to *refresh* Claude Code's
  credential will break against it. Meridian maintains its own separate login for this reason.
- **Claude Code credentials on macOS are keychain-only and global** — no `.credentials.json`
  anywhere — so `CLAUDE_CONFIG_DIR` relocates settings and `.claude.json` but not the credential.
  Login state is read from `.claude.json`'s `oauthAccount`, which Sentinel's `setActiveAccount`
  writes.
- **Meridian's `classifyError` collapses distinct failures** — it matches either "oauth token has
  expired" *or* "not logged in" and emits only the expiry wording. Cost two misdiagnoses; do not
  trust its error text.

## Verification

The model is the discriminator, since opencode and an interactive Claude Code session use different
ones.

```sh
tail -f ~/.sentinel/daemon.log        # expect POST /v1/messages for the model opencode requested
```

Then query `cache_ttl_events` for a recent row carrying opencode's model attributed to a real
account UUID, and `usage_events` for the same model to check whether `cost_usd` is populated (blank
today — that is the open gap, not a regression).

For any Sentinel-side change: `pnpm test` with all four coverage thresholds, and regression that
Claude Code and Claude Desktop still pool normally while the BYOK path still attributes to `byok`.
