# Test Migration Plan

This document is the sprint-by-sprint roadmap for retiring the mock-heavy
test pattern from `packages/daemon` in favor of the fake-Anthropic
integration harness now living at `packages/test-harness`.

**Why this exists.** Unit tests that wholesale mock `https.request`,
`global.fetch`, and internal modules with `vi.mock` allow tests to pass
while real behavior is broken. An AI agent editing code can make a test
pass by tweaking the mock instead of fixing the real issue. The fake
Anthropic server (`packages/test-harness/src/fake-anthropic.ts`) replaces
the mock surface with a real HTTP listener that speaks Anthropic's wire
protocol, injects the real rate-limit header names, and supports fault
injection via named scenarios. Tests that exercise the fake also exercise
every line of the proxy, the URL parser, the header pipeline, and the
credential path. There is no way to "mock around" a real bug.

Sprint 0 is already done — the foundation. This doc is Sprints 1–8.

Guiding rules for every sprint:
- **No new `vi.mock('https')`, `vi.mock(import('node:http'))`, or
  `global.fetch = vi.fn(...)`** in daemon tests. New tests against
  HTTP paths must use `startFakeAnthropic()`.
- **Track mock count per migrated file.** Drop the delta into the PR
  description so the trend is visible.
- **Do not widen `vitest.config.ts` coverage exclusions** without a
  written justification in the sprint PR. If migration breaks coverage,
  that's the signal to add integration tests, not to carve the file out.
- **Keep production behavior unchanged.** Env-gated test paths
  (`ANTHROPIC_UPSTREAM_URL`, `OAUTH_TOKEN_URL`, `OAUTH_AUTH_URL`,
  `CLAUDE_SENTINEL_TEST_KEYCHAIN_FILE`) must default to production
  values when unset.

---

## Sprint 0 — Foundation (DONE)

Sprint 0 was delivered alongside this plan. It did not rewrite anything;
it created the integration substrate.

Delivered:
- `packages/test-harness/` workspace: fake Anthropic server + scenarios + fixtures.
- `packages/daemon/src/hosts.ts`: env-overridable endpoint config.
- Env-gated test keychain adapter in `packages/daemon/src/accounts.ts`.
- Contract test: `packages/test-harness/src/fake-anthropic.contract.test.ts`.
- Three sample integration tests under `packages/daemon/src/*.integration.test.ts`.
- `scripts/record-fixtures.mjs` — captures real responses from `request-logs.db`.
- Playwright E2E scaffolding: `packages/app/e2e/` with one smoke spec.
- CI: branch coverage equalized to 95%; new Fake API contract check step;
  new Playwright E2E job on PRs.

---

## Sprint 1 — Migrate `proxy.test.ts`

**Target:** replace the `vi.mock('https')` wholesale mock with the fake server.

**Why first:** `proxy.test.ts` is the largest and most mocked (2092 lines, ~160
mock sites). The highest-leverage file — if the pattern survives here, it
survives anywhere.

Files touched:
- `packages/daemon/src/proxy.test.ts` — rewrite.
- `packages/test-harness/src/scenarios.ts` — add scenarios for SSE, 401, 429,
  body-truncation, and cache-ttl marker shapes.

Expected mock-count delta: **–150 or more**.

Coverage risk: medium. The current test hits edge cases (malformed SSE,
truncated bodies, upstream 5xx) via hand-crafted mock responses. Map each
to a scenario before deleting the old test.

Est. time: 3–4 days. Large file; worth doing in 3 PRs (constants + setup,
request path, response path + SSE).

Acceptance:
- `vitest run packages/daemon/src/proxy.test.ts` passes with zero
  `vi.mock('https')` calls.
- Overall branch coverage for `proxy.ts` does not drop.
- Integration test added for every scenario previously tested via mocks.

---

## Sprint 2 — Migrate `oauth.test.ts` + `token-refresher.test.ts`

**Target:** kill `global.fetch = vi.fn(...)` in both files.

Files touched:
- `packages/daemon/src/oauth.test.ts`
- `packages/daemon/src/token-refresher.test.ts`
- `packages/test-harness/src/scenarios.ts` — add scenarios for token-exchange
  errors (invalid_request, server_error, malformed JSON body).

Expected mock-count delta: **–40 or so**.

Coverage risk: low. Both files already have integration-style seeds
(`oauth.integration.test.ts` covers the happy path and the 400 case).
Extend the integration test instead of rewriting the unit test.

Est. time: 1 day.

---

## Sprint 3 — Migrate `claude-ai-usage.test.ts` + `claude-ai-run-budget.test.ts`

**Target:** remove fetch stubs; exercise the real parse + network path.

Files touched:
- `packages/daemon/src/claude-ai-usage.test.ts`
- `packages/daemon/src/claude-ai-run-budget.test.ts`
- `vitest.config.ts` — **lift the coverage exemptions** at lines 32–33
  (`claude-ai-usage.ts`, `claude-ai-run-budget.ts`).

Expected mock-count delta: **–30**.

Coverage risk: medium. These files currently live outside coverage. The
integration rewrite should land with enough coverage to meet the 95%
threshold before the exemption is removed; otherwise the CI job fails.

Est. time: 2 days.

---

## Sprint 4 — Migrate `token-rotator.test.ts` + `rate-limit-store.test.ts`

**Target:** replace hand-seeded `store.update({...})` calls with scenario
traffic through a real proxy (the pattern demonstrated in
`token-rotator.integration.test.ts`).

