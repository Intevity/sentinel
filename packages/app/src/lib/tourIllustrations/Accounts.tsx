import React from 'react';
import { motion } from 'motion/react';

const AVATAR_COLORS = ['#0A84FF', '#32D74B', '#FF9F0A'];

export default function AccountsIllustration({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <svg viewBox="0 0 200 80" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      {AVATAR_COLORS.map((color, i) => (
        <motion.g
          key={color}
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.08 * i, ease: [0.16, 1, 0.3, 1] }}
        >
          {/* Card */}
          <rect
            x={50 + i * 28}
            y={18 + i * 6}
            width={100}
            height={36}
            rx={8}
            fill="white"
            stroke="currentColor"
            strokeOpacity={0.18}
            strokeWidth={1}
          />
          {/* Avatar dot */}
          <circle cx={62 + i * 28} cy={36 + i * 6} r={6} fill={color} />
          {/* Name line */}
          <rect
            x={74 + i * 28}
            y={28 + i * 6}
            width={50}
            height={5}
            rx={2.5}
            fill="currentColor"
            opacity={0.55}
          />
          {/* Sub line */}
          <rect
            x={74 + i * 28}
            y={38 + i * 6}
            width={32}
            height={4}
            rx={2}
            fill="currentColor"
            opacity={0.25}
          />
          {/* Mini progress bar */}
          <rect
            x={74 + i * 28}
            y={46 + i * 6}
            width={60}
            height={3}
            rx={1.5}
            fill="currentColor"
            opacity={0.12}
          />
          <rect
            x={74 + i * 28}
            y={46 + i * 6}
            width={60 * (0.4 + i * 0.2)}
            height={3}
            rx={1.5}
            fill={color}
          />
        </motion.g>
      ))}
    </svg>
  );
}
