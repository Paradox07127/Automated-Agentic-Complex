import { useEffect, useRef, useState } from 'react';

/** `value`, taking a new one at most once per `ms`; the last value within a window lands when it ends. */
export function useThrottled<T>(value: T, ms = 1000): T {
  const [shown, setShown] = useState(value);
  const at = useRef(0);
  useEffect(() => {
    if (Object.is(value, shown)) return;
    const take = () => {
      at.current = Date.now();
      setShown(() => value);
    };
    const wait = at.current + ms - Date.now();
    if (wait <= 0) {
      take();
      return;
    }
    const id = setTimeout(take, wait);
    return () => clearTimeout(id);
  }, [value, shown, ms]);
  return shown;
}
