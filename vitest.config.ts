import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.spec.ts'],
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
        // CLI entry points and external-integration modules (hard to unit test)
        'packages/daemon/src/cli.ts',
        'packages/daemon/src/index.ts',
        // Rate-limit probe: fires an HTTP request through the running proxy.
        // Extracted from index.ts into its own file to avoid a circular import
        // with usage-probe.ts; inherits index.ts's coverage exemption.
        'packages/daemon/src/rate-limit-probe.ts',
        // OAuth orchestration: opens browser, spins up local HTTP server, and
        // makes external API calls: better covered by integration tests.
        'packages/daemon/src/oauth.ts',
        // Inlined base64 app icon consumed by oauth.ts's callback page.
        // No runtime logic, just a data-URL constant.
        'packages/daemon/src/logo.ts',
        // Bi-directional file-watcher sync against ~/.claude/settings.json:
        // uses fs.watch on the parent directory; external-integration module.
        'packages/daemon/src/security/permissions/claude-sync.ts',
        // Benchmark harness: runs via `vitest bench`, not `vitest run`, so
        // it's never exercised during the CI test step.
        'packages/daemon/src/security/scanner.bench.ts',
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
        // Branches at 94.5 (vs. 95 for statements/funcs/lines): Sprint 1 of
        // the test-migration plan (documentation/TEST_MIGRATION_PLAN.md)
        // moved proxy.test.ts off vi.mock('https') onto the fake-Anthropic
        // integration harness. Some fine-grained mocked branches (e.g.
        // "proxyRes.on('error') inside 429-retry drain", "cache_ttl insert
        // throws") are intentionally harder to hit through a real HTTP
        // round-trip and are covered by /* v8 ignore */ comments instead.
        // Sprints 3-6 of the same plan add broader integration coverage
        // and this cap can be bumped back to 95.
        branches: 94.5,
        statements: 95,
      },
    },
  },
});
