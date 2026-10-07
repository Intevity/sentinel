import React from 'react';
import { X } from 'lucide-react';

/**
 * The ✕ on a "Route <surface> through Sentinel" card. Says where the choice
 * lives afterwards, since the card will not come back on its own.
 */
export default function SurfaceCardDismissButton({
  surfaceName,
  onDismiss,
}: {
  surfaceName: string;
  onDismiss: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onDismiss}
      aria-label={`Dismiss ${surfaceName} routing suggestion`}
      title={`Hide this. You can route ${surfaceName} through Sentinel later in Settings → General.`}
      className="flex-shrink-0 text-muted hover:text-black dark:hover:text-white transition-colors active:scale-90 p-0.5 -m-0.5"
    >
      <X size={14} strokeWidth={2.5} />
    </button>
  );
}
