import { useEffect, type Dispatch } from 'react';
import type { Bar, CommAction } from '../comm/commReducer';
import { useComm } from '../comm/useComm';

/** The reducer's own linger clock is held so the line stays until the user closes it or a new line replaces it. */
function useHold(bar: Bar | null, paused: boolean, dispatch: Dispatch<CommAction>) {
  const id = bar?.id ?? null;
  const held = bar?.phase === 'linger' || paused;
  useEffect(() => {
    if (id) dispatch({ type: 'hold', id, held });
  }, [id, held, dispatch]);
}

/**
 * Her line for the bubble, from `/feed` `line` events through the comm reducer, and a side session's answer under it.
 * A finished line stays held in the reducer so the collapsed icon can reopen it; other phases keep their clocks unless `paused`.
 */
export function useSpeech(demo: Parameters<typeof useComm>[0], still: boolean, paused: boolean) {
  const [comm, dispatch] = useComm(demo, still);
  const bar = comm.bars.find((b) => b.kind === 'main') ?? comm.bars[0] ?? null;
  const side = comm.bars.find((b) => b !== bar && b.kind === 'side') ?? null;
  useHold(bar, paused, dispatch);
  useHold(side, paused, dispatch);
  return { bar, side, dispatch };
}
