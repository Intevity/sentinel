import React from 'react';
import { motion } from 'motion/react';

export default function AutoSwitchIllustration({
  className,
}: {
  className?: string;
}): React.ReactElement {
  // Three account dots evenly spaced around a 26px radius ring centered at (100,42)
  const dots = [
    { angle: -90, color: '#0A84FF' },
    { angle: 30, color: '#32D74B' },
    { angle: 150, color: '#FF9F0A' },
  ];
  const cx = 100;
  const cy = 42;
  const r = 22;
  return (
    <svg viewBox="0 0 200 80" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      {/* Rotating dashed orbit */}
      <motion.g
        style={{ originX: `${cx}px`, originY: `${cy}px` }}
        animate={{ rotate: 360 }}
        transition={{ duration: 14, ease: 'linear', repeat: Infinity }}
      >
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.55}
          strokeWidth={1.5}
          strokeDasharray="3 4"
        />
      </motion.g>
      {/* Static account dots */}
      {dots.map((d) => {
        const rad = (d.angle * Math.PI) / 180;
        const x = cx + r * Math.cos(rad);
        const y = cy + r * Math.sin(rad);
        return (
          <g key={d.angle}>
            <circle cx={x} cy={y} r={6} fill={d.color} />
            <circle
              cx={x}
              cy={y}
              r={9}
              fill="none"
              stroke={d.color}
              strokeOpacity={0.25}
              strokeWidth={1}
            />
          </g>
        );
      })}
      {/* Center hub with rotation arrows */}
      <circle cx={cx} cy={cy} r={9} fill="currentColor" opacity={0.92} />
      <motion.g
        style={{ originX: `${cx}px`, originY: `${cy}px` }}
        animate={{ rotate: 360 }}
        transition={{ duration: 4.5, ease: 'linear', repeat: Infinity }}
      >
        <path
          d={`M${cx - 4} ${cy - 1} A4 4 0 1 1 ${cx + 4} ${cy + 1}`}
          fill="none"
          stroke="white"
          strokeWidth={1.6}
          strokeLinecap="round"
        />
        <path
          d={`M${cx + 3} ${cy - 2} L${cx + 4.5} ${cy + 1} L${cx + 1.5} ${cy + 0.5} Z`}
          fill="white"
        />
      </motion.g>
    </svg>
  );
}
