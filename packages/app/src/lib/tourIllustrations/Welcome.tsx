import React from 'react';
import { motion } from 'motion/react';

export default function WelcomeIllustration({
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
      <defs>
        <linearGradient id="welcome-shield" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.95" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <motion.g
        initial={{ scale: 0.85, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Shield body */}
        <path
          d="M100 18 L120 24 V42 C120 52 110 60 100 64 C90 60 80 52 80 42 V24 Z"
          fill="url(#welcome-shield)"
        />
        {/* Inner check */}
        <path
          d="M91 41 L98 48 L110 35"
          fill="none"
          stroke="white"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </motion.g>
      {/* Orbiting sparkles */}
      <motion.g
        style={{ originX: '100px', originY: '42px' }}
        animate={{ rotate: 360 }}
        transition={{ duration: 16, ease: 'linear', repeat: Infinity }}
      >
        <Sparkle x={148} y={28} size={6} />
        <Sparkle x={56} y={52} size={4} />
        <Sparkle x={140} y={62} size={5} />
        <Sparkle x={64} y={20} size={5} />
      </motion.g>
    </svg>
  );
}

function Sparkle({ x, y, size }: { x: number; y: number; size: number }): React.ReactElement {
  return (
    <path
      d={`M${x} ${y - size} L${x + size * 0.35} ${y - size * 0.35} L${x + size} ${y} L${x + size * 0.35} ${y + size * 0.35} L${x} ${y + size} L${x - size * 0.35} ${y + size * 0.35} L${x - size} ${y} L${x - size * 0.35} ${y - size * 0.35} Z`}
      fill="currentColor"
      opacity={0.7}
    />
  );
}
