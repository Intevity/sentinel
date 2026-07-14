import { describe, expect, it } from 'vitest';
import { claudeInstallCommand } from './claudeInstall.js';

describe('claudeInstallCommand', () => {
  it('returns the PowerShell installer on Windows platforms', () => {
    expect(claudeInstallCommand('Win32')).toBe('irm https://claude.ai/install.ps1 | iex');
    expect(claudeInstallCommand('Windows')).toBe('irm https://claude.ai/install.ps1 | iex');
  });

  it('returns the shell installer on macOS and Linux', () => {
    expect(claudeInstallCommand('MacIntel')).toBe(
      'curl -fsSL https://claude.ai/install.sh | bash',
    );
    expect(claudeInstallCommand('Linux x86_64')).toBe(
      'curl -fsSL https://claude.ai/install.sh | bash',
    );
  });
});
