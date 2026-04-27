import React from 'react';
import { motion } from 'motion/react';

export default function SecurityIllustration({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <svg viewBox="0 0 200 80" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <defs>
        <linearGradient id="sec-shield" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.95" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.55" />
        </linearGradient>
        <clipPath id="sec-shield-clip">
          <path d="M100 14 L124 22 V44 C124 56 113 65 100 70 C87 65 76 56 76 44 V22 Z" />
        </clipPath>
      </defs>
      {/* Shield body */}
      <path
        d="M100 14 L124 22 V44 C124 56 113 65 100 70 C87 65 76 56 76 44 V22 Z"
        fill="url(#sec-shield)"
      />
      {/* Scan line sweeping vertically inside the shield */}
      <g clipPath="url(#sec-shield-clip)">
        <motion.rect
          x={76}
          width={48}
          height={4}
          fill="white"
          opacity={0.65}
          initial={{ y: 14 }}
          animate={{ y: 64 }}
          transition={{ duration: 2.4, repeat: Infinity, repeatType: 'mirror', ease: 'easeInOut' }}
        />
      </g>
      {/* Inner lock outline */}
      <rect
        x={91}
        y={36}
        width={18}
        height={14}
        rx={2}
        fill="none"
        stroke="white"
        strokeWidth={1.6}
      />
      <path d="M94 36 V32 A6 6 0 0 1 106 32 V36" fill="none" stroke="white" strokeWidth={1.6} />
    </svg>
  );
}
