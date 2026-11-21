import { useEffect, useState } from 'react';

/** Frozen screenshot mode: `still=1` in the search or hash query, or the shell's `html.still`. */
export function isStill(): boolean {
  if (typeof window === 'undefined') return true;
  const hash = window.location.hash;
  const i = hash.indexOf('?');
  const q = new URLSearchParams(i < 0 ? window.location.search : hash.slice(i + 1));
  return q.get('still') === '1' || document.documentElement.classList.contains('still');
}

/**
 * Seconds left, counting down once a second from `secondsLeft`; restarts when the input changes.
 * Null (no deadline) stays null. Hover never pauses it.
 */
export function useCountdown(secondsLeft: number | null, running = true): number | null {
  const [base, setBase] = useState(secondsLeft);
  const [left, setLeft] = useState(secondsLeft);
  if (base !== secondsLeft) {
    setBase(secondsLeft);
    setLeft(secondsLeft);
  }

  useEffect(() => {
    if (secondsLeft == null || secondsLeft <= 0 || !running || isStill()) return;
    const started = Date.now();
    const timer = setInterval(() => {
      const next = Math.max(0, secondsLeft - Math.floor((Date.now() - started) / 1000));
      setLeft((l) => (l === next ? l : next));
      if (next === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [secondsLeft, running]);

  return left;
}
