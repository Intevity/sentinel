// Sprint 6 — env-var hijacking detectors. Each dangerous variable in the
// SECURITY_PLAN.md table gets a positive case (assigned via `export VAR=`)
// asserting both detectorId and severity. Negatives lock in that
// similar-but-safe variables, read-only operations, and substring confusion
// (e.g. `MYAPP_CONFIG_PATH`) do not fire. Shell-syntax variants pin
// `VAR=value cmd`, `env VAR=value cmd`, and csh `setenv VAR value` against
// the same detector so refactors of the regex catch regressions.

import { describe, it, expect } from 'vitest';
import { scanToolUseBlocks } from './detectors.js';

const ALL_OPTS = { scanSecrets: true, scanInjection: true, scanToolUse: true };

function bashFindings(command: string) {
  return scanToolUseBlocks([{ index: 0, name: 'Bash', input: { command } }], ALL_OPTS);
}

describe('Sprint 6 — env-var hijack: HIGH severity variables', () => {
  it.each([
    ['LD_PRELOAD'],
    ['LD_LIBRARY_PATH'],
    ['LD_AUDIT'],
    ['DYLD_INSERT_LIBRARIES'],
    ['DYLD_LIBRARY_PATH'],
    ['DYLD_FALLBACK_LIBRARY_PATH'],
    ['NODE_OPTIONS'],
    ['NODE_EXTRA_CA_CERTS'],
    ['PYTHONPATH'],
    ['PYTHONSTARTUP'],
    ['PERL5LIB'],
    ['PERL5OPT'],
    ['RUBYOPT'],
    ['RUBYLIB'],
    ['GIT_SSH'],
    ['GIT_SSH_COMMAND'],
    ['DOCKER_HOST'],
    ['KUBECONFIG'],
    ['GOOGLE_APPLICATION_CREDENTIALS'],
  ])('flags HIGH for export %s=...', (varName) => {
    const findings = bashFindings(`export ${varName}=/tmp/payload.value`);
    const hit = findings.find((f) => f.detectorId === 'env-var-hijack-high');
    expect(hit, `expected env-var-hijack-high finding for ${varName}`).toBeDefined();
    expect(hit!.severity).toBe('high');
  });
});

describe('Sprint 6 — env-var hijack: MEDIUM severity variables', () => {
  it.each([
    ['PYTHONHOME'],
    ['HTTP_PROXY'],
    ['HTTPS_PROXY'],
    ['ALL_PROXY'],
    ['NO_PROXY'],
    ['PATH'],
    ['AWS_ACCESS_KEY_ID'],
    ['AWS_PROFILE'],
    ['AWS_DEFAULT_REGION'],
  ])('flags MEDIUM for export %s=...', (varName) => {
    const findings = bashFindings(`export ${varName}=somevalue`);
    const hit = findings.find((f) => f.detectorId === 'env-var-hijack-medium');
    expect(hit, `expected env-var-hijack-medium finding for ${varName}`).toBeDefined();
    expect(hit!.severity).toBe('medium');
  });
});

describe('Sprint 6 — env-var hijack: shell syntax variants', () => {
  it('matches bare assignment at command head: VAR=value cmd', () => {
    const findings = bashFindings('LD_PRELOAD=/tmp/evil.so /usr/bin/foo');
    const hit = findings.find((f) => f.detectorId === 'env-var-hijack-high');
    expect(hit, 'expected env-var-hijack-high for bare LD_PRELOAD assignment').toBeDefined();
    expect(hit!.severity).toBe('high');
  });

  it('matches env-prefix form: env VAR=value cmd', () => {
    const findings = bashFindings('env LD_PRELOAD=/tmp/evil.so cmd args');
    const hit = findings.find((f) => f.detectorId === 'env-var-hijack-high');
    expect(hit, 'expected env-var-hijack-high for `env LD_PRELOAD=...`').toBeDefined();
    expect(hit!.severity).toBe('high');
  });

  it('matches env-prefix with intervening safe vars: env SAFE=v VAR=value cmd', () => {
    const findings = bashFindings('env LANG=en_US.UTF-8 LD_PRELOAD=/tmp/evil.so cmd');
    const hit = findings.find((f) => f.detectorId === 'env-var-hijack-high');
    expect(hit, 'expected env-var-hijack-high after intervening safe env var').toBeDefined();
    expect(hit!.severity).toBe('high');
  });

  it('matches csh setenv form: setenv VAR value (no equals sign)', () => {
    const findings = bashFindings('setenv LD_PRELOAD /tmp/evil.so');
    const hit = findings.find((f) => f.detectorId === 'env-var-hijack-high');
    expect(hit, 'expected env-var-hijack-high for csh `setenv LD_PRELOAD ...`').toBeDefined();
    expect(hit!.severity).toBe('high');
  });

  it('matches assignment after a command separator: cmd1 ; VAR=value', () => {
    const findings = bashFindings('echo hi ; LD_PRELOAD=/tmp/evil.so /bin/sh');
    const hit = findings.find((f) => f.detectorId === 'env-var-hijack-high');
    expect(hit, 'expected env-var-hijack-high after `;` separator').toBeDefined();
    expect(hit!.severity).toBe('high');
  });
});

