import React from 'react';
import { motion } from 'motion/react';

export default function ReplayIllustration({
  className,
}: {
  className?: string;
}): React.ReactElement {
  const cx = 100;
  const cy = 42;
  const r = 18;
  return (
    <svg
      viewBox="0 0 200 80"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      {/* Background pulse */}
      <motion.circle
        cx={cx}
        cy={cy}
        r={r + 4}
        fill="currentColor"
        opacity={0.12}
        initial={{ scale: 0.9 }}
        animate={{ scale: [0.9, 1.1, 0.9] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
        style={{ originX: `${cx}px`, originY: `${cy}px` }}
      />
      {/* Static framing ring around the help mark — gives the icon a
          finished silhouette now that the rotating arrow has been removed. */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.45}
        strokeWidth={2}
      />
      {/* Center help mark */}
      <text
        x={cx}
        y={cy + 5}
        textAnchor="middle"
        fontSize={16}
        fontWeight={700}
        fill="currentColor"
        fontFamily="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif"
      >
        ?
      </text>
    </svg>
  );
}
