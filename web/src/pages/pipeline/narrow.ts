import { useSyncExternalStore } from 'react';

const NARROW = '(max-width: 1099px)';
const mq = () => (typeof window.matchMedia === 'function' ? window.matchMedia(NARROW) : null);

/** Below 1100 px the station cards and the readouts take their compact form. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    (on) => {
      const m = mq();
      m?.addEventListener('change', on);
      return () => m?.removeEventListener('change', on);
    },
    () => mq()?.matches ?? false,
  );
}
