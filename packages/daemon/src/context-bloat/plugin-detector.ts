/**
 * Detect Claude Code plugins/skills enabled via
 * `~/.claude/settings.json#/enabledPlugins`. Each enabled plugin
 * contributes tool definitions to every request's context, so the
 * Optimize tab surfaces the count and (when available) the names so
 * users can prune ones they don't actively use.
 */

export interface DetectedPlugin {
  name: string;
}

interface SettingsShape {
  enabledPlugins?: Record<string, unknown>;
}

/**
 * Pure parse of an already-deserialised settings.json. Filters to keys
 * whose value is truthy — Claude Code stores `true` for active plugins
 * and `false` for explicitly-disabled ones, so a key with a falsy
 * value is not contributing to context.
 */
export function detectPlugins(settings: unknown): DetectedPlugin[] {
  if (!settings || typeof settings !== 'object') return [];
  const ep = (settings as SettingsShape).enabledPlugins;
  if (!ep || typeof ep !== 'object') return [];
  const out: DetectedPlugin[] = [];
  for (const [name, value] of Object.entries(ep)) {
    if (value) out.push({ name });
  }
  return out;
}
