import React from 'react';
import { motion } from 'motion/react';

export default function AlertsIllustration({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <svg
      viewBox="0 0 200 80"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      {/* Pulsing radial waves */}
      {[0, 0.6, 1.2].map((delay, i) => (
        <motion.circle
          key={i}
          cx={100}
          cy={42}
          r={14}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          initial={{ scale: 1, opacity: 0.65 }}
          animate={{ scale: 2.4, opacity: 0 }}
          transition={{ duration: 2.0, delay, repeat: Infinity, ease: 'easeOut' }}
          style={{ originX: '100px', originY: '42px' }}
        />
      ))}
      {/* Bell body */}
      <motion.g
        initial={{ y: -2 }}
        animate={{ y: [0, -2, 2, -1, 1, 0] }}
        transition={{ duration: 2.0, repeat: Infinity, repeatDelay: 0.4 }}
        style={{ originX: '100px', originY: '30px' }}
      >
        <path
          d="M100 22 C107 22 112 28 112 36 V46 L116 50 H84 L88 46 V36 C88 28 93 22 100 22 Z"
          fill="currentColor"
          opacity={0.95}
        />
        <circle cx={100} cy={20} r={2.5} fill="currentColor" />
        {/* Clapper */}
        <path
          d="M96 50 C96 53 98 55 100 55 C102 55 104 53 104 50 Z"
          fill="currentColor"
        />
      </motion.g>
    </svg>
  );
}
