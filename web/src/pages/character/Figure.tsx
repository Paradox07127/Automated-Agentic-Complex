// Placeholder art until characters ship portraits and the host renders a live preview; all decorative.
import { useState } from 'react';
import { artEnabled } from '../../ui';

/** Standing silhouette on the preview stage. */
export function Silhouette({ h = 200 }: { h?: number }) {
  return (
    <svg width={h * 0.45} height={h} viewBox="0 0 90 200" aria-hidden="true">
      <path d="M45 6c-13 0-21 9-21 22 0 9 3 15 7 19l-3 10h34l-3-10c4-4 7-10 7-19 0-13-8-22-21-22z" fill="#3a3b3e" />
      <path d="M26 24c2-14 11-20 21-20 12 0 20 8 20 20-4-5-10-8-18-8-9 0-16 3-23 8z" fill="#55565a" />
      <path d="M24 30c-4 18-2 34 2 46l6-30z M66 30c4 18 2 34-2 46l-6-30z" fill="#4a4b4f" />
      <path d="M28 58h34l8 18 4 52-12 4-3 44h-9l-1-40h-4l-1 40h-9l-3-44-12-4 4-52z" fill="#2d2e31" />
      <path d="M30 60l15 22 15-22" fill="none" stroke="#6b6c70" strokeWidth="1.5" />
      <path d="M22 78l-6 44 6 2 6-38z M68 78l6 44-6 2-6-38z" fill="#38393c" />
      <path d="M28 58h34l8 18 4 52-12 4-3 44h-9l-1-40h-4l-1 40h-9l-3-44-12-4 4-52z" fill="none" stroke="rgba(255,255,255,.28)" strokeWidth="1" />
      <rect x="35" y="176" width="9" height="6" fill="rgb(34 34 34)" />
      <rect x="47" y="176" width="9" height="6" fill="rgb(34 34 34)" />
    </svg>
  );
}

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
