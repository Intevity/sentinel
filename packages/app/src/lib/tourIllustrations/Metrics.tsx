import React from 'react';
import { motion } from 'motion/react';

export default function MetricsIllustration({
  className,
}: {
  className?: string;
}): React.ReactElement {
  // Five bars with an upward trend line connecting their tops.
  const bars = [
    { x: 60, h: 22 },
    { x: 76, h: 30 },
    { x: 92, h: 26 },
    { x: 108, h: 38 },
    { x: 124, h: 46 },
  ];
  const baseline = 64;
  const linePath = bars
    .map((b, i) => {
      const x = b.x + 5;
      const y = baseline - b.h - 4;
      return `${i === 0 ? 'M' : 'L'}${x} ${y}`;
    })
    .join(' ');
  return (
    <svg
      viewBox="0 0 200 80"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      {/* Bars */}
      {bars.map((b, i) => (
        <motion.rect
          key={b.x}
          x={b.x}
          y={baseline - b.h}
          width={10}
          height={b.h}
          rx={2}
          fill="currentColor"
          opacity={0.7}
          initial={{ scaleY: 0, originY: baseline }}
          animate={{ scaleY: 1 }}
          transition={{ duration: 0.5, delay: 0.06 * i, ease: [0.16, 1, 0.3, 1] }}
          style={{ transformOrigin: `${b.x + 5}px ${baseline}px` }}
        />
      ))}
      {/* Trend line */}
      <motion.path
        d={linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.7, delay: 0.4, ease: 'easeOut' }}
      />
      {/* Trend dots */}
      {bars.map((b, i) => (
        <motion.circle
          key={b.x}
          cx={b.x + 5}
          cy={baseline - b.h - 4}
          r={2}
          fill="currentColor"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2, delay: 0.4 + 0.06 * i }}
        />
      ))}
      {/* Baseline */}
      <line
        x1={50}
        y1={baseline + 1}
        x2={142}
        y2={baseline + 1}
        stroke="currentColor"
        strokeOpacity={0.25}
        strokeWidth={1}
      />
    </svg>
  );
}
