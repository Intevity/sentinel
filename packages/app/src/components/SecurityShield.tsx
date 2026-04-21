import React from 'react';

interface SecurityShieldProps {
  scanOn: boolean;
  permsOn: boolean;
  size?: number;
}

const SHIELD_PATH =
  'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z';

// Diagonal from top-right (24,0) to bottom-left (0,24).
// Left of the diagonal (upper-left triangle) = scan layer.
// Right of the diagonal (lower-right triangle) = permissions layer.
const LEFT_CLIP = '0,0 24,0 0,24';
const RIGHT_CLIP = '24,0 24,24 0,24';

export default function SecurityShield({
  scanOn,
  permsOn,
  size = 16,
}: SecurityShieldProps): React.ReactElement {
  const anyOn = scanOn || permsOn;
  // Unique IDs avoid collisions if the icon ever renders twice on one page.
  // Strip colons from React.useId so SVG `url(#...)` resolvers don't fail.
  const baseId = React.useId().replace(/:/g, '');
  const leftClip = `${baseId}-scan`;
  const rightClip = `${baseId}-perms`;
  const title = `Security: scan ${scanOn ? 'on' : 'off'}, permissions ${permsOn ? 'on' : 'off'}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${anyOn ? 'text-ios-green' : 'text-[#8E8E93]'} flex-shrink-0 block`}
      aria-label={title}
      role="img"
    >
      <title>{title}</title>
      <defs>
        <clipPath id={leftClip}>
          <polygon points={LEFT_CLIP} />
        </clipPath>
        <clipPath id={rightClip}>
          <polygon points={RIGHT_CLIP} />
        </clipPath>
      </defs>
      {/* Grey outline underneath. Always drawn so the silhouette stays
          consistent with neighbouring header icons when a layer is off. */}
      <g className="text-[#8E8E93]">
        <path d={SHIELD_PATH} stroke="currentColor" />
      </g>
      {/* Green layer. Pulses to show "actively protecting". When both
          layers are on, render a single unclipped shield to avoid a
          hairline seam along the diagonal where the two clipPaths meet. */}
      {anyOn && (
        <g className="sentinel-shield-pulse text-ios-green">
          {scanOn && permsOn ? (
            <path d={SHIELD_PATH} fill="currentColor" stroke="currentColor" />
          ) : (
            <>
              {scanOn && (
                <path
                  d={SHIELD_PATH}
                  fill="currentColor"
                  stroke="currentColor"
                  clipPath={`url(#${leftClip})`}
                />
              )}
              {permsOn && (
                <path
                  d={SHIELD_PATH}
                  fill="currentColor"
                  stroke="currentColor"
                  clipPath={`url(#${rightClip})`}
                />
              )}
            </>
          )}
        </g>
      )}
    </svg>
  );
}
