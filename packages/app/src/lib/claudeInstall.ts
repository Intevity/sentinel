/**
 * Official Claude Code CLI install one-liner for the current OS, shown in the
 * add-account panel when the `claude` binary can't be found. Windows gets the
 * PowerShell installer; macOS/Linux get the shell installer. These are the
 * commands Anthropic documents at https://code.claude.com/docs — the native
 * installer needs no Node/npm, so it's the right suggestion for users who only
 * have Claude Desktop.
 */
export function claudeInstallCommand(platform: string): string {
  return /win/i.test(platform)
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash';
}
