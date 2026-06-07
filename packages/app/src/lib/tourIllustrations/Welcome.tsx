import React from 'react';
import { motion } from 'motion/react';
import sentinelMascot from '../../assets/sentinelMascot.png';

export default function WelcomeIllustration({
  className,
}: {
  className?: string;
}): React.ReactElement {
  return (
    <svg viewBox="0 0 200 80" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      {/* Orbiting sparkles behind the mascot, kept from the original welcome
          art for continuity. */}
      <motion.g
        style={{ originX: '100px', originY: '40px' }}
        animate={{ rotate: 360 }}
        transition={{ duration: 16, ease: 'linear', repeat: Infinity }}
      >
        <Sparkle x={150} y={24} size={6} />
        <Sparkle x={50} y={28} size={5} />
        <Sparkle x={58} y={62} size={4} />
        <Sparkle x={146} y={60} size={4} />
      </motion.g>
      {/* Mascot: scales in on open (outer group), then gently bobs forever
          (inner group translates so it never fights the scale transform). */}
      <motion.g
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        style={{ originX: '100px', originY: '40px' }}
      >
        <motion.g
          animate={{ y: [0, -3, 0] }}
          transition={{ duration: 3, ease: 'easeInOut', repeat: Infinity }}
        >
          <image
            href={sentinelMascot}
            x={66}
            y={9}
            width={68}
            height={62}
            preserveAspectRatio="xMidYMid meet"
          />
        </motion.g>
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
