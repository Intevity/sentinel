import React, { useMemo, useState } from 'react';
import { HexColorPicker, HexColorInput } from 'react-colorful';
import { X, RotateCcw } from 'lucide-react';
import type { AccountInfo } from '@claude-sentinel/shared';
import { sendToSentinel } from '../lib/ipc.js';
import { accountColor, PRESET_SWATCHES } from '../lib/accountColor.js';

interface Props {
  account: AccountInfo;
  onClose: () => void;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

export default function AccountColorPicker({ account, onClose }: Props): React.ReactElement {
  // Seed the picker with the current resolved color so the wheel and hex
  // field start where the user expects, even for accounts that inherit the
  // default gradient.
  const initial = useMemo(() => accountColor(account).toUpperCase(), [account]);
  const [color, setColor] = useState<string>(initial);
  const [saving, setSaving] = useState(false);

  const rgb = hexToRgb(color) ?? { r: 0, g: 122, b: 255 };
  const setRgb = (patch: Partial<{ r: number; g: number; b: number }>): void => {
    setColor(rgbToHex(patch.r ?? rgb.r, patch.g ?? rgb.g, patch.b ?? rgb.b));
  };

  const save = async (next: string | null): Promise<void> => {
    setSaving(true);
    try {
      await sendToSentinel({ type: 'update_account', accountId: account.id, color: next });
    } finally {
      setSaving(false);
      onClose();
    }
  };

  const label = account.displayName || account.email;

  return (
    <div className="absolute inset-0 bg-black/40 z-40 flex items-center justify-center p-3">
      <div className="bg-white dark:bg-[#1E1E1E] rounded-2xl shadow-card max-w-[380px] w-full max-h-full overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-black/5 dark:border-white/5">
          <h2 className="text-[14px] font-semibold text-black dark:text-white truncate pr-2">
            Avatar color · {label}
          </h2>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-full hover:bg-[#8E8E93]/10 flex items-center justify-center flex-shrink-0"
            title="Close"
            aria-label="Close"
          >
            <X size={14} className="text-[#8E8E93]" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-4">
          <div className="flex gap-3 items-start">
            <div className="color-picker-wrap flex-1 min-w-0">
              <HexColorPicker color={color} onChange={(c) => setColor(c.toUpperCase())} />
            </div>
            <div
              className="w-14 h-14 rounded-full shadow-sm flex-shrink-0 ring-1 ring-black/5 dark:ring-white/10"
              style={{ backgroundImage: `linear-gradient(to bottom right, ${color}, ${color})` }}
              aria-label="Preview"
            />
          </div>

          <div className="grid grid-cols-4 gap-2">
            <div className="col-span-4">
              <label className="block text-[10px] font-semibold text-[#8E8E93] uppercase tracking-wider mb-1">Hex</label>
              <HexColorInput
                color={color}
                onChange={(c) => setColor(c.toUpperCase())}
                prefixed
                className="w-full text-[12px] font-mono px-2 py-1.5 rounded-lg bg-[#F2F2F7] dark:bg-[#2A2A2A] text-black dark:text-white outline-none focus:ring-2 focus:ring-ios-blue/40 uppercase"
              />
            </div>
            <RgbField label="R" value={rgb.r} onChange={(v) => setRgb({ r: v })} />
            <RgbField label="G" value={rgb.g} onChange={(v) => setRgb({ g: v })} />
            <RgbField label="B" value={rgb.b} onChange={(v) => setRgb({ b: v })} />
          </div>

          <div>
            <p className="text-[10px] font-semibold text-[#8E8E93] uppercase tracking-wider mb-1.5">Presets</p>
            <div className="flex items-center gap-2 flex-wrap">
              {PRESET_SWATCHES.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  onClick={() => setColor(hex)}
                  className={`w-7 h-7 rounded-full transition-transform active:scale-90 ring-1 ring-black/5 dark:ring-white/10 ${
                    color.toUpperCase() === hex ? 'ring-2 ring-ios-blue ring-offset-1 ring-offset-white dark:ring-offset-[#1E1E1E]' : ''
                  }`}
                  style={{ backgroundColor: hex }}
                  aria-label={`Pick ${hex}`}
                  title={hex}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              onClick={() => void save(null)}
              disabled={saving}
              className="inline-flex items-center gap-1 text-[11px] text-[#8E8E93] hover:text-black dark:hover:text-white transition-colors disabled:opacity-40"
              title="Clear the custom color and revert to the default gradient"
            >
              <RotateCcw size={11} />
              Reset to default
            </button>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                disabled={saving}
                className="text-[11px] font-medium px-3 py-1.5 rounded-lg text-[#8E8E93] hover:bg-[#8E8E93]/10 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={() => void save(color)}
                disabled={saving}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-ios-blue text-white hover:bg-ios-blue/90 active:scale-95 transition-all disabled:opacity-40"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RgbField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }): React.ReactElement {
  return (
    <label className="block">
      <span className="block text-[10px] font-semibold text-[#8E8E93] uppercase tracking-wider mb-1">{label}</span>
      <input
        type="number"
        min={0}
        max={255}
        value={value}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (Number.isFinite(n)) onChange(Math.max(0, Math.min(255, n)));
        }}
        className="w-full text-[12px] tabular-nums px-2 py-1.5 rounded-lg bg-[#F2F2F7] dark:bg-[#2A2A2A] text-black dark:text-white outline-none focus:ring-2 focus:ring-ios-blue/40"
      />
    </label>
  );
}
