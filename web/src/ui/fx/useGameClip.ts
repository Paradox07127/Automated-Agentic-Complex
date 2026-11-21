import { useEffect, useMemo, useRef, type RefObject } from 'react';
import type { GameClip } from '../../design/gameClips.generated';
import { animate, fxCalm } from './motion';

export interface GameClipOptions {
  /** Play forward once mounted (entrances). */
  autoplay?: boolean;
}

export interface GameClipControls {
  /** Forward from where the clip stands; resolves when it ends. */
  play(): Promise<void>;
  /** Backward to the first frame (hover out). */
  reverse(): Promise<void>;
  /** To the first frame at once (a pressed key, which the game snaps back to Normal). */
  rest(): void;
  /** Holds the clip where it stands; play() goes on from there. */
  pause(): void;
  /** Writes where the clip ended into each node's own style and drops its animations. */
  settle(): void;
  /** The current run. */
  readonly finished: Promise<void>;
}

function targets(root: Element, key: string): Element[] {
  const sel = `[data-g="${key}"]`;
  return [...(root.matches(sel) ? [root] : []), ...root.querySelectorAll(sel)];
}

function keyframes(track: GameClip['tracks'][number]): Keyframe[] {
  return track.keyframes.map((k) => ({ offset: k.offset, easing: k.easing, [track.property]: k.value }));
}

/**
 * Plays a game clip (gameClips.generated.ts) with Web Animations on the `[data-g="<key>"]` elements under root.
 * Still shots and reduced motion jump to the end frame (loops stay at rest); a loop pauses while the document is hidden.
 */
export function useGameClip(clip: GameClip, rootRef: RefObject<Element | null>, opts: GameClipOptions = {}): GameClipControls {
  const anims = useRef<Animation[]>([]);
  const done = useRef<Promise<void>>(Promise.resolve());

  const controls = useMemo(() => {
    const run = (rate: 1 | -1): Promise<void> => {
      const root = rootRef.current;
      if (!root) return done.current;
      const calm = fxCalm();
      if (clip.loop && calm) return done.current;
      if (anims.current.length === 0) {
        const timing: KeyframeAnimationOptions = { duration: clip.duration, iterations: clip.loop ? Infinity : 1, fill: clip.loop ? 'none' : 'both' };
        anims.current = clip.tracks.flatMap((t) => targets(root, t.key).flatMap((el) => animate(el, keyframes(t), timing) ?? []));
        if (rate < 0) for (const a of anims.current) a.currentTime = clip.duration;
      }
      for (const a of anims.current) {
        a.playbackRate = rate;
        a.play();
        if (calm) a.finish();
        else if (clip.loop && document.hidden) a.pause();
      }
      done.current = Promise.all(anims.current.map((a) => a.finished.catch(() => a))).then(() => undefined);
      return done.current;
    };
    return {
      play: () => run(1),
      reverse: () => run(-1),
      rest: () => {
        for (const a of anims.current) {
          a.pause();
          a.currentTime = 0;
        }
      },
      pause: () => {
        for (const a of anims.current) a.pause();
      },
      settle: () => {
        for (const a of anims.current) {
          a.commitStyles();
          a.cancel();
        }
        anims.current = [];
      },
      get finished() {
        return done.current;
      },
    } satisfies GameClipControls;
  }, [clip, rootRef]);

  useEffect(() => {
    if (opts.autoplay) void controls.play();
    return () => {
      for (const a of anims.current) a.cancel();
      anims.current = [];
    };
  }, [controls, opts.autoplay]);

  useEffect(() => {
    if (!clip.loop) return;
    const sync = () => {
      for (const a of anims.current) {
        if (document.hidden) a.pause();
        else if (a.playState === 'paused') a.play();
      }
    };
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [clip.loop]);

  return controls;
}
