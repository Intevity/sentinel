import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { RoundRobinStrategy } from '@claude-sentinel/shared';
import { menuPop } from '../lib/motion.js';

interface RoundRobinStrategyMenuProps {
  value: RoundRobinStrategy;
  onChange: (v: RoundRobinStrategy) => void;
}

interface StrategyOption {
  value: RoundRobinStrategy;
  label: string;
  description: string;
}

const OPTIONS: StrategyOption[] = [
  {
    value: 'balance',
    label: 'Balance',
    description: 'Spread requests evenly across accounts.',
  },
  {
    value: 'earliest-reset',
    label: 'Earliest reset',
    description: 'Pin to the account whose window resets soonest.',
  },
];

/** Discreet chevron-trigger popover that lets users pick the round-robin
 *  strategy without opening Settings. Mirrors `HeaderMenu.tsx`'s structure:
 *  relative wrapper, click-outside handler on document, `AnimatePresence`
 *  + `menuPop` for the reveal. */
export default function RoundRobinStrategyMenu({
  value,
  onChange,
}: RoundRobinStrategyMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (v: RoundRobinStrategy): void => {
    onChange(v);
    setOpen(false);
  };

  const activeLabel = OPTIONS.find((o) => o.value === value)?.label ?? 'Balance';

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Rotation strategy: ${activeLabel}. Click to change.`}
        className="text-muted hover:text-black dark:hover:text-white transition-colors active:scale-90 p-0.5 -m-0.5 flex items-center"
      >
        <ChevronDown
          size={12}
          strokeWidth={2.5}
          className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            {...menuPop}
            style={{ transformOrigin: 'top left' }}
            role="menu"
            aria-label="Round-robin strategy"
            className="absolute left-0 top-full mt-1 z-30 min-w-[240px] rounded-xl bg-white dark:bg-[#2A2A2C] shadow-lg ring-1 ring-black/10 dark:ring-white/10 overflow-hidden"
          >
            <div className="px-3 py-2 border-b border-black/5 dark:border-white/5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                Rotation strategy
              </p>
            </div>
            {OPTIONS.map((opt) => {
              const active = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => pick(opt.value)}
                  className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors"
                >
                  <span
                    className={`flex-shrink-0 mt-[5px] w-2 h-2 rounded-full ${
                      active ? 'bg-ios-blue' : 'bg-muted/30'
                    }`}
                    aria-hidden
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-[12px] font-medium text-black dark:text-white">
                      {opt.label}
                    </span>
                    <span className="block text-[10px] text-muted leading-snug">
                      {opt.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
