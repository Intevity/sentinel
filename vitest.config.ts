import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.spec.ts'],
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
        // Claude.ai usage + run-budget endpoints: authenticated HTTP calls
        // against undocumented claude.ai endpoints; same exemption rationale
        // as oauth.ts.
        'packages/daemon/src/claude-ai-usage.ts',
        'packages/daemon/src/claude-ai-run-budget.ts',
        // Bi-directional file-watcher sync against ~/.claude/settings.json:
        // uses fs.watch on the parent directory; external-integration module.
        'packages/daemon/src/security/permissions/claude-sync.ts',
        // Benchmark harness: runs via `vitest bench`, not `vitest run`, so
        // it's never exercised during the CI test step.
        'packages/daemon/src/security/scanner.bench.ts',
        // Shared types-only files (no runtime logic)
        'packages/shared/src/**',
        // App frontend (requires browser/Tauri)
        'packages/app/src/**',
      ],
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 90,
        statements: 95,
      },
    },
  },
});
