import { useEffect, useState } from 'react';

/** Wall clock in ms, re-read every `everyMs` while `on`. */
export function useNow(everyMs: number, on = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs, on]);
  return now;
}
