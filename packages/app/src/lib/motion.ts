import type { Variants } from 'motion/react';

export const DUR = { fast: 0.15, med: 0.2, slow: 0.25, bar: 0.45 } as const;
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
export const EASE_STD = [0.4, 0, 0.2, 1] as const;

export const menuPop: Variants = {
  initial: { opacity: 0, scale: 0.95, y: -4 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { duration: DUR.fast, ease: EASE_OUT } },
  exit: { opacity: 0, scale: 0.95, y: -4, transition: { duration: DUR.fast } },
};

export const panelSlide: Variants = {
  initial: { opacity: 0, x: 20 },
  animate: { opacity: 1, x: 0, transition: { duration: DUR.slow, ease: EASE_OUT } },
  exit: { opacity: 0, x: 20, transition: { duration: DUR.med } },
};