describe('Sprint 6 — env-var hijack: negatives', () => {
  it.each([
    ['custom env-prefix not in deny list', 'MYAPP_DEBUG=1 npm test'],
    ['similar prefix but unknown name', 'MYAPP_CONFIG_PATH=/etc/foo.conf cmd'],
    ['printenv read is not assignment', 'printenv LD_PRELOAD'],
    ['name boundary: LDPRELOAD missing underscore', 'LDPRELOAD=/tmp/x cmd'],
    ['suffix-confusion: NODE_OPTIONS_BACKUP', 'NODE_OPTIONS_BACKUP=foo cmd'],
    ['prefix-confusion: MY_PATH', 'MY_PATH=/tmp cmd'],
  ])('does not fire for %s', (_label, command) => {
    const findings = bashFindings(command);
    const hits = findings.filter(
      (f) => f.detectorId === 'env-var-hijack-high' || f.detectorId === 'env-var-hijack-medium',
    );
    expect(hits, `unexpected env-var-hijack finding(s) for: ${command}`).toEqual([]);
  });

  it('does not fire when the variable name appears inside a quoted string', () => {
    // The leading anchor is `(?:^|[\s;&|])`. The quote `"` is not in that
    // class so `LD_PRELOAD` embedded in quoted text cannot satisfy the
    // assignment-form alternative. Setenv form requires literal `setenv`
    // before the var, also absent here. Some downstream confidence-drop
    // logic in scanBash may further demote findings inside quoted contexts;
    // the behaviour we pin here is that no HIGH-severity finding emerges.
    const findings = bashFindings('echo "LD_PRELOAD is dangerous"');
    const high = findings.find(
      (f) => f.detectorId === 'env-var-hijack-high' && f.severity === 'high',
    );
    expect(high, 'no HIGH env-var-hijack finding inside echoed string').toBeUndefined();
  });
});

describe('Sprint 6 — env-var hijack: combined detectors and gating', () => {
  it('AWS_ACCESS_KEY_ID assignment fires env-var-hijack-medium against the AWS_* family', () => {
    // SECURITY_PLAN.md Sprint 6 references `export AWS_ACCESS_KEY_ID=AKIA...`
    // as a case that should ALSO fire the aws-access-key secret detector.
    // Today scanToolUseBlocks() runs scanBash on Bash input but not the
    // secret scanner, and scanRequestBody() skips tool_use blocks (only
    // text + tool_result content reach scanSecretsIn). The cross-pipeline
    // dual-fire is therefore aspirational and belongs to a future sprint
    // that broadens secret scanning to tool_use.input.command. Pin only
    // the env-var-hijack side here so the regression signal is honest.
    const findings = bashFindings('export AWS_ACCESS_KEY_ID=AKIAZQ7EJVPNQXR3HKLM');

    const envHit = findings.find((f) => f.detectorId === 'env-var-hijack-medium');
    expect(envHit, 'expected env-var-hijack-medium for AWS_ACCESS_KEY_ID').toBeDefined();
    expect(envHit!.severity).toBe('medium');
  });

  it('returns no env-var-hijack findings when scanToolUse is disabled', () => {
    const findings = scanToolUseBlocks(
      [{ index: 0, name: 'Bash', input: { command: 'export LD_PRELOAD=/tmp/evil.so' } }],
      { ...ALL_OPTS, scanToolUse: false },
    );
    const hits = findings.filter(
      (f) => f.detectorId === 'env-var-hijack-high' || f.detectorId === 'env-var-hijack-medium',
    );
    expect(hits).toEqual([]);
  });
});
