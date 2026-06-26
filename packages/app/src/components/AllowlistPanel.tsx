import React, { useMemo, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import type { SecurityAllowlistEntry } from '@sentinel/shared';
import { useSecurityAllowlist } from '../hooks/useSecurityAllowlist.js';
import { useInlineConfirm } from '../hooks/useInlineConfirm.js';
import { FilterChip } from './FilterChip.js';
import { SearchInput } from './settings/primitives.js';

/**
 * Scanning-allowlist manager: the matches a user has chosen to always allow,
 * grouped by detector category with a search box. Extracted from
 * SecurityRulesOverlay so it can render inline in the Settings overlay's
 * Security › Scanning sub-tab (the single source of truth for this config).
 */
type AllowlistCategory = 'secrets' | 'injection' | 'bash' | 'write' | 'webfetch' | 'other';

interface CategoryMeta {
  id: AllowlistCategory;
  label: string;
  tone: 'red' | 'orange' | 'green' | 'blue' | undefined;
}

const CATEGORY_ORDER: CategoryMeta[] = [
  { id: 'secrets', label: 'Secrets', tone: 'red' },
  { id: 'injection', label: 'Prompt injection', tone: 'orange' },
  { id: 'bash', label: 'Risky bash', tone: 'orange' },
  { id: 'write', label: 'Risky write', tone: 'orange' },
  { id: 'webfetch', label: 'Risky webfetch', tone: 'orange' },
  { id: 'other', label: 'Other', tone: undefined },
];

const SECRET_DETECTORS = new Set<string>([
  'aws-access-key',
  'github-ghp',
  'github-pat',
  'github-oauth',
  'anthropic-key',
  'openai-project',
  'openai-legacy',
  'slack-token',
  'stripe-live-secret',
  'stripe-live-restricted',
  'google-api-key',
  'hf-token',
  'npm-token',
  'npmrc-auth',
  'google-oauth-refresh',
  'private-key-block',
  'private-key-header-doc',
]);

const INJECTION_DETECTORS = new Set<string>([
  'unicode-tag-chars',
  'ignore-instructions',
  'jailbreak-persona',
  'role-impersonation',
]);

const BASH_DETECTORS = new Set<string>([
  'curl-pipe-shell',
  'eval-curl',
  'reverse-shell-devtcp',
  'reverse-shell-bashi',
  'netcat-listen',
  'rm-rf-root',
  'ssh-authorized-keys',
  'aws-credentials-write',
  'cron-install',
  'launch-daemon',
  'base64-decode-exec',
  'curl-exfil-post',
  'curl-token-header',
  'history-wipe',
  'chmod-world-writable',
]);

function categorize(detectorId: string): AllowlistCategory {
  if (SECRET_DETECTORS.has(detectorId)) return 'secrets';
  if (INJECTION_DETECTORS.has(detectorId)) return 'injection';
  if (BASH_DETECTORS.has(detectorId)) return 'bash';
  if (detectorId.startsWith('risky-write-')) return 'write';
  if (detectorId.startsWith('risky-webfetch-')) return 'webfetch';
  return 'other';
}

type AllowlistFilter = 'all' | AllowlistCategory;

export default function AllowlistPanel(): React.ReactElement {
  const { entries, loading, error, remove } = useSecurityAllowlist();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<AllowlistFilter>('all');

  const counts = useMemo(() => {
    const m: Record<AllowlistCategory, number> = {
      secrets: 0,
      injection: 0,
      bash: 0,
      write: 0,
      webfetch: 0,
      other: 0,
    };
    for (const e of entries) m[categorize(e.detectorId)] += 1;
    return m;
  }, [entries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (filter !== 'all' && categorize(e.detectorId) !== filter) return false;
      if (q) {
        const hay = [e.title ?? '', e.detectorId, e.matchMask ?? '', e.note ?? '']
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [entries, search, filter]);

  const grouped = useMemo(() => {
    const m: Record<AllowlistCategory, SecurityAllowlistEntry[]> = {
      secrets: [],
      injection: [],
      bash: [],
      write: [],
      webfetch: [],
      other: [],
    };
    for (const e of filtered) m[categorize(e.detectorId)].push(e);
    return m;
  }, [filtered]);

  const filtersActive = search.trim() !== '' || filter !== 'all';
  const clearFilters = (): void => {
    setSearch('');
    setFilter('all');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 gap-2 text-muted">
        <Loader2 size={12} className="animate-spin" />
        <span className="text-[11px]">Loading allowlist…</span>
      </div>
    );
  }
  if (error) return <p className="text-[12px] text-ios-red px-1">{error}</p>;

  return (
    <>
      <p className="text-[11px] text-muted leading-snug px-3 pt-2.5">
        Matches you&apos;ve chosen to always allow. Entries here are silently suppressed across
        every future scan. Added by clicking <span className="font-semibold">Always allow</span> on
        a finding in the Security tab.
      </p>

      {entries.length > 0 && (
        <div className="space-y-2 px-3 pt-1">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search title, detector, match, or note"
          />
          <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
            <FilterChip
              label={`All (${entries.length})`}
              active={filter === 'all'}
              onClick={() => setFilter('all')}
            />
            {CATEGORY_ORDER.map((cat) => {
              const count = counts[cat.id];
              if (count === 0) return null;
              const onClick = (): void => setFilter(filter === cat.id ? 'all' : cat.id);
              return cat.tone ? (
                <FilterChip
                  key={cat.id}
                  label={cat.label}
                  count={count}
                  active={filter === cat.id}
                  onClick={onClick}
                  tone={cat.tone}
                />
              ) : (
                <FilterChip
                  key={cat.id}
                  label={cat.label}
                  count={count}
                  active={filter === cat.id}
                  onClick={onClick}
                />
              );
            })}
            {filtersActive && (
              <button
                onClick={clearFilters}
                className="ml-auto text-[11px] font-medium text-ios-blue hover:opacity-80 active:scale-95"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {entries.length === 0 && (
        <div className="glass-card px-4 py-6 text-center">
          <p className="text-[12px] text-muted">
            No entries yet. Click <span className="font-semibold">Always allow</span> on a
            Security-tab event to add one.
          </p>
        </div>
      )}

      {entries.length > 0 && filtered.length === 0 && (
        <p className="text-[11px] text-muted px-1">No entries match the current filter.</p>
      )}

      {filtered.length > 0 && (
        <div className="space-y-4">
          {CATEGORY_ORDER.map((cat) => {
            const items = grouped[cat.id];
            if (items.length === 0) return null;
            return (
              <div key={cat.id}>
                <p className="section-label">{cat.label}</p>
                <div className="glass-card divide-y divide-black/5 dark:divide-white/5 mt-2">
                  {items.map((entry) => (
                    <AllowlistRow key={entry.id} entry={entry} onRemove={() => remove(entry.id)} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function AllowlistRow({
  entry,
  onRemove,
}: {
  entry: SecurityAllowlistEntry;
  onRemove: () => Promise<void>;
}): React.ReactElement {
  const { pending, trigger } = useInlineConfirm(onRemove);
  const when = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(entry.createdAt));
  return (
    <div className="flex items-start gap-2 px-3 py-2">
      <div className="flex-1 min-w-0">
        <p className="text-[12px] font-semibold text-black dark:text-white truncate">
          {entry.title ?? entry.detectorId}
        </p>
        <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
          {entry.matchMask && (
            <code className="text-[10px] font-mono bg-muted/10 px-1 py-0.5 rounded truncate">
              {entry.matchMask}
            </code>
          )}
          <span className="text-[10px] text-muted">added {when}</span>
        </div>
        {entry.note && <p className="text-[10px] text-muted mt-1 leading-snug">{entry.note}</p>}
      </div>
      <button
        onClick={trigger}
        className={`flex-shrink-0 flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full transition-all active:scale-95 ${
          pending ? 'bg-ios-red text-white' : 'bg-ios-red/10 text-ios-red hover:bg-ios-red/20'
        }`}
        title={pending ? 'Click again to remove' : 'Remove from allowlist'}
      >
        <Trash2 size={10} strokeWidth={2.5} />
        {pending ? 'Confirm?' : 'Remove'}
      </button>
    </div>
  );
}
