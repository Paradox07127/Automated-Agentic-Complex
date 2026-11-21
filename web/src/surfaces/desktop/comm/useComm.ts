import { useEffect, useReducer } from 'react';
import { getBridge, type StreamEvent } from '../../../bridge';
import { playDemo, type CommDemo } from './commDemo';
import { commReducer, INITIAL, parseAccepted, parseLine } from './commReducer';

const TICK_MS = 100;

/** The bars from `/feed` `turn_accepted` and `line` events (or a demo script), with their clocks running unless `still`. */
export function useComm(demo: CommDemo | null, still: boolean) {
  const [state, dispatch] = useReducer(commReducer, INITIAL);

  useEffect(() => {
    const onEvent = (e: StreamEvent) => {
      if (e.event === 'turn_accepted') {
        const turn = parseAccepted(e.data);
        if (turn) dispatch({ type: 'accepted', ...turn });
        return;
      }
      if (e.event !== 'line') return;
      const line = parseLine(e.data);
      if (line) dispatch({ type: 'line', line });
    };
    if (demo) return playDemo(demo, still, onEvent);
    return getBridge().feed.subscribe(onEvent, () => {});
  }, [demo, still]);

  const timed = state.bars.some((b) => b.phase !== 'streaming');
  useEffect(() => {
    if (still || !timed) return;
    let last = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      dispatch({ type: 'tick', dt: now - last });
      last = now;
    }, TICK_MS);
    return () => clearInterval(t);
  }, [still, timed]);

  return [state, dispatch] as const;
}
