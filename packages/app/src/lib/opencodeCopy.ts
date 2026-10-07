import type { OpencodeConfigDetails } from '@sentinel/shared';

/**
 * User-facing copy for the opencode surface, shared by the status card and the
 * Settings → General toggle so the two never disagree.
 *
 * Two facts the copy must get right, because a wrong guess misleads the user
 * about whose quota they spend or why a button is disabled:
 *
 *  - opencode has two credential paths. An Anthropic API key is forwarded
 *    untouched (bring your own key). The `opencode-claude-auth` plugin presents
 *    Claude Code's identity and is served from Sentinel's account pool.
 *  - "unwritable" has more than one cause. Blaming comments for a file that is
 *    merely invalid JSON sends the user hunting for comments that are not there.
 */

/** How routing affects credentials, in one sentence pair. */
export const OPENCODE_CREDENTIALS_COPY =
  'With an Anthropic API key, opencode keeps using your own key. With the opencode-claude-auth plugin (Claude subscription sign-in), requests use Sentinel’s account pool.';

/** Why Sentinel will not write the file, naming the actual cause. */
export function opencodeUnwritableCopy(details: OpencodeConfigDetails): string {
  return details.unwritableReason === 'comments'
    ? 'Your opencode config contains comments, which Sentinel will not rewrite — saving it would delete them.'
    : "Your opencode config isn't valid JSON, so Sentinel won't rewrite it. Fix the syntax error, or add the base URL by hand.";
}

/** Title and body for the status card in a non-active state. */
export function opencodeCardCopy(details: OpencodeConfigDetails | null): {
  title: string;
  body: string;
} {
  switch (details?.state) {
    case 'plugin-override':
      return {
        title: 'opencode is bypassing Sentinel',
        body: `A configured plugin (${details.overridingPlugins.join(', ')}) rewrites opencode's Anthropic base URL when it starts, so it reaches Anthropic without passing through Sentinel. Remove the plugin from your opencode config to route it here.`,
      };
    case 'unwritable':
      return {
        title: 'opencode needs a manual config edit',
        body: `${opencodeUnwritableCopy(details)} Add this to it by hand:`,
      };
    case 'foreign-base-url':
      return {
        title: 'opencode routed elsewhere',
        body: `opencode's Anthropic provider points at ${details.baseUrl}. Enabling routes it through Sentinel instead; Sentinel saves that URL and puts it back when you disable routing.`,
      };
    default:
      return {
        title: 'Route opencode through Sentinel',
        body: `Routes opencode through the Sentinel proxy for request logging, security scanning, and permission rules. ${OPENCODE_CREDENTIALS_COPY} Restart opencode after enabling.`,
      };
  }
}

/** Description under the Settings → General toggle. */
export function opencodeToggleDescription(details: OpencodeConfigDetails | null): string {
  if (details?.state === 'plugin-override') {
    return `Unavailable: the ${details.overridingPlugins.join(', ')} plugin rewrites opencode's Anthropic base URL at startup, so it bypasses Sentinel regardless of this setting.`;
  }
  if (details?.state === 'unwritable') return `Unavailable: ${opencodeUnwritableCopy(details)}`;

  const parts = [
    `Route opencode through the Sentinel proxy for request logging, security scanning, and permission rules. ${OPENCODE_CREDENTIALS_COPY}`,
  ];
  if (details?.state === 'foreign-base-url') {
    parts.push(
      `Turning this on replaces your base URL (${details.baseUrl}); Sentinel saves it and restores it when you turn this off.`,
    );
  } else if (details?.previousBaseUrl) {
    parts.push(`Turning this off restores your previous base URL (${details.previousBaseUrl}).`);
  }
  parts.push('Restart opencode after changing this.');
  // The daemon resolves this from the GUI-launched environment, which can
  // differ from the shell opencode runs in — show it so a mismatch is visible.
  if (details?.configPath) parts.push(`Config file: ${details.configPath}`);
  return parts.join(' ');
}
