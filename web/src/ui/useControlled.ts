import { useCallback, useState } from 'react';

/**
 * Controlled when the caller passes a change handler; otherwise keeps its own state so demos and
 * read-mostly uses still respond. A parent that rejects a change (e.g. asks to confirm first) stays in charge.
 */
export function useControlled<T>(value: T, onChange: ((v: T) => void) | undefined): [T, (v: T) => void] {
  const [inner, setInner] = useState(value);
  const [prev, setPrev] = useState(value);
  if (!Object.is(prev, value)) {
    setPrev(value);
    setInner(value);
  }
  const controlled = onChange !== undefined;
  const set = useCallback(
    (v: T) => {
      if (!controlled) setInner(v);
      onChange?.(v);
    },
    [controlled, onChange],
  );
  return [controlled ? value : inner, set];
}
