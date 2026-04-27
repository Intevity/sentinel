import React from 'react';
import { motion } from 'motion/react';

export default function BudgetIllustration({
  className,
}: {
  className?: string;
}): React.ReactElement {
  // Arc from 0 to ~70% of full circle. Drawn as a stroke-dashed circle so we can
  // animate the dash offset for the fill animation.
  const cx = 100;
  const cy = 42;
  const r = 22;
  const circumference = 2 * Math.PI * r;
  const fillFraction = 0.7;
  return (
    <svg viewBox="0 0 200 80" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      {/* Track */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.18}
        strokeWidth={5}
      />
      {/* Filled arc */}
      <motion.circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray={circumference}
        initial={{ strokeDashoffset: circumference }}
        animate={{ strokeDashoffset: circumference * (1 - fillFraction) }}
        transition={{ duration: 1.4, ease: [0.16, 1, 0.3, 1] }}
        style={{ transform: `rotate(-90deg)`, transformOrigin: `${cx}px ${cy}px` }}
      />
      {/* Dollar glyph in the middle */}
      <text
        x={cx}
        y={cy + 5}
        textAnchor="middle"
        fontSize={20}
        fontWeight={700}
        fill="currentColor"
        fontFamily="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif"
      >
        $
      </text>
    </svg>
  );
}
