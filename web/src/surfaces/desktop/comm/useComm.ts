import { useEffect, useReducer } from 'react';
import { getBridge, type StreamEvent } from '../../../bridge';
import { playDemo, type CommDemo } from './commDemo';
import { commReducer, INITIAL, parseAccepted, parseLine } from './commReducer';

/** The bars from `/feed` `turn_accepted` and `line` events (or a demo script), with exact-deadline phase transitions. */
export function useComm(demo: CommDemo | null, still: boolean) {
  const [state, dispatch] = useReducer(commReducer, INITIAL);

  useEffect(() => {
    const lost = () => dispatch({ type: 'lost' });
    const onEvent = (e: StreamEvent) => {
      if (e.event === 'reset' || e.event === 'gap') return lost();
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
    return getBridge().feed.subscribe(onEvent, lost);
  }, [demo, still]);

  const nextMs = state.bars
    .filter((b) => b.phase !== 'streaming' && (b.phase === 'fading' || (!b.pinned && !b.held)))
    .reduce((min, b) => Math.min(min, Math.max(1, b.left)), Number.POSITIVE_INFINITY);

  useEffect(() => {
    if (still || !Number.isFinite(nextMs)) return;
    const t = setTimeout(() => dispatch({ type: 'tick', dt: nextMs }), nextMs);
    return () => clearTimeout(t);
  }, [still, nextMs, state.bars]);

  return [state, dispatch] as const;
}
