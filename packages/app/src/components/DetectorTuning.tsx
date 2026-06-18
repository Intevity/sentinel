import React, { useMemo, useState } from 'react';
import type { DetectorStatsRow, DetectorTier, Settings } from '@sentinel/shared';
import { useDetectorStats } from '../hooks/useDetectorStats.js';

interface DetectorTuningProps {
  settings: Settings;
  onUpdate: (patch: Partial<Settings>) => Promise<void>;
}

/**
 * Per-detector visibility tier UI for Settings > Security > Detectors.
 *
 * Each row shows a 30-day activity badge (total / blocked / approved /
 * acknowledged) and a 3-way radio: Active, Informational, Disabled.
 * Sorted by total events descending so the loudest rules surface at the
 * top. Search box filters by detector id (case-insensitive substring).
 *
 * On change, dispatches `update_settings` with the full
 * `detectorOverrides` map (the daemon's parse layer uses replace
 * semantics, so the patch fully specifies the new override state).
 *
 * Caveat note in the UI: `Disabled` short-circuits the detector at scan
 * time, which means it also stops contributing to the block-decision
 * path. Users who want noise reduction without losing block coverage
 * should pick `Informational` instead.
 */
export function DetectorTuning({ settings, onUpdate }: DetectorTuningProps): React.ReactElement {
  const { rows, loading, error } = useDetectorStats();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search) return rows;
    const needle = search.toLowerCase();
    return rows.filter((r) => r.detectorId.toLowerCase().includes(needle));
  }, [rows, search]);

  const setTier = async (detectorId: string, tier: DetectorTier): Promise<void> => {
    const next = { ...(settings.detectorOverrides ?? {}) };
    if (tier === 'active') {
      // Active is the default; remove the explicit override so the map
      // stays minimal and the UI's "no override" state is unambiguous.
      delete next[detectorId];
    } else {
      next[detectorId] = tier;
    }
    await onUpdate({ detectorOverrides: next });
  };

  if (loading) {
    return <div className="px-3 py-3 text-[11px] text-muted">Loading detector stats...</div>;
  }
  if (error) {
    return <div className="px-3 py-3 text-[11px] text-ios-red">{error}</div>;
  }
  if (rows.length === 0) {
    return (
      <div className="px-3 py-3 text-[11px] text-muted">
        No detector activity in the last 30 days. Tiers can still be set manually if you know a
        detector id, but the typical workflow is to let the auto-demote migration handle this.
      </div>
    );
  }

  return (
    <div>
      <div className="px-3 pt-2 pb-1.5 text-[11px] text-muted leading-snug">
        Per-detector visibility over the last 30 days. <strong>Active</strong> is the default:
        events show in the banner and Alerts tab. <strong>Informational</strong> still records
        events for audit but hides them from the banner, useful for chronically noisy detectors that
        have never blocked or required approval. <strong>Disabled</strong> stops the detector
        running entirely, which also removes it from the block-decision path: prefer Informational
        for noise reduction.
      </div>
      <div className="px-3 pb-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search detector id"
          className="w-full text-[12px] px-2 py-1 rounded bg-muted/10 placeholder-muted focus:outline-none focus:bg-muted/20"
        />
      </div>
      <div className="divide-y divide-black/5 dark:divide-white/5">
        {filtered.map((row) => (
          <DetectorRow
            key={row.detectorId}
            row={row}
            onChange={(t) => setTier(row.detectorId, t)}
          />
        ))}
        {filtered.length === 0 && (
          <div className="px-3 py-3 text-[11px] text-muted">No detectors match.</div>
        )}
      </div>
    </div>
  );
}

function DetectorRow({
  row,
  onChange,
}: {
  row: DetectorStatsRow;
  onChange: (tier: DetectorTier) => Promise<void>;
}): React.ReactElement {
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-start gap-2 mb-1.5">
        <code className="flex-1 text-[12px] font-mono text-black dark:text-white truncate">
          {row.detectorId}
        </code>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap mb-2 text-[10px]">
        <Badge label="total" value={row.total} tone="muted" />
        <Badge label="blocked" value={row.blocked} tone={row.blocked > 0 ? 'red' : 'muted'} />
        <Badge label="approved" value={row.approved} tone={row.approved > 0 ? 'green' : 'muted'} />
        <Badge label="acknowledged" value={row.acknowledged} tone="muted" />
        <Badge label="conf" value={row.avgConfidence.toFixed(2)} tone="muted" />
      </div>
      <div className="flex items-center gap-3 text-[11px]">
        <TierRadio
          label="Active"
          current={row.override}
          target="active"
          onSelect={() => onChange('active')}
        />
        <TierRadio
          label="Informational"
          current={row.override}
          target="informational"
          onSelect={() => onChange('informational')}
        />
        <TierRadio
          label="Disabled"
          current={row.override}
          target="disabled"
          onSelect={() => onChange('disabled')}
        />
      </div>
    </div>
  );
}

function Badge({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | string;
  tone: 'muted' | 'red' | 'green';
}): React.ReactElement {
  const cls =
    tone === 'red'
      ? 'bg-ios-red/10 text-ios-red'
      : tone === 'green'
        ? 'bg-ios-green/10 text-ios-green'
        : 'bg-muted/10 text-muted';
  return (
    <span className={`px-1.5 py-0.5 rounded ${cls}`}>
      {label}: <span className="font-semibold">{value}</span>
    </span>
  );
}

function TierRadio({
  label,
  current,
  target,
  onSelect,
}: {
  label: string;
  current: DetectorTier;
  target: DetectorTier;
  onSelect: () => void | Promise<void>;
}): React.ReactElement {
  const checked = current === target;
  return (
    <label className="inline-flex items-center gap-1 cursor-pointer">
      <input
        type="radio"
        checked={checked}
        onChange={() => void onSelect()}
        className="accent-ios-blue w-3 h-3"
      />
      <span className={checked ? 'font-semibold text-black dark:text-white' : 'text-muted'}>
        {label}
      </span>
    </label>
  );
}
