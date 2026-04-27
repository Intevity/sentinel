import React from 'react';
import { motion } from 'motion/react';

export default function PermissionsIllustration({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <svg viewBox="0 0 200 80" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      {/* Allow row */}
      <motion.g
        initial={{ x: -8, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
      >
        <rect
          x={50}
          y={18}
          width={100}
          height={18}
          rx={5}
          fill="white"
          stroke="currentColor"
          strokeOpacity={0.18}
          strokeWidth={1}
        />
        <circle cx={62} cy={27} r={6} fill="#32D74B" />
        <path
          d="M59 27 L61 29 L65 24"
          fill="none"
          stroke="white"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect x={74} y={23} width={56} height={3.5} rx={1.5} fill="currentColor" opacity={0.6} />
        <rect x={74} y={29} width={36} height={3} rx={1.5} fill="currentColor" opacity={0.25} />
      </motion.g>
      {/* Deny row */}
      <motion.g
        initial={{ x: 8, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
      >
        <rect
          x={50}
          y={44}
          width={100}
          height={18}
          rx={5}
          fill="white"
          stroke="currentColor"
          strokeOpacity={0.18}
          strokeWidth={1}
        />
        <circle cx={62} cy={53} r={6} fill="#FF453A" />
        <path
          d="M59 50 L65 56 M65 50 L59 56"
          stroke="white"
          strokeWidth={1.6}
          strokeLinecap="round"
        />
        <rect x={74} y={49} width={48} height={3.5} rx={1.5} fill="currentColor" opacity={0.6} />
        <rect x={74} y={55} width={28} height={3} rx={1.5} fill="currentColor" opacity={0.25} />
      </motion.g>
    </svg>
  );
}
