import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type WheelEvent } from 'react';
import { fxCalm } from '../../ui';

// The watch's right list is a UIScrollRect (watchpanel_pc): elastic, with inertia, wheel sensitivity 45 game px.
/** One wheel notch, in stage px (half the game's 45). */
const NOTCH = 22.5;
/** A pixel-mode wheel sends about this much per notch. */
const NOTCH_PX = 100;
/** m_Elasticity: the spring back from past either end, in s. */
const ELASTICITY = 0.1;
/** m_DecelerationRate: the share of its speed a fling keeps after one second. */
const DECELERATION = 0.135;
/** Speeds under this many px/s stop, as ScrollRect's. */
const STOP = 1;
/** A press moves this far, in stage px, before it scrolls instead of pressing (EventSystem's 10 game px). */
const DRAG_START = 5;
/** The fling's speed is read over the drag's last this many ms. */
const FLING_MS = 80;
/** CONTROLLER_RIGHT_LIST_ROLL_TIME: a key taking focus out of view scrolls in over this long, easing out (OutSine). */
const REVEAL_MS = 100;

/** How far past an end a pull of `over` px shows: ScrollRect's RubberDelta. */
const rubber = (over: number, view: number) => (1 - 1 / ((Math.abs(over) * 0.55) / view + 1)) * view * Math.sign(over);

/** Unity's Mathf.SmoothDamp with no speed limit: one step of `dt` s from `from` toward `to`; returns the place and speed. */
function smoothDamp(from: number, to: number, speed: number, time: number, dt: number): [number, number] {
  const omega = 2 / time;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = from - to;
  const temp = (speed + omega * change) * dt;
  const out = to + (change + temp) * exp;
  // Past the target: stop on it.
  if (to - from > 0 === out > to) return [to, 0];
  return [out, (speed - omega * temp) * exp];
}

interface Sim {
  pos: number;
  speed: number;
  /** A press that may become a drag: where it started, and the drag's samples once it moves. */
  press: { y: number; from: number; dragging: boolean; samples: Array<[number, number]> } | null;
  /** `t0` is taken on the first frame: frames carry their own clock. */
  tween: { from: number; to: number; t0: number | null } | null;
  frame: number;
  /** The last frame's time; null before the first. */
  last: number | null;
  /** The last press dragged: the click it ends in is not a press. */
  dragged: boolean;
}

/**
 * The list's scroll offset in stage px (0 at the top, `max` at the bottom) with the game's feel: a wheel notch moves
 * 22.5 px, a drag pulls with rubber past either end, a fling coasts and slows, an overscroll springs back in 0.1 s.
 * Still screenshots and reduced motion get no fling or spring: the offset stays within its ends.
 * `view` is the window's height and `scale` the stage's on screen, for the pointer's px.
 */
export function useListScroll(max: number, view: number, scale: number) {
  const [pos, setPos] = useState(0);
  const sim = useRef<Sim>({ pos: 0, speed: 0, press: null, tween: null, frame: 0, last: null, dragged: false });
  const clamp = useCallback((p: number) => Math.min(Math.max(p, 0), max), [max]);
  const put = useCallback((p: number) => {
    sim.current.pos = p;
    setPos(p);
  }, []);

  const step = useCallback(
    (now: number) => {
      const s = sim.current;
      const dt = s.last == null ? 1 / 60 : Math.min(Math.max((now - s.last) / 1000, 0.001), 0.05);
      s.last = now;
      s.frame = 0;
      if (s.tween) {
        s.tween.t0 ??= now - 1000 / 60;
        const t = Math.min((now - s.tween.t0) / REVEAL_MS, 1);
        put(s.tween.from + (s.tween.to - s.tween.from) * Math.sin((t * Math.PI) / 2));
        if (t >= 1) s.tween = null;
      } else if (!s.press?.dragging) {
        const end = clamp(s.pos);
        if (end !== s.pos) {
          const [p, v] = smoothDamp(s.pos, end, s.speed, ELASTICITY, dt);
          const settled = Math.abs(p - end) < 0.1;
          s.speed = settled || Math.abs(v) < STOP ? 0 : v;
          put(settled ? end : p);
        } else if (s.speed !== 0) {
          s.speed *= DECELERATION ** dt;
          if (Math.abs(s.speed) < STOP) s.speed = 0;
          put(s.pos + s.speed * dt);
        }
      }
      if (s.tween || (!s.press?.dragging && (s.speed !== 0 || clamp(s.pos) !== s.pos))) s.frame = requestAnimationFrame(step);
      else s.last = null;
    },
    [clamp, put],
  );
  const run = useCallback(() => {
    const s = sim.current;
    if (s.frame) return;
    s.frame = requestAnimationFrame(step);
  }, [step]);

  // A list that got shorter (开发者模式 off) keeps its offset within the new end.
  useEffect(() => {
    if (sim.current.pos > max) put(max);
  }, [max, put]);
  useEffect(() => () => cancelAnimationFrame(sim.current.frame), []);

  const onWheel = (e: WheelEvent) => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.deltaY === 0) return;
    const s = sim.current;
    const d = e.deltaMode === 1 ? e.deltaY * NOTCH : e.deltaMode === 2 ? e.deltaY * view : (e.deltaY / NOTCH_PX) * NOTCH;
    s.tween = null;
    const raw = s.pos + d;
    const end = clamp(raw);
    put(fxCalm() ? end : end + rubber(raw - end, view));
    if (!fxCalm()) run();
  };

  // The move and the release are read on the window: a drag may leave the list.
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const s = sim.current;
    s.dragged = false;
    s.press = { y: e.clientY, from: s.pos, dragging: false, samples: [] };
    const move = (m: globalThis.PointerEvent) => {
      const p = s.press;
      if (!p) return;
      const dy = (p.y - m.clientY) / scale;
      if (!p.dragging) {
        if (Math.abs(dy) < DRAG_START) return;
        p.dragging = true;
        p.y = m.clientY;
        p.from = s.pos;
        s.tween = null;
        s.speed = 0;
        return;
      }
      const raw = p.from + dy;
      const end = clamp(raw);
      put(fxCalm() ? end : end + rubber(raw - end, view));
      p.samples.push([m.timeStamp, s.pos]);
      while (p.samples.length > 2 && m.timeStamp - p.samples[0]![0] > FLING_MS) p.samples.shift();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const p = s.press;
      s.press = null;
      if (!p?.dragging) return;
      s.dragged = true;
      const [first, last] = [p.samples[0], p.samples.at(-1)];
      s.speed = !fxCalm() && first && last && last[0] > first[0] ? ((last[1] - first[1]) / (last[0] - first[0])) * 1000 : 0;
      if (fxCalm()) put(clamp(s.pos));
      else run();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const onClickCapture = (e: MouseEvent) => {
    if (!sim.current.dragged) return;
    sim.current.dragged = false;
    e.preventDefault();
    e.stopPropagation();
  };

  /** Scroll to `to` (clamped) as a key taking focus does. */
  const reveal = (to: number) => {
    const s = sim.current;
    const end = clamp(to);
    s.speed = 0;
    if (fxCalm()) {
      s.tween = null;
      put(end);
      return;
    }
    s.tween = { from: s.pos, to: end, t0: null };
    run();
  };

  return { pos, onWheel, onPointerDown, onClickCapture, reveal };
}
