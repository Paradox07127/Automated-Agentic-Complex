// Placeholder art until characters ship portraits and the host renders a live preview; all decorative.
import { useState } from 'react';
import { artEnabled } from '../../ui';

/** The emblem beside the nameplate; the drawn square mark where the app ships no emblem art or it fails to load. */
export function Emblem({ className }: { className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={className} aria-hidden="true">
      {artEnabled() && !failed ? (
        <img src="art/brand/emblem.png" width={28} height={24} alt="" onError={() => setFailed(true)} />
      ) : (
        <svg width="24" height="24" viewBox="0 0 24 24">
          <path d="M3 3h12v4H7v4h10v10H3v-4h10v-2H3z" fill="currentColor" />
          <path d="M17 3h4v4h-4z" fill="currentColor" />
        </svg>
      )}
    </span>
  );
}
