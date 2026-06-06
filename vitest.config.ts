import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.spec.ts',
      // Compression benchmark: a normal spec (its savings floors are the
      // regression guard), but it lives outside src/ so its large fixture
      // builders are never coverage-instrumented.
      'packages/daemon/bench/**/*.test.ts',
    ],
    // Exclude Playwright specs — they use @playwright/test, not vitest,
    // and fail if vitest tries to collect them.
    exclude: ['**/node_modules/**', '**/dist/**', 'packages/app/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'node_modules/**',
        '**/dist/**',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        'vitest.config.ts',
        'eslint.config.js',
        // CLI entry point: receives DaemonHandle from startDaemon() and wires
        // SIGINT/SIGTERM + process.exit. Pure lifecycle glue — every branch
        // invokes process.exit, which is untestable in-process and covered
        // end-to-end by the E2E suite that spawns the real daemon.
        'packages/daemon/src/cli.ts',
        // Test infrastructure — wires real daemon + fake Anthropic in-process
        // for index.*.integration.test.ts. Has no production callers.
        'packages/daemon/src/index.test-helpers.ts',
        // Inlined base64 app icon consumed by oauth.ts's callback page.
        // No runtime logic, just a data-URL constant.
        'packages/daemon/src/logo.ts',
        // Bi-directional file-watcher sync against ~/.claude/settings.json:
        // uses fs.watch on the parent directory; external-integration module.
        'packages/daemon/src/security/permissions/claude-sync.ts',
        // Benchmark harness: runs via `vitest bench`, not `vitest run`, so
        // it's never exercised during the CI test step.
        'packages/daemon/src/security/scanner.bench.ts',
        // Compression benchmark fixtures + spec: the spec runs in CI (savings
        // floors guard regressions) but only EXERCISES already-instrumented
        // src/ code; the bench dir itself stays out of the coverage gate.
        'packages/daemon/bench/**',
        // Test infrastructure — shared factory imported only by proxy.*.integration.test.ts
        // siblings. Has no production callers. Added in Sprint 1 of the
        // test migration (see documentation/TEST_MIGRATION_PLAN.md).
        'packages/daemon/src/proxy.test-helpers.ts',
        // The fake Anthropic server (`@claude-sentinel/test-harness`) is
        // itself test infrastructure — a real HTTP listener that replaces
        // `vi.mock('https')` in the daemon's integration tests. Its own
        // behavior is gated by `fake-anthropic.contract.test.ts`, which
        // checks wire-shape compatibility with recorded fixtures. Counting
        // its branches toward the production-code coverage gate would
        // conflate "tests we wrote to avoid mocks" with "code that ships".
        'packages/test-harness/src/**',
        // Shared types-only files (no runtime logic)
        'packages/shared/src/**',
        // App frontend (requires browser/Tauri)
        'packages/app/src/**',
      ],
      thresholds: {
        lines: 95,
        functions: 95,
        // Branches at 93 (down from 94.5 in Sprint 1). Sprint 6 of the
        // test-migration plan lifted the coverage exemption on
        // `packages/daemon/src/index.ts` (2,357 LOC: startDaemon, 62 IPC
        // handlers, performSwitch, persistOAuthResult, alert evaluator
        // wiring, retention-purge loops, shutdown). The new
        // `index.*.integration.test.ts` files bring lines + statements +
        // functions above 95, but index.ts is heavily callback-driven:
        // many conditionals live inside options passed to createProxyServer,
        // the startup force-refresh IIFE, and async ticks that complete
        // after test teardown. Those are either covered by sibling integration
        // files (proxy.*.integration, token-refresher.integration) or sit
        // behind narrow `/* v8 ignore */` blocks with justification.
        // Sprint 7 is the path back to 94.5 — a proxy-driven daemon
        // harness that exercises every callback option from within the
        // real daemon context rather than the standalone proxy fixture.
        branches: 93,
        statements: 95,
      },
    },
  },
});
