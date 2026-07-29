import { REPO } from './bugReport.js';

/**
 * Copy + links for the "an update tried to install and didn't" banner.
 *
 * Sentinel can detect that a Windows install silently failed but never why:
 * the updater plugin hands the installer to `ShellExecuteW`, throws away the
 * result, and exits the process. So the banner's job is to name the version
 * that didn't land and point at the most likely cause for the installer the
 * user actually has — an elevation prompt for the MSI, SmartScreen/antivirus
 * for the NSIS `-setup.exe` — then get out of the way with a manual download
 * link.
 */
export interface FailedUpdateAttempt {
  /** Version that failed to install. */
  targetVersion: string;
  /** Version still running. */
  runningVersion: string;
  /** `nsis` | `msi` | `app` | `appimage` | `deb` | `rpm` | `unknown`. */
  installer: string;
  /** Exact artifact filename that failed. */
  artifact: string;
  /** `modal` (a human clicked Install) or `auto` (silent path). */
  trigger: string;
}

/** Strip surrounding whitespace and one leading `v`, so we never emit `/vv1`. */
function bareVersion(version: string): string {
  return version.trim().replace(/^v/i, '');
}

/**
 * Release page for a specific version, falling back to /releases/latest when
 * the version is unknown — a link to the wrong page is worse than a link to
 * the newest one.
 */
export function releaseUrlFor(version: string): string {
  const v = bareVersion(version);
  return v
    ? `https://github.com/${REPO}/releases/tag/v${v}`
    : `https://github.com/${REPO}/releases/latest`;
}

export function failedUpdateHeadline(a: FailedUpdateAttempt): string {
  const target = bareVersion(a.targetVersion);
  const running = bareVersion(a.runningVersion);
  return `Sentinel ${target} didn't install — still on ${running}`;
}

export function failedUpdateDetail(a: FailedUpdateAttempt): string {
  switch (a.installer) {
    case 'msi':
      return 'The installer needs administrator approval and Windows never got it — the User Account Control prompt was dismissed, or a policy blocked it. Download the update and run it yourself, approving the prompt.';
    case 'nsis':
      return 'The installer was downloaded but never ran. SmartScreen or antivirus blocking it is the usual cause. Download the update and run it yourself.';
    default:
      return 'The update was downloaded but the installer never replaced the app. Download it and install it yourself.';
  }
}
