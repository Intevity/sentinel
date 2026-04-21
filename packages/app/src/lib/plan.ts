/**
 * Plan-type display helpers shared between the Accounts tab and the app
 * header. Source of truth was inlined in AccountCard.tsx; moved here so the
 * header can render the same "(Max)" / "(Team)" label without duplicating
 * the lookup table.
 *
 * `billingType` on OAuthAccount and `planType` on AccountInfo converge on
 * the same string set: 'pro' | 'max' | 'team' | 'enterprise'. Unknown
 * values fall through to the raw string so new tiers surface immediately.
 */

interface PlanMeta {
  label: string;
  /** Tailwind classes: background tint + text color for the pill variant. */
  color: string;
}

const PLAN_META: Record<string, PlanMeta> = {
  pro: { label: 'Pro', color: 'bg-ios-blue/10 text-ios-blue' },
  max: { label: 'Max', color: 'bg-ios-purple/10 text-ios-purple' },
  team: { label: 'Team', color: 'bg-ios-indigo/10 text-ios-indigo' },
  enterprise: { label: 'Enterprise', color: 'bg-ios-orange/10 text-ios-orange' },
};

const UNKNOWN_COLOR = 'bg-[#8E8E93]/10 text-[#8E8E93]';

/** Human-readable plan label. Capitalizes the first letter when the tier
 *  isn't in our known list so new plans appear reasonably. */
export function planLabel(planType: string | null | undefined): string {
  if (!planType) return '';
  const meta = PLAN_META[planType];
  if (meta) return meta.label;
  return planType.charAt(0).toUpperCase() + planType.slice(1);
}

/** Pill classes (bg + fg) for a plan chip. */
export function planColor(planType: string | null | undefined): string {
  if (!planType) return UNKNOWN_COLOR;
  return PLAN_META[planType]?.color ?? UNKNOWN_COLOR;
}
