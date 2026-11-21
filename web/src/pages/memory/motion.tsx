import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { GameClip } from '../../design/gameClips.generated';
import { useGameClip } from '../../ui';

type Root = RefObject<Element | null>;

/** Where the mounted view puts its out clip; the page plays it before it switches views. */
export type LeaveSlot = { current: (() => Promise<void>) | null };

export interface RunProps {
  root: Root;
  clip: GameClip;
  /** Played when `clip` ends, or with it when `together`. */
  next?: GameClip;
  together?: boolean;
  onEnd: () => void;
}

/** Plays game clips on the [data-g] nodes under root; unmounting it drops their animations, so the CSS rest state shows. */
export function Run({ root, clip, next, together = false, onEnd }: RunProps) {
  const a = useGameClip(clip, root);
  const b = useGameClip(next ?? clip, root);
  const end = useRef(onEnd);
  useEffect(() => {
    end.current = onEnd;
  });
  useLayoutEffect(() => {
    let alive = true;
    // A player inside its root runs before the root's ref is set; the microtask still runs before the first paint.
    queueMicrotask(() => {
      if (!alive) return;
      const first = a.play();
      const all = !next ? first : together ? Promise.all([first, b.play()]) : first.then(() => (alive ? b.play() : undefined));
      void all.then(() => alive && end.current());
    });
    return () => {
      alive = false;
    };
  }, [a, b, next, together]);
  return null;
}

/** An entrance played once on mount; the player leaves when it ends, so nothing stays attached at rest. */
export function useEntrance(root: Root, clip: GameClip, next?: GameClip, together = false): ReactNode {
  const [done, setDone] = useState(false);
  return done ? null : <Run root={root} clip={clip} next={next} together={together} onEnd={() => setDone(true)} />;
}

/** Offers the view's out clip to the page while the view is mounted. */
export function useExit(root: Root, clip: GameClip, slot: LeaveSlot | undefined) {
  const out = useGameClip(clip, root);
  useEffect(() => {
    if (!slot) return;
    const play = () => out.play();
    slot.current = play;
    return () => {
      if (slot.current === play) slot.current = null;
    };
  }, [out, slot]);
}

/** View switching that lets the mounted view play its out clip first. */
export function useLeave<T>(now: T, set: (v: T) => void) {
  const slot = useRef<(() => Promise<void>) | null>(null);
  const pick = (v: T) => {
    const out = slot.current;
    if (!out || v === now) set(v);
    else void out().then(() => set(v));
  };
  return { slot, pick };
}

/** A Highlighted clip on hover or focus: forward in, backward out. */
export function useHoverClip<T extends HTMLElement>(clip: GameClip) {
  const ref = useRef<T>(null);
  const c = useGameClip(clip, ref);
  const on = () => void c.play();
  const off = () => void c.reverse();
  return { ref, on, off };
}
