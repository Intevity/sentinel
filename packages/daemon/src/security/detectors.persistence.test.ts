// Sprint 4 — persistence-mechanism detectors. Each new RISKY_WRITE entry
// gets a positive (a path that should match) and a similar-but-different
// negative (a path that must NOT match), to lock in regex precision.
// Each new BASH_RULE detector gets a positive and a negative for the same
// reason. Style mirrors detectors.test.ts.

import { describe, it, expect } from 'vitest';
import { scanToolUseBlocks } from './detectors.js';

const ALL_OPTS = { scanSecrets: true, scanInjection: true, scanToolUse: true };

function writeFinding(filePath: string) {
  return scanToolUseBlocks(
    [{ index: 0, name: 'Write', input: { file_path: filePath, content: 'x' } }],
    ALL_OPTS,
  ).find((f) => f.kind === 'risky_write');
}

function bashFindings(command: string) {
  return scanToolUseBlocks([{ index: 0, name: 'Bash', input: { command } }], ALL_OPTS);
}

describe('Sprint 4 — persistence write targets (HIGH)', () => {
  it.each([
    [
      '~/Library/LaunchAgents/com.example.plist',
      '/Users/me/Library/LaunchAgents/com.example.plist',
    ],
    ['/Library/LaunchDaemons/com.example.plist', '/Library/LaunchDaemons/com.example.plist'],
    ['/etc/systemd/system service unit', '/etc/systemd/system/foo.service'],
    ['/etc/systemd/system timer unit', '/etc/systemd/system/foo.timer'],
    ['~/.config/systemd/user unit', '/Users/me/.config/systemd/user/foo.service'],
    ['~/.gnupg agent state', '/Users/me/.gnupg/gpg-agent.conf'],
    ['~/.docker/config.json', '/Users/me/.docker/config.json'],
    ['~/.kube/config', '/Users/me/.kube/config'],
    ['/etc/cron.d', '/etc/cron.d/zzz'],
    ['/etc/cron.daily', '/etc/cron.daily/runme'],
    ['per-repo .git/hooks', '/Users/me/work/repo/.git/hooks/pre-commit'],
  ])('flags HIGH for %s', (_label, path) => {
    const f = writeFinding(path);
    expect(f, `expected risky_write finding for ${path}`).toBeDefined();
    expect(f!.severity).toBe('high');
  });

  it.each([
    // LaunchAgents bypass attempt: similarly-named directory under Library
    ['Library Application Support', '/Users/me/Library/Application Support/foo'],
    // LaunchDaemons confusion: a Frameworks path under /Library
    ['Library Frameworks', '/Library/Frameworks/foo'],
    // systemd: text file in the dir but not a .service/.timer
    ['/etc/systemd/system README', '/etc/systemd/system/README'],
    // systemd user typo
    ['~/.config/some-app/user.cfg', '/Users/me/.config/some-app/user.cfg'],
    // .gnupg-look-alike outside the home dir's gnupg state
    ['gnupg-notes.md', '/Users/me/Documents/gnupg-notes.md'],
    // .docker but not the config helper file
    ['~/.docker/scout/cache.json', '/Users/me/.docker/scout/cache.json'],
    // .kube cache, not config
    ['~/.kube/cache/foo', '/Users/me/.kube/cache/foo'],
    // /etc/cron-look-alike (missing the trailing dot)
    ['/etc/crony/foo', '/etc/crony/foo'],
    // .gitignore inside a git repo, not the hooks dir
    ['repo .gitignore', '/Users/me/work/repo/.gitignore'],
  ])('does NOT flag %s as a persistence-vector write', (_label, path) => {
    const f = writeFinding(path);
    // sudoers prefix already covers /etc/sudoers.d so don't include here;
    // these cases are specifically the new Sprint 4 vectors.
    expect(f, `unexpected risky_write finding for ${path}`).toBeUndefined();
  });
});