Files touched:
- `packages/daemon/src/token-rotator.test.ts`
- `packages/daemon/src/rate-limit-store.test.ts`

Expected mock-count delta: **–50** (rotator tests alone have
`vi.spyOn(accounts, 'readSentinelCredentials')` everywhere — can use the
test-keychain adapter instead).

Coverage risk: low.

Est. time: 2–3 days.

---

## Sprint 5 — Lift `oauth.ts` coverage exemption

**Target:** remove `packages/daemon/src/oauth.ts` from `vitest.config.ts`
exclude list (line 28). Backfill coverage with integration tests against
the full PKCE callback flow using the fake's auth + token endpoints.

Files touched:
- `packages/daemon/src/oauth.integration.test.ts` — expand: cover
  `startCallbackServer`, `exchangeCode`, `fetchProfile`, cancellation,
  port-reuse races.
- `vitest.config.ts` — remove oauth.ts from exclude.
- Fake server — add `authUrl` callback simulator so tests can synthesize
  the `?code=X&state=Y` callback without driving a browser.

Expected mock-count delta: **–0** (the file previously had no tests).

Coverage risk: **high**. oauth.ts has intricate platform-specific browser
launching (~150 lines of macOS/Linux/Windows exec logic) that cannot be
exercised in CI. Those paths stay covered by `/* v8 ignore */` pragmas —
keep the file in CI but keep the platform branches out.

Est. time: 3 days.

---

## Sprint 6 — Lift `index.ts` coverage exemption

**Target:** remove `packages/daemon/src/index.ts` from exclude (line 21).
Test IPC handler dispatch end-to-end by connecting directly to the
daemon's Unix socket (the bridge script at
`packages/app/e2e/helpers/ipc-http-bridge.mjs` shows the protocol).

Files touched:
- `packages/daemon/src/index.integration.test.ts` — new.
- `vitest.config.ts` — remove index.ts from exclude.

Expected mock-count delta: **0** (greenfield coverage).

Coverage risk: **high**. `index.ts` is 2000+ lines of startup orchestration
and IPC routing. Plan to leave some sub-branches under `/* v8 ignore */`
(process-signal handlers, unclean-shutdown paths).

Est. time: 4–5 days.

---

## Sprint 7 — Expand Playwright suite

**Target:** fill in the three `test.fixme` placeholders in
`packages/app/e2e/smoke.spec.ts` and add regression coverage for every
critical UI flow identified in the original survey.

Flows to cover:
1. **add-account OAuth (happy path)** — click "+" in AccountSwitcher,
   intercept `start_login`, synthesize the callback via
   `fake.authUrl + ?code=X&state=Y`, verify account row appears.
2. **switch-account** — seed two accounts, click the inactive one,
   verify `~/.claude.json` (mocked via HOME) and the daemon-broadcast
   `account_switched` event.
3. **configure alert and trigger** — open Alerts tab, create 90%
   threshold alert for an account, switch fake to `5h-warning` scenario,
   fire a request through the proxy, verify `alert_triggered` broadcast.
4. **round-robin pool toggle** — flip to round-robin mode, verify
   `settings_changed` broadcast and rotator pool reflects the change.
5. **view usage metrics** — probe triggers, drain meter updates.

Files touched:
- `packages/app/e2e/*.spec.ts` — five new/updated specs.
- `packages/app/e2e/helpers/test-daemon.ts` — expand scenarios.

Expected mock-count delta: **0** (greenfield UI coverage).

Est. time: 4 days.

---

## Sprint 8 — Add mock-count CI budget

**Target:** now that the daemon is mostly mock-free, lock it in. Fail CI
if a PR raises the `vi.mock` / `vi.fn` / `vi.spyOn` count beyond a
per-file budget.

Files touched:
- `.github/workflows/ci.yml` — new job.
- `scripts/mock-budget.mjs` — new script that counts occurrences and
  compares to `.mock-budget.json` (checked in).

Budget shape:
```json
{
  "packages/daemon/src/proxy.test.ts": 5,
  "packages/daemon/src/oauth.test.ts": 3,
  ...
}
```

PRs that cross a budget get a CI failure with a diff of which lines
added mocks. Bumping a budget requires a short justification in the PR
description — no silent slides backward.

Expected mock-count delta: **caps the floor**.

Est. time: 1 day.

---

## How to execute a sprint

1. Start a branch per sprint.
2. Read the sprint section here. Do not expand the scope mid-sprint —
   new ideas go into a follow-up sprint.
3. Before deleting a mock-heavy test, write the integration test that
   replaces it. Run both side by side. Once the integration test is
   green, delete the old one.
4. Record the mock-count delta in the PR description:
   ```
   Before: 318 mock sites across 26 test files
   After:  168 mock sites across 26 test files
   Delta:  –150
   ```
5. PR template should also note: `Coverage before / after`, `New test files`,
   `Fake scenarios added`.

## When to pause the migration

- If Sprint 1's rewrite reveals structural issues in `fake-anthropic.ts`
  (missing header, wrong status code order, SSE framing bugs), fix the
  fake first and re-run the contract test. Never paper over with
  per-test mock shims.
- If a real-shape fixture drifts from the recorded snapshot, regenerate
  via `node scripts/record-fixtures.mjs --from-db` and inspect the diff
  — Anthropic may have changed a field.
