import { useEffect } from 'react';
import { useComm } from '../comm/useComm';

/**
 * Her line for the bubble, from `/feed` `line` events through the comm reducer. A finished line stays held in the
 * reducer so the collapsed icon can reopen it; other phases keep their clocks unless `paused`.
 */
export function useSpeech(demo: Parameters<typeof useComm>[0], still: boolean, paused: boolean) {
  const [comm, dispatch] = useComm(demo, still);
  const bar = comm.bars.find((b) => b.kind === 'main') ?? comm.bars[0] ?? null;
  const id = bar?.id ?? null;

  // The reducer's own linger clock is held so the line stays until the user closes it or a new line replaces it.
  const held = bar?.phase === 'linger' || paused;
  useEffect(() => {
    if (id) dispatch({ type: 'hold', id, held });
  }, [id, held, dispatch]);

  return { bar, dispatch };
}