describe('Sprint 4 — persistence write targets (MEDIUM editor configs)', () => {
  it.each([
    ['~/.vimrc', '/Users/me/.vimrc'],
    ['~/.vim/ tree', '/Users/me/.vim/autoload/foo.vim'],
    ['~/.config/nvim/init.lua', '/Users/me/.config/nvim/init.lua'],
    ['~/.config/nvim/init.vim', '/Users/me/.config/nvim/init.vim'],
    ['~/.config/nvim/lua tree', '/Users/me/.config/nvim/lua/plugins.lua'],
    ['~/.emacs', '/Users/me/.emacs'],
    ['~/.emacs.d/init.el', '/Users/me/.emacs.d/init.el'],
    ['VS Code user settings', '/Users/me/.config/Code/User/settings.json'],
    ['VS Code keybindings', '/Users/me/.config/Code/User/keybindings.json'],
    ['VS Code extensions', '/Users/me/.vscode/extensions/some.extension/dist/foo.js'],
  ])('flags MEDIUM for %s', (_label, path) => {
    const f = writeFinding(path);
    expect(f, `expected risky_write finding for ${path}`).toBeDefined();
    expect(f!.severity).toBe('medium');
  });

  it.each([
    // notes about vim, not the rc file itself
    ['vim-notes.md', '/Users/me/projects/vim-notes.md'],
    // generic README inside the nvim config
    ['nvim README', '/Users/me/.config/nvim/README.md'],
    // ELPA package files, not the user init.el
    ['emacs.d elpa pkg', '/Users/me/.emacs.d/elpa/somepkg/foo.el'],
    // VS Code cache, not user-config
    ['VS Code cache', '/Users/me/.config/Code/Cache/foo'],
    // remote vscode-server data, distinct from local extensions tree
    ['vscode-server data', '/Users/me/.vscode-server/data/foo'],
  ])('does NOT flag %s as an editor-config write', (_label, path) => {
    const f = writeFinding(path);
    expect(f, `unexpected risky_write finding for ${path}`).toBeUndefined();
  });
});

describe('Sprint 4 — persistence Bash detectors', () => {
  it('crontab-edit: flags `crontab -e`', () => {
    const findings = bashFindings('crontab -e');
    const f = findings.find((x) => x.detectorId === 'crontab-edit');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });

  it('crontab-edit: flags `crontab -` (read from stdin)', () => {
    const findings = bashFindings('echo "* * * * * /tmp/x" | crontab -');
    const f = findings.find((x) => x.detectorId === 'crontab-edit');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });

  it('crontab-edit: does NOT flag `crontab -l` (list)', () => {
    const findings = bashFindings('crontab -l');
    expect(findings.find((x) => x.detectorId === 'crontab-edit')).toBeUndefined();
  });

  it('git-hooks-redirect: flags `git config --global core.hooksPath /tmp/x`', () => {
    const findings = bashFindings('git config --global core.hooksPath /tmp/evil');
    const f = findings.find((x) => x.detectorId === 'git-hooks-redirect');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });

  it('git-hooks-redirect: flags repo-local `git config core.hooksPath`', () => {
    const findings = bashFindings('git config core.hooksPath ./hooks');
    const f = findings.find((x) => x.detectorId === 'git-hooks-redirect');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('high');
  });

  it('git-hooks-redirect: does NOT flag unrelated `git config user.email`', () => {
    const findings = bashFindings('git config user.email "j@x.com"');
    expect(findings.find((x) => x.detectorId === 'git-hooks-redirect')).toBeUndefined();
  });

  // at-scheduled and login-items-osascript both use base severity 'medium'
  // at confidence < 0.85, which the existing scanBash degrade ladder
  // emits as 'low' (matches the rsync/scp/python-socket-inline pattern).
  // We assert the finding fires by detectorId; the severity ladder is
  // existing-system behavior pinned by the secret/bash test suite, not
  // this sprint's contract.
  it('at-scheduled: flags `at now + 5 min`', () => {
    const findings = bashFindings('at now + 5 min < /tmp/cmd');
    expect(findings.find((x) => x.detectorId === 'at-scheduled')).toBeDefined();
  });

  it('at-scheduled: flags `at +1 hour`', () => {
    const findings = bashFindings('at +1 hour < /tmp/cmd');
    expect(findings.find((x) => x.detectorId === 'at-scheduled')).toBeDefined();
  });

  it('at-scheduled: does NOT bleed into `cat foo.txt`', () => {
    const findings = bashFindings('cat foo.txt');
    expect(findings.find((x) => x.detectorId === 'at-scheduled')).toBeUndefined();
  });

  it('at-scheduled: does NOT flag `chat now hello` (no word boundary)', () => {
    const findings = bashFindings('echo chat now hello');
    expect(findings.find((x) => x.detectorId === 'at-scheduled')).toBeUndefined();
  });

  it('login-items-osascript: flags Login Items registration', () => {
    const cmd =
      'osascript -e \'tell application "System Events" to make login item at end with properties {path:"/Applications/Evil.app"} -- Add to Login Items\'';
    const findings = bashFindings(cmd);
    expect(findings.find((x) => x.detectorId === 'login-items-osascript')).toBeDefined();
  });

  it('login-items-osascript: does NOT flag a benign `osascript display notification`', () => {
    const findings = bashFindings('osascript -e \'display notification "hello"\'');
    expect(findings.find((x) => x.detectorId === 'login-items-osascript')).toBeUndefined();
  });
});
